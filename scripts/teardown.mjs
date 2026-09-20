// Removes everything the demo created in LaunchDarkly, so you can run `npm run setup` from
// scratch (for example to test the setup the way a first-time user would). It catches resources made by
// Terraform and also ones made by hand or by earlier versions of this project.
//
//   npm run teardown                (asks you to type the project key first)
//   npm run teardown -- --dry-run   (lists what it would do; changes nothing)
//   npm run teardown -- --yes       (no question)
//
// Order matters: experiments are stopped and archived first (they block deleting the flags they
// use and the API cannot delete them), then `terraform destroy`, then anything left over is
// deleted through the API. LaunchDarkly's own ld-example-* samples are never touched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  AI_CONFIG_KEY, DEMO_FLAG_KEYS, DEMO_METRIC_KEYS, createApi, deleteIfPresent, mergeEnv, tearDownExperiments,
} from './setup-lib.mjs';
import { TOKEN_HELP, getApiToken } from './token.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: process.env.LD_PROJECT_KEY || 'default' },
    env: { type: 'string', default: process.env.LD_ENV_KEY || 'test' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
const dryRun = args['dry-run'];
const token = await getApiToken();
if (!token) {
  console.error(TOKEN_HELP);
  process.exit(1);
}

console.log(`This deletes the CGC demo's flags, metrics, AI Config, trigger and experiments from LaunchDarkly
project "${args.project}"${dryRun ? ' (dry run: nothing is deleted)' : ''}. Other resources and the ld-example-* samples are left alone.`);
if (!dryRun && !args.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type the project key (${args.project}) to continue: `);
  rl.close();
  if (answer.trim() !== args.project) {
    console.log('Cancelled.');
    process.exit(1);
  }
}

const icons = { created: '-', exists: '=', manual: '!' };
const problems = [];
const report = (result) => {
  console.log(`  [${icons[result.status]}] ${result.detail}`);
  if (result.status === 'manual') problems.push(result.detail);
};
const ctx = { api: createApi({ token, dryRun }), project: args.project, envKey: args.env };

const tfEnv = { ...process.env, LAUNCHDARKLY_ACCESS_TOKEN: token, TF_IN_AUTOMATION: '1' };
const tf = (tfArgs) => spawnSync('terraform', ['-chdir=terraform', ...tfArgs], { env: tfEnv, encoding: 'utf8' });
const hasTerraform = spawnSync('terraform', ['version'], { stdio: 'ignore' }).status === 0;
const stateList = hasTerraform && existsSync('terraform/terraform.tfstate') ? tf(['state', 'list']).stdout.trim() : '';
const hasState = stateList !== '';
const ownsProject = stateList.split('\n').includes('launchdarkly_project.demo[0]');
const tfDestroy = () => spawnSync('terraform', ['-chdir=terraform', 'destroy', '-auto-approve', '-input=false', '-var', `project_key=${args.project}`, '-var', `environment_key=${args.env}`, ...(ownsProject ? ['-var', 'create_project=true'] : [])], { env: tfEnv, stdio: 'inherit' });

if (ownsProject) {
  // Setup created this project (--create-project), so deleting the project removes everything in
  // it, including experiments, which cannot be deleted one by one. Terraform would try to delete
  // each flag and metric first and LaunchDarkly refuses while an experiment uses them, so the
  // children are forgotten (removed from Terraform's state only, nothing is deleted) and just the
  // project is destroyed.
  const children = stateList.split('\n').filter((address) => address && address !== 'launchdarkly_project.demo[0]');
  console.log(`\nThe project "${args.project}" was created by npm run setup --create-project, so the whole project is deleted with everything in it (flags, metrics, experiments, AI Config).`);
  if (dryRun) console.log('  [=] Would delete the project "' + args.project + '" and everything in it.');
  else {
    if (children.length) tf(['state', 'rm', ...children]);
    if (tfDestroy().status !== 0) problems.push('Deleting the project did not finish; read the error above. Deleting a project needs a token with Admin or Owner permissions.');
  }
  if (problems.length) { console.log('\nSome things could not be removed:'); problems.forEach((p) => console.log(`  - ${p}`)); process.exit(1); }
  console.log('\nClean.');
  process.exit(0);
}

console.log('\n1. Experiments');
for (const result of await tearDownExperiments(ctx)) report(result);

console.log('\n2. Terraform');
if (!hasState) {
  console.log('  [=] No Terraform state here, so nothing to destroy with Terraform.');
} else if (dryRun) {
  console.log('  [=] Would run terraform destroy for:\n' + tf(['state', 'list']).stdout.trim().split('\n').map((l) => `      ${l}`).join('\n'));
} else if (tfDestroy().status !== 0) {
  problems.push('terraform destroy did not finish; read its error above.');
}

console.log('\n3. Anything left, deleted through the API');
report(await deleteIfPresent(ctx, `AI Config ${AI_CONFIG_KEY}`, `/projects/${args.project}/ai-configs/${AI_CONFIG_KEY}`, { beta: true }));
for (const key of DEMO_FLAG_KEYS) report(await deleteIfPresent(ctx, `flag ${key}`, `/flags/${args.project}/${key}`));
for (const key of DEMO_METRIC_KEYS) report(await deleteIfPresent(ctx, `metric ${key}`, `/metrics/${args.project}/${key}`));

if (existsSync('.env') && !dryRun) {
  const cleared = mergeEnv(readFileSync('.env', 'utf8'), { LD_TRIGGER_URL: '' }, { overwrite: true });
  if (readFileSync('.env', 'utf8').includes('LD_TRIGGER_URL=')) writeFileSync('.env', cleared.text);
}

if (problems.length) {
  console.log('\nSome things could not be removed:');
  for (const p of problems) console.log(`  - ${p}`);
  if (problems.some((p) => /still in use in the following experiments|in use by/i.test(p))) {
    console.log(`\nLaunchDarkly keeps experiments even after they are archived (they cannot be deleted through the API), and they\nstill block deleting the flags and metrics they used. To start over cleanly, use a scratch project instead:\n  npm run setup -- --project cgc-test --create-project      (and npm run teardown -- --project cgc-test deletes it all)`);
  }
  process.exit(1);
}
console.log(`\nClean. ${dryRun ? '' : 'Now try it from scratch: npm run setup'}`);
