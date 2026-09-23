import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '^/office/(snapshot|stream)$': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
})
