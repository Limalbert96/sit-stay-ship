import { describe, expect, it } from 'vitest';
import { personaFromUrl, syntheticVisitor } from './chaos';

describe('personaFromUrl', () => {
  it('opens as one of the fixed personas', () => {
    expect(personaFromUrl('?persona=maya-beta')).toMatchObject({ key: 'maya-beta', tier: 'beta' });
  });

  it('makes up a premium visitor for ?visitor=, so the tier rule serves it the feature', () => {
    // Premium also keeps these out of the experiment, which only runs on trial users.
    expect(personaFromUrl('?visitor=shopper-07')).toEqual({
      key: 'shopper-07', name: 'shopper-07', tier: 'premium', synthetic: true,
    });
  });

  it('falls back to the usual default for no switch, or a persona that does not exist', () => {
    expect(personaFromUrl('')).toBeNull();
    expect(personaFromUrl('?persona=nobody')).toBeNull();
  });
});

describe('syntheticVisitor', () => {
  it('is marked synthetic, so LaunchDarkly can tell it from a real customer', () => {
    expect(syntheticVisitor('shopper-01').synthetic).toBe(true);
  });
});
