// LaunchDarkly explains every evaluation with a "reason". Turn it into plain words.
export function describeReason(reason) {
  switch (reason?.kind) {
    case 'TARGET_MATCH':
      return 'individual target';
    case 'RULE_MATCH':
      return `targeting rule ${reason.ruleIndex + 1}${reason.inExperiment ? ', in an experiment' : ''}`;
    case 'FALLTHROUGH':
      return reason.inExperiment ? 'default rule, in an experiment' : 'default rule';
    case 'OFF':
      return 'flag is off';
    default:
      return 'unknown';
  }
}
