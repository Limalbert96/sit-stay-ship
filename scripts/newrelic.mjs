// `npm run newrelic`: wires LaunchDarkly and New Relic together, both ways (see newrelic-lib.mjs).
// `npm run setup` runs the same steps when NR_USER_KEY is in .env.
//
//   npm run newrelic                          set everything up (safe to run again)
//   npm run newrelic -- --auto-remediation on   let the rage-click alert pull the kill switch itself
//   npm run newrelic -- --auto-remediation off  back to manual only (the default, for live demos)
//   npm run newrelic -- --status              is the automated kill switch on or off?
//
// Needs in .env: NR_USER_KEY (a New Relic user key, NRAK-...), NR_ACCOUNT_ID, LD_API_TOKEN, and the
// Terraform state from npm run setup (for the New Relic trigger's URL).
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { autoRemediationEnabled, nerdGraphClient, setAutoRemediation, setUpNewRelic } from './newrelic-lib.mjs';
import { TOKEN_HELP, getApiToken } from './token.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    'auto-remediation': { type: 'string' },
    status: { type: 'boolean', default: false },
  },
});

const icons = { created: '+', exists: '=', manual: '!' };
const report = (step, r) => console.log(`  [${icons[r.status]}] ${step}: ${r.detail}`);

{
  const env = process.env;
  const nerdgraph = env.NR_USER_KEY && nerdGraphClient({ userKey: env.NR_USER_KEY, url: env.NR_API_URL ?? 'https://api.newrelic.com/graphql' });
  if (!nerdgraph || !env.NR_ACCOUNT_ID) {
    console.error('Put NR_USER_KEY (a New Relic user key, NRAK-...) and NR_ACCOUNT_ID in .env first.');
    process.exit(1);
  }
  if (args.status) {
    const on = await autoRemediationEnabled(nerdgraph, { accountId: env.NR_ACCOUNT_ID });
    console.log(on === null ? 'No automated kill switch yet: run npm run newrelic.' : `Automated kill switch is ${on ? 'ON' : 'off'}.`);
    process.exit(0);
  }
  if (args['auto-remediation']) {
    const enabled = { on: true, off: false }[args['auto-remediation']];
    if (enabled === undefined) {
      console.error('Use --auto-remediation on or --auto-remediation off.');
      process.exit(1);
    }
    report('automated kill switch', await setAutoRemediation(nerdgraph, { accountId: env.NR_ACCOUNT_ID, enabled }));
    process.exit(0);
  }
  const token = await getApiToken();
  if (!token) {
    console.error(TOKEN_HELP);
    process.exit(1);
  }
  console.log('New Relic');
  for (const [step, r] of await setUpNewRelic({ token, project: env.LD_PROJECT_KEY ?? 'default' })) report(step, r);
}
