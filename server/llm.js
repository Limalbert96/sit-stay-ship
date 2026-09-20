// Produces the chatbot reply. LaunchDarkly AI Configs only hold the model name and
// prompt; something else has to call the model. Providers, in order:
//   1. OpenAI   when OPENAI_API_KEY is set and the model name starts with "gpt"
//   2. Ollama   a local, free model server (https://ollama.com) if it has the model
//   3. mock     canned replies, so the demo still runs with nothing installed
// Ollama exposes an OpenAI-compatible API, so 1 and 2 share the same request code.
//
// The AI Config names the model exactly as its provider knows it: "gpt-4o" runs on OpenAI,
// anything else ("llama3.2:1b") runs on Ollama. Nothing is mapped or translated.
import { buildMockReply, estimateTokens } from './mockLlm.js';

const OPENAI_URL = 'https://api.openai.com';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 800;
const CHAT_TIMEOUT_MS = 90_000; // first call may load the model into memory
const PROBE_CACHE_MS = 5_000;

// Local models the demo uses. `npm run setup` pulls them and the backend loads them at startup.
export const DEMO_MODELS = ['llama3.2:1b', 'llama3.2:3b'];

let probeCache = { at: 0, url: '', models: [] };

// Which models does the local Ollama server have? Empty if it is not running.
async function ollamaModels({ ollamaUrl, fetchImpl }) {
  if (probeCache.url === ollamaUrl && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.models;
  let models = [];
  try {
    const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) models = ((await res.json()).models ?? []).map((m) => m.name);
  } catch {
    // Ollama not installed or not running.
  }
  probeCache = { at: Date.now(), url: ollamaUrl, models };
  return models;
}

// "llama3.2:1b" matches an installed "llama3.2:1b"; a bare name matches its ":latest" tag.
const hasModel = (installed, model) =>
  installed.includes(model) || installed.includes(`${model}:latest`);

// Decide who answers for an AI Config model: OpenAI for gpt models (needs a key), Ollama for
// anything it has installed, otherwise canned replies.
export async function resolveProvider(
  model,
  { apiKey = process.env.OPENAI_API_KEY, ollamaUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL, fetchImpl = fetch } = {},
) {
  if (/^gpt/i.test(model)) return apiKey ? 'openai' : 'mock';
  return hasModel(await ollamaModels({ ollamaUrl, fetchImpl }), model) ? 'ollama' : 'mock';
}

async function chatCompletion({ baseUrl, apiKey, model, systemPrompt, userMessage, fetchImpl }) {
  const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${baseUrl} returned status ${res.status}`);

  const data = await res.json();
  const usage = data.usage ?? {};
  return {
    reply: (data.choices?.[0]?.message?.content ?? '').trim(),
    tokens: { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens },
  };
}

// Load the local stand-in models into memory ahead of the first chat message, so it is not
// slow (a cold model can take 10 to 30 seconds). Fire and forget; failures are harmless.
export async function warmUp({
  ollamaUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
  fetchImpl = fetch,
  models = DEMO_MODELS,
} = {}) {
  const installed = await ollamaModels({ ollamaUrl, fetchImpl });
  const wanted = models.filter((m) => hasModel(installed, m));
  await Promise.allSettled(
    wanted.map((model) =>
      fetchImpl(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ model, keep_alive: '30m' }), // no prompt: just load and keep resident
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      }),
    ),
  );
  return wanted;
}

export async function generateReply({
  model,
  systemPrompt,
  userMessage,
  apiKey = process.env.OPENAI_API_KEY,
  ollamaUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
  fetchImpl = fetch,
}) {
  const provider = await resolveProvider(model, { apiKey, ollamaUrl, fetchImpl });

  if (provider === 'mock') {
    const reply = buildMockReply({ model, systemPrompt, userMessage });
    const input = estimateTokens(systemPrompt + userMessage);
    const output = estimateTokens(reply);
    return { reply, tokens: { input, output, total: input + output }, provider };
  }

  const result = await chatCompletion({
    baseUrl: provider === 'openai' ? OPENAI_URL : ollamaUrl,
    apiKey: provider === 'openai' ? apiKey : undefined,
    model,
    systemPrompt,
    userMessage,
    fetchImpl,
  });
  return { ...result, provider };
}
