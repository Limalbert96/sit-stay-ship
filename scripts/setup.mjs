// One-shot setup for anyone who clones this repo: `npm run setup`.
//
//   1. Terraform creates everything in LaunchDarkly: flags with their targeting, the two metrics,
//      the flag trigger (kill switch), the AI Config with its models, optionally Slack.
//   2. The outputs (client-side ID, SDK key, trigger URL) are written into .env.
//   3. The LaunchDarkly API (Terraform has no resource for these) sets the AI Config's default
//      rule so the chatbot works, then creates and starts the two experiments.
//   4. Ollama is installed if you ask, started, and the two local models are pulled.
//
// Safe to run again. Needs Terraform (https://developer.hashicorp.com/terraform/install) and a
// LaunchDarkly API access token (Account settings, Authorization, Access tokens, role Writer):
//
//   npm run setup                        (asks for the token the first time and can save it in .env)
//   export LD_API_TOKEN=api-...          (or set it yourself, or put LD_API_TOKEN=... in .env)
//   npm run setup -- --dry-run           (terraform plan only; nothing is changed)
//
// Options: --project default  --env test  --skip-models  --install-ollama  --no-experiments
//          --slack-webhook-url <url>
//          --create-project   create a brand-new project with the key given by --project (a scratch
//                             space to try everything from scratch; delete it with npm run teardown)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { EXPERIMENTS, createApi, envFromTerraformOutputs, inspectTerraformState, mergeEnv, stepAiConfigTargeting, stepExperiment } from './setup-lib.mjs';
import { setupOllama } from './ollama.mjs';
import { TOKEN_HELP, getApiToken } from './token.mjs';

if (existsSync('.env')) process.loadEnvFile('.env'); // real shell variables win over .env

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: process.env.LD_PROJECT_KEY || 'default' },
    env: { type: 'string', default: process.env.LD_ENV_KEY || 'test' },
    'dry-run': { type: 'boolean', default: false },
    'skip-models': { type: 'boolean', default: false },
    'install-ollama': { type: 'boolean', default: false },
    'no-experiments': { type: 'boolean', default: false },
    'slack-webhook-url': { type: 'string', default: '' },
    'create-project': { type: 'boolean', default: false },
  },
});
const dryRun = args['dry-run'];

const token = await getApiToken(); // from the shell or .env, or asked for in a terminal
if (!token) {
  console.error(TOKEN_HELP + '\nThen run npm run setup again.');
  process.exit(1);
}
if (spawnSync('terraform', ['version'], { stdio: 'ignore' }).status !== 0) {
  console.error(`Terraform is not installed. Install it (macOS: brew tap hashicorp/tap && brew install hashicorp/tap/terraform,
or https://developer.hashicorp.com/terraform/install), then run npm run setup again.`);
  process.exit(1);
}

const icons = { created: '+', exists: '=', manual: '!' };
const manual = [];
const report = (step, result) => {
  console.log(`  [${icons[result.status]}] ${step}: ${result.detail}`);
  if (result.status === 'manual') manual.push(`${step}: ${result.detail}`);
};

// Run terraform in ./terraform with the token passed the way the provider expects.
const tfEnv = {
  ...process.env,
  LAUNCHDARKLY_ACCESS_TOKEN: token,
  TF_IN_AUTOMATION: '1',
  ...(args['slack-webhook-url'] && { TF_VAR_slack_webhook_url: args['slack-webhook-url'] }),
};
const terraform = (tfArgs, options = {}) =>
  spawnSync('terraform', ['-chdir=terraform', ...tfArgs], { env: tfEnv, encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
// Terraform's state remembers which project it manages. Refuse to point it at another one (it would
// delete the resources in the first), and keep managing a project that Terraform created.
const stateFile = 'terraform/terraform.tfstate';
const known = inspectTerraformState(existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '');
if (known.projectKey && known.projectKey !== args.project) {
  console.error(`This folder's Terraform state belongs to the LaunchDarkly project "${known.projectKey}", but you asked for "${args.project}".
Running setup against another project would delete what Terraform created in "${known.projectKey}".
Remove that first with:  npm run teardown -- --project ${known.projectKey}
then run setup again.`);
  process.exit(1);
}
const createProject = args['create-project'] || known.ownsProject;
const vars = ['-var', `project_key=${args.project}`, '-var', `environment_key=${args.env}`, ...(createProject ? ['-var', 'create_project=true'] : [])];

console.log(`Setting up LaunchDarkly project "${args.project}", environment "${args.env}"${dryRun ? ' (dry run: nothing is changed)' : ''}\n`);
console.log('1. Terraform');
if (terraform(['init', '-input=false']).status !== 0) process.exit(1);
if (dryRun) {
  const plan = terraform(['plan', '-input=false', ...vars]);
  process.exit(plan.status ?? 1);
}
if (terraform(['apply', '-auto-approve', '-input=false', ...vars]).status !== 0) {
  console.error('\nTerraform did not finish. Read the error above. If it says a resource "already exists", run npm run teardown first.');
  process.exit(1);
}

console.log('\n2. .env');
const outputs = JSON.parse(terraform(['output', '-json'], { capture: true }).stdout || '{}');
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
// These belong to the project and environment just set up, so they replace older values.
// The project and environment are remembered so npm run experiments and npm run teardown use them too.
const updates = { ...envFromTerraformOutputs(outputs), LD_PROJECT_KEY: args.project, LD_ENV_KEY: args.env };
const merged = mergeEnv(readFileSync('.env', 'utf8'), updates, { overwrite: true });
if (merged.changed.length) writeFileSync('.env.bak', readFileSync('.env', 'utf8')); // keep your previous values
writeFileSync('.env', merged.text);
console.log(`  ${merged.changed.length ? `updated ${merged.changed.join(', ')} (previous file saved as .env.bak)` : 'already up to date'}`);

const ctx = { api: createApi({ token }), project: args.project, envKey: args.env };
console.log('\n3. AI Config default rule (through the LaunchDarkly API)');
report('canine-coach-chatbot', await stepAiConfigTargeting(ctx));
if (!args['no-experiments']) {
  console.log('\n   Experiments (created and started)');
  for (const def of EXPERIMENTS) report(def.key, await stepExperiment(ctx, def));
}

console.log('\n4. Local chatbot models (Ollama)');
manual.push(...(await setupOllama({ install: args['install-ollama'], skipModels: args['skip-models'] })).manual);

console.log('\nStill to do by hand:');
console.log('  - Slack (optional): npm run setup -- --slack-webhook-url <url>, or Organization settings, Integrations, Slack.');
if (manual.length) {
  console.log('\nThese steps did not complete on their own, so do them by hand:');
  for (const m of manual) console.log(`  - ${m}`);
}
console.log('\nNext:');
console.log('  1. Start the app:            npm run dev   (already running? Ctrl-C and start it again: it reads .env only at start)');
if (!args['no-experiments']) {
  console.log('  2. Generate experiment data (allow a few minutes for the Results tab to update):');
  console.log('       npm run simulate -- --target flag --users 5000');
  console.log('       npm run simulate -- --target ai --users 2000');
}
