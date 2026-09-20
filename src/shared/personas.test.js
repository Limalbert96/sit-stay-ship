import { describe, expect, it } from 'vitest';
import { PERSONAS, findPersona, toContext } from './personas';

describe('personas', () => {
  it('have unique, stable keys so individual targeting works', () => {
    const keys = PERSONAS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(toContext(PERSONAS[0]).key).toBe(toContext(PERSONAS[0]).key);
  });

  it('build a user context carrying the tier attribute', () => {
    const context = toContext(findPersona('maya-beta'));
    expect(context).toEqual({ kind: 'user', key: 'maya-beta', name: 'Maya', tier: 'beta' });
  });

  it('include a free-tier user that only individual targeting can reach', () => {
    expect(findPersona('alex-vip').tier).toBe('free');
  });

  it('return undefined for unknown keys', () => {
    expect(findPersona('nobody')).toBeUndefined();
  });
});
