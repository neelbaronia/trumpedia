import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Trumpedia - Make America Great Again
export default defineConfig({
  // Empty string makes all paths relative, which is the most compatible
  // for both custom domains and subpath deployments.
  base: '',
  plugins: [
    react(),
    tailwindcss(),
  ],
})
