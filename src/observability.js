// New Relic browser agent (Integrations).
//
// Configure via .env (see .env.example): NR_ACCOUNT_ID, NR_BROWSER_APP_ID, NR_BROWSER_LICENSE_KEY. Values come from New Relic:
//   Add data -> Browser monitoring -> Copy/paste snippet. They are browser
//   ingest identifiers, not secrets, but we keep them out of source control anyway.
// Without them the app runs normally and this module is a no-op.
import { BrowserAgent } from '@newrelic/browser-agent/loaders/browser-agent';

// Vite replaces each import.meta.env.NR_* below at build time (see vite.config.js).
export const nrEnabled = Boolean(
  import.meta.env.NR_ACCOUNT_ID && import.meta.env.NR_BROWSER_APP_ID && import.meta.env.NR_BROWSER_LICENSE_KEY,
);

const agent = nrEnabled
  ? new BrowserAgent({
      init: {
        distributed_tracing: { enabled: true },
        privacy: { cookies_enabled: true },
        ajax: { deny_list: ['bam.nr-data.net'] },
        // Replays are fully masked so no typed chat text leaves the browser.
        session_replay: {
          enabled: true,
          sampling_rate: 100,
          error_sampling_rate: 100,
          mask_all_inputs: true,
          mask_text_selector: '*',
        },
      },
      info: {
        beacon: 'bam.nr-data.net',
        errorBeacon: 'bam.nr-data.net',
        licenseKey: import.meta.env.NR_BROWSER_LICENSE_KEY,
        applicationID: import.meta.env.NR_BROWSER_APP_ID,
        sa: 1,
      },
      loader_config: {
        accountID: import.meta.env.NR_ACCOUNT_ID,
        trustKey: import.meta.env.NR_ACCOUNT_ID,
        agentID: import.meta.env.NR_BROWSER_APP_ID,
        licenseKey: import.meta.env.NR_BROWSER_LICENSE_KEY,
        applicationID: import.meta.env.NR_BROWSER_APP_ID,
      },
    })
  : null;

export function noticeError(error, attributes) {
  agent?.noticeError(error, attributes);
}

export function addPageAction(name, attributes) {
  agent?.addPageAction(name, attributes);
}

// Tag every later event with who is browsing and what the flag served, so
// errors in New Relic can be sliced by flag state ("errors where flag = true").
export function tagSession({ personaKey, tier, premiumVideos }) {
  if (!agent) return;
  agent.setUserId(personaKey);
  agent.setCustomAttribute('tier', tier);
  agent.setCustomAttribute('flag_premium_video_tutorials', Boolean(premiumVideos));
}
