// Loads .env for the Vite config, the chat backend and the traffic script.
//   LD_CLIENT_ID  browser SDK ID (public)
//   LD_SDK_KEY    server SDK key (secret, server-side only)
// Both must come from the SAME LaunchDarkly environment (this project uses "test").
import { existsSync } from 'node:fs';

// Values already set in the shell win over .env.
if (existsSync('.env')) process.loadEnvFile('.env');

// Client-side ID for the browser. Refuses a server SDK key ("sdk-..."), which would
// otherwise be bundled into public JavaScript if the two names get swapped in .env.
export function clientSideId() {
  const id = process.env.LD_CLIENT_ID ?? '';
  if (id.startsWith('sdk-')) {
    throw new Error(
      'LD_CLIENT_ID looks like a server-side SDK key. Put the Client-side ID there and the SDK key in LD_SDK_KEY.',
    );
  }
  return id;
}

export const sdkKey = () => process.env.LD_SDK_KEY;
