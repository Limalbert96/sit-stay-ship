// Fixed demo personas, shared by the React app and the Node backend.
//
// Keys must be STABLE: LaunchDarkly individual targeting matches on the context
// key, so a key that changes between sessions can never be targeted.
// `tier` is the custom attribute that targeting rules in LaunchDarkly match on.
//
// Targeting story for the `premium-video-tutorials` flag (see README):
//   - alex-vip     -> tier "free", but targeted INDIVIDUALLY by key
//   - dana-premium -> matched by the RULE  tier is one of [premium, beta]
//   - maya-beta    -> matched by the same rule
//   - jo-trial,
//     riley-trial  -> tier "trial": the experiment audience. LaunchDarkly hashes each key into
//                     one side of a 50/50 split and keeps it there. Two users may land on the
//                     same side (a coin flip each); when they split, you see both arms.
//   - sam-free     -> matches nothing, so always gets the default rule: off
export const PERSONAS = [
  { key: 'sam-free', name: 'Sam', tier: 'free' },
  { key: 'alex-vip', name: 'Alex', tier: 'free' },
  { key: 'dana-premium', name: 'Dana', tier: 'premium' },
  { key: 'maya-beta', name: 'Maya', tier: 'beta' },
  { key: 'jo-trial', name: 'Jo', tier: 'trial' },
  { key: 'riley-trial', name: 'Riley', tier: 'trial' },
];

export const DEFAULT_PERSONA = PERSONAS[0];

export function findPersona(key) {
  return PERSONAS.find((p) => p.key === key);
}

// Build the LaunchDarkly context for a persona.
export function toContext(persona) {
  return {
    kind: 'user',
    key: persona.key,
    name: persona.name,
    tier: persona.tier,
  };
}
