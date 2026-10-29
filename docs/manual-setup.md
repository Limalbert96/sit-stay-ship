# Manual setup (instead of the script)

`npm run setup` does all of this for you. Use this page only if you prefer clicking through LaunchDarkly by hand, or a setup step reported `[!]`. The environment variables are in the [README](../README.md#environment-variables-env).

### Create the feature flags

In LaunchDarkly create two **boolean** flags and turn on "SDKs using Client-side ID" for both:

| Flag key | Used for | Code |
|---|---|---|
| `premium-video-tutorials` | Release, targeting and the experiment | `PremiumVideos`, read as `flags.premiumVideoTutorials` |
| `exam-progress-tracker` | Optional gradual-rollout scenario | `ExamTracker`, read as `flags.examProgressTracker` |

**Set the targeting from JSON (fastest).** Open the flag, choose your environment, switch the targeting view to **JSON**, paste this for `premium-video-tutorials`, and click Review and save. Variation `0` is `true`, `1` is `false`.

```json
{
  "offVariation": 1,
  "on": true,
  "prerequisites": [],
  "contextTargets": [{ "variation": 0, "values": ["alex-vip"] }],
  "rules": [
    {
      "description": "Paying and beta tiers",
      "clauses": [{ "contextKind": "user", "attribute": "tier", "op": "in", "values": ["premium", "beta"], "negate": false }],
      "variation": 0
    },
    {
      "description": "Trial users (experiment audience)",
      "clauses": [{ "contextKind": "user", "attribute": "tier", "op": "in", "values": ["trial"], "negate": false }],
      "rollout": { "contextKind": "user", "variations": [{ "variation": 0, "weight": 50000 }, { "variation": 1, "weight": 50000 }] }
    }
  ],
  "fallthrough": { "variation": 1 }
}
```

That gives individual targeting (`alex-vip`), rule-based targeting (`tier` is `premium` or `beta`), a 50/50 rule for `trial` users (the experiment audience) and a dark default (`false` for everyone else). For `exam-progress-tracker` use one rule with `"values": ["beta"]` and no `contextTargets`.

### Create the metrics

LaunchDarkly, Metrics, Create metric, custom **conversion** (occurrence) metrics:

| Metric key | Event key | Sent when |
|---|---|---|
| `clicked-start-training` | `clicked-start-training` | A user clicks **Start Training** |
| `ai-response-helpful` | `ai-response-helpful` | A user clicks **Yes** under a chatbot reply |

### Create the flag trigger

The trigger belongs to one flag *in one environment*. In LaunchDarkly:
1. Open **Premium Video Tutorials** and stay on its **Targeting** tab.
2. Click the three-dot (overflow) menu next to the environment name (for example *Test*) and choose **Configuration in environment**.
3. In the **Triggers** section click **+ Add trigger**. Trigger type **Generic trigger**, action **Turn flag off**, **Save trigger**.
4. **Copy the trigger URL now.** LaunchDarkly shows it only once (you can regenerate it from the trigger's overflow menu). Paste it into `.env` as `LD_TRIGGER_URL`. Anyone holding the URL can turn the flag off, so keep it private.
5. For [automated remediation](../README.md#automated-remediation-let-new-relic-pull-the-kill-switch-itself), add a second trigger the same way with trigger type **New Relic** (not *New Relic [Deprecated]*), and put its URL in New Relic's webhook destination. `npm run setup` does both for you.

The "Add adaptive trigger" button you see on individual targeting rules is a different feature.

Command-line alternative (needs `$LD_API_TOKEN`):

```bash
curl -X POST "https://app.launchdarkly.com/api/v2/flags/cgc-demo/premium-video-tutorials/triggers/test" \
  -H "Authorization: $LD_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"integrationKey": "generic-trigger", "instructions": [{"kind": "turnFlagOff"}]}'
# the New Relic one: the same call with "integrationKey": "new-relic-v2"
```

Flag triggers are only available on certain plans (the API reference says Enterprise). A free trial includes them. If your account has no **Triggers** section, use the fallback under [Release and remediate](../README.md#release-and-remediate).

### Create the AI Config

See [AI Configs](../README.md#ai-configs).

### Other `curl` equivalents (optional)

```bash
# create a flag
curl -X POST "https://app.launchdarkly.com/api/v2/flags/cgc-demo" \
  -H "Authorization: $LD_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Premium Video Tutorials","key":"premium-video-tutorials","temporary":true,"clientSideAvailability":{"usingEnvironmentId":true}}'

# create the experiment metric
curl -X POST "https://app.launchdarkly.com/api/v2/metrics/cgc-demo" \
  -H "Authorization: $LD_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"clicked-start-training","name":"clicked-start-training","kind":"custom","eventKey":"clicked-start-training","isNumeric":false,"successCriteria":"HigherThanBaseline"}'
```
