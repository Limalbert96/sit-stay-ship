import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changeTrackingEnabled, entitySearchQuery, flagChangeEvent, guidsFromSearch, recordFlagChange, resetEntityCache,
} from './changeTracking.js';

const env = {
  NR_API_KEY: 'NRAK-test',
  NR_ACCOUNT_ID: '7923562',
  NR_APM_APP_NAME: 'Canine Good Citizen',
  LD_PROJECT_KEY: 'cgc-demo',
  LD_ENV_KEY: 'test',
};

const searchResult = {
  ok: true,
  json: async () => ({
    data: { actor: { entitySearch: { results: { entities: [
      { guid: 'GUID-BROWSER', name: 'Canine Good Citizen', domain: 'BROWSER' },
      { guid: 'GUID-APM', name: 'Canine Good Citizen', domain: 'APM' },
    ] } } } },
  }),
};
const created = { ok: true, json: async () => ({ data: { changeTrackingCreateEvent: { changeTrackingEvent: { changeTrackingId: 'x' } } } }) };

beforeEach(() => resetEntityCache());

describe('changeTrackingEnabled', () => {
  it('needs a user key and something to identify the account or the entities', () => {
    expect(changeTrackingEnabled(env)).toBe(true);
    expect(changeTrackingEnabled({ NR_ACCOUNT_ID: '1' })).toBe(false); // license keys cannot call NerdGraph
    expect(changeTrackingEnabled({ NR_API_KEY: 'NRAK-test' })).toBe(false);
    expect(changeTrackingEnabled({ NR_API_KEY: 'NRAK-test', NR_APM_ENTITY_GUID: 'a', NR_BROWSER_ENTITY_GUID: 'b' })).toBe(true);
  });
});

describe('entitySearchQuery', () => {
  it('looks for both the APM and the browser entity of one app name', () => {
    const q = entitySearchQuery({ name: 'Canine Good Citizen', accountId: '7923562' });
    expect(q).toContain("name = 'Canine Good Citizen'");
    expect(q).toContain("domain IN ('APM', 'BROWSER')");
    expect(q).toContain('accountId = 7923562');
  });
});

describe('flagChangeEvent', () => {
  const event = (extra) => flagChangeEvent({
    guid: 'GUID-APM', flagKey: 'premium-video-tutorials', project: 'cgc-demo', environment: 'test', ...extra,
  });

  it('builds a FEATURE_FLAG change event aimed at one entity', () => {
    const { query, variables } = event();
    expect(query).toContain('changeTrackingCreateEvent');
    expect(query).toContain('category: "FEATURE_FLAG"');
    expect(variables.query).toBe("id = 'GUID-APM'");
    expect(variables.flagKey).toBe('premium-video-tutorials');
    expect(variables.description).toContain('cgc-demo');
    expect(query).toContain('project: "cgc-demo"');
    expect(query).toContain('environment: "test"');
  });

  it('says whether the flag went on or off, so a marker is readable on its own', () => {
    expect(event({ state: 'on' }).variables.shortDescription).toBe('premium-video-tutorials turned ON');
    expect(event({ state: 'off' }).variables.shortDescription).toBe('premium-video-tutorials turned OFF');
    expect(event({ state: 'on' }).query).toContain('flagState: "on"');
    expect(event({ state: 'on' }).variables.description).toContain('turned ON');
  });

  it('falls back to "changed" when the state could not be read', () => {
    expect(event().variables.shortDescription).toBe('premium-video-tutorials changed');
    expect(event().query).toContain('flagState: "unknown"');
  });

  it('labels a kill-switch change as the kill switch, not as an edit', () => {
    const { query, variables } = event({ state: 'off', viaKillSwitch: true });
    expect(variables.shortDescription).toBe('premium-video-tutorials turned OFF by the kill switch');
    expect(variables.description).toContain('to stop a bad release');
    expect(variables.user).toBe('LaunchDarkly kill switch');
    expect(query).toContain('trigger: "kill-switch"');
  });

  it('strips anything that could end the string early in the custom attributes', () => {
    // customAttributes is a scalar literal, so these values cannot be passed as variables.
    const { query } = flagChangeEvent({ guid: 'G', flagKey: 'k', project: 'x" evil: "1', environment: 'test' });
    expect(query).toContain('project: "xevil1"');
    expect(query.match(/customAttributes: \{[^}]*\}/)[0]).not.toContain('evil: "');
  });
});

describe('guidsFromSearch', () => {
  it('sorts the two entities by domain, and copes with neither being there', () => {
    expect(guidsFromSearch({ actor: { entitySearch: { results: { entities: [
      { guid: 'b', domain: 'BROWSER' }, { guid: 'a', domain: 'APM' },
    ] } } } })).toEqual({ apm: 'a', browser: 'b' });
    expect(guidsFromSearch({})).toEqual({ apm: undefined, browser: undefined });
  });
});

describe('recordFlagChange', () => {
  it('looks the entities up once, then marks both of them', async () => {
    const fetchImpl = vi.fn(async (_url, options) => (JSON.parse(options.body).query.startsWith('{ actor') ? searchResult : created));

    expect(await recordFlagChange('premium-video-tutorials', { fetchImpl, env })).toEqual({ marked: ['apm', 'browser'], error: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // one lookup, then one event per entity
    expect(fetchImpl.mock.calls[0][1].headers['API-Key']).toBe('NRAK-test');

    await recordFlagChange('exam-progress-tracker', { fetchImpl, env });
    expect(fetchImpl).toHaveBeenCalledTimes(5); // the lookup is cached, so only two more calls
  });

  it('skips the lookup when both GUIDs are given', async () => {
    const fetchImpl = vi.fn(async () => created);
    const withGuids = { ...env, NR_APM_ENTITY_GUID: 'A', NR_BROWSER_ENTITY_GUID: 'B' };

    await recordFlagChange('premium-video-tutorials', { fetchImpl, env: withGuids });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variables.query).toBe("id = 'A'");
  });

  it('reports the message NerdGraph returns, which arrives with status 200', async () => {
    const fetchImpl = vi.fn(async (_url, options) => (JSON.parse(options.body).query.startsWith('{ actor')
      ? searchResult
      : { ok: true, json: async () => ({ errors: [{ message: 'Not authorized' }] }) }));

    await expect(recordFlagChange('premium-video-tutorials', { fetchImpl, env })).rejects.toThrow('Not authorized');
  });

  it('says so when New Relic has no matching entity', async () => {
    const empty = { ok: true, json: async () => ({ data: { actor: { entitySearch: { results: { entities: [] } } } } }) };
    await expect(recordFlagChange('premium-video-tutorials', { fetchImpl: vi.fn(async () => empty), env }))
      .rejects.toThrow('no APM or Browser entity found');
  });
});
