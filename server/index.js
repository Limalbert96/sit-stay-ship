// Backend for the AI Config chatbot. It evaluates a LaunchDarkly AI Config
// per user, gets a reply from a model, and reports AI metrics back to LaunchDarkly.
//
// Started with the New Relic APM agent preloaded (see the "server" script in package.json).
// The agent reads NR_APM_* settings from .env via newrelic.cjs; without a license key it disables
// itself and newrelic.* calls do nothing.
//
// Needs a SERVER-side SDK key (secret, never ship to the browser):
//   LaunchDarkly -> Project settings -> Environments -> your environment -> "SDK key"
// Put it in .env as LD_SDK_KEY. Without it the server still runs
// on a local fallback config. Replies come from a local Ollama model, OpenAI, or canned text (see llm.js).
import { randomUUID } from 'node:crypto';
import express from 'express';
import newrelic from 'newrelic';
import * as ld from '@launchdarkly/node-server-sdk';
import { initAi, LDFeedbackKind } from '@launchdarkly/server-sdk-ai';
import { findPersona, toContext } from '../src/shared/personas.js';
import { sdkKey } from './env.js';
import { generateReply, resolveProvider, warmUp } from './llm.js';
import { changeTrackingEnabled, recordFlagChange } from './changeTracking.js';

const PORT = Number(process.env.PORT ?? 3001);
// Server-side SDK key (LD_SDK_KEY in .env).
const SDK_KEY = sdkKey();
// Key of the AI Config (created by terraform/main.tf).
const AI_CONFIG_KEY = 'canine-coach-chatbot';
const RUN_TTL_MS = 30 * 60 * 1000;

// Used only when LaunchDarkly is unreachable or the AI Config does not exist yet.
const FALLBACK_CONFIG = {
  enabled: true,
  model: { name: 'llama3.2:1b' },
  messages: [{ role: 'system', content: 'You are a helpful, concise canine good citizen coach.' }],
};

let ldClient = null;
let aiClient = null;
if (SDK_KEY) {
  ldClient = ld.init(SDK_KEY);
  await ldClient.waitForInitialization({ timeout: 10 }).catch((err) => {
    console.error('LaunchDarkly did not initialise, using fallback config:', err.message);
  });
  aiClient = initAi(ldClient);
} else {
  console.warn('No LD_SDK_KEY in .env: using the local fallback config, no metrics are sent.');
}

// Optional (Integrations): mark every flag change on the New Relic APM and Browser entities, which
// is what LaunchDarkly's own New Relic integration would do if its API still worked. The SDK raises
// "update" whenever a flag is edited in LaunchDarkly, from the UI, the API or the kill-switch
// trigger. Failures only warn: a demo must not depend on New Relic being reachable.

// The "update" event carries only the flag key, so the resulting on/off state is read back here.
// allFlagsState is the one call that reports it without sending analytics events, so reading it
// does not add a fake user to the flag's evaluations. The reason kind is "OFF" only when the flag's
// own switch is off, which is what a marker should say, whatever the targeting rules serve.
const PROBE_CONTEXT = { kind: 'user', key: 'sit-stay-ship-change-tracking', anonymous: true };
async function flagState(key) {
  try {
    const state = await ldClient.allFlagsState(PROBE_CONTEXT, { withReasons: true });
    const reason = state.getFlagReason(key);
    if (!reason) return undefined;
    return reason.kind === 'OFF' ? 'off' : 'on';
  } catch {
    return undefined; // a marker without the state still beats no marker
  }
}

// Set when the page fires the kill switch, so the flag change that follows a second later can be
// labelled as the kill switch rather than as someone editing a flag.
let killSwitchFiredAt = 0;
const KILL_SWITCH_WINDOW_MS = 20_000;

if (ldClient && changeTrackingEnabled()) {
  console.log('New Relic change tracking on: flag changes will be marked on the APM and Browser entities.');
  ldClient.on('update', async ({ key }) => {
    const state = await flagState(key);
    const viaKillSwitch = state === 'off' && Date.now() - killSwitchFiredAt < KILL_SWITCH_WINDOW_MS;
    recordFlagChange(key, { state, viaKillSwitch })
      .then(({ marked }) => console.log(
        `Marked "${key}" ${state ? `turned ${state.toUpperCase()}` : 'changed'}${viaKillSwitch ? ' (kill switch)' : ''} on New Relic (${marked.join(' and ')}).`,
      ))
      .catch((err) => console.warn(`Could not mark "${key}" on New Relic: ${err.message}`));
  });
}

async function loadConfig(persona) {
  if (!aiClient) return { config: { ...FALLBACK_CONFIG, createTracker: () => null }, live: false };
  const config = await aiClient.completionConfig(AI_CONFIG_KEY, toContext(persona), FALLBACK_CONFIG);
  return { config, live: true };
}

const systemPromptOf = (config) => config.messages?.find((m) => m.role === 'system')?.content ?? '';

// Trackers are per run; feedback arrives in a later request, so remember them briefly.
const runs = new Map();
function rememberRun(tracker, context) {
  const runId = randomUUID();
  runs.set(runId, { tracker, context, expires: Date.now() + RUN_TTL_MS });
  for (const [id, run] of runs) if (run.expires < Date.now()) runs.delete(id);
  return runId;
}

const app = express();
app.use(express.json({ limit: '10kb' }));

// Only known demo personas are accepted, so callers cannot inject arbitrary contexts.
function personaFrom(value, res) {
  const persona = findPersona(value);
  if (!persona) res.status(400).json({ error: 'unknown persona' });
  return persona;
}

app.get('/api/chat/config', async (req, res) => {
  const persona = personaFrom(req.query.persona, res);
  if (!persona) return;
  const { config } = await loadConfig(persona);
  const model = config.model?.name ?? 'unknown';
  res.json({ enabled: config.enabled, model, provider: await resolveProvider(model) });
});

app.post('/api/chat', async (req, res) => {
  const persona = personaFrom(req.body?.persona, res);
  if (!persona) return;
  const message = String(req.body?.message ?? '').slice(0, 500);
  if (!message.trim()) return res.status(400).json({ error: 'message required' });

  const { config } = await loadConfig(persona);
  if (!config.enabled) return res.status(503).json({ error: 'assistant disabled' });

  const tracker = config.createTracker();
  const started = Date.now();
  const model = config.model?.name ?? 'unknown';
  // Slice New Relic APM transactions by user and by the model LaunchDarkly picked.
  newrelic.addCustomAttributes({ persona: persona.key, aiModel: model });

  try {
    const { reply, tokens } = await generateReply({ model, systemPrompt: systemPromptOf(config), userMessage: message });
    tracker?.trackDuration(Date.now() - started);
    tracker?.trackTokens(tokens);
    tracker?.trackSuccess();
    res.json({ reply, model, runId: rememberRun(tracker, toContext(persona)) });
  } catch (err) {
    console.error('Model call failed:', err.message);
    tracker?.trackError();
    res.status(502).json({ error: 'model call failed' });
  }
});

app.post('/api/chat/feedback', (req, res) => {
  const run = runs.get(req.body?.runId);
  if (!run) return res.status(404).json({ error: 'unknown run' });
  const helpful = Boolean(req.body?.helpful);
  // Built-in AI metric (shows in the AI Config's monitoring tab)...
  run.tracker?.trackFeedback({ kind: helpful ? LDFeedbackKind.Positive : LDFeedbackKind.Negative });
  // ...and our custom metric `ai-response-helpful`, which the experiment uses.
  if (helpful) ldClient?.track('ai-response-helpful', run.context);
  res.json({ ok: true });
});

// Remediation from the browser: fires the flag trigger for the page's "Fire kill
// switch" button, so the trigger URL (a secret) stays on the server. Anyone who can reach
// this endpoint can turn the flag off, which is fine for a local demo but not for production.
app.post('/api/kill-switch', async (_req, res) => {
  const url = process.env.LD_TRIGGER_URL;
  if (!url) return res.status(501).json({ error: 'LD_TRIGGER_URL is not set in .env' });
  try {
    const result = await fetch(url, { method: 'POST' });
    if (result.ok) killSwitchFiredAt = Date.now(); // labels the flag change this causes (see above)
    res.status(result.ok ? 200 : 502).json({ fired: result.ok, status: result.status });
  } catch {
    res.status(502).json({ fired: false, error: 'could not reach LaunchDarkly' });
  }
});

// Bound to localhost on purpose: this is a local demo backend, and /api/kill-switch has no
// authentication, so it should not be reachable from the rest of the network. It also keeps the
// "port in use" error below clean, because a dual-stack bind can half-succeed before it fails.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Chat backend listening on http://localhost:${PORT}`);
  warmUp().then((models) => {
    if (models.length) console.log(`Local models ready: ${models.join(', ')}`);
    else console.warn('No local models found. For real chatbot replies start Ollama (`ollama serve`) and run `ollama pull llama3.2:1b llama3.2:3b`. Until then the chatbot uses canned replies.');
  });
});

// A second copy of the backend is worse than none: it cannot serve the API, but it still holds a
// LaunchDarkly connection, so every flag change would be marked in New Relic twice. Stop instead.
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use, so the chat backend is already running. Stopping this second copy.
Use the one that is running, or start this one on another port with PORT=3002 npm run server.`);
  } else {
    console.error('The chat backend could not start:', err.message);
  }
  await ldClient?.close();
  process.exit(1);
});
