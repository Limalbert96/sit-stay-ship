import { describe, expect, it, vi } from 'vitest';
import { tokenProblem, verifyToken } from './token.mjs';

describe('tokenProblem', () => {
  it('accepts something shaped like an API access token', () => {
    expect(tokenProblem('api-0123456789abcdef0123456789abcdef')).toBe('');
  });

  it('catches an SDK key or mobile key pasted by mistake', () => {
    expect(tokenProblem('sdk-0123456789abcdef0123456789abcdef')).toContain('SDK or mobile key');
    expect(tokenProblem('mob-0123456789abcdef0123456789abcdef')).toContain('SDK or mobile key');
  });

  it('catches empty, spaced and too-short input', () => {
    expect(tokenProblem('')).toContain('Nothing entered');
    expect(tokenProblem('api-abc def')).toContain('no spaces');
    expect(tokenProblem('api-short')).toContain('too short');
  });
});

describe('verifyToken', () => {
  it('reports who the token belongs to when LaunchDarkly accepts it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ email: 'me@example.com' }) });
    expect(await verifyToken('api-x', fetchImpl)).toEqual({ valid: true, who: 'me@example.com' });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('api-x');
  });

  it('rejects a token LaunchDarkly refuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401, json: async () => ({}) });
    expect((await verifyToken('api-bad', fetchImpl)).valid).toBe(false);
  });

  it('does not block setup when LaunchDarkly cannot be reached', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await verifyToken('api-x', fetchImpl)).toMatchObject({ valid: true, unchecked: true });
  });
});
