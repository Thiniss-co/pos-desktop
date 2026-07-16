import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['src/renderer/src/**/*.test.ts', 'happy-dom']],
    include: ['src/**/*.test.ts']
  }
})
