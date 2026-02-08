import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

console.log("main.tsx: Starting React initialization");

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error("main.tsx: Root element not found!");
  alert("Root element not found!");
} else {
  try {
    const root = createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    console.log("main.tsx: React render called");
  } catch (err) {
    console.error("main.tsx: Render error", err);
    alert("Render error: " + err);
  }
}
