import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Only the modules that ship. A config file or a maintenance script with no
      // tests is not a coverage gap, and counting them made the headline number
      // read as 8% when the shipped surface is closer to 90%.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
})
