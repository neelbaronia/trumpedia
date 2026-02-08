import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Trumpedia - Make America Great Again
export default defineConfig({
  // Using an empty string for base makes all asset paths relative (./assets/...)
  // This ensures the site works on both neelbaronia.github.io/trumpedia/ AND trumpedia.org
  base: '',
  plugins: [
    react(),
    tailwindcss(),
  ],
})
