import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { clientSideId } from './server/env.js'

// Browser-visible settings. Only the values listed here reach the browser bundle;
// everything else in .env (SDK keys, API keys) stays server-side.
const browserEnv = {
  LD_CLIENT_ID: clientSideId(),
  NR_ACCOUNT_ID: process.env.NR_ACCOUNT_ID ?? '',
  NR_BROWSER_APP_ID: process.env.NR_BROWSER_APP_ID ?? '',
  NR_BROWSER_LICENSE_KEY: process.env.NR_BROWSER_LICENSE_KEY ?? '',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: Object.fromEntries(
    Object.entries(browserEnv).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  ),
  server: {
    // Forward chat API calls to the Node backend (npm run server).
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.js',
  },
})
