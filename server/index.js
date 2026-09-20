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
    res.status(result.ok ? 200 : 502).json({ fired: result.ok, status: result.status });
  } catch {
    res.status(502).json({ fired: false, error: 'could not reach LaunchDarkly' });
  }
});

app.listen(PORT, () => {
  console.log(`Chat backend listening on http://localhost:${PORT}`);
  warmUp().then((models) => {
    if (models.length) console.log(`Local models ready: ${models.join(', ')}`);
    else console.warn('No local models found. For real chatbot replies start Ollama (`ollama serve`) and run `ollama pull llama3.2:1b llama3.2:3b`. Until then the chatbot uses canned replies.');
  });
});
