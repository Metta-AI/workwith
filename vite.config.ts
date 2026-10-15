import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const web = path.resolve(import.meta.dirname, 'web')

export default defineConfig({
  root: web,
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true,
    // Codinger, and a published transcript (web.codinger.app/s/<id>).
    rollupOptions: { input: { main: path.join(web, 'index.html'), share: path.join(web, 'share.html') } },
  },
})
