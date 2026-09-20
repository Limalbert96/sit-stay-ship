import { useFlags, useLDClient } from 'launchdarkly-react-client-sdk';
import { describeReason } from '../flagReason';

const FLAGS = [
  { key: 'premium-video-tutorials', label: 'Premium videos' },
  { key: 'exam-progress-tracker', label: 'Exam tracker' },
];

// Always-visible strip inside the demo bar: who is browsing, what each flag serves them,
// and why. Handy while demoing targeting. It re-renders whenever a flag changes.
export default function FlagStatus({ persona }) {
  useFlags(); // subscribes this component to flag changes so it re-renders
  const ldClient = useLDClient();
  if (!ldClient) return null;

  return (
    <div aria-label="Flag status" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 1.5rem', alignItems: 'center', fontSize: '0.8125rem' }}>
      <span>
        Viewing as <strong>{persona.name}</strong> (tier: {persona.tier}, key: <code>{persona.key}</code>)
      </span>
      {FLAGS.map(({ key, label }) => {
        const { value, reason } = ldClient.variationDetail(key, false);
        return (
          <span key={key} data-flag={key} data-value={String(Boolean(value))}>
            {label}: <strong style={{ color: value ? 'var(--secondary)' : '#6B7280' }}>{value ? 'ON' : 'OFF'}</strong>{' '}
            <span style={{ color: 'var(--text-muted)' }}>({describeReason(reason)})</span>
          </span>
        );
      })}
    </div>
  );
}
