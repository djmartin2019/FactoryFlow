import { defineConfig } from "vitest/config";

export default defineConfig({
  // Several suites replay the whole 30-day dataset (a few seconds alone); the default 5 s timeout flakes when the
  // files run in parallel on a busy machine or CI runner.
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
