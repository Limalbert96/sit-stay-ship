// Plays out a whole bad-release incident, so the story is visible on a New Relic chart instead of
// having to be told: the feature is released, real customers hit the broken card and rage-click it,
// the kill switch turns the flag off, and traffic carries on cleanly afterwards.
//
//   npm run incident                          the default run (about 8 minutes)
//   npm run incident -- --users 20            more customers in the incident
//   npm run incident -- --calm 30 --detect 60 a shorter run, for a rehearsal
//   npm run incident -- --dry-run             prints the plan and changes nothing
//   npm run incident -- --auto-remediation    nobody presses the kill switch: New Relic's alert
//                                             does it (the workflow is switched on for this run
//                                             only, and back off afterwards, even on Ctrl-C)
//
// The customers are real browser sessions: each one is a separate headless Chrome with its own
// profile, so New Relic sees a distinct session and a distinct user, and the clicks are real mouse
// events, so they register as rage clicks. Nothing is faked into New Relic; the telemetry comes
// from the app's own browser agent, exactly as it would from a person.
//
// The visitors are SYNTHETIC: made-up premium-tier customers named shopper-NN, marked
// `synthetic: true` in their LaunchDarkly context. They are premium so the tier rule serves them
// the feature (that is how they meet the bug) and so they stay out of the trial-users experiment.
//
// Needs: the app running (`npm run dev`), LD_API_TOKEN and LD_TRIGGER_URL in .env, and Chrome.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RAGE_CLICK_SIGNAL, autoRemediationEnabled, nerdGraphClient, setAutoRemediation } from './newrelic-lib.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:5173' },
    api: { type: 'string', default: 'http://localhost:3001' },
    users: { type: 'string', default: '12' },      // customers who meet the bad release
    healthy: { type: 'string', default: '4' },     // customers before it, so the chart has a baseline
    recovery: { type: 'string', default: '4' },    // customers after the kill switch, to show it worked
    calm: { type: 'string', default: '90' },       // seconds between the release and the first error
    spread: { type: 'string', default: '60' },     // seconds the incident's sessions are spread over
    detect: { type: 'string', default: '150' },    // seconds the errors run before the kill switch
    concurrency: { type: 'string', default: '3' },
    linger: { type: 'string', default: '25' },     // seconds a session stays open, so telemetry is sent
    'dry-run': { type: 'boolean', default: false },
    'auto-remediation': { type: 'boolean', default: false },
    'remediate-timeout': { type: 'string', default: '600' }, // seconds to wait for New Relic to act
  },
});

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const num = (name) => Number(args[name]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => new Date().toLocaleTimeString();
const say = (message) => console.log(`[${clock()}] ${message}`);

// --- one browser session -----------------------------------------------------------------------

// Drives one headless Chrome through the Chrome DevTools Protocol. A fresh profile each time is
// what makes New Relic count a separate session.
let nextPort = 9400;
async function visit({ visitor, chaos, rageClicks, linger }) {
  const port = nextPort++; // sequential, so two sessions at once cannot land on the same port
  const profile = mkdtempSync(join(tmpdir(), 'cgc-incident-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  // Chrome keeps writing to its profile for a moment after being killed, so wait for it to exit
  // before deleting it, and never let tidying up fail the visit: a leftover temp folder is harmless.
  const cleanUp = async () => {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, wait(3000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch { /* it is in the system temp folder; the OS clears it */ }
  };

  try {
    // The debugging port takes a moment to open.
    for (let i = 0; i < 60; i++) {
      try {
        await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch { await wait(250); }
    }

    const pageUrl = `${args.url}/?visitor=${encodeURIComponent(visitor)}${chaos ? '&chaos=1' : ''}`;
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evaluate = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

    await wait(4000); // the app boots, LaunchDarkly evaluates, the browser agent starts

    let clicked = 0;
    for (let i = 0; i < rageClicks; i++) {
      // Where is the "Try again" button on the broken card? It only exists while the card is broken.
      const box = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Try again');
        if (!button) return null;
        const r = button.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) break;
      // Real mouse events, so New Relic sees clicks a person could have made. Repeated fast on the
      // same button, they are what a frustrated customer does, and what rage-click detection looks for.
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      clicked += 1;
      await wait(90 + Math.floor(Math.random() * 60)); // fast enough to read as rage, not as patience
    }

    await wait(linger); // the browser agent batches; give it time to send before the tab closes
    await send('Page.navigate', { url: 'about:blank' }); // unload, so it flushes what it still holds
    await wait(2000);
    return { visitor, clicked, sawBrokenCard: clicked > 0 };
  } finally {
    await cleanUp();
  }
}

// Runs the visits a few at a time, spread over `spreadMs` so they do not all land on one second.
async function crowd({ visitors, chaos, rageClicks, linger, spreadMs }) {
  const queue = [...visitors];
  const done = [];
  const workers = Math.min(num('concurrency'), visitors.length);
  const rounds = Math.ceil(queue.length / workers);
  const gap = rounds > 1 ? spreadMs / rounds : 0; // each worker waits between its own visits

  const worker = async () => {
    while (queue.length) {
      const visitor = queue.shift();
      const result = await visit({ visitor, chaos, rageClicks, linger }).catch((err) => ({ visitor, error: err.message }));
      done.push(result);
      say(result.error
        ? `  ${result.visitor}: could not run (${result.error})`
        : `  ${result.visitor}: ${chaos ? `${result.clicked} rage clicks on the broken card` : 'browsed happily'}`);
      if (gap) await wait(gap);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return done;
}

// --- the LaunchDarkly side ----------------------------------------------------------------------

async function turnFlagOn() {
  const project = process.env.LD_PROJECT_KEY ?? 'default';
  const environment = process.env.LD_ENV_KEY ?? 'test';
  const res = await fetch(`https://app.launchdarkly.com/api/v2/flags/${project}/premium-video-tutorials`, {
    method: 'PATCH',
    headers: {
      Authorization: process.env.LD_API_TOKEN,
      'Content-Type': 'application/json; domain-model=launchdarkly.semanticpatch',
    },
    body: JSON.stringify({
      environmentKey: environment,
      instructions: [{ kind: 'turnFlagOn' }],
      comment: 'Releasing the premium videos (incident simulation)',
    }),
  });
  if (!res.ok) throw new Error(`LaunchDarkly refused to turn the flag on (status ${res.status})`);
}

// Through the backend, not straight to the trigger URL: that is what the page's button does, and it
// is what lets the backend label the New Relic marker as the kill switch rather than an edit.
async function fireKillSwitch() {
  const res = await fetch(`${args.api}/api/kill-switch`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.fired) throw new Error(`the kill switch did not fire (status ${res.status})`);
}

// --- the incident -------------------------------------------------------------------------------

const names = (prefix, count, from = 1) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i + from).padStart(2, '0')}`);

const plan = `Incident simulation
  app                 ${args.url}   (backend ${args.api})
  1. release          turn premium-video-tutorials ON
  2. calm             ${num('healthy')} customers browse normally, then wait ${args.calm}s
  3. bad release      ${num('users')} customers meet the broken card and rage-click it, over ${args.spread}s
  4. it burns         ${args['auto-remediation'] ? 'until New Relic notices' : `${args.detect}s with the feature still on, so an alert has time to notice`}
  5. remediate        ${args['auto-remediation'] ? 'New Relic\'s alert fires the kill switch by itself (automated remediation, this run only)' : 'fire the kill switch: the flag goes off, no deploy'}
  6. recovery         ${num('recovery')} more customers, now seeing a working page
`;
console.log(plan);

if (args['dry-run']) {
  console.log('Dry run: nothing was changed.');
  process.exit(0);
}
if (!process.env.LD_API_TOKEN) {
  console.error('LD_API_TOKEN is not in .env, so the flag cannot be turned on. See the README.');
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`Chrome is not at ${CHROME}. Set CHROME=/path/to/chrome and run it again.`);
  process.exit(1);
}

// --- automated remediation (New Relic pulls the kill switch) -------------------------------------

const auto = args['auto-remediation'];
// The trigger New Relic's workflow calls has its own id (see terraform/outputs.tf); reading it from
// state, rather than hardcoding it, means a re-created trigger (new id, new URL) is picked up
// automatically.
const NR_TRIGGER_ID = auto
  ? spawnSync('terraform', ['-chdir=terraform', 'output', '-raw', 'new_relic_trigger_id'], { encoding: 'utf8' }).stdout.trim()
  : null;
const nerdgraph = auto && nerdGraphClient({ userKey: process.env.NR_USER_KEY, url: process.env.NR_API_URL ?? 'https://api.newrelic.com/graphql' });

async function flagIsOn() {
  const project = process.env.LD_PROJECT_KEY ?? 'default';
  const environment = process.env.LD_ENV_KEY ?? 'test';
  const res = await fetch(`https://app.launchdarkly.com/api/v2/flags/${project}/premium-video-tutorials?env=${environment}`, {
    headers: { Authorization: process.env.LD_API_TOKEN },
  });
  return (await res.json()).environments?.[environment]?.on;
}

// The flag going off does not by itself say WHO turned it off: the page's kill-switch button and
// New Relic's workflow are two separate triggers, and nothing stops a person from pressing the
// button while this is waiting for New Relic (tested: it happened, and "the flag went off" alone
// would have wrongly reported it as the automated path). Checking the New Relic trigger's own
// _lastTriggeredAt is how the script knows which one actually fired.
async function newRelicTriggerFiredAfter(since) {
  const project = process.env.LD_PROJECT_KEY ?? 'default';
  const environment = process.env.LD_ENV_KEY ?? 'test';
  const res = await fetch(`https://app.launchdarkly.com/api/v2/flags/${project}/premium-video-tutorials/triggers/${environment}`, {
    headers: { Authorization: process.env.LD_API_TOKEN },
  });
  const { items = [] } = await res.json();
  const ours = items.find((trigger) => trigger._id === NR_TRIGGER_ID);
  return ours && ours._lastTriggeredAt > since ? ours._lastTriggeredAt : null;
}

// Is a rage-click issue that started during this run still open?
async function openIssueSince(since) {
  const data = await nerdgraph(`query($acc: Int!, $from: EpochMilliseconds!, $to: EpochMilliseconds!) { actor { account(id: $acc) {
    aiIssues { issues(timeWindow: { startTime: $from, endTime: $to }) { issues { state conditionName activatedAt } } } } } }`,
  { acc: Number(process.env.NR_ACCOUNT_ID), from: since, to: Date.now() });
  const ours = data.actor.account.aiIssues.issues.issues.filter((i) => i.conditionName?.includes('Rage Click') && i.activatedAt >= since);
  return ours.some((i) => i.state !== 'CLOSED');
}

// Polls every 10 seconds; returns the time it became true, or null on timeout.
async function waitFor(check, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return Date.now();
    await wait(10_000);
  }
  return null;
}

let restoreAutoRemediation = null;
if (auto) {
  if (!process.env.NR_USER_KEY || !process.env.NR_ACCOUNT_ID) {
    console.error('--auto-remediation needs NR_USER_KEY and NR_ACCOUNT_ID in .env (and npm run newrelic run once).');
    process.exit(1);
  }
  if (!NR_TRIGGER_ID) {
    console.error('Could not read new_relic_trigger_id from Terraform output. Run npm run setup (or terraform apply) first.');
    process.exit(1);
  }
  const before = await autoRemediationEnabled(nerdgraph, { accountId: process.env.NR_ACCOUNT_ID });
  if (before === null) {
    console.error('There is no automated kill switch in New Relic yet: run npm run newrelic first.');
    process.exit(1);
  }
  await setAutoRemediation(nerdgraph, { accountId: process.env.NR_ACCOUNT_ID, enabled: true });
  say(`Automated kill switch ON for this run (it was ${before ? 'on' : 'off'}; it goes back afterwards). Alert signal: ${RAGE_CLICK_SIGNAL.aggregationMethod}, empty windows = ${RAGE_CLICK_SIGNAL.fillValue}.`);
  restoreAutoRemediation = async () => {
    restoreAutoRemediation = null;
    await setAutoRemediation(nerdgraph, { accountId: process.env.NR_ACCOUNT_ID, enabled: before });
    say(`Automated kill switch back ${before ? 'on' : 'off'}.`);
  };
  // Put it back even if the run is stopped halfway, so the demo's manual kill switch is never beaten to it.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await restoreAutoRemediation?.().catch((err) => console.error(`Could not switch it back: ${err.message}. Run npm run newrelic -- --auto-remediation off`));
      process.exit(130);
    });
  }
}

const started = Date.now();
let incidentAt = started;
try {

say('1. Releasing the feature: premium-video-tutorials ON');
await turnFlagOn();

say(`2. ${num('healthy')} customers browse the working page (this is the "before" the chart compares against)`);
await crowd({ visitors: names('shopper', num('healthy')), chaos: false, rageClicks: 0, linger: 6000, spreadMs: 8000 });

say(`   Quiet for ${args.calm}s, so the release and the errors are not the same moment on the chart`);
await wait(num('calm') * 1000);

say(`3. The bad release reaches ${num('users')} customers, who start rage-clicking`);
incidentAt = Date.now();
const hit = await crowd({
  visitors: names('shopper', num('users'), num('healthy') + 1),
  chaos: true,
  rageClicks: 6,
  linger: num('linger') * 1000,
  spreadMs: num('spread') * 1000,
});
const clicks = hit.reduce((total, r) => total + (r.clicked ?? 0), 0);
say(`   ${hit.filter((r) => r.sawBrokenCard).length} customers hit the broken card, ${clicks} rage clicks between them`);
if (!clicks) say('   No clicks landed: is the flag on, and is the app running at the URL above?');

if (!auto) {
  say(`4. Leaving it broken for ${args.detect}s, the way a real incident waits to be noticed`);
  await wait(num('detect') * 1000);
}

if (auto) {
  say('5. Waiting for New Relic: the alert opens an issue, the workflow fires the trigger');
  // incidentAt (when rage-clicking started), not Date.now() here: the alert fires in roughly 20s
  // now, often faster than step 3's clicks finish dispatching, so a baseline taken only at the
  // start of this wait can be LATER than a trigger that already fired legitimately during step 3.
  // Confirmed: a real, correctly-labelled New Relic firing was missed and reported as a timeout
  // because of exactly this.
  let firedAt = null;
  const offAt = await waitFor(async () => {
    firedAt = await newRelicTriggerFiredAfter(incidentAt);
    return firedAt !== null;
  }, num('remediate-timeout') * 1000);
  if (!offAt) {
    // The flag may still have gone off some other way (for example someone pressed the page's
    // button); say so plainly rather than silently crediting New Relic for a change it did not make.
    const otherwise = (await flagIsOn()) === false ? ' (the flag IS off, but not via the New Relic trigger: did someone press the kill switch manually?)' : '';
    throw new Error(`New Relic's trigger did not fire within ${args['remediate-timeout']}s${otherwise}`);
  }
  say(`   New Relic's trigger fired ${Math.round((firedAt - incidentAt) / 1000)}s after the bad release reached customers. Nobody pressed anything.`);
} else {
  say('5. Firing the kill switch');
  await fireKillSwitch();
}
await wait(5000); // the flag change reaches New Relic as a change event

say(`6. ${num('recovery')} more customers arrive, and the page works again`);
await crowd({
  visitors: names('shopper', num('recovery'), num('healthy') + num('users') + 1),
  chaos: true, // they ask for the bad release, but the flag is off, so there is nothing to break
  rageClicks: 2,
  linger: 6000,
  spreadMs: 10000,
});

if (auto) {
  // The fill on the alert's signal (newrelic-lib.mjs) is what lets this happen: with no rage
  // clicks after the fix, empty windows count as 0 and the issue recovers on its own.
  say('7. Waiting for New Relic to close the issue now that the rage clicks have stopped');
  const closedAt = await waitFor(async () => (await openIssueSince(started)) === false, 15 * 60 * 1000);
  say(closedAt
    ? `   The issue closed by itself ${Math.round((closedAt - started) / 60000)} minutes into the run.`
    : '   The issue is still open after 15 minutes: check the alert condition\'s fill option (npm run newrelic fixes it).');
}

const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(`
Done in ${minutes} minutes. The flag is OFF, the way the ${auto ? 'automated' : ''} kill switch left it.

In New Relic, open the Browser entity (Canine Good Citizen) and set the time range to the last 30
minutes. The JavaScript error chart should show the quiet start, the spike while customers were
rage-clicking, the flag-change markers (switch on "Related Changes" on Browser charts), and clean
traffic after them. Errors can take a minute or two to appear.`);
} finally {
  await restoreAutoRemediation?.();
}
