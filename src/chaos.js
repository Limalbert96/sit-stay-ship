// Demo-only switches that can be set in the URL, so a scripted run (or a shared link) can put the
// page straight into a given state. None of this affects a normal visit with no query string.
//
//   ?chaos=1              the "bad release" simulation is already ticked
//   ?persona=maya-beta    open as one of the fixed demo personas
//   ?visitor=shopper-07   open as a synthetic visitor: a made-up premium-tier customer, used by
//                         scripts/simulate-incident.mjs to fill an incident with distinct users
import { findPersona } from './shared/personas';

export const chaosFromUrl = () => new URLSearchParams(window.location.search).get('chaos') === '1';

// Synthetic visitors are premium tier: the tier rule serves them the feature, so they meet the bad
// release, and they stay out of the experiment, which only runs on trial users.
export const syntheticVisitor = (id) => ({ key: id, name: id, tier: 'premium', synthetic: true });

// The persona the page should open as, or null for the usual default.
export function personaFromUrl(search = window.location.search) {
  const params = new URLSearchParams(search);
  const visitor = params.get('visitor');
  if (visitor) return syntheticVisitor(visitor);
  return findPersona(params.get('persona') ?? '') ?? null;
}
