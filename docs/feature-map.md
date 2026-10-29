# Feature map: what is built and where to see it

A reference table matching every capability to the file or screen that shows it.

### Basics: SDKs, instructions and code comments

| Requirement | How it is met |
|---|---|
| Use one of the top 5 LaunchDarkly SDKs | **JavaScript**: `launchdarkly-react-client-sdk` (browser) for Parts 1 and 2 and experimentation, `@launchdarkly/node-server-sdk` and `@launchdarkly/server-sdk-ai` (Node) for the AI Config. |
| Detailed set-up and run instructions, including assumptions about the environment | The README and these docs: the [Get started](../README.md#quick-start), [Quick start](setup-details.md), [Manual setup](manual-setup.md), [Troubleshooting](troubleshooting.md#troubleshooting) and [Assumptions and security notes](architecture.md#assumptions-and-security-notes). |
| Code comments where the SDK key is replaced or a flag is re-created | SDK keys: `.env.example` (every key, where to find it), `src/main.jsx` (client-side ID), `server/index.js` and `server/env.js` (SDK key). Flags: `terraform/main.tf` (each flag, with why it exists; `terraform apply` re-creates them) and `src/components/CGCPrepLanding.jsx` (the flag keys the code reads). |
| A sample app a customer could run | A working landing page with a [tour](walkthrough.md#tour-of-the-app), a one-command setup, teardown, tests and a [demo storyline](demo-storyline.md#demo-storyline-a-15-minute-walkthrough). Demo tooling (user switch, bad-release switch) lives in a clearly separate bar at the top. |

### Release and remediate (you are the engineering manager)

*Scenario: ship faster without more risk. Test in production before releasing to customers, and roll back quickly, with little impact, if a bug slips through.*

| Capability | How it is met | Where to see it |
|---|---|---|
| **Feature flag** around a specific new feature; release by toggling on, roll back by toggling off | Flag `premium-video-tutorials` gates the **Premium Video Tutorials** card (`CGCPrepLanding.jsx` renders `<PremiumVideos />` only when the flag is true). | Toggle the flag's targeting in LaunchDarkly; the card appears and disappears. |
| **Instant releases and rollbacks**: a "listener" so the app switches with no page reload | The SDK streams changes and `useFlags()` re-renders; an explicit `ldClient.on('change:premium-video-tutorials', ...)` listener also raises the "changed live" banner. | Toggle the flag with the app open: the card and banner change within a second, no reload. Covered by tests in `CGCPrepLanding.test.jsx`. |
| **Remediate**: use a trigger to turn off a problematic feature (curl or browser) | A LaunchDarkly **flag trigger** ("turn flag off") created by Terraform. `FlagBoundary` contains the failure and the trigger switches the feature off. | Tick **Simulate a bad release**, then run `curl -X POST "<trigger url>"` or click **Fire kill switch**. |
| *Scenario:* test in production before releasing | The flag starts **dark** (default `false`); a single user is targeted first. | The status strip shows Alex gets the feature ("individual target") while everyone else does not. |
| *Scenario:* roll back with minimal customer impact | Error boundary: only the broken card degrades, the page stays up; the trigger removes it for everyone within a second. | Bad-release switch, then kill switch. |

### Targeting (you are the developer)

*Scenario: a high-traffic landing page revamp; ship well-tested code using individual and rule-based targeting.*

| Capability | How it is met | Where to see it |
|---|---|---|
| **Feature flag** around a specific component (the same flag as above) | The same flag, around the `PremiumVideos` component. | As above. |
| **Context attributes**: create a context with attributes of your choosing and target on them | `user` context with a stable `key`, a `name` and the custom attribute **`tier`** (`free`, `premium`, `beta`, `trial`), built in `src/shared/personas.js`; six personas. | The user dropdown; the status strip prints the persona's key and tier. |
| **Target**: demonstrate both individual and rule-based targeting | **Individual:** `alex-vip` (a free user) gets the feature by key. **Rule:** `tier` is one of `premium`, `beta` (Dana, Maya). Sam matches neither. | Switch personas; the status strip explains each result ("individual target", "targeting rule 1", "default rule"). |
| *Scenario:* well-tested code | Unit tests for the flag behaviour, the listener, targeting context and the error boundary (`npm test`); a single targeted user can test a change first. | `npm test`. |

### Experimentation (you are the product manager)

*Scenario: measure the impact of the new feature to make a data-informed decision.*

| Capability | How it is met | Where to see it |
|---|---|---|
| **Feature flag**: the same flag as the targeting example | `premium-video-tutorials` again. | Experiment page. |
| **Metrics**: create a metric | `clicked-start-training`, a custom conversion metric, sent when a visitor clicks **Start Training** (`ldClient.track`). Created by Terraform. | LaunchDarkly, Metrics. |
| **Experiment**: create an experiment using that flag and metric | `premium-videos-start-training`: the flag's "trial users" rule split 50/50 (`Videos shown` vs `Videos hidden`), metric `clicked-start-training`, created and started by `npm run setup`. | LaunchDarkly, Experiments. |
| **Measure**: run long enough to decide | `npm run simulate` sends thousands of synthetic visitors (clearly marked `synthetic: true`); the Results tab shows conversion per treatment, lift and significance, and you decide to release or not. A [worked example with a screenshot](walkthrough.md#reading-the-result-a-real-example) shows how to read it. | Results tab, a few minutes after the simulator finishes. |

### AI Configs (you are the AI product manager)

*Scenario: manage which models and prompts a chatbot uses, to find the most effective configuration.*

| Capability | How it is met | Where to see it |
|---|---|---|
| **AI Config**: change prompts and models quickly | The **Canine Behaviorist AI** chat reads the AI Config `canine-coach-chatbot` (variations `Concise`: small model, short prompt; `Detailed`: larger model, long prompt). Change the served variation, or edit a prompt, in LaunchDarkly and the chat follows within about 3 seconds. Replies come from free local models (Ollama). | The line above the chat names the model; add an individual target on the AI Config to switch a persona. |
| *(Optional)* **Experiment** on prompt and model variants | `canine-coach-prompt-model`: `Concise` vs `Detailed`, metric `ai-response-helpful` (the **Yes** button), created and started by `npm run setup`. | LaunchDarkly, Experiments. |

### Integrations (Slack, Terraform, New Relic)

| Capability | How it is met |
|---|---|
| Explore LaunchDarkly integrations for a more compelling demo | **Slack**: every flag change is posted to a channel (added by hand with LaunchDarkly's Slack app). **Terraform**: the whole LaunchDarkly setup is code (`terraform/`). Optional **New Relic** browser and APM agents, flag changes written to New Relic as change-tracking markers, and a second flag trigger New Relic can fire on its own to remediate an incident with no one pressing a button ([off by default](integrations.md#automated-remediation-let-new-relic-pull-the-kill-switch-itself)). |
