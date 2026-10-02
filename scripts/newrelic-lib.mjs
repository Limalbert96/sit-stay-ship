// New Relic wiring for the demo, used by `npm run setup` and `npm run newrelic`. Two halves:
//
// 1. LaunchDarkly -> New Relic: LaunchDarkly's New Relic integration (`new-relic-apm-v2`) writes
//    every flag change to New Relic as a FEATURE_FLAG change tracking event. One subscription marks
//    one New Relic application, so there are two, named after the entity: "<app> [APM]" for the
//    Node service and "<app> [Browser]" for the React page. The Browser app also CALLS the APM
//    service, so APM markers show on Browser charts under "Related Changes" as well.
//    Created through the LaunchDarkly REST API: the Terraform provider (3.1.x) only accepts the
//    integration keys compiled into it, and this one is newer than that list.
//
// 2. New Relic -> LaunchDarkly: an alert on rage clicks, and a Workflow that fires a LaunchDarkly
//    flag trigger when the alert opens an issue (automated kill switch). Created through NerdGraph.
//    The Workflow is created DISABLED: a live demo uses the page's manual kill switch, and an
//    enabled Workflow would turn the flag off before the presenter does.
//
// Every step looks its object up by name first and updates it, so running it again is safe, and it
// adopts objects made by hand with the same names.
//
// Steps return { status: 'created' | 'exists' | 'manual', detail } and never throw, like setup-lib.

import { spawnSync } from 'node:child_process';
import { createApi } from './setup-lib.mjs';
import { resolveEntityGuids } from '../server/changeTracking.js';

export const NEW_RELIC_INTEGRATION = 'new-relic-apm-v2';
const KIND_LABEL = { apm: 'APM', browser: 'Browser' };
export const subscriptionName = (kind, appName = 'Canine Good Citizen') => `${appName} [${KIND_LABEL[kind] ?? kind}]`;
// Earlier versions of this script used this name; a subscription found under it is renamed.
const legacyName = (kind) => `CGC Prep: flag changes to New Relic (${kind})`;

export const ALERT_CONDITION_NAME = 'Rage Click';
export const ALERT_POLICY_NAME = 'CGC Prep: bad release';
export const WORKFLOW_NAME = 'Rage click -> LaunchDarkly kill switch';
export const DESTINATION_NAME = 'LaunchDarkly kill switch (rage click alert)';
export const CHANNEL_NAME = 'LaunchDarkly kill switch webhook (workflows)';

// An entity GUID is base64 of "account|DOMAIN|TYPE|id"; the integration wants the numeric id.
export function appIdFromGuid(guid) {
  const parts = Buffer.from(guid, 'base64').toString('utf8').split('|');
  return parts.length === 4 && /^\d+$/.test(parts[3]) ? parts[3] : null;
}

// ---- 1. LaunchDarkly's New Relic integration ---------------------------------------------

// The integration's default policy covers only the production environment. This demo runs in
// test, so the subscription covers every environment of this one project instead.
export function subscriptionBody({ kind, userKey, appId, domain, project, appName }) {
  return {
    name: subscriptionName(kind, appName),
    on: true,
    tags: ['cgc-prep'],
    config: { apiKey: userKey, applicationId: String(appId), domain },
    statements: [{ effect: 'allow', actions: ['*'], resources: [`proj/${project}:env/*:flag/*`] }],
  };
}

export async function stepNewRelicIntegration({ api, project }, { userKey, appIds, domain = 'api.newrelic.com', appName }) {
  const list = await api('GET', `/integrations/${NEW_RELIC_INTEGRATION}`);
  if (list.status === 404) {
    return [{ status: 'manual', detail: `the ${NEW_RELIC_INTEGRATION} integration is not available in this LaunchDarkly account` }];
  }
  const existing = list.data?.items ?? [];
  const results = [];
  for (const [kind, appId] of Object.entries(appIds)) {
    if (!appId) {
      results.push({ status: 'manual', detail: `no New Relic ${kind} application found, so nothing to mark it on` });
      continue;
    }
    const body = subscriptionBody({ kind, userKey, appId, domain, project, appName });
    const found = existing.find((s) => s.name === body.name || s.name === legacyName(kind));
    if (found) {
      // JSON patch: bring an existing subscription back to this config (the key may have rotated).
      const res = await api('PATCH', `/integrations/${NEW_RELIC_INTEGRATION}/${found._id}`, [
        { op: 'replace', path: '/name', value: body.name },
        { op: 'replace', path: '/config', value: body.config },
        { op: 'replace', path: '/statements', value: body.statements },
        { op: 'replace', path: '/on', value: true },
      ]);
      results.push(res.status >= 200 && res.status < 300
        ? { status: 'exists', detail: `${kind}: "${body.name}" (application ${appId})` }
        : { status: 'manual', detail: `${kind}: could not update "${body.name}" (LaunchDarkly answered ${res.status}: ${res.data?.message ?? 'no message'})` });
      continue;
    }
    const res = await api('POST', `/integrations/${NEW_RELIC_INTEGRATION}`, body);
    results.push(res.status >= 200 && res.status < 300
      ? { status: 'created', detail: `${kind}: "${body.name}" (application ${appId})` }
      : { status: 'manual', detail: `${kind}: could not create "${body.name}" (LaunchDarkly answered ${res.status}: ${res.data?.message ?? 'no message'})` });
  }
  return results;
}

export async function tearDownNewRelicIntegration({ api }) {
  const list = await api('GET', `/integrations/${NEW_RELIC_INTEGRATION}`);
  // Ours carry the cgc-prep tag (set by subscriptionBody), whatever they are named.
  const ours = (list.data?.items ?? []).filter((s) => s.tags?.includes('cgc-prep') || s.name?.startsWith('CGC Prep: flag changes to New Relic'));
  const results = [];
  for (const s of ours) {
    const res = await api('DELETE', `/integrations/${NEW_RELIC_INTEGRATION}/${s._id}`);
    if (res.status === 0) {
      results.push({ status: 'exists', detail: `would delete the New Relic subscription "${s.name}"` }); // dry run
      continue;
    }
    results.push(res.status >= 200 && res.status < 300 || res.status === 404
      ? { status: 'created', detail: `deleted the New Relic subscription "${s.name}"` }
      : { status: 'manual', detail: `could not delete "${s.name}" (LaunchDarkly answered ${res.status})` });
  }
  return results;
}

// ---- 2. New Relic alert and automated kill switch ------------------------------------------

export function nerdGraphClient({ userKey, url = 'https://api.newrelic.com/graphql', fetchImpl = fetch }) {
  return async function nerdgraph(query, variables = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': userKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    // NerdGraph answers 200 with an "errors" array, so the status alone does not say it worked.
    if (!res.ok) throw new Error(`New Relic answered ${res.status}`);
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
  };
}

// What the trigger records in LaunchDarkly when New Relic fires it. A trigger's audit entry takes
// the request's `eventName` ("<eventName> was triggered"), so flag history says which path turned
// the flag off: this, or the page's manual kill switch (server/index.js sends its own eventName).
export const AUTO_REMEDIATION_EVENT = 'New Relic auto-remediation: the rage-click alert opened an issue';

// The alert's signal. Two things have to both be true for the issue to close itself once the kill
// switch works and rage clicks stop:
//
// 1. CADENCE, not EVENT_TIMER. EVENT_TIMER only re-evaluates a window when a NEW event arrives for
//    it; once clicks stop there is no later event to trigger that re-evaluation, so a still-open
//    violation never gets a chance to see anything, fill included, and it sits open until
//    violationTimeLimitSeconds (tested: 15+ minutes with no new clicks, still open). CADENCE
//    publishes a window every aggregationDelay seconds regardless of data, so it keeps evaluating.
// 2. fillOption STATIC / fillValue 0. With fillOption NONE, an empty window still has no value at
//    all, which CADENCE cannot compare against the threshold either. The fill is what turns "no
//    events" into an actual 0, which is what lets the violation see something below the threshold.
export const RAGE_CLICK_SIGNAL = {
  aggregationMethod: 'CADENCE',
  aggregationDelay: 60,
  // Explicit null: NerdGraph keeps a field's previous value across an update unless it is set,
  // even to null, and the two methods' timer fields are mutually exclusive (switching from
  // EVENT_TIMER otherwise fails: "Aggregation timer must not be supplied when ... 'CADENCE'").
  aggregationTimer: null,
  aggregationWindow: 60,
  fillOption: 'STATIC',
  fillValue: 0,
};

// This is the other half of letting the issue close once the rage clicks stop, and the harder one
// to find: fillOption only fills a gap WITHIN a signal that is still reporting (so a window with no
// matching events still gets a value). It does nothing when the signal itself goes fully quiet, no
// matching events at all for the browser app, which is exactly what happens between demo runs.
// NerdGraph's own `expiration` settings govern that case, and left at their defaults
// (closeViolationsOnExpiration: false) an open violation then never gets the chance to recompute
// and never closes, even with the signal correctly otherwise configured and the data genuinely
// zero. Confirmed live, twice, on two different condition IDs: with expiration left default, an
// issue stayed ACTIVATED 12 and 33 minutes respectively despite the underlying query reading zero
// the whole time; setting this closed a stuck issue within about a minute.
export const RAGE_CLICK_EXPIRATION = {
  expirationDuration: 120,
  closeViolationsOnExpiration: true,
  openViolationOnExpiration: false,
};

export const rageClickQuery = (appName) =>
  `SELECT uniqueCount(enduser.id) FROM UserAction WHERE rageClick = true AND appName = '${appName.replace(/'/g, "\\'")}'`;

async function findCondition(nerdgraph, accountId) {
  const data = await nerdgraph(`query($id: Int!, $name: String) { actor { account(id: $id) { alerts {
    nrqlConditionsSearch(searchCriteria: { name: $name }) { nrqlConditions { id name policyId signal { fillOption } expiration { expirationDuration } } } } } } }`,
  { id: Number(accountId), name: ALERT_CONDITION_NAME });
  return data.actor.account.alerts.nrqlConditionsSearch.nrqlConditions.find((c) => c.name === ALERT_CONDITION_NAME);
}

// Adopts an existing "Rage Click" condition (its threshold is left as it is) and only fixes its
// signal; creates the policy and condition when there is none. A threshold of 1 means one
// frustrated customer is enough, so a presenter rage-clicking alone can set it off in a demo.
export async function stepRageClickAlert(nerdgraph, { accountId, appName, threshold = 1 }) {
  try {
    const existing = await findCondition(nerdgraph, accountId);
    if (existing) {
      await nerdgraph(`mutation($acc: Int!, $id: ID!, $signal: AlertsNrqlConditionSignalInput, $expiration: AlertsNrqlConditionExpirationInput) {
        alertsNrqlConditionStaticUpdate(accountId: $acc, id: $id, condition: { signal: $signal, expiration: $expiration }) { id } }`,
      { acc: Number(accountId), id: existing.id, signal: RAGE_CLICK_SIGNAL, expiration: RAGE_CLICK_EXPIRATION });
      return { status: 'exists', detail: `alert "${ALERT_CONDITION_NAME}" (empty windows count as 0, and a quiet signal force-closes after ${RAGE_CLICK_EXPIRATION.expirationDuration}s, so it reliably closes)`, policyId: existing.policyId };
    }
    const policy = await nerdgraph(`mutation($acc: Int!, $name: String!) {
      alertsPolicyCreate(accountId: $acc, policy: { name: $name, incidentPreference: PER_CONDITION }) { id } }`,
    { acc: Number(accountId), name: ALERT_POLICY_NAME });
    const policyId = policy.alertsPolicyCreate.id;
    await nerdgraph(`mutation($acc: Int!, $policy: ID!, $condition: AlertsNrqlConditionStaticInput!) {
      alertsNrqlConditionStaticCreate(accountId: $acc, policyId: $policy, condition: $condition) { id } }`,
    {
      acc: Number(accountId),
      policy: policyId,
      condition: {
        name: ALERT_CONDITION_NAME,
        enabled: true,
        description: 'Customers are rage-clicking: someone clicked the same thing again and again, which usually means something on the page is broken.',
        nrql: { query: rageClickQuery(appName) },
        signal: RAGE_CLICK_SIGNAL,
        expiration: RAGE_CLICK_EXPIRATION,
        terms: [{ operator: 'ABOVE_OR_EQUALS', threshold, thresholdDuration: 60, thresholdOccurrences: 'AT_LEAST_ONCE', priority: 'CRITICAL' }],
        violationTimeLimitSeconds: 86400,
      },
    });
    return { status: 'created', detail: `policy "${ALERT_POLICY_NAME}" with alert "${ALERT_CONDITION_NAME}"`, policyId };
  } catch (err) {
    return { status: 'manual', detail: `could not set up the rage-click alert (${err.message})` };
  }
}

const notificationsQuery = `query($acc: Int!) { actor { account(id: $acc) {
  aiNotifications {
    destinations { entities { id name properties { key value } } }
    channels { entities { id name destinationId product } }
  }
  aiWorkflows { workflows { entities { id name workflowEnabled } } } } } }`;

async function lookUp(nerdgraph, accountId) {
  const data = await nerdgraph(notificationsQuery, { acc: Number(accountId) });
  const account = data.actor.account;
  return {
    destination: account.aiNotifications.destinations.entities.find((d) => d.name === DESTINATION_NAME),
    channel: account.aiNotifications.channels.entities.find((c) => c.name === CHANNEL_NAME),
    workflow: account.aiWorkflows.workflows.entities.find((w) => w.name === WORKFLOW_NAME),
  };
}

const channelProperties = () => [
  { key: 'payload', value: JSON.stringify({ eventName: AUTO_REMEDIATION_EVENT }) },
  { key: 'headers', value: '{}' },
];

// Destination (the trigger URL) -> channel -> workflow on the rage-click policy. The channel's
// product must be IINT (Workflows); a workflow cannot attach to an ALERTS-product channel.
// A new workflow starts disabled; an existing one keeps its on/off state unless `enabled` is given.
export async function stepAutoRemediation(nerdgraph, { accountId, policyId, triggerUrl, enabled }) {
  try {
    const acc = Number(accountId);
    let { destination, channel, workflow } = await lookUp(nerdgraph, acc);

    if (!destination) {
      const d = await nerdgraph(`mutation($acc: Int!, $dest: AiNotificationsDestinationInput!) {
        aiNotificationsCreateDestination(accountId: $acc, destination: $dest) { destination { id } } }`,
      { acc, dest: { name: DESTINATION_NAME, type: 'WEBHOOK', properties: [{ key: 'url', value: triggerUrl }] } });
      destination = d.aiNotificationsCreateDestination.destination;
    } else if (destination.properties?.find((p) => p.key === 'url')?.value !== triggerUrl) {
      // The trigger URL changes whenever the trigger is re-created; keep the destination on the live one.
      await nerdgraph(`mutation($acc: Int!, $id: ID!, $dest: AiNotificationsDestinationUpdate!) {
        aiNotificationsUpdateDestination(accountId: $acc, destinationId: $id, destination: $dest) { destination { id } } }`,
      { acc, id: destination.id, dest: { properties: [{ key: 'url', value: triggerUrl }] } });
    }

    if (!channel) {
      const c = await nerdgraph(`mutation($acc: Int!, $ch: AiNotificationsChannelInput!) {
        aiNotificationsCreateChannel(accountId: $acc, channel: $ch) { channel { id } } }`,
      { acc, ch: { name: CHANNEL_NAME, type: 'WEBHOOK', product: 'IINT', destinationId: destination.id, properties: channelProperties() } });
      channel = c.aiNotificationsCreateChannel.channel;
    } else {
      await nerdgraph(`mutation($acc: Int!, $id: ID!, $ch: AiNotificationsChannelUpdate!) {
        aiNotificationsUpdateChannel(accountId: $acc, channelId: $id, channel: $ch) { channel { id } } }`,
      { acc, id: channel.id, ch: { properties: channelProperties() } });
    }

    if (!workflow) {
      const w = await nerdgraph(`mutation($acc: Int!, $wf: AiWorkflowsCreateWorkflowInput!) {
        aiWorkflowsCreateWorkflow(accountId: $acc, createWorkflowData: $wf) { workflow { id workflowEnabled } errors { description } } }`,
      {
        acc,
        wf: {
          name: WORKFLOW_NAME,
          workflowEnabled: Boolean(enabled),
          mutingRulesHandling: 'NOTIFY_ALL_ISSUES',
          issuesFilter: { name: 'Rage click policy', type: 'FILTER', predicates: [{ attribute: 'labels.policyIds', operator: 'EXACTLY_MATCHES', values: [String(policyId)] }] },
          destinationConfigurations: [{ channelId: channel.id, notificationTriggers: ['ACTIVATED'] }],
        },
      });
      const errors = w.aiWorkflowsCreateWorkflow.errors;
      if (errors?.length) throw new Error(errors.map((e) => e.description).join('; '));
      workflow = w.aiWorkflowsCreateWorkflow.workflow;
      return { status: 'created', detail: `workflow "${WORKFLOW_NAME}" (${workflow.workflowEnabled ? 'ON' : 'off'})`, workflowId: workflow.id, enabled: workflow.workflowEnabled };
    }
    if (enabled !== undefined && workflow.workflowEnabled !== Boolean(enabled)) {
      return { ...(await setAutoRemediation(nerdgraph, { accountId, enabled })), status: 'exists' };
    }
    return { status: 'exists', detail: `workflow "${WORKFLOW_NAME}" (${workflow.workflowEnabled ? 'ON' : 'off'})`, workflowId: workflow.id, enabled: workflow.workflowEnabled };
  } catch (err) {
    return { status: 'manual', detail: `could not set up the automated kill switch (${err.message})` };
  }
}

export async function setAutoRemediation(nerdgraph, { accountId, enabled }) {
  const { workflow } = await lookUp(nerdgraph, Number(accountId));
  if (!workflow) throw new Error(`there is no "${WORKFLOW_NAME}" workflow yet: run npm run newrelic first`);
  await nerdgraph(`mutation($acc: Int!, $wf: AiWorkflowsUpdateWorkflowInput!) {
    aiWorkflowsUpdateWorkflow(accountId: $acc, updateWorkflowData: $wf) { workflow { id } errors { description } } }`,
  { acc: Number(accountId), wf: { id: workflow.id, workflowEnabled: Boolean(enabled) } });
  return { status: 'created', detail: `workflow "${WORKFLOW_NAME}" is now ${enabled ? 'ON' : 'off'}`, workflowId: workflow.id, enabled: Boolean(enabled) };
}

export async function autoRemediationEnabled(nerdgraph, { accountId }) {
  const { workflow } = await lookUp(nerdgraph, Number(accountId));
  return workflow ? workflow.workflowEnabled : null;
}

// ---- Both halves together (npm run setup and npm run newrelic) -----------------------------

// Returns [stepName, result] pairs. `enabled` is only applied to a workflow being created or when
// given; leaving it out keeps an existing workflow's on/off state.
export async function setUpNewRelic({ token, project, enabled } = {}) {
  const env = process.env;
  if (!env.NR_USER_KEY || !env.NR_ACCOUNT_ID) {
    return [{ status: 'manual', detail: 'NR_USER_KEY and NR_ACCOUNT_ID are not both in .env, so New Relic was skipped' }];
  }
  const results = [];
  const domain = (env.NR_API_URL ?? '').includes('.eu.') ? 'api.eu.newrelic.com' : 'api.newrelic.com';
  const nerdgraph = nerdGraphClient({ userKey: env.NR_USER_KEY, url: env.NR_API_URL ?? 'https://api.newrelic.com/graphql' });

  // 1. LaunchDarkly -> New Relic: flag changes as change tracking events on the APM entity.
  let guids = {};
  try {
    guids = await resolveEntityGuids({ env: { ...env } });
  } catch (err) {
    results.push(['New Relic entities', { status: 'manual', detail: `could not look them up (${err.message})` }]);
  }
  const api = createApi({ token });
  for (const r of await stepNewRelicIntegration({ api, project }, {
    userKey: env.NR_USER_KEY,
    appIds: { apm: guids.apm && appIdFromGuid(guids.apm), browser: guids.browser && appIdFromGuid(guids.browser) },
    domain,
    appName: env.NR_APM_APP_NAME ?? 'Canine Good Citizen',
  })) results.push(['LaunchDarkly -> New Relic', r]);

  // 2. New Relic -> LaunchDarkly: the rage-click alert, and the automated kill switch behind it.
  const alert = await stepRageClickAlert(nerdgraph, { accountId: env.NR_ACCOUNT_ID, appName: env.NR_APM_APP_NAME ?? 'Canine Good Citizen' });
  results.push(['rage-click alert', alert]);
  const triggerUrl = spawnSync('terraform', ['-chdir=terraform', 'output', '-raw', 'new_relic_trigger_url'], { encoding: 'utf8' }).stdout.trim();
  if (!alert.policyId) {
    results.push(['automated kill switch', { status: 'manual', detail: 'skipped, because the alert is not set up' }]);
  } else if (!triggerUrl.startsWith('https://')) {
    results.push(['automated kill switch', { status: 'manual', detail: 'no New Relic trigger URL in the Terraform state: run npm run setup first' }]);
  } else {
    results.push(['automated kill switch', await stepAutoRemediation(nerdgraph, { accountId: env.NR_ACCOUNT_ID, policyId: alert.policyId, triggerUrl, enabled })]);
  }
  return results;
}
