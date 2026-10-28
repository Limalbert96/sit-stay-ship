// `npm run check:newrelic:cleanup`: removes what `npm run check:newrelic` leaves behind when it is run
// with --keep, or when it crashed before cleaning up: its scratch LaunchDarkly projects and its
// temporary New Relic subscriptions.
//
//   npm run check:newrelic:cleanup                      everything the check ever made
//   npm run check:newrelic:cleanup -- nr-check-ab12cd   just that run
//   npm run check:newrelic:cleanup -- --dry-run         lists what it would delete; changes nothing
//
// It only ever touches projects whose key starts with nr-check- and subscriptions named
// "<app> (check xxxxxx) [APM|Browser]", so the demo project and its real subscriptions are safe.
// New Relic keeps the change events already recorded; they cannot be deleted.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CHECK_PROJECT_PREFIX, NEW_RELIC_INTEGRATION, isCheckSubscription } from './newrelic-lib.mjs';
import { createApi, ok } from './setup-lib.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args, positionals } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  allowPositionals: true,
});
const only = positionals[0];

if (!process.env.LD_API_TOKEN) {
  console.error('Put LD_API_TOKEN in .env first.');
  process.exit(1);
}
if (only && !only.startsWith(CHECK_PROJECT_PREFIX)) {
  console.error(`"${only}" is not a project the check made (its key starts with ${CHECK_PROJECT_PREFIX}). Nothing was deleted.`);
  process.exit(1);
}

const dryRun = args['dry-run'];
const api = createApi({ token: process.env.LD_API_TOKEN, dryRun });
let problems = 0;
const report = (res, what) => {
  // A dry run answers status 0 to anything that would change something.
  const done = res.status === 0 ? `would delete ${what}` : ok(res.status) || res.status === 404 ? `deleted ${what}` : null;
  if (!done) problems += 1;
  console.log(`  [${done ? '-' : '!'}] ${done ?? `could not delete ${what} (LaunchDarkly answered ${res.status}: ${res.data?.message ?? 'no message'})`}`);
};

console.log(`Looking for what npm run check:newrelic left behind${only ? ` (${only})` : ''}${dryRun ? ' (dry run: nothing is deleted)' : ''}`);

const projects = (await api('GET', '/projects?limit=200')).data.items ?? [];
const keys = projects.map((p) => p.key).filter((key) => key.startsWith(CHECK_PROJECT_PREFIX) && (!only || key === only));
const subscriptions = ((await api('GET', `/integrations/${NEW_RELIC_INTEGRATION}`)).data.items ?? []).filter((s) => isCheckSubscription(s.name, only));

for (const key of keys) report(await api('DELETE', `/projects/${key}`), `scratch project ${key}`);
for (const s of subscriptions) report(await api('DELETE', `/integrations/${NEW_RELIC_INTEGRATION}/${s._id}`), `subscription "${s.name}"`);
if (!keys.length && !subscriptions.length) console.log('  [=] nothing to clean up');

process.exit(problems ? 1 : 0);
