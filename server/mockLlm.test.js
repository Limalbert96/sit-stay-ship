import { describe, expect, it } from 'vitest';
import { buildMockReply, estimateTokens } from './mockLlm.js';

describe('buildMockReply', () => {
  const base = { model: 'model-x', systemPrompt: 'You are a coach.', userMessage: 'How do I teach loose leash walking?' };

  it('names the model LaunchDarkly selected', () => {
    expect(buildMockReply(base)).toMatch(/^\[model-x · mock\]/);
  });

  it('gives item-specific advice', () => {
    expect(buildMockReply(base)).toMatch(/Loose Leash/);
  });

  it('is shorter when the prompt asks for concise answers', () => {
    const concise = buildMockReply({ ...base, systemPrompt: 'Be concise.' });
    expect(concise.length).toBeLessThan(buildMockReply(base).length);
  });

  it('falls back to the list of test items for unrelated questions', () => {
    expect(buildMockReply({ ...base, userMessage: 'hello' })).toMatch(/10 CGC items/);
  });
});

describe('estimateTokens', () => {
  it('never returns less than 1', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
