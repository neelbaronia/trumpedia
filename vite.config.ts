import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Trumpedia - Make America Great Again
export default defineConfig({
  // When deploying to a custom domain, we use '/' as the base.
  // GitHub Pages usually hosts at neelbaronia.github.io/trumpedia/,
  // but trumpedia.org will point to the root.
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
})
