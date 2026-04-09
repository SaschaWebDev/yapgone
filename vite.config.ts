import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
  },
  // Required by src/lib/picpetite/* — keeps the @jsquash WASM modules out of
  // dev pre-bundling so they remain dynamically importable from inside the
  // compression worker, and lets the worker itself use ES module syntax.
  optimizeDeps: {
    exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/webp'],
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': {
        target: 'http://localhost:8787',
        ws: true,
      },
    },
  },
})
