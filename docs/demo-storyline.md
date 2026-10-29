# Demo storyline (a 15-minute walkthrough)

One company, four hats. Keep the app and the LaunchDarkly project (`cgc-demo`, environment `test`) side by side, plus Slack if you set it up. The **demo bar** at the top of the app shows who you are viewing as and what each flag serves, with the reason.

**Before you start:** `npm run setup` has already created and started both experiments, and (as it told you) you can run the two `npm run simulate` commands now so the results are ready by Act 3. Then `npm run dev`, wait for `Local models ready`, and open <http://localhost:5173>.

### Act 1: Engineering manager, "ship faster, keep quality" (4 minutes)

*The situation: leadership wants features faster, but quality is your brand. You need to test in production safely and undo a bad release fast.*

1. **Release.** Pick **Dana** (premium). Turn `premium-video-tutorials` **on** in LaunchDarkly. The Premium Video card appears and the banner says the flag changed, with no reload. *Say:* "The feature was already deployed, dark. Releasing it is a toggle, not a deploy."
2. **Roll back.** Turn it **off**: the card disappears instantly. *Say:* "That is the listener: the SDK streams the change and the page re-renders."
3. **A bad release.** Turn it on again and tick **Simulate a bad release**. The card degrades to "temporarily unavailable" while the rest of the page keeps working. *Say:* "A bug slipped through. The error boundary limited the damage, but customers still see a broken card."
4. **Remediate with the trigger.** Click **Fire kill switch** (or run `curl -X POST "<trigger url>"`). The flag turns off for everyone within a second. *Say:* "Anything that can POST to a URL can turn the feature off: a monitoring alert, a chatops command, a script. No deploy, no rollback pipeline."
5. Untick the bad-release box and turn the flag back on for Act 2.

### Act 2: Developer, "roll it out carefully" (3 minutes)

*The situation: 40,000 visitors a day depend on this page. You want a specific person, then a specific audience, to see the new component first.*

1. With the flag on and the default `false`, pick **Sam** (free): no card. *Say:* "Nobody gets it yet. This is production-safe."
2. Pick **Alex** (free): the card appears, the strip says **individual target**. *Say:* "Alex is on the flag's individual target list, so a teammate can verify the feature in production before anyone else."
3. Pick **Dana** and **Maya**: they see it, the strip says **targeting rule 1**. *Say:* "This is rule-based: `tier` is `premium` or `beta`. Anyone who matches gets it, with no code change."
4. In LaunchDarkly remove `alex-vip` from the individual targets: Alex's card vanishes live. Add him back.
5. *Point out the context:* a `user` context with a stable key and one attribute, `tier`, defined in `src/shared/personas.js`.

### Act 3: Product manager, "did it help?" (Experimentation, 3 minutes)

*The situation: the team shipped the videos. Do they raise the number of trial users who click Start Training?*

1. **Set the scene.** Pick **Jo**, then **Riley** (both trial): the strip says "targeting rule 3, in an experiment". *Say:* "We shipped premium videos. Trial users are split 50/50, videos or not, and I want to know if it changes what they do. Sam, Alex, Dana and Maya are unaffected, which keeps the test clean."
2. **Show the design.** Open the experiment `premium-videos-start-training`, Design tab. *Say:* "One metric: did they click Start Training. Since a trial has no real traffic, I sent 5,000 fake visitors and secretly planted a 40% lift, to check LaunchDarkly can find it."
3. **Show the result.** Open Results, hover `Videos shown`. *Say:* "9.9 in 100 clicked without the videos, 14.1 with them — that's 42% more clicks, which is close to the 40% I planted, so the tool works. The p-value is 0.0002: if the videos changed nothing, a gap this big happens by chance about 2 times in 10,000. And LaunchDarkly's range for the true effect never dips below zero, so this isn't noise."
4. **Decide, with a caveat.** *Say:* "I'd release to all trial users and plan around the cautious end of that range, closer to 20% than 42%. But this is fake data and one metric — a real test runs for weeks and watches a guardrail metric too, like refunds."

### Act 4: AI product manager, "which prompt and model?" (AI Config, 4 minutes)

*The situation: a support chatbot. You want to change its model and prompt without shipping code, and find the best configuration.*

1. **Set the scene.** Pick a persona, ask "How do I teach loose leash walking?". The line above the chat names the model. *Say:* "Model and prompt both come from LaunchDarkly, not the code."
2. **Show it changing live.** In the AI Config `canine-coach-chatbot`, Targeting, add an individual target for your persona serving the other variation. Ask again within about 3 seconds: the model and the answer's style both change. *Say:* "That's a click, not a deploy." Remove the target after.
3. **Show the design.** Click **Yes** or **No** under a reply. *Say:* "Each Yes is the metric `ai-response-helpful`. I sent 2,000 fake users and planted a 20% lift for the detailed prompt, same idea as the videos test."
4. **Show the result and decide.** Open the experiment `canine-coach-prompt-model`, Results tab. *Say:* "Half the short-answer group found it helpful, six in ten of the detailed group did — 20% more, matching what I planted. p = 0.003, range +7% to +33%, never zero. I'd make Detailed the default. The catch: prompt and model changed together, so I can't say which one did the work."

### Act 5: Integrations (throughout)

If Slack is connected, keep the channel visible during Acts 1 to 4: every toggle, target change and trigger firing is posted there with who did it. *Say:* "That is how the rest of the team sees what changed."

If New Relic is connected, have the [incident chart](integrations.md#new-relic-optional-browser-and-apm-agents) open from an earlier `npm run incident` run: the error spike across a dozen customers, the alert, and the flag-change marker where it stops. *Say:* "Same story as Act 1, but as the on-call engineer would have seen it."

Finish with `terraform/main.tf`: "Everything you saw was created from code, in one command."
