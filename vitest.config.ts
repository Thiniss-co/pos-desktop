import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      // Unit tests never reach an OS spooler (src/main/receipt/printBoundary.types.ts).
      '@printBoundary': resolve('src/main/receipt/printBoundary.virtual.ts')
    }
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['src/renderer/src/**/*.test.ts', 'happy-dom']],
    include: ['src/**/*.test.ts']
  }
})
