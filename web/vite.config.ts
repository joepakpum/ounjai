import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    watch: { usePolling: true },
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
})
