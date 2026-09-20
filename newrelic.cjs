'use strict';
// New Relic APM agent config for the Node backend (server/index.js).
// Values come from the environment (.env is loaded before the agent starts, see the
// "server" script in package.json). Without a license key the agent stays disabled,
// so the app runs the same and prints no errors.
exports.config = {
  app_name: [process.env.NR_APM_APP_NAME || 'Canine Good Citizen'],
  license_key: process.env.NR_APM_LICENSE_KEY,
  agent_enabled: Boolean(process.env.NR_APM_LICENSE_KEY),
  ai_monitoring: { enabled: process.env.NR_APM_AIM_ENABLED === 'true' },
  distributed_tracing: { enabled: true },
  logging: { level: 'info' },
};
