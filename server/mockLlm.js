// Canned replies used by llm.js when no OPENAI_API_KEY is set, so the demo needs no
// model provider account. It reads the model name and system prompt LaunchDarkly
// hands us, so changing either in the AI Config still visibly changes the reply.

const ADVICE = [
  { match: /stranger|greet/i, tip: 'Practice Accepting a Friendly Stranger: have a helper approach and shake your hand while your dog stays calm at your side.' },
  { match: /pet|touch/i, tip: 'For Sitting Politely for Petting, reward a sit before the helper reaches out, and end the session if your dog jumps.' },
  { match: /groom|brush|appearance/i, tip: 'For Appearance and Grooming, handle ears, paws and coat daily so the evaluator brushing your dog feels routine.' },
  { match: /walk|loose|leash|lead/i, tip: 'For Walking on a Loose Leash, reward every step where the lead is slack and turn away when it tightens.' },
  { match: /crowd/i, tip: 'For Walking Through a Crowd, start at a quiet park and add people gradually while keeping your dog close.' },
  { match: /sit|down|stay/i, tip: 'For Sit, Down and Stay, build duration first, then distance, then distractions, one at a time.' },
  { match: /come|recall/i, tip: 'For Coming When Called, use a long line and a high-value treat, and never call your dog to something unpleasant.' },
  { match: /dog|other/i, tip: 'For Reaction to Another Dog, keep distance, reward calm looks, and shrink the distance slowly.' },
  { match: /noise|distract/i, tip: 'For Reaction to Distraction, pair sudden sounds with treats until your dog shrugs them off.' },
  { match: /alone|separat/i, tip: 'For Supervised Separation, start with seconds and build to three minutes with a calm handler nearby.' },
];

const FALLBACK = 'The 10 CGC items are: friendly stranger, sitting for petting, grooming, loose leash, crowd walking, sit/down/stay, recall, other dogs, distractions and separation. Which one should we work on?';

export function buildMockReply({ model, systemPrompt, userMessage }) {
  const tip = ADVICE.find((a) => a.match.test(userMessage))?.tip ?? FALLBACK;
  const concise = /concise|brief|short/i.test(systemPrompt);
  const body = concise ? tip.split('.')[0] + '.' : `${tip} Short, happy sessions of five minutes work best.`;
  return `[${model} · mock] ${body}`;
}

// Rough token estimate (about 4 characters per token) for the AI metrics.
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}
