import { useEffect, useRef, useState } from 'react';
import { Bot, Send } from 'lucide-react';

// AI Configs.
// The browser never sees the model or prompt logic. It asks our backend
// (server/index.js), which reads the LaunchDarkly AI Config for this user.
// Change the model or prompt in LaunchDarkly and the next message uses it.
const CONFIG_POLL_MS = 3000;
const PROVIDER_LABEL = {
  ollama: 'running locally with Ollama',
  openai: 'via OpenAI',
  mock: 'canned replies (that model is not available: is Ollama running? Start it with `ollama serve`)',
};

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return res.json();
}

export default function AIChatbot({ persona }) {
  const [config, setConfig] = useState(null);
  const [offline, setOffline] = useState(false);
  const [chatError, setChatError] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  // Poll so the "current model" badge follows AI Config edits within seconds.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api(`/api/chat/config?persona=${encodeURIComponent(persona.key)}`);
        if (!cancelled) {
          setConfig(next);
          setOffline(false);
        }
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    load();
    const id = setInterval(load, CONFIG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [persona.key]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setChatError(false);
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    try {
      const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ persona: persona.key, message: text }) });
      setMessages((m) => [...m, { role: 'assistant', content: data.reply, runId: data.runId, model: data.model }]);
    } catch {
      setChatError(true);
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async (runId, helpful) => {
    setMessages((m) => m.map((msg) => (msg.runId === runId ? { ...msg, feedback: helpful } : msg)));
    try {
      await api('/api/chat/feedback', { method: 'POST', body: JSON.stringify({ runId, helpful }) });
    } catch {
      setOffline(true);
    }
  };

  return (
    <div className="card animate-fade-in" style={{ borderColor: '#8B5CF6', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ color: '#8B5CF6', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Bot size={24} />
        Canine Behaviorist AI
      </h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {offline && 'Chat backend is not reachable. Start it with `npm run server`.'}
        {!offline && config && (config.enabled
          ? `Model: ${config.model} (from LaunchDarkly AI Config) · ${PROVIDER_LABEL[config.provider] ?? config.provider}`
          : 'Assistant is switched off in LaunchDarkly.')}
        {chatError && ' Sorry, the assistant could not answer. Try again.'}
      </p>

      <div ref={scroller} style={{ background: '#F3F4F6', borderRadius: '8px', padding: '0.75rem', flex: 1, minHeight: '220px', maxHeight: '320px', overflowY: 'auto', marginBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {messages.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Ask about any of the 10 CGC test items.</span>}
        {messages.map((msg, i) => (
          <div key={msg.runId ?? `user-${i}`} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
            <div style={{ background: msg.role === 'user' ? 'var(--primary)' : 'white', color: msg.role === 'user' ? 'white' : 'var(--text-main)', padding: '0.5rem 1rem', borderRadius: '16px', fontSize: '0.875rem', whiteSpace: 'pre-wrap' }}>
              {msg.content}
            </div>
            {msg.role === 'assistant' && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', fontSize: '0.75rem' }}>
                {msg.feedback === undefined ? (
                  <>
                    <span style={{ color: 'var(--text-muted)' }}>Was this helpful?</span>
                    <button onClick={() => sendFeedback(msg.runId, true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}>Yes</button>
                    <button onClick={() => sendFeedback(msg.runId, false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444' }}>No</button>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>{msg.feedback ? 'Thanks for the feedback.' : 'Thanks, we will improve.'}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Thinking...</span>}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask a training question..."
          disabled={!config?.enabled}
          style={{ flex: 1, padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border)', outline: 'none' }}
        />
        <button className="btn btn-primary" onClick={send} disabled={busy || !config?.enabled} aria-label="Send" style={{ padding: '0.75rem' }}>
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
