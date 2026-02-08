import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

console.log("main.tsx: Script file loaded");

// Set a global flag so we can check if JS ran
(window as any).reactLoaded = true;

const rootElement = document.getElementById('root');

if (rootElement) {
  try {
    const root = createRoot(rootElement);
    console.log("main.tsx: React root created, rendering...");
    root.render(<App />);
  } catch (err) {
    console.error("main.tsx: Render error", err);
    const debug = document.getElementById('debug-info');
    if (debug) debug.innerText = "Render error: " + err;
  }
} else {
  console.error("main.tsx: Root element not found");
}
