import { defineConfig } from 'vite'

// In dev, Vite serves the client and forwards /ws to the Node server.
export default defineConfig({
  server: { proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } } },
})
