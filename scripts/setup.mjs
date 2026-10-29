// One-shot setup for anyone who clones this repo: `npm run setup`.
//
//   1. Terraform creates everything in LaunchDarkly: the project (if it does not exist yet), flags
//      with their targeting, the two metrics, the two flag triggers (the page's kill switch and New
//      Relic's), the AI Config with its models.
//   2. The outputs (client-side ID, SDK key, trigger URL) are written into .env.
//   3. The LaunchDarkly API (Terraform has no resource for these) sets the AI Config's default
//      rule so the chatbot works, then creates and starts the two experiments. With NR_USER_KEY
//      in .env it also wires New Relic: the integration, the rage-click alert and the automated
//      kill switch (created off).
//   4. Ollama is installed if you ask, started, and the two local models are pulled.
//
// Safe to run again. Needs Terraform (https://developer.hashicorp.com/terraform/install) and a
// LaunchDarkly API access token (Account settings, Authorization, Access tokens; role Admin to
// create the project, Writer is enough once it exists):
//
//   npm run setup                        (asks for the token the first time and can save it in .env)
//   npm run setup -- --dry-run           (terraform plan only; nothing is changed)
//
// Options: --project cgc-demo  --env test  --skip-models  --install-ollama  --no-experiments
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { EXPERIMENTS, createApi, envFromTerraformOutputs, inspectTerraformState, mergeEnv, stepAiConfigTargeting, stepExperiment } from './setup-lib.mjs';
import { setupOllama } from './ollama.mjs';
import { setUpNewRelic } from './newrelic-lib.mjs';
import { TOKEN_HELP, getApiToken } from './token.mjs';

if (existsSync('.env')) process.loadEnvFile('.env'); // real shell variables win over .env

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: process.env.LD_PROJECT_KEY || 'cgc-demo' },
    env: { type: 'string', default: process.env.LD_ENV_KEY || 'test' },
    'dry-run': { type: 'boolean', default: false },
    'skip-models': { type: 'boolean', default: false },
    'install-ollama': { type: 'boolean', default: false },
    'no-experiments': { type: 'boolean', default: false },
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
// Terraform creates the project when it does not exist yet, and keeps managing one it created
// (dropping create_project would make Terraform delete it). That is what lets teardown remove the
// whole project in one step. An existing project made some other way is only filled in.
const ctx = { api: createApi({ token }), project: args.project, envKey: args.env };
const createProject = known.ownsProject || (await ctx.api('GET', `/projects/${args.project}`)).status === 404;
const vars = ['-var', `project_key=${args.project}`, '-var', `environment_key=${args.env}`, ...(createProject ? ['-var', 'create_project=true'] : [])];

console.log(`Setting up LaunchDarkly project "${args.project}"${createProject && !known.ownsProject ? ' (new: Terraform creates it)' : ''}, environment "${args.env}"${dryRun ? ' (dry run: nothing is changed)' : ''}\n`);
console.log('1. Terraform');
if (terraform(['init', '-input=false']).status !== 0) process.exit(1);
if (dryRun) {
  const plan = terraform(['plan', '-input=false', ...vars]);
  process.exit(plan.status ?? 1);
}
if (terraform(['apply', '-auto-approve', '-input=false', ...vars]).status !== 0) {
  console.error(`\nTerraform did not finish. Read the error above.
  - "already exists": the project has the demo's resources from a run this folder's Terraform state does not know about. Run npm run teardown, then npm run setup.
  - a permissions error creating the project: creating "${args.project}" needs a token with the Admin or Owner role.`);
  process.exit(1);
}

console.log('\n2. .env');
const outputs = JSON.parse(terraform(['output', '-json'], { capture: true }).stdout || '{}');
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
// These belong to the project and environment just set up, so they replace older values.
// The project and environment are remembered so the other scripts (teardown, incident) use them too.
const updates = { ...envFromTerraformOutputs(outputs), LD_PROJECT_KEY: args.project, LD_ENV_KEY: args.env };
const merged = mergeEnv(readFileSync('.env', 'utf8'), updates, { overwrite: true });
if (merged.changed.length) writeFileSync('.env.bak', readFileSync('.env', 'utf8')); // keep your previous values
writeFileSync('.env', merged.text);
console.log(`  ${merged.changed.length ? `updated ${merged.changed.join(', ')} (previous file saved as .env.bak)` : 'already up to date'}`);

console.log('\n3. AI Config default rule (through the LaunchDarkly API)');
report('canine-coach-chatbot', await stepAiConfigTargeting(ctx));
if (!args['no-experiments']) {
  console.log('\n   Experiments (created and started)');
  for (const def of EXPERIMENTS) report(def.key, await stepExperiment(ctx, def));
}

// Optional: only with NR_USER_KEY in .env. The automated kill switch is created OFF, so a live demo
// stays manual; npm run newrelic -- --auto-remediation on switches it on.
if (process.env.NR_USER_KEY && process.env.NR_ACCOUNT_ID) {
  console.log('\n   New Relic (flag changes as change events; rage-click alert; automated kill switch, off)');
  for (const [step, r] of await setUpNewRelic({ token, project: args.project })) report(step, r);
}

console.log('\n4. Local chatbot models (Ollama)');
manual.push(...(await setupOllama({ install: args['install-ollama'], skipModels: args['skip-models'] })).manual);

console.log('\nStill to do by hand:');
console.log('  - Slack (optional): add LaunchDarkly\'s Slack app by hand (README, Integrations, Slack).');
if (manual.length) {
  console.log('\nThese steps did not complete on their own, so do them by hand:');
  for (const m of manual) console.log(`  - ${m}`);
}
console.log('\nNext:');
console.log('  1. Start the app:            npm run dev   (already running? Ctrl-C and start it again: it reads .env only at start)');
const newRelicConfigured = Boolean(process.env.NR_USER_KEY && process.env.NR_ACCOUNT_ID);
if (!args['no-experiments'] || newRelicConfigured) {
  console.log('  2. Generate demo data (allow a few minutes for the Results tab to update):');
  if (!args['no-experiments']) {
    console.log('       npm run simulate -- --target flag --users 5000');
    console.log('       npm run simulate -- --target ai --users 2000');
  }
  if (newRelicConfigured) {
    console.log('     Or play out a bad release (about 8 minutes, needs the app running and Chrome):');
    console.log('       npm run incident                        the script presses the kill switch');
    console.log('       npm run incident -- --auto-remediation  New Relic\'s alert turns the flag off');
  }
}
