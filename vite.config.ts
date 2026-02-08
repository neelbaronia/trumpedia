import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Use absolute root path for custom domain
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // Ensure assets are placed in a standard directory
    assetsDir: 'assets',
    // Generate a manifest file to help debug if needed
    manifest: true,
  }
})
