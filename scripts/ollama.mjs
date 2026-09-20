// Installs, starts and feeds Ollama (https://ollama.com), which runs the chatbot's local models.
import { spawn, spawnSync } from 'node:child_process';
import { DEMO_MODELS } from '../server/llm.js';

const URL_DEFAULT = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export const hasOllamaCli = () => spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;

export async function serverIsUp(url = URL_DEFAULT) {
  try {
    return (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// Installs with Homebrew on macOS. Elsewhere it returns the manual instruction instead of
// running an installer on your behalf.
export function installOllama() {
  if (process.platform === 'darwin' && spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0) {
    return spawnSync('brew', ['install', 'ollama'], { stdio: 'inherit' }).status === 0
      ? { ok: true }
      : { ok: false, hint: 'brew install ollama failed. Install it from https://ollama.com/download.' };
  }
  return { ok: false, hint: 'Install Ollama from https://ollama.com/download (Linux: https://ollama.com/download/linux), then run this again.' };
}

// Make sure an Ollama server is up. If one is already running (the desktop app, or an earlier
// `ollama serve`) it is left alone and `child` is null. Otherwise `ollama serve` is started as a
// child of this process and returned, so the caller can stop it again with child.kill().
export async function startServer(url = URL_DEFAULT) {
  if (await serverIsUp(url)) return { up: true, child: null };
  const child = spawn('ollama', ['serve'], { stdio: 'ignore' });
  child.on('error', () => {});
  process.on('exit', () => child.kill()); // never leave a server we started behind
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 750));
    if (await serverIsUp(url)) return { up: true, child };
  }
  child.kill();
  return { up: false, child: null };
}

export const pullModel = (model) => spawnSync('ollama', ['pull', model], { stdio: 'inherit' }).status === 0;

// Install (optional), start and feed Ollama with the demo models. Needs no LaunchDarkly account or
// token. Used by `npm run ollama` and as the last step of `npm run setup`. Returns anything that
// needs doing by hand.
export async function setupOllama({ install = false, skipModels = false, models = DEMO_MODELS, log = console.log } = {}) {
  const manual = [];
  if (!hasOllamaCli() && install) {
    const installed = installOllama();
    if (!installed.ok) manual.push(installed.hint);
  }
  if (!hasOllamaCli()) {
    log('  [!] Ollama is not installed. Run npm run ollama, or install it from https://ollama.com/download.');
    log('      Without it the chatbot still works, with canned replies.');
    return { manual };
  }
  if (skipModels) {
    log('  [=] Model download skipped.');
    return { manual };
  }
  const server = await startServer();
  if (!server.up) {
    manual.push(`Ollama is installed but its server did not start: run "ollama serve" in another terminal, then "ollama pull ${models.join(' ')}".`);
    return { manual };
  }
  for (const model of models) {
    log(`  Pulling ${model} (skipped by Ollama if you already have it)`);
    if (!pullModel(model)) manual.push(`Could not pull ${model}: run "ollama pull ${model}".`);
  }
  log('  [+] Models are ready. (npm run dev starts and stops Ollama for you.)');
  server.child?.kill(); // stop the server this script started; npm run dev starts it again when needed
  return { manual };
}
