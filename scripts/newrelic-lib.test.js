import { describe, expect, it, vi } from 'vitest';
import {
  RAGE_CLICK_EXPIRATION, RAGE_CLICK_SIGNAL, appIdFromGuid, rageClickQuery, stepNewRelicIntegration, subscriptionBody, subscriptionName,
  tearDownNewRelicIntegration,
} from './newrelic-lib.mjs';

const guid = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '');

describe('appIdFromGuid', () => {
  it('reads the numeric application id out of an entity GUID', () => {
    expect(appIdFromGuid(guid('7923562|APM|APPLICATION|1300459696'))).toBe('1300459696');
    expect(appIdFromGuid(guid('7923562|BROWSER|APPLICATION|1431958174'))).toBe('1431958174');
    expect(appIdFromGuid(guid('not a guid'))).toBeNull();
  });
});

describe('subscriptionBody', () => {
  it('is named after the entity and covers every environment of the one project', () => {
    // The integration's default policy is production only; the demo runs in test.
    const body = subscriptionBody({ kind: 'browser', userKey: 'NRAK-x', appId: 42, domain: 'api.newrelic.com', project: 'cgc-demo', appName: 'Canine Good Citizen' });
    expect(body.name).toBe('Canine Good Citizen [Browser]');
    expect(body.config).toEqual({ apiKey: 'NRAK-x', applicationId: '42', domain: 'api.newrelic.com' });
    expect(body.statements[0].resources).toEqual(['proj/cgc-demo:env/*:flag/*']);
    expect(body.tags).toContain('cgc-prep');
  });
});

describe('stepNewRelicIntegration', () => {
  const args = { userKey: 'NRAK-x', appIds: { apm: '1', browser: '2' }, appName: 'Canine Good Citizen' };

  it('creates one subscription per entity', async () => {
    const api = vi.fn(async (method) => (method === 'GET' ? { status: 200, data: { items: [] } } : { status: 201, data: {} }));
    const results = await stepNewRelicIntegration({ api, project: 'cgc-demo' }, args);
    expect(results.map((r) => r.status)).toEqual(['created', 'created']);
    expect(api.mock.calls.filter(([m]) => m === 'POST').map(([, , body]) => body.name))
      .toEqual(['Canine Good Citizen [APM]', 'Canine Good Citizen [Browser]']);
  });

  it('adopts and renames a subscription made under the old name, instead of adding a duplicate', async () => {
    const items = [{ _id: 'old', name: subscriptionName('apm').replace('Canine Good Citizen [APM]', 'CGC Prep: flag changes to New Relic (apm)') }];
    const api = vi.fn(async (method) => (method === 'GET' ? { status: 200, data: { items } } : { status: 200, data: {} }));
    await stepNewRelicIntegration({ api, project: 'cgc-demo' }, { ...args, appIds: { apm: '1' } });
    const [method, path, patch] = api.mock.calls[1];
    expect(method).toBe('PATCH');
    expect(path).toBe('/integrations/new-relic-apm-v2/old');
    expect(patch).toContainEqual({ op: 'replace', path: '/name', value: 'Canine Good Citizen [APM]' });
  });

  it('says so when the integration is not available in the account', async () => {
    const api = vi.fn(async () => ({ status: 404, data: {} }));
    const [result] = await stepNewRelicIntegration({ api, project: 'cgc-demo' }, args);
    expect(result.status).toBe('manual');
  });
});

describe('tearDownNewRelicIntegration', () => {
  it('removes only the subscriptions this project made, and only reports in a dry run', async () => {
    const items = [{ _id: 'a', name: 'Canine Good Citizen [APM]', tags: ['cgc-prep'] }, { _id: 'b', name: 'Someone else', tags: [] }];
    const api = vi.fn(async (method) => (method === 'GET' ? { status: 200, data: { items } } : { status: 0, data: {} }));
    const results = await tearDownNewRelicIntegration({ api });
    expect(api.mock.calls.filter(([m]) => m === 'DELETE').map(([, path]) => path)).toEqual(['/integrations/new-relic-apm-v2/a']);
    expect(results[0].detail).toMatch(/would delete/);
  });
});

describe('the rage-click alert', () => {
  it('uses CADENCE with a 0 fill, so the issue can close once the clicks stop', () => {
    // EVENT_TIMER only re-evaluates a window when a new event arrives for it: once clicks stop
    // there is no later event to trigger that re-evaluation, so the fill never gets a chance to
    // apply and a still-open violation never closes (confirmed: stayed open 15+ minutes). CADENCE
    // publishes a window on a timer regardless of data, so fillOption/fillValue actually get used.
    expect(RAGE_CLICK_SIGNAL).toMatchObject({ aggregationMethod: 'CADENCE', fillOption: 'STATIC', fillValue: 0 });
    expect(RAGE_CLICK_SIGNAL.aggregationTimer).toBeNull(); // explicit: CADENCE and EVENT_TIMER fields are mutually exclusive
  });

  it('counts distinct frustrated customers on one app', () => {
    expect(rageClickQuery("Bob's app")).toBe("SELECT uniqueCount(enduser.id) FROM UserAction WHERE rageClick = true AND appName = 'Bob\\'s app'");
  });

  it('force-closes a violation after a real quiet gap, which fillOption alone does not do', () => {
    // fillOption only fills a gap WITHIN a signal that is still reporting; it does nothing once the
    // signal goes fully quiet (no matching events at all), which is exactly what happens between
    // demo runs. Confirmed live, twice, on two different condition IDs: with expiration left at its
    // default (closeViolationsOnExpiration: false), an issue stayed ACTIVATED for 12 and 33 minutes
    // respectively despite the underlying query reading zero the entire time. Setting this closed a
    // stuck issue within about a minute.
    expect(RAGE_CLICK_EXPIRATION).toMatchObject({ closeViolationsOnExpiration: true, expirationDuration: 120 });
  });
});
