// `npm run dev`: starts the web app and the chat backend, and Ollama for the chatbot's local
// models if it is installed but not running. An Ollama that this command started is stopped
// again when you stop `npm run dev` (Ctrl-C); one that was already running (the desktop app, or
// your own `ollama serve`) is left alone. Without Ollama the chatbot uses canned replies.
import { spawn } from 'node:child_process';
import { hasOllamaCli, serverIsUp, startServer } from './ollama.mjs';

let ollama = null;
if (await serverIsUp()) {
  console.log('[ollama] already running, leaving it alone');
} else if (!hasOllamaCli()) {
  console.log('[ollama] not installed, so the chatbot will use canned replies (install it from https://ollama.com/download, see README)');
} else {
  const started = await startServer();
  ollama = started.child;
  console.log(started.up ? '[ollama] started for this session, it stops when you stop npm run dev' : '[ollama] could not start; run `ollama serve` in another terminal for real chatbot replies');
}

const dev = spawn('npx', ['concurrently', '-k', '-n', 'web,api', 'vite', 'npm:server'], { stdio: 'inherit', shell: process.platform === 'win32' });

const stop = (code = 0) => {
  ollama?.kill();
  process.exit(code);
};
dev.on('exit', (code) => stop(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    dev.kill(signal);
    stop(0);
  });
}
