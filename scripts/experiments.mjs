// Creates and starts the two experiments: `npm run experiments`. `npm run setup` already does this;
// use this to retry after a step reported a problem, or after --no-experiments.
//
//   - premium-videos-start-training: flag premium-video-tutorials, metric clicked-start-training
//   - canine-coach-prompt-model:     the AI Config, metric ai-response-helpful
//
// The flag experiment runs on the "trial users" rule, the AI experiment on the AI Config's default
// rule. Safe to run again; existing experiments are left alone. Then generate data with
// `npm run simulate` (see the README). It uses the project and environment that npm run setup
// remembered in .env (LD_PROJECT_KEY, LD_ENV_KEY), unless you pass --project and --env.
//
//   npm run experiments
//   npm run experiments -- --project cgc-test --env test --dry-run
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXPERIMENTS, createApi, stepExperiment } from './setup-lib.mjs';
import { TOKEN_HELP, getApiToken } from './token.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: process.env.LD_PROJECT_KEY || 'default' },
    env: { type: 'string', default: process.env.LD_ENV_KEY || 'test' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const token = await getApiToken();
if (!token) {
  console.error(TOKEN_HELP);
  process.exit(1);
}

const icons = { created: '+', exists: '=', manual: '!' };
const ctx = { api: createApi({ token, dryRun: args['dry-run'] }), project: args.project, envKey: args.env };
console.log(`Experiments in project "${args.project}", environment "${args.env}"${args['dry-run'] ? ' (dry run: nothing is changed)' : ''}\n`);

let problems = 0;
for (const def of EXPERIMENTS) {
  const result = await stepExperiment(ctx, def);
  console.log(`  [${icons[result.status]}] ${def.key}: ${result.detail}`);
  if (result.status === 'manual') problems += 1;
}

console.log('\nNext: generate data with');
console.log('  npm run simulate -- --target flag --users 5000');
console.log('  npm run simulate -- --target ai --users 2000');
console.log('then open Experiments in LaunchDarkly and read the Results tab (allow a few minutes).');
process.exit(problems ? 1 : 0);
