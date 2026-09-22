// Generates SYNTHETIC visitors so the experiments have data to analyse. A trial
// account has no real traffic, so this is a simulation: every user has
// `synthetic: true`, and outcome odds come from the options below.
// The resulting numbers demonstrate the workflow, not real customer behaviour.
//
// Usage:
//   npm run simulate -- --target flag --users 2000 --base 0.10 --lift 0.04
//   npm run simulate -- --target ai   --users 500  --base 0.50 --lift 0.10
//
//   --target flag  Feature-flag experiment: users evaluate `premium-video-tutorials`;
//                  those who get it click "Start Training" with probability base + lift.
//   --target ai    AI Config experiment: users evaluate `canine-coach-chatbot`; the
//                  "detailed" variation gets thumbs-up with probability base + lift.
//   --users        simulated visitors (default 1000)
//   --base         outcome rate without the treatment (default 0.10 flag, 0.50 ai)
//   --lift         extra outcome rate with the treatment (default 0.04 flag, 0.10 ai)
//
// Uses LD_SDK_KEY from .env, so it feeds the experiments in that key's environment.
import { parseArgs } from 'node:util';
import * as ld from '@launchdarkly/node-server-sdk';
import { initAi, LDFeedbackKind } from '@launchdarkly/server-sdk-ai';
import { sdkKey as readSdkKey } from '../server/env.js';
import { DEMO_MODELS } from '../server/llm.js';

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'flag' },
    users: { type: 'string', default: '1000' },
    base: { type: 'string' },
    lift: { type: 'string' },
  },
});

if (!['flag', 'ai'].includes(values.target)) {
  console.error('--target must be "flag" or "ai"');
  process.exit(1);
}
const isAi = values.target === 'ai';
const users = Number(values.users);
const base = Number(values.base ?? (isAi ? 0.5 : 0.1));
const lift = Number(values.lift ?? (isAi ? 0.1 : 0.04));

const sdkKey = readSdkKey();
if (!sdkKey) {
  console.error('Set LD_SDK_KEY in .env (server-side SDK key).');
  process.exit(1);
}

const FLAG_KEY = 'premium-video-tutorials';
const FLAG_METRIC = 'clicked-start-training';
const AI_CONFIG_KEY = 'canine-coach-chatbot';
const AI_METRIC = 'ai-response-helpful';
const TREATED_AI_MODEL = DEMO_MODELS[1]; // the larger model, used by the "detailed" variation (terraform/main.tf)
// Simulated flag users are trial-tier: the experiment runs on the "trial users" rule
// (terraform/main.tf), so exactly these users are in it.
const TIERS = ['free', 'premium', 'beta'];

const client = ld.init(sdkKey);
await client.waitForInitialization({ timeout: 10 });
const aiClient = isAi ? initAi(client) : null;

// The SDK keeps events in a buffer of 10,000 and drops the overflow. Each simulated user produces
// several events, so send them in batches; otherwise a large run loses part of its users.
const FLUSH_EVERY = 200;

const tally = {};
const record = (arm, converted) => {
  tally[arm] ??= { seen: 0, converted: 0 };
  tally[arm].seen += 1;
  if (converted) tally[arm].converted += 1;
};

for (let i = 0; i < users; i++) {
  if (i > 0 && i % FLUSH_EVERY === 0) await client.flush();
  const context = {
    kind: 'user',
    key: `sim-${values.target}-user-${i}`,
    tier: isAi ? TIERS[i % TIERS.length] : 'trial',
    synthetic: true,
  };

  if (isAi) {
    // completionConfig() records the exposure; the tracker records this run's metrics.
    const config = await aiClient.completionConfig(AI_CONFIG_KEY, context, { enabled: false });
    if (!config.enabled) continue;
    const tracker = config.createTracker();
    tracker.trackSuccess();
    tracker.trackDuration(300 + Math.floor(Math.random() * 900));
    tracker.trackTokens({ input: 60, output: 120, total: 180 });
    const treated = config.model?.name === TREATED_AI_MODEL;
    const helpful = Math.random() < base + (treated ? lift : 0);
    tracker.trackFeedback({ kind: helpful ? LDFeedbackKind.Positive : LDFeedbackKind.Negative });
    if (helpful) client.track(AI_METRIC, context);
    record(config.model?.name ?? 'unknown', helpful);
  } else {
    // variation() records the exposure the experiment analyses.
    const hasFeature = await client.variation(FLAG_KEY, context, false);
    const converted = Math.random() < base + (hasFeature ? lift : 0);
    if (converted) client.track(FLAG_METRIC, context);
    record(`flag=${hasFeature}`, converted);
  }
}

await client.flush();
client.close();

console.log(`target: ${values.target} | synthetic users: ${users}`);
for (const [arm, { seen, converted }] of Object.entries(tally)) {
  console.log(`${arm}: ${seen} users, ${converted} positive outcomes (${((converted / seen) * 100).toFixed(1)}%)`);
}
console.log('Events sent. Allow a few minutes for results to appear in LaunchDarkly.');
