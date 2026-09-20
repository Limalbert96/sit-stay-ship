import React from 'react';
import CGCPrepLanding from './components/CGCPrepLanding';
import './index.css';

const LD_CLIENT_ID = import.meta.env.LD_CLIENT_ID || 'PLACEHOLDER_CLIENT_ID';

export default function App() {
  return (
    <>
      {LD_CLIENT_ID === 'PLACEHOLDER_CLIENT_ID' && (
        <div style={{ background: '#FEF2F2', borderBottom: '1px solid #F87171', color: '#B91C1C', padding: '1rem', textAlign: 'center', fontWeight: 500 }}>
          ⚠️ Set LD_CLIENT_ID in your .env file to enable feature flags.
        </div>
      )}
      <CGCPrepLanding />
    </>
  );
}
