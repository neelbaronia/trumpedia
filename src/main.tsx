import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// IMMEDIATE ALERT TO CONFIRM SCRIPT LOAD
console.log("main.tsx: Script file loaded");

const rootElement = document.getElementById('root');

if (rootElement) {
  try {
    const root = createRoot(rootElement);
    console.log("main.tsx: React root created, rendering...");
    root.render(<App />);
  } catch (err) {
    alert("React Render Error: " + err);
  }
} else {
  alert("FATAL: Root element #root not found in DOM");
}
