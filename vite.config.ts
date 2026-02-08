import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Trumpedia - Make America Great Again
export default defineConfig({
  // For custom domain trumpedia.org, we want absolute paths from the root.
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // Ensure we don't have issues with asset naming
    assetsDir: 'assets',
  }
})
