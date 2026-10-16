import { describe, expect, it, vi } from 'vitest';
import {
  RAGE_CLICK_EXPIRATION, RAGE_CLICK_SIGNAL, rageClickQuery, stepNewRelicIntegration, tearDownNewRelicAlerting, subscriptionBody, subscriptionName,
  tearDownNewRelicIntegration,
} from './newrelic-lib.mjs';

const guid = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '');
const APM_GUID = guid('7923562|APM|APPLICATION|1300459696');
const BROWSER_GUID = guid('7923562|BROWSER|APPLICATION|1431958174');

describe('subscriptionBody', () => {
  it('is named after the entity, points at its entity.guid, and covers every environment of the one project', () => {
    // The integration's default policy is production only; the demo runs in test.
    const body = subscriptionBody({ kind: 'browser', userKey: 'NRAK-x', guid: BROWSER_GUID, domain: 'api.newrelic.com', project: 'cgc-demo', appName: 'Canine Good Citizen' });
    expect(body.name).toBe('Canine Good Citizen [Browser]');
    expect(body.config).toEqual({ apiKey: 'NRAK-x', entityGuid: BROWSER_GUID, domain: 'api.newrelic.com' });
    expect(body.statements[0].resources).toEqual(['proj/cgc-demo:env/*:flag/*']);
    expect(body.tags).toContain('cgc-prep');
  });
});

describe('stepNewRelicIntegration', () => {
  const args = { userKey: 'NRAK-x', guids: { apm: APM_GUID, browser: BROWSER_GUID }, appName: 'Canine Good Citizen' };
  const fakeApi = (items = []) => vi.fn(async (method) => (method === 'GET' ? { status: 200, data: { items } } : { status: 201, data: {} }));
  const posted = (api) => api.mock.calls.filter(([m]) => m === 'POST').map(([, , body]) => body);

  it('creates one subscription per entity', async () => {
    const api = fakeApi();
    const results = await stepNewRelicIntegration({ api, project: 'cgc-demo' }, args);
    expect(results.map((r) => r.status)).toEqual(['created', 'created']);
    expect(posted(api).map((b) => b.name)).toEqual(['Canine Good Citizen [APM]', 'Canine Good Citizen [Browser]']);
  });

  it('sends each application\'s entity.guid', async () => {
    const api = fakeApi();
    await stepNewRelicIntegration({ api, project: 'cgc-demo' }, args);
    expect(posted(api).map((b) => b.config)).toEqual([
      { apiKey: 'NRAK-x', entityGuid: APM_GUID, domain: 'api.newrelic.com' },
      { apiKey: 'NRAK-x', entityGuid: BROWSER_GUID, domain: 'api.newrelic.com' },
    ]);
  });

  it('adopts and renames a subscription made under the old name, instead of adding a duplicate', async () => {
    const items = [{ _id: 'old', name: subscriptionName('apm').replace('Canine Good Citizen [APM]', 'CGC Prep: flag changes to New Relic (apm)') }];
    const api = fakeApi(items);
    await stepNewRelicIntegration({ api, project: 'cgc-demo' }, { ...args, guids: { apm: APM_GUID } });
    const [method, path, patch] = api.mock.calls.find(([m]) => m === 'PATCH');
    expect(method).toBe('PATCH');
    expect(path).toBe('/integrations/new-relic-apm-v2/old');
    expect(patch).toContainEqual({ op: 'replace', path: '/name', value: 'Canine Good Citizen [APM]' });
    expect(patch).toContainEqual({ op: 'replace', path: '/config', value: { apiKey: 'NRAK-x', entityGuid: APM_GUID, domain: 'api.newrelic.com' } });
  });

  it('says which application is missing instead of creating a subscription for it', async () => {
    const api = fakeApi();
    const results = await stepNewRelicIntegration({ api, project: 'cgc-demo' }, { ...args, guids: { apm: APM_GUID, browser: undefined } });
    expect(results.map((r) => r.status)).toEqual(['created', 'manual']);
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

describe('tearDownNewRelicAlerting', () => {
  // A fake NerdGraph holding everything setup makes; `policyName` is the policy the alert is in.
  const fakeNerdgraph = (policyName = 'CGC Prep: bad release') => vi.fn(async (query) => {
    if (query.includes('aiNotifications {')) return { actor: { account: {
      aiNotifications: {
        destinations: { entities: [{ id: 'd1', name: 'LaunchDarkly kill switch (rage click alert)', properties: [] }] },
        channels: { entities: [{ id: 'c1', name: 'LaunchDarkly kill switch webhook (workflows)' }] },
      },
      aiWorkflows: { workflows: { entities: [{ id: 'w1', name: 'Rage click -> LaunchDarkly kill switch', workflowEnabled: false }] } },
    } } };
    if (query.includes('nrqlConditionsSearch')) return { actor: { account: { alerts: { nrqlConditionsSearch: { nrqlConditions: [{ id: 'cond1', name: 'Rage Click', policyId: 'p1' }] } } } } };
    if (query.includes('policy(id')) return { actor: { account: { alerts: { policy: { id: 'p1', name: policyName } } } } };
    return {};
  });
  const mutations = (nerdgraph) => nerdgraph.mock.calls.map(([q]) => q.match(/^mutation[^{]*\{\s*(\w+)/)?.[1]).filter(Boolean);

  it('removes the workflow, channel and destination in the order New Relic allows, then the policy', async () => {
    const nerdgraph = fakeNerdgraph();
    const results = await tearDownNewRelicAlerting(nerdgraph, { accountId: '1' });
    expect(mutations(nerdgraph)).toEqual(['aiWorkflowsDeleteWorkflow', 'aiNotificationsDeleteChannel', 'aiNotificationsDeleteDestination', 'alertsPolicyDelete']);
    expect(results.every((r) => r.status === 'created')).toBe(true);
  });

  it('deletes only the alert, and leaves the policy, when the alert was adopted into someone else\'s policy', async () => {
    const nerdgraph = fakeNerdgraph('Platform team policy');
    await tearDownNewRelicAlerting(nerdgraph, { accountId: '1' });
    expect(mutations(nerdgraph)).toContain('alertsConditionDelete');
    expect(mutations(nerdgraph)).not.toContain('alertsPolicyDelete');
  });

  it('only reports in a dry run', async () => {
    const nerdgraph = fakeNerdgraph();
    const results = await tearDownNewRelicAlerting(nerdgraph, { accountId: '1', dryRun: true });
    expect(mutations(nerdgraph)).toEqual([]);
    expect(results.map((r) => r.detail).every((d) => d.startsWith('would delete'))).toBe(true);
  });

  it('says so when there is nothing to remove', async () => {
    const nerdgraph = vi.fn(async (query) => (query.includes('aiNotifications {')
      ? { actor: { account: { aiNotifications: { destinations: { entities: [] }, channels: { entities: [] } }, aiWorkflows: { workflows: { entities: [] } } } } }
      : { actor: { account: { alerts: { nrqlConditionsSearch: { nrqlConditions: [] } } } } }));
    expect((await tearDownNewRelicAlerting(nerdgraph, { accountId: '1' }))[0].detail).toMatch(/no New Relic alert/);
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
