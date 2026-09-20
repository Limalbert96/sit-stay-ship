import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadEnvModule(vars) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  return import('./env.js');
}

afterEach(() => vi.unstubAllEnvs());

describe('env', () => {
  it('returns the client-side ID and SDK key from the environment', async () => {
    const env = await loadEnvModule({ LD_CLIENT_ID: 'abc123', LD_SDK_KEY: 'sdk-secret' });
    expect(env.clientSideId()).toBe('abc123');
    expect(env.sdkKey()).toBe('sdk-secret');
  });

  it('refuses to expose a server SDK key as the client-side ID', async () => {
    const env = await loadEnvModule({ LD_CLIENT_ID: 'sdk-oops' });
    expect(() => env.clientSideId()).toThrow('server-side SDK key');
  });
});
