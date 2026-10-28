// `npm run check:newrelic`: tries out both halves of the New Relic wiring through the APIs, with no
// Terraform and no browser. Nothing is faked: LaunchDarkly really turns a flag off, and New Relic
// really receives the change events.
//
//   npm run check:newrelic                 the whole check (about 1-4 minutes)
//   npm run check:newrelic -- --scratch    use a throwaway LaunchDarkly project, never the demo one
//   npm run check:newrelic -- --real       fire the trigger URL the New Relic destination already holds,
//                                          instead of a throwaway trigger (tests the live wiring)
//   npm run check:newrelic -- --keep       leave what it made in place (to look at in the UIs); remove it
//                                          later with npm run check:newrelic:cleanup
//   npm run check:newrelic -- --timeout 300 seconds to wait for the change events to reach New Relic
//
// Two modes. When the demo project (cgc-demo) and its premium-video-tutorials flag exist, it checks
// those: the real subscriptions, and the real New Relic alert, workflow and destination. When they do
// not (nothing set up yet, or torn down), or with --scratch, it builds its own: a scratch project with
// one flag, and two temporary subscriptions aimed at your real APM and Browser applications. It deletes
// all of that afterwards. The only lasting trace is a few change events on those two applications.
//
// What it checks:
//   1. LaunchDarkly -> New Relic: a flag change shows up as a ChangeTrackingEvent on BOTH the APM and the
//      Browser application, on the entity.guid each subscription targets.
//   2. New Relic -> LaunchDarkly: a new-relic-v2 trigger, fired with the body New Relic's workflow sends,
//      turns the flag off and is recorded as that trigger. In demo mode it also checks that the alert,
//      workflow, channel and destination exist, with the destination pointing at a live trigger.
//
// It turns the flag on, fires the trigger (which turns it off), and in demo mode puts the flag back the way
// it found it. The full alert path (rage clicks -> issue -> workflow) is `npm run incident --
// --auto-remediation`; this is the quick check that the two integrations themselves work.
//
// Needs in .env: LD_API_TOKEN, NR_USER_KEY, NR_ACCOUNT_ID (and NR_APM_APP_NAME if it is not the default).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ALERT_CONDITION_NAME, CHANNEL_NAME, CHECK_PROJECT_PREFIX, DESTINATION_NAME, NEW_RELIC_INTEGRATION, WORKFLOW_NAME, changeEventsQuery,
  checkSubscriptionLabel, entitySearchQuery, findCondition, guidsFromSearch, lookUp, nerdGraphClient, stepNewRelicIntegration, subscriptionName,
  triggerIdFromUrl,
} from './newrelic-lib.mjs';
import { createApi, ok } from './setup-lib.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    scratch: { type: 'boolean', default: false },
    real: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '240' },
  },
});

const env = process.env;
const envKey = env.LD_ENV_KEY ?? 'test';
const FLAG = 'premium-video-tutorials';
const appName = env.NR_APM_APP_NAME ?? 'Canine Good Citizen';
const accountId = Number(env.NR_ACCOUNT_ID);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, passed, detail = '') => {
  results.push(passed);
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`);
  return passed;
};
const note = (name, detail) => console.log(`  [info] ${name}: ${detail}`);

// Polls until fn() returns something truthy; returns it, or null on timeout.
async function waitFor(fn, timeoutMs, everyMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() >= until) return null;
    await wait(everyMs);
  }
}

if (!env.LD_API_TOKEN || !env.NR_USER_KEY || !accountId) {
  console.error('Put LD_API_TOKEN, NR_USER_KEY and NR_ACCOUNT_ID in .env first.');
  process.exit(1);
}
if (args.scratch && args.real) {
  console.error('--real fires the demo project\'s own destination, so it cannot be combined with --scratch.');
  process.exit(1);
}

const api = createApi({ token: env.LD_API_TOKEN });
const nerdgraph = nerdGraphClient({ userKey: env.NR_USER_KEY, url: env.NR_API_URL ?? 'https://api.newrelic.com/graphql' });
const nrql = async (query) =>
  (await nerdgraph('query($acc: Int!, $q: Nrql!) { actor { account(id: $acc) { nrql(query: $q) { results } } } }', { acc: accountId, q: query }))
    .actor.account.nrql.results;

// ---- Before anything changes: is the integration there, and where do the applications live? -------

console.log('Preflight');
const integration = await api('GET', `/integrations/${NEW_RELIC_INTEGRATION}`);
if (!check(`${NEW_RELIC_INTEGRATION} integration is available in LaunchDarkly`, integration.status !== 404, integration.status === 404 ? 'LaunchDarkly answered 404' : '')) process.exit(1);

const guids = guidsFromSearch(await nerdgraph(entitySearchQuery({ name: appName, accountId })));
if (!check(`New Relic APM and Browser applications "${appName}" found`, Boolean(guids.apm && guids.browser), guids.apm && guids.browser ? '' : 'start the app (npm run dev) so both agents report in')) process.exit(1);

// Which project to test against.
let project = env.LD_PROJECT_KEY ?? 'cgc-demo';
let scratch = args.scratch;
if (!scratch) {
  const [p, f] = await Promise.all([api('GET', `/projects/${project}`), api('GET', `/flags/${project}/${FLAG}`)]);
  if (p.status === 404 || f.status === 404) {
    scratch = true;
    note('demo project', `${p.status === 404 ? `project ${project}` : `flag ${FLAG}`} does not exist, so using a scratch project`);
  }
}
if (scratch) project = `${CHECK_PROJECT_PREFIX}${randomBytes(3).toString('hex')}`;
const flagPath = `/flags/${project}/${FLAG}`;
const flagIsOn = async () => (await api('GET', `${flagPath}?env=${envKey}`)).data.environments?.[envKey]?.on;
const setFlag = (on) => api('PATCH', flagPath, {
  environmentKey: envKey,
  instructions: [{ kind: on ? 'turnFlagOn' : 'turnFlagOff' }],
  comment: 'npm run check:newrelic',
});

console.log(`\nChecking ${scratch ? 'scratch project' : 'project'} ${project} / ${envKey} / ${FLAG}`);

// Undo steps, run in reverse order whatever happens.
const cleanups = [];
let triggerId;
let wasOn;
let destinationUrl;
const subscriptionLabel = checkSubscriptionLabel(appName, project);

try {
  // ---- LaunchDarkly -> New Relic: the subscriptions -----------------------------------------------
  console.log('\nLaunchDarkly -> New Relic (flag changes as change tracking events)');
  if (scratch) {
    const created = await api('POST', '/projects', {
      key: project, name: `New Relic check (${project})`,
      environments: [{ key: envKey, name: 'Test', color: '3DD68C' }],
    });
    if (!check('scratch project created', ok(created.status), ok(created.status) ? '' : `LaunchDarkly answered ${created.status}: ${created.data.message ?? 'no message'}`)) throw new Error('cannot go on without a project');
    cleanups.push(async () => {
      const res = await api('DELETE', `/projects/${project}`);
      console.log(`  ${ok(res.status) ? 'deleted' : `COULD NOT DELETE (status ${res.status}): remove it by hand,`} scratch project ${project}`);
    });

    const flag = await waitFor(async () => {
      const res = await api('POST', `/flags/${project}`, {
        key: FLAG, name: 'Premium Video Tutorials (check)', temporary: true,
        variations: [{ value: true }, { value: false }], defaults: { onVariation: 0, offVariation: 1 },
      });
      return ok(res.status) ? res : null;
    }, 30_000, 2000);
    if (!check('scratch flag created', Boolean(flag))) throw new Error('cannot go on without a flag');

    // Subscriptions come after the flag, so the flag's own creation is not sent to New Relic.
    const domain = (env.NR_API_URL ?? '').includes('.eu.') ? 'api.eu.newrelic.com' : 'api.newrelic.com';
    for (const r of await stepNewRelicIntegration({ api, project }, { userKey: env.NR_USER_KEY, guids, domain, appName: subscriptionLabel })) {
      check('temporary subscription', r.status === 'created', r.detail);
    }
    cleanups.push(async () => {
      const list = await api('GET', `/integrations/${NEW_RELIC_INTEGRATION}`);
      for (const kind of ['apm', 'browser']) {
        const sub = (list.data.items ?? []).find((s) => s.name === subscriptionName(kind, subscriptionLabel));
        if (!sub) continue;
        const res = await api('DELETE', `/integrations/${NEW_RELIC_INTEGRATION}/${sub._id}`);
        console.log(`  ${ok(res.status) ? 'deleted' : `COULD NOT DELETE (status ${res.status}): remove it by hand,`} subscription "${sub.name}"`);
      }
    });
  } else {
    for (const [kind, label] of [['apm', 'APM'], ['browser', 'Browser']]) {
      const sub = (integration.data.items ?? []).find((s) => s.name === subscriptionName(kind, appName));
      check(`subscription "${subscriptionName(kind, appName)}" is on`, Boolean(sub?.on), sub ? '' : 'missing: run npm run newrelic');
      if (sub) check(`  ...and aims at the ${label} entity.guid`, sub.config?.entityGuid === guids[kind], sub.config?.entityGuid === guids[kind] ? '' : 'stale: run npm run newrelic');
    }
  }

  // ---- New Relic -> LaunchDarkly: the objects that should already exist ------------------------------
  console.log('\nNew Relic -> LaunchDarkly (the alert, and the workflow that fires the trigger)');
  const { destination, channel, workflow } = await lookUp(nerdgraph, accountId);
  const condition = await findCondition(nerdgraph, accountId);
  // Scratch mode has no demo project for these to point at, so they are reported, not judged.
  const expect = scratch ? (name, passed, _detail) => note(name, passed ? 'present' : 'not set up (npm run newrelic sets it up with the demo)') : check;
  expect(`alert "${ALERT_CONDITION_NAME}"`, Boolean(condition), condition ? '' : 'run npm run newrelic');
  expect(`destination "${DESTINATION_NAME}"`, Boolean(destination));
  expect(`channel "${CHANNEL_NAME}"`, Boolean(channel));
  expect(`workflow "${WORKFLOW_NAME}"`, Boolean(workflow), workflow ? (workflow.workflowEnabled ? 'ON' : 'off, which is the demo default') : 'run npm run newrelic');
  destinationUrl = destination?.properties?.find((p) => p.key === 'url')?.value;
  if (!scratch && destination) {
    const live = ((await api('GET', `${flagPath}/triggers/${envKey}`)).data.items ?? []).find((t) => t._id === triggerIdFromUrl(destinationUrl));
    check('destination points at a trigger that still exists', Boolean(live),
      live ? `${live._integrationKey}, ${live.enabled ? 'enabled' : 'DISABLED'}` : 'stale URL: the trigger was re-created, run npm run newrelic');
  }

  // ---- Fire a trigger and watch both sides react -----------------------------------------------------
  console.log(`\nFiring ${args.real ? 'the trigger the New Relic destination points at' : 'a throwaway new-relic-v2 trigger'}`);
  wasOn = await flagIsOn();
  if (!scratch) {
    cleanups.push(async () => {
      if (wasOn === true && (await flagIsOn()) === false) {
        await setFlag(true);
        console.log('  flag put back ON (it was on before)');
      } else {
        console.log(`  flag left ${wasOn ? 'ON' : 'OFF'} (it was ${wasOn ? 'on' : 'off'} before)`);
      }
    });
  }
  if (!wasOn) await setFlag(true);
  // Let LaunchDarkly settle on "on" before the clock starts, so the change we look for is the trigger's.
  await waitFor(flagIsOn, 20_000, 1000);
  const t0 = Date.now() - 5_000; // a little slack for clock drift between here and New Relic

  let url = destinationUrl;
  if (!args.real) {
    const res = await api('POST', `${flagPath}/triggers/${envKey}`, { integrationKey: NEW_RELIC_INTEGRATION, instructions: [{ kind: 'turnFlagOff' }] });
    if (!check('throwaway trigger created', ok(res.status) && Boolean(res.data.triggerURL), ok(res.status) ? '' : `LaunchDarkly answered ${res.status}: ${res.data.message ?? 'no message'}`)) throw new Error('cannot go on without a trigger');
    url = res.data.triggerURL;
    // In scratch mode the project's deletion takes the trigger with it.
    if (!scratch && !args.keep) {
      cleanups.push(async () => {
        const del = await api('DELETE', `${flagPath}/triggers/${envKey}/${res.data._id}`);
        console.log(`  ${ok(del.status) ? 'deleted' : `COULD NOT DELETE (status ${del.status}): remove ${res.data._id} by hand,`} the throwaway trigger`);
      });
    }
  } else if (!url) {
    check('the destination has a URL to fire', false, 'run npm run newrelic');
    throw new Error('cannot go on without a trigger');
  }
  triggerId = triggerIdFromUrl(url);

  // The body New Relic's workflow sends (WEBHOOK_PAYLOAD in newrelic-lib.mjs), with the placeholders filled in.
  const eventName = `Test script (npm run check:newrelic) at ${new Date().toISOString()}`;
  const fired = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ incident_url: 'https://one.newrelic.com/', condition_name: ALERT_CONDITION_NAME, eventName }),
  });
  check('trigger accepted the request', fired.ok, `status ${fired.status}`);

  check('flag went OFF', Boolean(await waitFor(async () => (await flagIsOn()) === false, 30_000, 2000)));

  const after = await waitFor(async () => {
    const t = ((await api('GET', `${flagPath}/triggers/${envKey}`)).data.items ?? []).find((x) => x._id === triggerId);
    return t?._lastTriggeredAt >= t0 ? t : null;
  }, 30_000, 2000);
  check('LaunchDarkly recorded that trigger as fired', Boolean(after), after ? `integration ${after._integrationKey}` : `no _lastTriggeredAt on ${triggerId}`);

  // The flag history carries the request's eventName; that entry's id is also in the link on the New Relic
  // event, which is how we tell the trigger's change from the "turn on" above. Soft, because the exact
  // wording of the entry is LaunchDarkly's.
  const spec = encodeURIComponent(`proj/${project}:env/${envKey}:flag/${FLAG}`);
  const audit = await waitFor(async () => {
    const entries = (await api('GET', `/auditlog?after=${t0}&spec=${spec}&limit=20`)).data.items ?? [];
    return entries.find((e) => JSON.stringify(e).includes(eventName));
  }, 30_000, 3000);
  if (audit) note('flag history', `"${(audit.title ?? audit.name ?? '').replace(/<[^>]+>/g, '')}"`);
  else note('flag history', 'did not find the eventName in the audit log (look at the flag history by hand)');

  // ---- The other half: did New Relic hear about it? ------------------------------------------------------
  console.log(`\nWaiting up to ${args.timeout}s for the change events to reach New Relic`);
  let seen = [];
  const forTrigger = (e) => !audit?._id || e.launchdarklyAuditLogUrl?.includes(audit._id);
  await waitFor(async () => {
    seen = (await nrql(changeEventsQuery({ project, flag: FLAG, envKey, sinceMs: t0 }))).filter(forTrigger);
    return ['APM', 'BROWSER'].every((d) => seen.some((e) => e['entity.domain'] === d));
  }, Number(args.timeout) * 1000, 10_000);
  for (const [kind, domain, label] of [['apm', 'APM', 'APM'], ['browser', 'BROWSER', 'Browser']]) {
    const hit = seen.find((e) => e['entity.domain'] === domain);
    check(`${label} application got a ChangeTrackingEvent`, Boolean(hit), hit ? hit.description?.replace(/\n/g, ' / ') : 'none yet: raise --timeout, or check the subscription');
    if (hit) check(`  ...on the ${label} entity.guid the subscription targets`, hit['entity.guid'] === guids[kind]);
  }
} catch (err) {
  console.error(`\n  stopped: ${err.message}`);
  results.push(false);
} finally {
  console.log('\nCleaning up');
  if (args.keep) {
    console.log(`  --keep: left everything in place${scratch ? ` (scratch project ${project} and its two "${subscriptionLabel}" subscriptions: run npm run check:newrelic:cleanup -- ${project})` : ''}`);
  } else {
    for (const undo of cleanups.reverse()) await undo().catch((err) => console.log(`  cleanup step failed: ${err.message}`));
  }
}

const failures = results.filter((passed) => !passed).length;
console.log(`\n${failures ? `${failures} of ${results.length} checks FAILED.` : `All ${results.length} checks passed.`}`);
process.exit(failures ? 1 : 0);
