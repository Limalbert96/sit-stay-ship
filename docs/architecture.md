# How it fits together

```
Browser (React, port 5173)                     Node backend (port 3001)
  launchdarkly-react-client-sdk                  @launchdarkly/node-server-sdk
    flags, listener, context           /api/*      @launchdarkly/server-sdk-ai (AI Config)
  chatbot UI  ----------------------------->     reply from Ollama (local) / OpenAI / canned
  "Fire kill switch" button  -------------->     POST to the flag trigger URL
        |                                              |
        v                                              v
  LaunchDarkly (flags, targeting, experiments, AI Config, triggers, Slack)
```

- The **browser** uses the client-side SDK with a public client-side ID. It evaluates flags for the persona you pick and re-renders the moment LaunchDarkly pushes a change.
- The **backend** uses the server-side SDK with a secret SDK key. It evaluates the AI Config for the chosen persona, gets a reply from a model, and reports metrics back to LaunchDarkly. It also holds the flag trigger URL, so the URL never reaches the browser.
- **Personas** are six fixed demo users with stable LaunchDarkly context keys, so individual targeting works and results are repeatable:

| Persona | Key | `tier` | Role in the demo |
|---|---|---|---|
| Sam | `sam-free` | free | Not targeted: never sees the feature (the dark default) |
| Alex | `alex-vip` | free | Free tier, but targeted **individually** by key |
| Dana | `dana-premium` | premium | Matched by the tier **rule** |
| Maya | `maya-beta` | beta | Matched by the tier **rule** |
| Jo | `jo-trial` | trial | The **experiment** audience: LaunchDarkly puts each trial user on one side of a 50/50 split |
| Riley | `riley-trial` | trial | Second experiment persona, so two users can show both sides of the split |

## Tests

```bash
npm test
```

94 tests (Vitest, React Testing Library) covering:
- **Release and remediate behaviour** (`CGCPrepLanding.test.jsx`): the flag gates the feature, the change listener subscribes and unsubscribes, re-identify with a stable persona key, the conversion metric, the bad-release switch with the error boundary, and the kill switch button.
- **Flag explanations** (`FlagStatus.test.jsx`, `flagReason.js`).
- **Model selection** (`server/llm.test.js`): OpenAI, Ollama, canned fallback, the local model mapping and warm-up. **New Relic wiring** (`scripts/newrelic-lib.test.js`): the entity lookup, the integration subscriptions, the webhook payload, the rage-click alert's signal, the change-event query and trigger-id parsing the quick check uses, and the order teardown deletes things in. **Setup and teardown** (`scripts/setup-lib.test.js`): `.env` merging, Terraform output handling, and every LaunchDarkly API call for experiments and clean-up, against a fake server; the API token checks (`scripts/token.test.js`). The Terraform config is checked with `terraform validate`.
- Personas, environment handling, and the canned replies.

## Assumptions and security notes

- Node.js 22.12 or newer. One LaunchDarkly environment is used for everything (`test` in the examples); the client-side ID and SDK key must come from that same environment.
- All LaunchDarkly configuration (flags, metrics, experiments, AI Config, trigger, Slack) lives in *your* account, so it is created by `npm run setup` or the manual steps rather than committed.
- **Secrets stay out of git:** `.env` is git-ignored. The SDK key, the API token, the trigger URL and the New Relic keys never reach the browser bundle (`vite.config.js` whitelists what is exposed). Rotate any key or trigger URL you have pasted somewhere public.
- **The kill switch endpoint** (`POST /api/kill-switch`) is unauthenticated: anyone who can reach the backend can turn the flag off. That is acceptable for a local demo; a real system would put it behind authentication.
- **Demo-only pieces**, each labelled in code: the **Simulate a bad release** switch, the canned-reply fallback, and the synthetic traffic simulator (simulated results are not real customer behaviour).
- The chat backend keeps AI trackers in memory for 30 minutes so late thumbs up/down feedback can be attributed. A production system would use a shared store.
- Local models are small and can be wrong about dog training. They exist to show the AI Config mechanics, not to give advice.

## Project layout

```
.env.example                  every setting, documented
terraform/                    the LaunchDarkly setup as code (project, flags, targeting, metrics, triggers, AI Config)
docs/images/                  experiment Results screenshots used in this README
newrelic.cjs                  New Relic APM agent config (optional)
vite.config.js                dev server, API proxy, whitelist of browser-visible settings
server/
  index.js                    chat backend: AI Config, metrics, kill switch
  llm.js                      OpenAI / Ollama / canned reply selection, model warm-up
  mockLlm.js                  canned replies
  env.js                      loads .env
scripts/
  setup.mjs, setup-lib.mjs    npm run setup (Terraform, .env, AI Config default rule, experiments, Ollama)
  teardown.mjs                npm run teardown
  token.mjs                   asks for and checks the LaunchDarkly API token
  dev.mjs                     npm run dev (app, backend, and Ollama if needed)
  ollama.mjs, ollama-setup.mjs  install, start and feed Ollama (npm run ollama)
  simulate-traffic.mjs        synthetic experiment traffic
  simulate-incident.mjs       plays out a bad release: real browser sessions, rage clicks, kill switch
  newrelic.mjs, newrelic-lib.mjs  npm run newrelic: LaunchDarkly's New Relic integration, alert, automated kill switch
  check-newrelic.mjs          npm run check:newrelic: quick API test of both New Relic integrations
  check-newrelic-cleanup.mjs  npm run check:newrelic:cleanup: removes what that check leaves with --keep
src/
  main.jsx                    LaunchDarkly provider (streaming, evaluation reasons)
  observability.js            New Relic browser agent
  shared/personas.js          the six demo users
  flagReason.js, chaos.js     helpers for the status strip and the bad-release switch
  components/
    CGCPrepLanding.jsx        page, listener, persona switch, kill switch
    FlagStatus.jsx            who you are and what each flag serves
    FlagBoundary.jsx          isolates a failing flagged feature
    PremiumVideos.jsx         the flagged feature (release, targeting, experiment)
    ExamTracker.jsx           the optional rollout feature
    AIChatbot.jsx             chat UI
```
