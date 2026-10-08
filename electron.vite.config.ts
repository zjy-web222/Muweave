import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'dist/main', rollupOptions: { input: {
      index: resolve('src/main/index.ts'), 'plugin-contract': resolve('src/shared/plugin.ts'),
      'plugin-server': resolve('src/main/plugin.ts'),
    } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve('dist/renderer'),
      assetsInlineLimit: 1024 * 1024,
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
})
