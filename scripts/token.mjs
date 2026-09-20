// Gets the LaunchDarkly API access token for `npm run setup` and `npm run teardown`.
// Order: LD_API_TOKEN from the shell or .env; otherwise, in a terminal, ask for it (hidden input),
// check it against LaunchDarkly, and offer to save it in .env so it is only asked for once.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { mergeEnv } from './setup-lib.mjs';

const API = 'https://app.launchdarkly.com/api/v2';

// Catches the usual mix-ups: an SDK key or mobile key pasted instead of the API token.
export function tokenProblem(token) {
  if (!token) return 'Nothing entered.';
  if (/\s/.test(token)) return 'A token has no spaces. Paste just the token.';
  if (token.startsWith('sdk-') || token.startsWith('mob-')) {
    return 'That is an SDK or mobile key. The API access token is a different thing (it starts with "api-").';
  }
  if (token.length < 20) return 'That looks too short to be an API access token.';
  return '';
}

// Asks LaunchDarkly who the token belongs to. `valid` is false only for a definite rejection, so a
// network hiccup does not block setup.
export async function verifyToken(token, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${API}/caller-identity`, { headers: { Authorization: token } });
    if (res.status === 401 || res.status === 403) return { valid: false };
    const data = await res.json().catch(() => ({}));
    return { valid: true, who: data.email ?? data.name ?? '' };
  } catch {
    return { valid: true, who: '', unchecked: true };
  }
}

const ENTER = new Set(['\r', '\n']);
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = new Set([String.fromCharCode(127), String.fromCharCode(8)]);

// Read one line without echoing it (a token is a secret, and terminals keep scrollback).
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ENTER.has(ch)) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === CTRL_C) process.exit(130);
        value = BACKSPACE.has(ch) ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

export async function getApiToken({ envPath = '.env' } = {}) {
  if (process.env.LD_API_TOKEN) return process.env.LD_API_TOKEN;
  if (!process.stdin.isTTY) return '';

  console.log(`LaunchDarkly API access token needed (only for setup and teardown; the app never uses it).
Create one in LaunchDarkly: Account settings, Authorization, Access tokens, Create token, role Writer.
It starts with "api-". Your input is hidden.
`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await askHidden('LaunchDarkly API access token: ');
    const problem = tokenProblem(token);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    const check = await verifyToken(token);
    if (!check.valid) {
      console.log('  LaunchDarkly rejected that token. Check that you copied all of it and that its role is Writer.');
      continue;
    }
    console.log(check.unchecked ? '  (could not reach LaunchDarkly to check it, continuing)' : `  Token accepted${check.who ? ` (${check.who})` : ''}.`);

    process.env.LD_API_TOKEN = token;
    if (await askYesNo('Save it in .env so you are not asked again? It is git-ignored. [Y/n] ')) {
      if (!existsSync(envPath) && existsSync('.env.example')) copyFileSync('.env.example', envPath);
      const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      writeFileSync(envPath, mergeEnv(text, { LD_API_TOKEN: token }, { overwrite: true }).text);
      console.log('  Saved to .env.');
    }
    console.log('');
    return token;
  }
  return '';
}

export const TOKEN_HELP = `LD_API_TOKEN is not set.

Create an API access token in LaunchDarkly (Account settings, Authorization, Access tokens,
Create token, role Writer), then either run this in a terminal and paste it when asked, or:

  export LD_API_TOKEN=api-xxxxxxxx
`;
