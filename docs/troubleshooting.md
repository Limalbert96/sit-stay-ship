# Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Red banner "Set LD_CLIENT_ID in your .env" | `.env` is missing or has no `LD_CLIENT_ID`. Run `npm run setup` or fill it in. |
| Every flag is off | Wrong environment: the client-side ID and the flag targeting must be in the same environment. Also check the flag's targeting is switched **on**. |
| Browser console: `http proxy error ... ECONNREFUSED` | The chat backend is not running. Use `npm run dev` (starts both). |
| Chat says the backend is not reachable | Same as above. |
| Chat replies are "canned" | Ollama is not running or the models are not pulled. Start it (`ollama serve`, or open the Ollama app), run `ollama pull llama3.2:1b` and `ollama pull llama3.2:3b` if you have not, then restart `npm run server`. |
| First chat reply is very slow | A cold model loads into memory. The backend warms both models at startup; wait for `Local models ready`. |
| "Assistant is switched off" | The AI Config's targeting is off, or it serves the `disabled` variation. Turn it on and serve `Concise` or `Detailed`. |
| **Fire kill switch** says "Set LD_TRIGGER_URL" | Put the trigger URL in `.env` (see [Create the flag trigger](manual-setup.md#create-the-flag-trigger)) and restart `npm run server`. |
| Flag experiment shows few or 0 users | Expected until you run `npm run simulate -- --target flag --users 5000`: in the app only Jo and Riley are in the experiment. The experiment must be running first (setup starts it), the simulator must use the same environment's `LD_SDK_KEY`, and LaunchDarkly analyses every 5 minutes, so wait a few minutes. |
| Jo or Riley does not see the videos | Trial users are in the 50/50 experiment, and each one is fixed to a side by a hash of their key, so about half of trial users never see the videos. The strip says "in an experiment". That is the experiment working. If Jo and Riley both land on the same side, that is a 1-in-2 chance and not a fault. |
| Some personas get the 3B model and others the 1B | The AI Config's 50/50 split is by a hash of the user key, so it is random but sticky; it is not tied to tier. |
| `terraform apply` fails with "already exists" | The project already has the demo's resources from a run this folder's Terraform state does not know about (for example it was set up from another machine). Run `npm run teardown`, then `npm run setup`. |
| `npm run teardown` fails with 409 "still in use in the following experiments" | Only in a project setup did not create, where experiments cannot be deleted through the API. Delete that project in LaunchDarkly, or start over in a new one that setup creates: `npm run setup -- --project cgc-demo-2`. |
| `terraform` says `expected integration_key to be one of [...]`, got `new-relic-v2` | The launchdarkly Terraform provider in use predates `new-relic-v2`. Run `terraform -chdir=terraform init -upgrade`, then `npm run setup` again. |
| `terraform` not found | Install Terraform (see [Prerequisites](setup-details.md#1-prerequisites)). |
| Setup fails creating the project with a permissions error | Creating (and deleting) a project needs a token with the Admin or Owner role. Use one, or point setup at a project that already exists with `--project <key>` (Writer is enough). |
| New Relic's workflow log shows `429` | LaunchDarkly rate-limits trigger calls. Wait a few minutes and avoid repeated test notifications. |
| `npm run setup` says a step needs manual work | The step's message names the LaunchDarkly response. Use the matching manual step above. |
| Build fails with "looks like a server-side SDK key" | `LD_CLIENT_ID` holds an `sdk-...` value. Put the client-side ID there and the SDK key in `LD_SDK_KEY`. |
