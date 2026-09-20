import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { client } = vi.hoisted(() => ({ client: { variationDetail: vi.fn() } }));
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}), useLDClient: () => client }));

import FlagStatus from './FlagStatus';
import { describeReason } from '../flagReason';

const persona = { key: 'alex-vip', name: 'Alex', tier: 'free' };

describe('describeReason', () => {
  it('explains each kind of evaluation in plain words', () => {
    expect(describeReason({ kind: 'TARGET_MATCH' })).toBe('individual target');
    expect(describeReason({ kind: 'RULE_MATCH', ruleIndex: 0 })).toBe('targeting rule 1');
    expect(describeReason({ kind: 'RULE_MATCH', ruleIndex: 1, inExperiment: true })).toBe('targeting rule 2, in an experiment');
    expect(describeReason({ kind: 'FALLTHROUGH' })).toBe('default rule');
    expect(describeReason({ kind: 'FALLTHROUGH', inExperiment: true })).toBe('default rule, in an experiment');
    expect(describeReason({ kind: 'OFF' })).toBe('flag is off');
    expect(describeReason(undefined)).toBe('unknown');
  });
});

describe('FlagStatus', () => {
  it('shows who is viewing and what each flag serves them, with the reason', () => {
    client.variationDetail.mockImplementation((key) =>
      key === 'premium-video-tutorials'
        ? { value: true, reason: { kind: 'TARGET_MATCH' } }
        : { value: false, reason: { kind: 'FALLTHROUGH' } },
    );
    render(<FlagStatus persona={persona} />);

    expect(screen.getByLabelText('Flag status')).toHaveTextContent('Viewing as Alex (tier: free, key: alex-vip)');
    const videos = document.querySelector('[data-flag="premium-video-tutorials"]');
    expect(videos).toHaveTextContent('Premium videos: ON (individual target)');
    const tracker = document.querySelector('[data-flag="exam-progress-tracker"]');
    expect(tracker).toHaveTextContent('Exam tracker: OFF (default rule)');
  });
});
