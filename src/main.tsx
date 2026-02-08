import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

console.log("main.tsx: Starting full initialization");

const rootElement = document.getElementById('root');
if (rootElement) {
  try {
    const root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    console.log("main.tsx: Full render called");
  } catch (err) {
    alert("React Render Error: " + err);
  }
} else {
  alert("Root element not found!");
}
