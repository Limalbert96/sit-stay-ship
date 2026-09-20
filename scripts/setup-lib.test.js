import { describe, expect, it, vi } from 'vitest';
import {
  EXPERIMENTS, createApi, deleteIfPresent, envFromTerraformOutputs, inspectTerraformState, mergeEnv, readEnvValue, stepAiConfigTargeting, stepExperiment, tearDownExperiments,
} from './setup-lib.mjs';

describe('mergeEnv', () => {
  const example = '# comment\nLD_CLIENT_ID=your-client-side-id\nLD_SDK_KEY=sdk-your-server-side-key\n# LD_TRIGGER_URL=https://x\nOTHER=keep';

  it('fills placeholders, uncomments an example line, and keeps comments and other keys', () => {
    const { text, changed } = mergeEnv(example, { LD_CLIENT_ID: 'abc', LD_SDK_KEY: 'sdk-real', LD_TRIGGER_URL: 'https://t' });
    expect(text).toBe('# comment\nLD_CLIENT_ID=abc\nLD_SDK_KEY=sdk-real\nLD_TRIGGER_URL=https://t\nOTHER=keep');
    expect(changed).toEqual(['LD_CLIENT_ID', 'LD_SDK_KEY', 'LD_TRIGGER_URL']);
  });

  it('never overwrites a real value unless asked', () => {
    const { text, changed } = mergeEnv('LD_SDK_KEY=sdk-mine', { LD_SDK_KEY: 'sdk-other' });
    expect(text).toBe('LD_SDK_KEY=sdk-mine');
    expect(changed).toEqual([]);
    expect(mergeEnv('LD_SDK_KEY=sdk-mine', { LD_SDK_KEY: 'sdk-other' }, { overwrite: true }).text).toBe('LD_SDK_KEY=sdk-other');
  });

  it('appends keys that are missing', () => {
    expect(mergeEnv('A=1', { B: '2' }).text).toBe('A=1\nB=2');
  });
});

describe('readEnvValue', () => {
  it('ignores placeholders and missing keys', () => {
    expect(readEnvValue('X=your-thing\nY=real', 'X')).toBe('');
    expect(readEnvValue('X=your-thing\nY=real', 'Y')).toBe('real');
    expect(readEnvValue('X=1', 'Z')).toBe('');
  });
});

// A fake LaunchDarkly: routes by "METHOD path" and records every call.
function fakeLd(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const path = url.replace('https://app.launchdarkly.com/api/v2', '');
    const key = `${init.method} ${path}`;
    calls.push({ key, init, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[key];
    const [status, data] = handler ? (typeof handler === 'function' ? handler() : handler) : [404, { message: 'not found' }];
    return { status, json: async () => data };
  });
  return { fetchImpl, calls, api: createApi({ token: 'api-test', fetchImpl }) };
}

describe('createApi', () => {
  it('sends the token, and marks semantic patches and beta endpoints', async () => {
    const { api, calls } = fakeLd({ 'PATCH /flags/p/f': [200, {}], 'GET /projects/p/ai-configs/x': [200, {}] });
    await api('PATCH', '/flags/p/f', { instructions: [] });
    await api('GET', '/projects/p/ai-configs/x', undefined, { beta: true });
    expect(calls[0].init.headers.Authorization).toBe('api-test');
    expect(calls[0].init.headers['Content-Type']).toContain('semanticpatch');
    expect(calls[1].init.headers['LD-API-Version']).toBe('beta');
  });

  it('does not send writes in a dry run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    const api = createApi({ token: 't', fetchImpl, dryRun: true });
    await api('POST', '/flags/p', { key: 'x' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('envFromTerraformOutputs', () => {
  it('maps the Terraform outputs to .env entries and skips empty ones', () => {
    const outputs = {
      client_side_id: { value: 'client123', sensitive: true },
      sdk_key: { value: 'sdk-secret', sensitive: true },
      trigger_url: { value: '' },
      ai_config_key: { value: 'canine-coach-chatbot' },
    };
    expect(envFromTerraformOutputs(outputs)).toEqual({ LD_CLIENT_ID: 'client123', LD_SDK_KEY: 'sdk-secret' });
    expect(envFromTerraformOutputs(undefined)).toEqual({});
  });
});

describe('stepAiConfigTargeting', () => {
  const routes = {
    'GET /projects/p/ai-configs/canine-coach-chatbot': [200, { variations: [{ key: 'concise', _id: 'c1' }, { key: 'detailed', _id: 'd1' }] }],
    'PATCH /projects/p/ai-configs/canine-coach-chatbot/targeting': [200, {}],
  };

  it('serves Concise and Detailed 50/50 by default, using the beta API version', async () => {
    const { api, calls } = fakeLd(routes);
    const result = await stepAiConfigTargeting({ api, project: 'p', envKey: 'test' });
    expect(result.status).toBe('created');
    const patch = calls.find((c) => c.key.startsWith('PATCH'));
    expect(patch.body.instructions[0].rolloutWeights).toEqual({ c1: 50000, d1: 50000 });
    expect(patch.init.headers['LD-API-Version']).toBe('beta');
  });

  it('asks for a manual step when the variations are missing', async () => {
    const { api } = fakeLd({ 'GET /projects/p/ai-configs/canine-coach-chatbot': [200, { variations: [] }] });
    expect((await stepAiConfigTargeting({ api, project: 'p', envKey: 'test' })).status).toBe('manual');
  });
});

describe('stepExperiment', () => {
  const flagExperiment = EXPERIMENTS[0];
  const base = '/projects/p/environments/test/experiments';
  const flagRoutes = (extra = {}, env = {}) => ({
    'GET /flags/p/premium-video-tutorials': [200, {
      variations: [{ _id: 'v-true', value: true }, { _id: 'v-false', value: false }],
      environments: { test: { version: 9, on: true, rules: [{ _id: 'r-paying', description: 'Paying and beta tiers' }, { _id: 'r-trial', description: 'Trial users (experiment audience)' }], ...env } },
    }],
    [`POST ${base}`]: [201, {}],
    [`PATCH ${base}/premium-videos-start-training`]: [200, {}],
    ...extra,
  });

  it('creates the experiment on the trial-users rule and starts it, without touching the default rule', async () => {
    const { api, calls } = fakeLd(flagRoutes());
    const result = await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment);
    expect(result.status).toBe('created');
    expect(calls.some((c) => c.key === 'PATCH /flags/p/premium-video-tutorials')).toBe(false);
    const create = calls.find((c) => c.key === `POST ${base}`).body;
    expect(create.iteration.flags['premium-video-tutorials']).toEqual({ ruleId: 'r-trial', flagConfigVersion: 9 });
    expect(create.iteration.metrics).toEqual([{ key: 'clicked-start-training', isGroup: false }]);
    expect(create.iteration.treatments.map((t) => [t.name, t.baseline])).toEqual([['Videos shown', false], ['Videos hidden', true]]);
    expect(calls.find((c) => c.key === `PATCH ${base}/premium-videos-start-training`).body.instructions[0].kind).toBe('startIteration');
  });

  it('asks for a manual step when the trial-users rule is missing', async () => {
    const { api } = fakeLd(flagRoutes({}, { rules: [] }));
    const result = await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment);
    expect(result.status).toBe('manual');
    expect(result.detail).toContain('Trial users (experiment audience)');
  });

  it('does not try to start an experiment on a flag that is off', async () => {
    const { api, calls } = fakeLd(flagRoutes({}, { on: false }));
    const result = await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment);
    expect(result.status).toBe('manual');
    expect(result.detail).toContain('is off');
    expect(calls.some((c) => c.key === `POST ${base}`)).toBe(false);
  });

  it('retries with a numeric allocation when the string form is rejected', async () => {
    let posts = 0;
    const { api, calls } = fakeLd(flagRoutes({ [`POST ${base}`]: () => (++posts === 1 ? [400, { message: 'bad allocation' }] : [201, {}]) }));
    expect((await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment)).status).toBe('created');
    const bodies = calls.filter((c) => c.key === `POST ${base}`).map((c) => c.body.iteration.treatments[0].allocationPercent);
    expect(bodies).toEqual(['50', 50]);
  });

  it('leaves an existing experiment alone', async () => {
    const { api, calls } = fakeLd({ [`GET ${base}/premium-videos-start-training`]: [200, {}] });
    expect((await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment)).status).toBe('exists');
    expect(calls).toHaveLength(1);
  });

  it('says what to finish by hand when the experiment is created but cannot start', async () => {
    const { api } = fakeLd(flagRoutes({ [`PATCH ${base}/premium-videos-start-training`]: [400, { message: 'no' }] }));
    const result = await stepExperiment({ api, project: 'p', envKey: 'test' }, flagExperiment);
    expect(result.status).toBe('manual');
    expect(result.detail).toContain('click Start');
  });

  it('builds the AI experiment from the AI Config variations', async () => {
    const { api, calls } = fakeLd({
      'GET /flags/p/canine-coach-chatbot': [200, { environments: { test: { version: 4 } } }],
      'GET /projects/p/ai-configs/canine-coach-chatbot': [200, { variations: [{ key: 'concise', _id: 'c1' }, { key: 'detailed', _id: 'd1' }] }],
      [`POST ${base}`]: [201, {}],
      [`PATCH ${base}/canine-coach-prompt-model`]: [200, {}],
    });
    const result = await stepExperiment({ api, project: 'p', envKey: 'test' }, EXPERIMENTS[1]);
    expect(result.status).toBe('created');
    expect(calls.some((c) => c.key.endsWith('/targeting'))).toBe(false); // the default rule is set by setup, not here
    const treatments = calls.find((c) => c.key === `POST ${base}`).body.iteration.treatments;
    expect(treatments.map((t) => [t.name, t.baseline, t.parameters[0].variationId])).toEqual([['Concise', true, 'c1'], ['Detailed', false, 'd1']]);
  });
});

describe('tearDownExperiments', () => {
  const base = '/projects/p/environments/test/experiments';

  it('stops a running experiment with its baseline as winner, then archives it', async () => {
    const running = { key: 'exp-1', currentIteration: { status: 'running', treatments: [{ _id: 't-a', baseline: false }, { _id: 't-b', baseline: true }] } };
    const { api, calls } = fakeLd({
      [`GET ${base}?limit=100`]: [200, { items: [running] }],
      [`GET ${base}/exp-1?expand=treatments`]: [200, running],
      [`PATCH ${base}/exp-1`]: [200, {}],
    });
    const results = await tearDownExperiments({ api, project: 'p', envKey: 'test' });
    expect(results.map((r) => r.status)).toEqual(['created']);
    const kinds = calls.filter((c) => c.key.startsWith('PATCH')).map((c) => c.body.instructions[0]);
    expect(kinds[0]).toMatchObject({ kind: 'stopIteration', winningTreatmentId: 't-b' });
    expect(kinds[1]).toEqual({ kind: 'archiveExperiment' });
  });

  it('archives a stopped experiment without stopping it, and never touches ld-example samples', async () => {
    const stopped = { key: 'exp-2', currentIteration: { status: 'stopped' } };
    const { api, calls } = fakeLd({
      [`GET ${base}?limit=100`]: [200, { items: [stopped, { key: 'ld-example-better-button-copy' }] }],
      [`GET ${base}/exp-2?expand=treatments`]: [200, stopped],
      [`PATCH ${base}/exp-2`]: [200, {}],
    });
    await tearDownExperiments({ api, project: 'p', envKey: 'test' });
    const patches = calls.filter((c) => c.key.startsWith('PATCH')).map((c) => c.body.instructions[0].kind);
    expect(patches).toEqual(['archiveExperiment']);
    expect(calls.some((c) => c.key.includes('ld-example'))).toBe(false);
  });

  it('does not try to stop a running experiment when no winner can be named', async () => {
    const running = { key: 'exp-3', currentIteration: { status: 'running' } };
    const { api, calls } = fakeLd({
      [`GET ${base}?limit=100`]: [200, { items: [running] }],
      [`GET ${base}/exp-3?expand=treatments`]: [200, running],
    });
    const results = await tearDownExperiments({ api, project: 'p', envKey: 'test' });
    expect(results[0].status).toBe('manual');
    expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(false);
  });

  it('reports a manual step when experiments cannot be listed', async () => {
    const { api } = fakeLd({});
    expect((await tearDownExperiments({ api, project: 'p', envKey: 'test' }))[0].status).toBe('manual');
  });
});

describe('deleteIfPresent', () => {
  it('treats deleted and already-gone as success, and reports anything else', async () => {
    const { api } = fakeLd({ 'DELETE /flags/p/a': [204, {}], 'DELETE /flags/p/c': [409, { message: 'in use by an experiment' }] });
    expect((await deleteIfPresent({ api }, 'flag a', '/flags/p/a')).status).toBe('created');
    expect((await deleteIfPresent({ api }, 'flag b', '/flags/p/b')).detail).toContain('not there');
    const blocked = await deleteIfPresent({ api }, 'flag c', '/flags/p/c');
    expect(blocked.status).toBe('manual');
    expect(blocked.detail).toContain('in use');
  });
});

describe('inspectTerraformState', () => {
  const state = (resources) => JSON.stringify({ resources });

  it('finds the project Terraform manages and whether it created that project', () => {
    const created = state([
      { mode: 'managed', type: 'launchdarkly_project', instances: [{ attributes: { key: 'cgc-test' } }] },
      { mode: 'managed', type: 'launchdarkly_feature_flag', instances: [{ attributes: { project_key: 'cgc-test' } }] },
    ]);
    expect(inspectTerraformState(created)).toEqual({ projectKey: 'cgc-test', ownsProject: true });
  });

  it('reads the project from the resources when Terraform did not create it', () => {
    const existing = state([{ mode: 'managed', type: 'launchdarkly_feature_flag', instances: [{ attributes: { project_key: 'default' } }] }]);
    expect(inspectTerraformState(existing)).toEqual({ projectKey: 'default', ownsProject: false });
  });

  it('ignores data sources and copes with an empty or broken state', () => {
    expect(inspectTerraformState(state([{ mode: 'data', type: 'launchdarkly_environment', instances: [{ attributes: { project_key: 'x' } }] }]))).toEqual({ projectKey: '', ownsProject: false });
    expect(inspectTerraformState('')).toEqual({ projectKey: '', ownsProject: false });
    expect(inspectTerraformState('not json')).toEqual({ projectKey: '', ownsProject: false });
  });
});
