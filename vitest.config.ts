import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
