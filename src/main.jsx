import { createRoot } from 'react-dom/client';
import { asyncWithLDProvider } from 'launchdarkly-react-client-sdk';
import './observability.js';
import './index.css';
import App from './App.jsx';
import { DEFAULT_PERSONA, toContext } from './shared/personas.js';
import { personaFromUrl } from './chaos.js';

// LaunchDarkly CLIENT-SIDE ID (safe to expose in the browser; NOT the server SDK key).
// Set LD_CLIENT_ID in .env. Find it in
// LaunchDarkly: Project settings ->
// Environments -> pick your environment -> "Client-side ID".
const LD_CLIENT_ID = import.meta.env.LD_CLIENT_ID || 'PLACEHOLDER_CLIENT_ID';

(async () => {
  let LDProvider;

  if (LD_CLIENT_ID !== 'PLACEHOLDER_CLIENT_ID') {
    try {
      // Streaming is on by default, so flag changes made in the LD dashboard
      // are pushed to the browser and useFlags() re-renders without a reload.
      LDProvider = await asyncWithLDProvider({
        clientSideID: LD_CLIENT_ID,
        // ?persona= or ?visitor= in the URL opens the page as that user (demo only, see chaos.js).
        context: toContext(personaFromUrl() ?? DEFAULT_PERSONA),
        // Lets the page explain why each flag value was served (see FlagStatus.jsx).
        options: { evaluationReasons: true },
      });
    } catch (err) {
      console.error('LaunchDarkly SDK failed to initialize:', err);
    }
  }

  const root = createRoot(document.getElementById('root'));
  root.render(
    LDProvider ? (
      <LDProvider>
        <App />
      </LDProvider>
    ) : (
      <App />
    ),
  );
})();
