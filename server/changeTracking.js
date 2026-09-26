// Marks LaunchDarkly flag changes on New Relic entities (optional, Integrations).
//
// Why this exists: LaunchDarkly ships a New Relic integration that is meant to write every flag
// change into New Relic, but it posts to an API New Relic has retired, so nothing arrives (see the
// README). This is the workaround. The chat backend already holds a LaunchDarkly server SDK
// connection, which emits an event whenever a flag is edited, so it posts the change to New Relic's
// NerdGraph API itself, as a change tracking event of category FEATURE_FLAG.
//
// It posts one event per entity, to BOTH the APM entity (the Node backend) and the Browser entity
// (the React app), because New Relic attaches markers per entity: a marker on the APM service does
// not show on the browser charts. That is what makes "the flag flipped here" line up with the error
// spike on either chart.
//
// Needs, in .env:
//   NR_API_KEY       a New Relic USER key (starts with NRAK-). Not the license or browser key:
//                    those can only send telemetry, and NerdGraph rejects them.
//   NR_ACCOUNT_ID    the same account id the agents already use.
// Optional:
//   NR_APM_ENTITY_GUID, NR_BROWSER_ENTITY_GUID   skip the lookup and use these exact entities.
//   NR_API_URL       for EU accounts: https://api.eu.newrelic.com/graphql
//
// With no NR_API_KEY this module does nothing at all, like the rest of the New Relic support.
const DEFAULT_URL = 'https://api.newrelic.com/graphql';
const LOOKUP_TIMEOUT_MS = 5_000;

const nerdGraphUrl = () => process.env.NR_API_URL ?? DEFAULT_URL;

// Change tracking needs a user key; the agents' license keys cannot call NerdGraph.
export function changeTrackingEnabled(env = process.env) {
  return Boolean(env.NR_API_KEY && (env.NR_ACCOUNT_ID || (env.NR_APM_ENTITY_GUID && env.NR_BROWSER_ENTITY_GUID)));
}

// Finds the APM and Browser entities by the name the agents report under. Both agents in this
// project use the same name, so one search returns both and `domain` tells them apart.
export function entitySearchQuery({ name, accountId }) {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, "domain IN ('APM', 'BROWSER')"];
  if (accountId) clauses.push(`accountId = ${Number(accountId)}`);
  return `{ actor { entitySearch(query: "${clauses.join(' AND ')}") { results { entities { guid name domain } } } } }`;
}

// customAttributes is a custom GraphQL scalar, and a scalar literal cannot contain variables, so
// these few values are written into the query text. Anything outside the character set LaunchDarkly
// allows in a key is dropped first, so no value can end the string early and change the query.
const safe = (value) => String(value ?? '').replace(/[^\w.-]/g, '');

// The change event itself. `state` is the flag's on/off switch after the change ("on", "off", or
// undefined if it could not be read), and `viaKillSwitch` marks the changes the demo's kill-switch
// trigger caused, so a marker on a New Relic chart reads as the story rather than "something
// changed": the errors start, the kill switch fires, the errors stop.
//
// Every value except the custom attributes goes through GraphQL variables rather than string
// interpolation, so a quote in a flag key or a description cannot break the query.
export function flagChangeEvent({ guid, flagKey, state, viaKillSwitch = false, project, environment }) {
  const label = state === 'on' ? 'turned ON' : state === 'off' ? 'turned OFF' : 'changed';
  const where = `project ${project}, environment ${environment}`;
  return {
    query: `mutation($query: String!, $flagKey: String!, $user: String!, $shortDescription: String!, $description: String!) {
  changeTrackingCreateEvent(changeTrackingEvent: {
    categoryAndTypeData: {
      categoryFields: { featureFlag: { featureFlagId: $flagKey } }
      kind: { category: "FEATURE_FLAG", type: "BASIC" }
    }
    entitySearch: { query: $query }
    user: $user
    shortDescription: $shortDescription
    description: $description
    customAttributes: {
      flagKey: "${safe(flagKey)}"
      flagState: "${safe(state ?? 'unknown')}"
      trigger: "${viaKillSwitch ? 'kill-switch' : 'manual'}"
      project: "${safe(project)}"
      environment: "${safe(environment)}"
      source: "sit-stay-ship"
    }
  }) {
    changeTrackingEvent { changeTrackingId }
  }
}`,
    variables: {
      // The mutation's own search has to resolve to exactly one entity, so it matches on the GUID.
      query: `id = '${guid}'`,
      flagKey,
      user: viaKillSwitch ? 'LaunchDarkly kill switch' : 'LaunchDarkly (sit-stay-ship)',
      shortDescription: viaKillSwitch ? `${flagKey} turned OFF by the kill switch` : `${flagKey} ${label}`,
      description: viaKillSwitch
        ? `The kill switch fired: the flag "${flagKey}" was turned OFF in LaunchDarkly to stop a bad release, with no deploy (${where}).`
        : `The LaunchDarkly flag "${flagKey}" was ${label} (${where}).`,
    },
  };
}

async function postNerdGraph(body, { fetchImpl = fetch, apiKey = process.env.NR_API_KEY, timeoutMs } = {}) {
  const res = await fetchImpl(nerdGraphUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify(body),
    ...(timeoutMs && { signal: AbortSignal.timeout(timeoutMs) }),
  });
  const data = await res.json().catch(() => ({}));
  // NerdGraph answers 200 with an "errors" array, so the status alone does not say it worked.
  if (!res.ok) throw new Error(`New Relic returned status ${res.status}`);
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; '));
  return data.data;
}

// Picks the APM and Browser GUIDs out of a search result.
export function guidsFromSearch(data) {
  const entities = data?.actor?.entitySearch?.results?.entities ?? [];
  const find = (domain) => entities.find((e) => e.domain === domain)?.guid;
  return { apm: find('APM'), browser: find('BROWSER') };
}

let cached = null;

export async function resolveEntityGuids({ fetchImpl = fetch, env = process.env } = {}) {
  if (cached) return cached;
  const fromEnv = { apm: env.NR_APM_ENTITY_GUID, browser: env.NR_BROWSER_ENTITY_GUID };
  if (fromEnv.apm && fromEnv.browser) {
    cached = fromEnv;
    return cached;
  }
  const name = env.NR_APM_APP_NAME ?? 'Canine Good Citizen';
  const data = await postNerdGraph(
    { query: entitySearchQuery({ name, accountId: env.NR_ACCOUNT_ID }) },
    { fetchImpl, apiKey: env.NR_API_KEY, timeoutMs: LOOKUP_TIMEOUT_MS },
  );
  const found = guidsFromSearch(data);
  cached = { apm: fromEnv.apm ?? found.apm, browser: fromEnv.browser ?? found.browser };
  return cached;
}

// Posts one change event per entity. Returns which entities got a marker, so the caller can log it.
export async function recordFlagChange(flagKey, { state, viaKillSwitch = false, fetchImpl = fetch, env = process.env } = {}) {
  const guids = await resolveEntityGuids({ fetchImpl, env });
  const targets = Object.entries(guids).filter(([, guid]) => guid);
  if (!targets.length) throw new Error('no APM or Browser entity found in New Relic for this app name');

  const results = await Promise.allSettled(
    targets.map(([, guid]) =>
      postNerdGraph(
        flagChangeEvent({
          guid,
          flagKey,
          state,
          viaKillSwitch,
          project: env.LD_PROJECT_KEY ?? 'default',
          environment: env.LD_ENV_KEY ?? 'test',
        }),
        { fetchImpl, apiKey: env.NR_API_KEY },
      ),
    ),
  );
  const marked = targets.filter((_, i) => results[i].status === 'fulfilled').map(([kind]) => kind);
  const failed = results.find((r) => r.status === 'rejected');
  if (!marked.length) throw failed.reason;
  return { marked, error: failed?.reason };
}

// Test hook: the GUID lookup is cached for the life of the process.
export const resetEntityCache = () => { cached = null; };
