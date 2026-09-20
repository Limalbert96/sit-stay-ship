import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateReply, resolveProvider, warmUp } from './llm.js';

const args = { systemPrompt: 'Be concise.', userMessage: 'loose leash tips' };
const completion = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
});
const tags = (...names) => ({ ok: true, json: async () => ({ models: names.map((name) => ({ name })) }) });

// Fake fetch: routes by URL so tests read like the real conversation with each server.
const fakeFetch = ({ installed = [], chat = completion('Reward slack leads.') } = {}) =>
  vi.fn(async (url) => {
    if (url.endsWith('/api/tags')) return installed === null ? Promise.reject(new Error('refused')) : tags(...installed);
    return chat;
  });

// resolveProvider caches the Ollama probe for a few seconds, so use distinct URLs per test.
let n = 0;
const freshUrl = () => `http://ollama-test-${n++}:11434`;

beforeEach(() => vi.useRealTimers());

describe('resolveProvider', () => {
  it('uses OpenAI for gpt models when a key is set, and never mixes them with Ollama', async () => {
    const fetchImpl = fakeFetch({ installed: ['gpt-4o'] });
    expect(await resolveProvider('gpt-4o', { apiKey: 'sk-x', ollamaUrl: freshUrl(), fetchImpl })).toBe('openai');
    expect(await resolveProvider('gpt-4o', { apiKey: '', ollamaUrl: freshUrl(), fetchImpl })).toBe('mock');
  });

  it('runs a model on Ollama when Ollama has it, under its own name', async () => {
    const fetchImpl = fakeFetch({ installed: ['llama3.2:1b'] });
    expect(await resolveProvider('llama3.2:1b', { apiKey: 'sk-x', ollamaUrl: freshUrl(), fetchImpl })).toBe('ollama');
  });

  it('falls back to canned replies when Ollama is not running', async () => {
    const fetchImpl = fakeFetch({ installed: null });
    expect(await resolveProvider('llama3.2:1b', { apiKey: '', ollamaUrl: freshUrl(), fetchImpl })).toBe('mock');
  });

  it('falls back to canned replies when Ollama lacks the model', async () => {
    const fetchImpl = fakeFetch({ installed: ['qwen2.5:0.5b'] });
    expect(await resolveProvider('llama3.2:3b', { apiKey: '', ollamaUrl: freshUrl(), fetchImpl })).toBe('mock');
  });
});

describe('generateReply', () => {
  it('returns a mock reply and never calls a model when nothing is available', async () => {
    const fetchImpl = fakeFetch({ installed: [] });
    const result = await generateReply({ ...args, model: 'llama3.2:1b', apiKey: '', ollamaUrl: freshUrl(), fetchImpl });
    expect(result.provider).toBe('mock');
    expect(result.reply).toMatch(/llama3.2:1b · mock/);
    expect(fetchImpl.mock.calls.every(([url]) => url.endsWith('/api/tags'))).toBe(true);
  });

  it('calls the local model with the model and prompt from the AI Config', async () => {
    const ollamaUrl = freshUrl();
    const fetchImpl = fakeFetch({ installed: ['llama3.2:3b'] });
    const result = await generateReply({ ...args, model: 'llama3.2:3b', apiKey: '', ollamaUrl, fetchImpl });
    const [url, init] = fetchImpl.mock.calls.find(([u]) => u.includes('/v1/chat/completions'));
    expect(url).toBe(`${ollamaUrl}/v1/chat/completions`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.2:3b');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(init.headers.Authorization).toBeUndefined();
    expect(result).toMatchObject({ reply: 'Reward slack leads.', provider: 'ollama', tokens: { total: 16 } });
  });

  it('calls OpenAI with the bearer key for gpt models', async () => {
    const fetchImpl = fakeFetch();
    const result = await generateReply({ ...args, model: 'gpt-4o', apiKey: 'sk-test', ollamaUrl: freshUrl(), fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(result.provider).toBe('openai');
  });

  it('throws when the model server rejects the request', async () => {
    const fetchImpl = fakeFetch({ chat: { ok: false, status: 500 } });
    await expect(generateReply({ ...args, model: 'gpt-4o', apiKey: 'sk-bad', ollamaUrl: freshUrl(), fetchImpl })).rejects.toThrow('500');
  });
});

describe('warmUp', () => {
  it('loads only the mapped models that are installed, without generating text', async () => {
    const fetchImpl = fakeFetch({ installed: ['llama3.2:1b'] });
    const loaded = await warmUp({ ollamaUrl: freshUrl(), fetchImpl });
    expect(loaded).toEqual(['llama3.2:1b']);
    const [url, init] = fetchImpl.mock.calls.find(([u]) => u.endsWith('/api/generate'));
    expect(url).toMatch(/\/api\/generate$/);
    expect(JSON.parse(init.body)).toEqual({ model: 'llama3.2:1b', keep_alive: '30m' });
  });

  it('does nothing when Ollama is not running', async () => {
    const fetchImpl = fakeFetch({ installed: null });
    expect(await warmUp({ ollamaUrl: freshUrl(), fetchImpl })).toEqual([]);
  });
});
