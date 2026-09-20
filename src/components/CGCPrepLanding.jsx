import { useEffect, useState } from 'react';
import { useFlags, useLDClient } from 'launchdarkly-react-client-sdk';
import { ShieldCheck, Target, Award, Users } from 'lucide-react';
import PremiumVideos from './PremiumVideos';
import { chaosFromUrl } from '../chaos';
import ExamTracker from './ExamTracker';
import AIChatbot from './AIChatbot';
import FlagBoundary from './FlagBoundary';
import FlagStatus from './FlagStatus';
import { DEFAULT_PERSONA, PERSONAS, findPersona, toContext } from '../shared/personas';
import { addPageAction, noticeError, tagSession } from '../observability';

// Flag key as created in LaunchDarkly. useFlags() exposes it camelCased.
const PREMIUM_VIDEOS_FLAG = 'premium-video-tutorials';
// Optional second scenario: beta targeting, then a gradual percentage rollout.
// The flag key is 'exam-progress-tracker'; useFlags() exposes it as flags.examProgressTracker.

export default function CGCPrepLanding() {
  const flags = useFlags();
  const ldClient = useLDClient();
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [notice, setNotice] = useState(null);
  const [trainingStarted, setTrainingStarted] = useState(false);
  // Demo only: makes the premium videos throw, like a bad release (see PremiumVideos.jsx).
  const [badRelease, setBadRelease] = useState(chaosFromUrl);
  const [killMessage, setKillMessage] = useState('');

  const showPremiumVideos = Boolean(flags.premiumVideoTutorials);

  // Instant release / rollback. useFlags() already re-renders on change;
  // this explicit listener adds the visible "changed live" banner so the demo
  // shows the switch happening with no page reload.
  useEffect(() => {
    if (!ldClient) return undefined;
    const onChange = (value) => {
      setNotice(`Flag "${PREMIUM_VIDEOS_FLAG}" changed to ${value ? 'ON' : 'OFF'} at ${new Date().toLocaleTimeString()}. No reload needed.`);
    };
    ldClient.on(`change:${PREMIUM_VIDEOS_FLAG}`, onChange);
    return () => ldClient.off(`change:${PREMIUM_VIDEOS_FLAG}`, onChange);
  }, [ldClient]);

  useEffect(() => {
    tagSession({ personaKey: persona.key, tier: persona.tier, premiumVideos: showPremiumVideos });
  }, [persona, showPremiumVideos]);

  // Switching persona re-identifies with a new LD context (same stable key each
  // time), which re-evaluates every flag for that user.
  const handleContextChange = async (e) => {
    const next = findPersona(e.target.value);
    setPersona(next);
    setTrainingStarted(false);
    if (ldClient) await ldClient.identify(toContext(next));
  };

  // Remediate from the browser: asks the backend to fire the flag trigger (server/index.js).
  const fireKillSwitch = async () => {
    setKillMessage('Firing the kill switch...');
    try {
      const res = await fetch('/api/kill-switch', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setKillMessage('Kill switch fired. The flag turns off in a moment.');
      else if (res.status === 501) setKillMessage('Set LD_TRIGGER_URL in .env first (see README).');
      else setKillMessage(`The trigger did not fire (${body.error ?? `status ${res.status}`}).`);
    } catch {
      setKillMessage('Could not reach the backend. Is `npm run server` running?');
    }
  };

  // Metric for the experiment: custom conversion event `clicked-start-training`.
  const handleStartTraining = () => {
    ldClient?.track('clicked-start-training');
    addPageAction('start_training_click', { flag_premium_video_tutorials: showPremiumVideos });
    setTrainingStarted(true);
  };

  return (
    <div className="app-container">
      {/* Demo tooling, kept apart from the site itself: switch user, simulate a bad release,
          and see what each flag serves. A real site would not have this bar. */}
      <div className="demo-bar" aria-label="Demo controls">
        <div className="demo-bar-controls">
          <span className="demo-bar-label">Demo controls</span>
          <div className="context-switcher">
            <Users size={18} color="var(--text-muted)" />
            <label htmlFor="persona" style={{ fontSize: '0.875rem', fontWeight: 500 }}>Simulate user:</label>
            <select id="persona" value={persona.key} onChange={handleContextChange} style={{ padding: '0.4rem', fontSize: '0.875rem' }}>
              {PERSONAS.map((p) => (
                <option key={p.key} value={p.key}>{`${p.name} (${p.tier})`}</option>
              ))}
            </select>
          </div>
          <label className="demo-bar-check">
            <input type="checkbox" checked={badRelease} onChange={(e) => setBadRelease(e.target.checked)} />
            Simulate a bad release
          </label>
          {badRelease && (
            <>
              <button type="button" className="btn btn-secondary demo-bar-button" onClick={fireKillSwitch}>Fire kill switch</button>
              {killMessage && <span role="status" className="demo-bar-message">{killMessage}</span>}
            </>
          )}
        </div>
        <FlagStatus persona={persona} />
        {notice && (
          <div role="status" className="demo-bar-notice">
            {notice}
          </div>
        )}
      </div>

      <header className="site-header">
        <div className="brand">
          <ShieldCheck size={32} color="var(--primary)" />
          <div>
            <h1>CGC Prep Master</h1>
            <p>Canine Good Citizen Certification</p>
          </div>
        </div>
        <nav className="site-links" aria-label="Site sections">
          <span className="site-link" title="Learn exactly what evaluators are looking for in all 10 test items.">
            <Award size={16} color="var(--primary)" />
            10-Step Curriculum
          </span>
          <span className="site-link" title="Locate AKC approved CGC evaluators in your local area.">
            <Target size={16} color="var(--primary)" />
            Find an Evaluator
          </span>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div>
            <h2>Pass the CGC Test with Confidence</h2>
            <p>Expert-led training, tracking tools, and resources to help your dog become a certified Canine Good Citizen.</p>
          </div>
          <div className="hero-actions">
            <div className="hero-buttons">
              <button className="btn btn-primary" onClick={handleStartTraining}>Start Training</button>
              <button className="btn btn-secondary">Take Practice Quiz</button>
            </div>
            {trainingStarted && (
              <p role="status" className="hero-message">
                Great start, {persona.name}! Your click was recorded as the experiment metric.
              </p>
            )}
          </div>
        </section>

        <div className="feature-grid">
          {/* Feature-flagged component (Parts 1 and 2, plus the experiment). */}
          {showPremiumVideos && (
            <FlagBoundary
              key={String(badRelease)}
              title="Premium Video Tutorials"
              onError={(error) => noticeError(error, { flag: PREMIUM_VIDEOS_FLAG, persona: persona.key })}
            >
              <PremiumVideos chaos={badRelease} />
            </FlagBoundary>
          )}

          {/* Optional second flag scenario. */}
          {flags.examProgressTracker && <ExamTracker />}

          {/* AI Config: Model and prompt come from LaunchDarkly via the backend. */}
          {/* key: a different persona starts a fresh conversation, so one user's questions and
              answers never show up under another user. */}
          <AIChatbot key={persona.key} persona={persona} />
        </div>
      </main>
    </div>
  );
}
