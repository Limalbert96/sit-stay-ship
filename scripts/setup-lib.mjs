// Building blocks for `npm run setup` (scripts/setup.mjs) and `npm run teardown`
// (scripts/teardown.mjs). Kept free of console and file access so they can be unit tested
// with a fake fetch.
//
// Terraform (terraform/) creates the flags, targeting, metrics, trigger and AI Config. What is
// left for the LaunchDarkly API, because the Terraform provider has no resource for it, is the
// AI Config's default rule and the experiments (below).

const API = 'https://app.launchdarkly.com/api/v2';
const PLACEHOLDER = /^(your-|sdk-your-)/;

// ---- .env handling -------------------------------------------------------------------

// Set KEY=value lines in .env text. Existing real values are kept unless overwrite is set;
// empty values and the placeholders from .env.example are replaced. Comments are preserved.
export function mergeEnv(text, updates, { overwrite = false } = {}) {
  const lines = text.split('\n');
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at === -1) {
      const commented = lines.findIndex((l) => l.startsWith(`# ${key}=`));
      if (commented === -1) lines.push(`${key}=${value}`);
      else lines[commented] = `${key}=${value}`;
      changed.push(key);
      continue;
    }
    const current = lines[at].slice(key.length + 1).trim();
    if (overwrite || current === '' || PLACEHOLDER.test(current)) {
      lines[at] = `${key}=${value}`;
      changed.push(key);
    }
  }
  return { text: lines.join('\n'), changed };
}

export function readEnvValue(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  const value = line?.slice(key.length + 1).trim() ?? '';
  return value && !PLACEHOLDER.test(value) ? value : '';
}

// What Terraform's state file says about this checkout: which LaunchDarkly project its resources
// belong to, and whether Terraform created that project (--create-project). Setup uses it to avoid
// two dangerous mistakes: pointing existing state at a different project (Terraform would delete
// the resources in the old one), and dropping create_project (Terraform would delete the project).
export function inspectTerraformState(stateText) {
  let state;
  try { state = JSON.parse(stateText || '{}'); } catch { return { projectKey: '', ownsProject: false }; }
  let projectKey = '';
  let ownsProject = false;
  for (const resource of state.resources ?? []) {
    if (resource.mode !== 'managed') continue;
    for (const instance of resource.instances ?? []) {
      const attributes = instance.attributes ?? {};
      if (resource.type === 'launchdarkly_project') {
        ownsProject = true;
        projectKey = attributes.key || projectKey;
      } else if (!projectKey && attributes.project_key) {
        projectKey = attributes.project_key;
      }
    }
  }
  return { projectKey, ownsProject };
}

// `terraform output -json` -> the .env entries the app needs.
export function envFromTerraformOutputs(outputs) {
  const value = (name) => outputs?.[name]?.value;
  return Object.fromEntries(
    Object.entries({
      LD_CLIENT_ID: value('client_side_id'),
      LD_SDK_KEY: value('sdk_key'),
      LD_TRIGGER_URL: value('trigger_url'),
    }).filter(([, v]) => v),
  );
}

// ---- LaunchDarkly REST client ----------------------------------------------------------

export function createApi({ token, fetchImpl = fetch, dryRun = false }) {
  return async function request(method, path, body, { beta = false } = {}) {
    const semanticPatch = method === 'PATCH' && Array.isArray(body?.instructions);
    const headers = {
      Authorization: token,
      'Content-Type': semanticPatch ? 'application/json; domain-model=launchdarkly.semanticpatch' : 'application/json',
      ...(beta && { 'LD-API-Version': 'beta' }),
    };
    if (dryRun && method !== 'GET') {
      console.log(`[dry run] ${method} ${path} ${body ? JSON.stringify(body) : ''}`);
      return { status: 0, data: {} };
    }
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

export const ok = (status) => status >= 200 && status < 300;
export const failed = (what, res) => ({ status: 'manual', detail: `${what} (LaunchDarkly answered ${res.status}: ${res.data?.message ?? 'no message'})` });

// ---- AI Config default rule and experiments ------------------------------------------------
// Each step returns { status: 'created' | 'exists' | 'manual', detail } and never throws, so
// one failing step does not stop the rest.

export const AI_CONFIG_KEY = 'canine-coach-chatbot';

export const EXPERIMENTS = [
  {
    key: 'premium-videos-start-training',
    name: 'Premium Videos: Start Training Conversion',
    description: 'Do visitors click Start Training more often when the premium video tutorials are shown?',
    hypothesis: 'Showing the premium video tutorials will increase the rate at which visitors click Start Training.',
    metricKey: 'clicked-start-training',
    kind: 'flag',
    flagKey: 'premium-video-tutorials',
    ruleDescription: 'Trial users (experiment audience)',
  },
  {
    key: 'canine-coach-prompt-model',
    name: 'Canine Coach: Concise vs Detailed Prompt and Model',
    description: 'Compares the two AI Config variations of the chatbot on how often users rate the reply helpful.',
    hypothesis: 'The detailed prompt on the larger model will earn more thumbs-up than the concise prompt on the small model, because it explains the reasoning behind each CGC test item.',
    metricKey: 'ai-response-helpful',
    kind: 'ai',
    flagKey: AI_CONFIG_KEY,
  },
];

// Serve Concise and Detailed 50/50 by default (a new AI Config serves "disabled" until told
// otherwise, so the chatbot would show "switched off"). The AI experiment runs on this default rule.
export async function stepAiConfigTargeting({ api, project, envKey }) {
  const config = await api('GET', `/projects/${project}/ai-configs/${AI_CONFIG_KEY}`, undefined, { beta: true });
  if (!ok(config.status)) return failed('Could not read the AI Config to set its targeting', config);
  const idOf = (key) => (config.data.variations ?? []).find((v) => v.key === key)?._id;
  const [concise, detailed] = [idOf('concise'), idOf('detailed')];
  if (!concise || !detailed) return { status: 'manual', detail: 'The AI Config has no concise and detailed variations to serve' };
  const res = await api('PATCH', `/projects/${project}/ai-configs/${AI_CONFIG_KEY}/targeting`, {
    environmentKey: envKey,
    instructions: [{ kind: 'updateFallthroughVariationOrRollout', rolloutContextKind: 'user', rolloutWeights: { [concise]: 50000, [detailed]: 50000 } }],
    comment: 'Created by npm run setup: 50/50 split for the experiment',
  }, { beta: true });
  if (!ok(res.status) && res.status !== 0) return failed('Could not set the AI Config default rule to a 50/50 split', res);
  return { status: 'created', detail: `${AI_CONFIG_KEY}: default rule serves Concise and Detailed 50/50` };
}

// Create an experiment and start it. The flag experiment runs on the flag's "trial users" rule
// (a 50/50 rollout that Terraform creates); the AI experiment runs on the AI Config's default rule
// (a 50/50 split, see stepAiConfigTargeting). If the experiment API refuses, the step reports what
// to finish by hand.
export async function stepExperiment({ api, project, envKey }, def) {
  const base = `/projects/${project}/environments/${envKey}/experiments`;
  if (ok((await api('GET', `${base}/${def.key}`)).status)) return { status: 'exists', detail: `${def.key}: already exists, left as is` };

  const flag = await api('GET', `/flags/${project}/${def.flagKey}`);
  if (!ok(flag.status)) return failed(`Could not read ${def.flagKey} to build the experiment`, flag);

  let treatments;
  let ruleId = 'fallthrough'; // the AI Config's default rule; a flag experiment uses its own rule
  if (def.kind === 'flag') {
    const on = flag.data.variations?.find((v) => v.value === true)?._id;
    const off = flag.data.variations?.find((v) => v.value === false)?._id;
    // The experiment runs on the "trial users" rule that Terraform created (a 50/50 rollout).
    const rule = (flag.data.environments?.[envKey]?.rules ?? []).find((r) => r.description === def.ruleDescription);
    if (!rule?._id) return { status: 'manual', detail: `${def.key}: the rule "${def.ruleDescription}" was not found on ${def.flagKey}. Run terraform apply (npm run setup) first.` };
    ruleId = rule._id;
    if (flag.data.environments?.[envKey]?.on === false) {
      return { status: 'manual', detail: `${def.key}: ${def.flagKey} is off in ${envKey}, and an experiment cannot start on a flag that is off. Turn it on, then run npm run experiments.` };
    }
    treatments = [
      { name: 'Videos shown', baseline: false, variationId: on },
      { name: 'Videos hidden', baseline: true, variationId: off },
    ];
  } else {
    const config = await api('GET', `/projects/${project}/ai-configs/${def.flagKey}`, undefined, { beta: true });
    const idOf = (key) => (config.data.variations ?? []).find((v) => v.key === key)?._id;
    treatments = [
      { name: 'Concise', baseline: true, variationId: idOf('concise') },
      { name: 'Detailed', baseline: false, variationId: idOf('detailed') },
    ];
  }

  // The version changes when the default rule is edited, so read it after that edit.
  const fresh = await api('GET', `/flags/${project}/${def.flagKey}`);
  const version = fresh.data.environments?.[envKey]?.version ?? flag.data.environments?.[envKey]?.version;

  const build = (allocationPercent) => ({
    key: def.key, name: def.name, description: def.description,
    iteration: {
      hypothesis: def.hypothesis, canReshuffleTraffic: false, randomizationUnit: 'user',
      metrics: [{ key: def.metricKey, isGroup: false }], primarySingleMetricKey: def.metricKey,
      treatments: treatments.map((t) => ({
        name: t.name, baseline: t.baseline, allocationPercent, parameters: [{ flagKey: def.flagKey, variationId: t.variationId }],
      })),
      flags: { [def.flagKey]: { ruleId, flagConfigVersion: version } },
    },
  });
  // The API documents the percentage as a string; some versions take a number, so try both.
  let created = await api('POST', base, build('50'));
  if (created.status === 400) created = await api('POST', base, build(50));
  if (!ok(created.status) && created.status !== 0) return failed(`Could not create experiment ${def.key}`, created);

  const started = await api('PATCH', `${base}/${def.key}`, { instructions: [{ kind: 'startIteration', changeJustification: 'Started by npm run setup' }] });
  if (!ok(started.status) && started.status !== 0) {
    return { status: 'manual', detail: `${def.key}: created as a draft but not started (${started.data?.message ?? started.status}). Open it in LaunchDarkly and click Start.` };
  }
  return { status: 'created', detail: `${def.key}: created and started` };
}

// ---- Teardown ---------------------------------------------------------------------------------

// Everything the demo has ever created, so a clean-up also catches resources made by hand or by
// earlier versions of this project. Sample resources from LaunchDarkly (ld-example-*) are left alone.
export const DEMO_FLAG_KEYS = ['premium-video-tutorials', 'exam-progress-tracker', 'ai-chatbot-config', 'beta-exam-tracker'];
export const DEMO_METRIC_KEYS = ['clicked-start-training', 'ai-response-helpful'];

// Stop (if running) and archive every non-sample experiment in the environment. Experiments
// block deleting the flags they use, and they cannot be deleted through the API, only archived.
export async function tearDownExperiments({ api, project, envKey }) {
  const base = `/projects/${project}/environments/${envKey}/experiments`;
  const list = await api('GET', `${base}?limit=100`);
  if (!ok(list.status)) return [failed('Could not list experiments', list)];
  const results = [];
  for (const item of (list.data.items ?? []).filter((e) => !e.key.startsWith('ld-example'))) {
    // treatments (needed to name a winner when stopping) only come back when asked for
    const detail = await api('GET', `${base}/${item.key}?expand=treatments`);
    const iteration = detail.data.currentIteration ?? item.currentIteration ?? {};
    if (iteration.status === 'running') {
      const winner = (iteration.treatments ?? []).find((t) => t.baseline) ?? iteration.treatments?.[0];
      const winnerId = winner?._id ?? winner?.id;
      if (!winnerId) { results.push({ status: 'manual', key: item.key, detail: `Could not stop experiment ${item.key}: no treatments found to name a winner. Stop it in LaunchDarkly.` }); continue; }
      const stopped = await api('PATCH', `${base}/${item.key}`, { instructions: [{ kind: 'stopIteration', winningTreatmentId: winnerId, winningReason: 'Stopped by npm run teardown' }] });
      if (!ok(stopped.status) && stopped.status !== 0) { results.push({ ...failed(`Could not stop experiment ${item.key}`, stopped), key: item.key }); continue; }
    }
    if (iteration.archived === true || item.archived === true) { results.push({ status: 'exists', key: item.key, detail: `${item.key}: already archived` }); continue; }
    const archived = await api('PATCH', `${base}/${item.key}`, { instructions: [{ kind: 'archiveExperiment' }] });
    results.push(ok(archived.status) || archived.status === 0
      ? { status: 'created', key: item.key, detail: `${item.key}: stopped and archived` }
      : { ...failed(`Could not archive experiment ${item.key}`, archived), key: item.key });
  }
  return results;
}

// Delete one resource; "already gone" (404) counts as success so the clean-up can be re-run.
export async function deleteIfPresent({ api }, label, path, options) {
  const res = await api('DELETE', path, undefined, options);
  if (res.status === 404) return { status: 'exists', detail: `${label}: not there` };
  if (ok(res.status) || res.status === 0) return { status: 'created', detail: `${label}: deleted` };
  return failed(`Could not delete ${label}`, res);
}
