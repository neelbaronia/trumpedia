import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

function SimpleApp() {
  return (
    <div style={{ padding: '20px', textAlign: 'center', fontFamily: 'sans-serif' }}>
      <h1 style={{ color: '#c8102e' }}>Trumpedia is Live!</h1>
      <p>The app has initialized successfully.</p>
      <button 
        onClick={() => window.location.reload()}
        style={{ padding: '10px 20px', background: '#3366cc', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
      >
        Refresh Page
      </button>
    </div>
  )
}

console.log("main.tsx: Starting minimal initialization");

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<SimpleApp />);
  console.log("main.tsx: Minimal render called");
} else {
  alert("Root element not found!");
}
