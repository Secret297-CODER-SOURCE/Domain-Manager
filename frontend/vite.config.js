import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
    fs: { allow: ['..'] },
  },
  // argon2-browser ships a .wasm file — exclude from dep optimization so Vite serves it raw
  optimizeDeps: {
    exclude: ['argon2-browser'],
  },
  // kdbxweb and argon2-browser may reference Node globals; provide an empty shim
  define: {
    global: 'globalThis',
  },
})
