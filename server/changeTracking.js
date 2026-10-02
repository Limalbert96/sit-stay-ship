// Marks LaunchDarkly flag changes on New Relic entities, from the chat backend (optional, OFF by
// default).
//
// The preferred way to get flag changes into New Relic is LaunchDarkly's own New Relic integration
// (`new-relic-apm-v2`), which `npm run setup` creates when NR_USER_KEY is set: LaunchDarkly writes a
// FEATURE_FLAG change tracking event for every flag change, on both the APM and the Browser entity,
// without this app having to run. See the README.
//
// This module is the older, app-side way, kept as a fallback for accounts without that
// integration. The chat backend holds a LaunchDarkly server SDK connection, which emits an event
// whenever a flag is edited, and posts the change to New Relic's NerdGraph API itself. Running both
// would mark every change twice, so this only runs when asked for:
//
//   NR_BACKEND_CHANGE_TRACKING=true   switch this on
//   NR_USER_KEY                       a New Relic USER key (starts with NRAK-). Not the license or
//                                     browser key: those can only send telemetry.
//   NR_ACCOUNT_ID                     the same account id the agents already use.
// Optional:
//   NR_APM_ENTITY_GUID, NR_BROWSER_ENTITY_GUID   skip the lookup and use these exact entities.
//   NR_API_URL       for EU accounts: https://api.eu.newrelic.com/graphql
const DEFAULT_URL = 'https://api.newrelic.com/graphql';
const LD_API = 'https://app.launchdarkly.com/api/v2';
const LOOKUP_TIMEOUT_MS = 5_000;
// Only a trigger fired in roughly the last few seconds explains the change; an older firing is
// some earlier, unrelated event and must not be quoted as if it just happened.
const TRIGGER_FRESHNESS_MS = 15_000;

const nerdGraphUrl = () => process.env.NR_API_URL ?? DEFAULT_URL;

// Off unless asked for (the LaunchDarkly integration does this job), and it needs a user key: the
// agents' license keys cannot call NerdGraph.
export function changeTrackingEnabled(env = process.env) {
  return env.NR_BACKEND_CHANGE_TRACKING === 'true'
    && Boolean(env.NR_USER_KEY && (env.NR_ACCOUNT_ID || (env.NR_APM_ENTITY_GUID && env.NR_BROWSER_ENTITY_GUID)));
}

// LaunchDarkly's own "Generic trigger made changes to the flag ..." text is identical for every
// generic-trigger flag trigger: the trigger object has no name or description field to tell two
// of them apart, so that sentence alone cannot say which trigger fired. The caller CAN give a
// trigger an eventName on each POST, though (see server/index.js, scripts/simulate-incident.mjs),
// and LaunchDarkly echoes the most recent one back on the flag's /triggers endpoint. Reading that
// back is the only way to put an unambiguous "which trigger" into a New Relic marker.
export async function latestTriggerEventName({ flagKey, project, environment, token, fetchImpl = fetch }) {
  if (!token) return null;
  try {
    const res = await fetchImpl(`${LD_API}/flags/${project}/${flagKey}/triggers/${environment}`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { items = [] } = await res.json();
    const latest = items
      .filter((trigger) => Date.now() - trigger._lastTriggeredAt < TRIGGER_FRESHNESS_MS)
      .sort((a, b) => b._lastTriggeredAt - a._lastTriggeredAt)[0];
    return latest?._recentTriggerBodies?.[0]?.jsonBody?.eventName ?? null;
  } catch {
    return null; // a marker without the cause still beats no marker
  }
}

// Strips LaunchDarkly's markdown out of an audit-log title: [text](url) -> text, `code` -> code,
// and the backslash-escaped parentheses LaunchDarkly puts around "(via API)".
function plainText(markdown) {
  return markdown
    .replace(/\\([()])/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

// The general case `latestTriggerEventName` does not cover: a flag edited directly, in the
// LaunchDarkly UI or by a plain API call, with no trigger involved at all. LaunchDarkly's own audit
// log already has a clear one-line summary of this ("Albert Lim updated Premium Video Tutorials in
// 'Test'", or "... turned on the flag ... (via API)"); reading it back is what turns our own New
// Relic marker from a bare "turned ON" into something that says who did it and how.
export async function latestAuditTitle({ flagKey, token, fetchImpl = fetch }) {
  if (!token) return null;
  try {
    const res = await fetchImpl(`${LD_API}/auditlog?q=${encodeURIComponent(flagKey)}&limit=1`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const [latest] = (await res.json()).items ?? [];
    if (!latest || Date.now() - latest.date > TRIGGER_FRESHNESS_MS) return null;
    return latest.title ? plainText(latest.title) : null;
  } catch {
    return null; // a marker without the cause still beats no marker
  }
}

// Finds the APM and Browser entities by the name the agents report under. Both agents in this
// project use the same name, so one search returns both and `domain` tells them apart.
export function entitySearchQuery({ name, accountId }) {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, "domain IN ('APM', 'BROWSER')"];
  if (accountId) clauses.push(`accountId = ${Number(accountId)}`);
  return `{ actor { entitySearch(query: "${clauses.join(' AND ')}") { results { entities { guid name domain } } } } }`;
}

// customAttributes is a custom GraphQL scalar, and a scalar literal cannot contain variables, so
// these few values are written into the query text. Anything outside the character set LaunchDarkly
// allows in a key is dropped first, so no value can end the string early and change the query.
const safe = (value) => String(value ?? '').replace(/[^\w.-]/g, '');

// The change event itself. `state` is the flag's on/off switch after the change ("on", "off", or
// undefined if it could not be read), and `viaKillSwitch` marks the changes the demo's kill-switch
// trigger caused, so a marker on a New Relic chart reads as the story rather than "something
// changed": the errors start, the kill switch fires, the errors stop.
//
// Every value except the custom attributes goes through GraphQL variables rather than string
// interpolation, so a quote in a flag key or a description cannot break the query.
// customAttributes is a GraphQL custom scalar; NerdGraph only accepts it as an inline literal in
// the query text, not through a $variable (confirmed by testing), which is why its few values go
// through `safe()` below rather than the $variables object the rest of this mutation uses.
const flagChangeMutation = (customAttributes) => `mutation($query: String!, $flagKey: String!, $user: String!, $shortDescription: String!, $description: String!) {
  changeTrackingCreateEvent(changeTrackingEvent: {
    categoryAndTypeData: {
      categoryFields: { featureFlag: { featureFlagId: $flagKey } }
      kind: { category: "FEATURE_FLAG", type: "BASIC" }
    }
    entitySearch: { query: $query }
    user: $user
    shortDescription: $shortDescription
    description: $description
    customAttributes: {
      flagKey: "${safe(customAttributes.flagKey)}"
      flagState: "${safe(customAttributes.flagState)}"
      trigger: "${safe(customAttributes.trigger)}"
      project: "${safe(customAttributes.project)}"
      environment: "${safe(customAttributes.environment)}"
      source: "sit-stay-ship"
    }
  }) {
    changeTrackingEvent { changeTrackingId }
  }
}`;

// `state` is the flag's on/off switch after the change ("on", "off", or undefined if it could not
// be read). `triggerEventName`, read back from the trigger that just fired (see
// latestTriggerEventName above), is the exact, unambiguous cause: it is what tells "the page's
// kill-switch button" apart from "New Relic fired this on its own" apart from any other trigger,
// because LaunchDarkly's own text ("Generic trigger made changes to the flag ...") is identical
// for every trigger of the same type and cannot say which one it was. `viaKillSwitch` is the
// fallback guess from timing alone, used only when no eventName could be read back.
export function flagChangeEvent({ guid, flagKey, state, viaKillSwitch = false, triggerEventName, auditTitle, project, environment }) {
  const label = state === 'on' ? 'turned ON' : state === 'off' ? 'turned OFF' : 'changed';
  const where = `project ${project}, environment ${environment}`;
  // Most to least specific: the trigger's own eventName (exact, when a trigger fired); failing
  // that, LaunchDarkly's own audit-log summary (covers a plain UI or API edit); failing that, the
  // old guess from timing alone, clearly marked as unconfirmed rather than stated as fact.
  const cause = triggerEventName ?? auditTitle ?? (viaKillSwitch ? 'the kill switch (cause unconfirmed: no recent trigger eventName found)' : null);
  const source = triggerEventName ? 'named-trigger' : auditTitle ? 'audit-log' : viaKillSwitch ? 'kill-switch-guessed' : 'manual';

  return {
    query: flagChangeMutation({
      flagKey,
      flagState: state ?? 'unknown',
      trigger: source,
      project,
      environment,
    }),
    variables: {
      // The mutation's own search has to resolve to exactly one entity, so it matches on the GUID.
      query: `id = '${guid}'`,
      flagKey,
      user: triggerEventName ? 'LaunchDarkly trigger' : auditTitle ? 'LaunchDarkly' : viaKillSwitch ? 'LaunchDarkly kill switch' : 'LaunchDarkly (sit-stay-ship)',
      shortDescription: cause ? `${flagKey} ${label}: ${cause}` : `${flagKey} ${label}`,
      description: cause
        ? `The flag "${flagKey}" was ${label} (${where}). Cause: ${cause}.`
        : `The LaunchDarkly flag "${flagKey}" was ${label} (${where}).`,
    },
  };
}

async function postNerdGraph(body, { fetchImpl = fetch, apiKey = process.env.NR_USER_KEY, timeoutMs } = {}) {
  const res = await fetchImpl(nerdGraphUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify(body),
    ...(timeoutMs && { signal: AbortSignal.timeout(timeoutMs) }),
  });
  const data = await res.json().catch(() => ({}));
  // NerdGraph answers 200 with an "errors" array, so the status alone does not say it worked.
  if (!res.ok) throw new Error(`New Relic returned status ${res.status}`);
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; '));
  return data.data;
}

// Picks the APM and Browser GUIDs out of a search result.
export function guidsFromSearch(data) {
  const entities = data?.actor?.entitySearch?.results?.entities ?? [];
  const find = (domain) => entities.find((e) => e.domain === domain)?.guid;
  return { apm: find('APM'), browser: find('BROWSER') };
}

let cached = null;

export async function resolveEntityGuids({ fetchImpl = fetch, env = process.env } = {}) {
  if (cached) return cached;
  const fromEnv = { apm: env.NR_APM_ENTITY_GUID, browser: env.NR_BROWSER_ENTITY_GUID };
  if (fromEnv.apm && fromEnv.browser) {
    cached = fromEnv;
    return cached;
  }
  const name = env.NR_APM_APP_NAME ?? 'Canine Good Citizen';
  const data = await postNerdGraph(
    { query: entitySearchQuery({ name, accountId: env.NR_ACCOUNT_ID }) },
    { fetchImpl, apiKey: env.NR_USER_KEY, timeoutMs: LOOKUP_TIMEOUT_MS },
  );
  const found = guidsFromSearch(data);
  cached = { apm: fromEnv.apm ?? found.apm, browser: fromEnv.browser ?? found.browser };
  return cached;
}

// Posts one change event per entity. Returns which entities got a marker, so the caller can log it.
export async function recordFlagChange(flagKey, { state, viaKillSwitch = false, triggerEventName, auditTitle, fetchImpl = fetch, env = process.env } = {}) {
  const guids = await resolveEntityGuids({ fetchImpl, env });
  const targets = Object.entries(guids).filter(([, guid]) => guid);
  if (!targets.length) throw new Error('no APM or Browser entity found in New Relic for this app name');

  const results = await Promise.allSettled(
    targets.map(([, guid]) =>
      postNerdGraph(
        flagChangeEvent({
          guid,
          flagKey,
          state,
          viaKillSwitch,
          triggerEventName,
          auditTitle,
          project: env.LD_PROJECT_KEY ?? 'default',
          environment: env.LD_ENV_KEY ?? 'test',
        }),
        { fetchImpl, apiKey: env.NR_USER_KEY },
      ),
    ),
  );
  const marked = targets.filter((_, i) => results[i].status === 'fulfilled').map(([kind]) => kind);
  const failed = results.find((r) => r.status === 'rejected');
  if (!marked.length) throw failed.reason;
  return { marked, error: failed?.reason };
}

// Test hook: the GUID lookup is cached for the life of the process.
export const resetEntityCache = () => { cached = null; };
