import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Marginer's anchoring (quote pieces + occurrence numbers) is used straight
// from its checkout, so improvements there carry over.
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  resolve: { alias: { '@marginer': path.resolve(import.meta.dirname, '../marginer/src') } },
  server: { fs: { allow: [import.meta.dirname, path.resolve(import.meta.dirname, '../marginer/src')] } },
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
})
