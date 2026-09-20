import { useState } from 'react';
import { CheckCircle, Circle } from 'lucide-react';

const TASKS = [
  'Accepting a friendly stranger',
  'Sitting politely for petting',
  'Walking on a loose lead',
  'Walking through a crowd',
  'Reaction to another dog',
];

// Optional extra flag scenario (`exam-progress-tracker`): a progress checklist that
// is dark-launched to beta testers first and then rolled out gradually by percentage.
export default function ExamTracker() {
  const [completed, setCompleted] = useState(() => TASKS.map(() => false));

  const toggle = (index) => {
    setCompleted((prev) => prev.map((done, i) => (i === index ? !done : done)));
  };

  return (
    <div className="card animate-fade-in" style={{ borderColor: 'var(--secondary)' }}>
      <h3 style={{ color: 'var(--secondary)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <CheckCircle size={24} />
        Exam Progress Tracker
      </h3>
      <p style={{ marginBottom: '1rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
        Track your dog's progress on test items before the actual exam.
      </p>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {TASKS.map((task, i) => (
          <button
            key={task}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={completed[i]}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.55rem 0.75rem',
              fontSize: '0.875rem',
              textAlign: 'left',
              font: 'inherit',
              background: completed[i] ? '#ECFDF5' : '#F9FAFB',
              border: `1px solid ${completed[i] ? '#10B981' : '#E5E7EB'}`,
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {completed[i] ? <CheckCircle color="#10B981" /> : <Circle color="#9CA3AF" />}
            <span style={{ textDecoration: completed[i] ? 'line-through' : 'none', color: completed[i] ? '#065F46' : 'inherit' }}>
              {task}
            </span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: '1rem', width: '100%', background: '#E5E7EB', borderRadius: '99px', height: '8px', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            background: 'var(--secondary)',
            width: `${(completed.filter(Boolean).length / TASKS.length) * 100}%`,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}
