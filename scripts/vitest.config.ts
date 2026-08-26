import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the scripts' own tests: @zkdeal/bench has its own vitest run via
    // `pnpm -r run test`, and sweeping it from here would re-run it under the
    // wrong package resolution context.
    include: ['scripts/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
