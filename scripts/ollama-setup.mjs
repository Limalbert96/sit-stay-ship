// `npm run ollama`: installs Ollama (macOS with Homebrew; elsewhere it tells you where to get it),
// starts it, and downloads the two local models the chatbot uses (about 3.3 GB). It needs no
// LaunchDarkly account and no API token: run it any time, on its own or before `npm run setup`.
//
//   npm run ollama
//   npm run ollama -- --no-install     (do not install Ollama, only download the models)
//   npm run ollama -- --skip-models    (install and start only)
import { parseArgs } from 'node:util';
import { setupOllama } from './ollama.mjs';

const { values: args } = parseArgs({
  options: {
    'no-install': { type: 'boolean', default: false },
    'skip-models': { type: 'boolean', default: false },
  },
});

console.log('Local chatbot models (Ollama)');
const { manual } = await setupOllama({ install: !args['no-install'], skipModels: args['skip-models'] });
if (manual.length) {
  console.log('\nThese steps did not complete on their own, so do them by hand:');
  for (const m of manual) console.log(`  - ${m}`);
  process.exit(1);
}
