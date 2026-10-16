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
  // The page's files load from where the page came from: the root, or /m/<machine>/ when the hub
  // passes a machine's own page through (web.codinger.app/m/<machine>/, to test a build on a
  // phone with no deploy). The HTML keeps root paths, which that machine rewrites (server/index.ts,
  // serveStatic), with window.__base for the files that scripts load; CSS loads its own relative.
  experimental: {
    renderBuiltUrl(file, { hostType }) {
      if (hostType === 'js') return { runtime: `(window.__base||'/')+${JSON.stringify(file)}` }
      if (hostType === 'css') return { relative: true }
      return '/' + file
    },
  },
})
