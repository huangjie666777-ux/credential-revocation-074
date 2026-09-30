import { defineConfig } from "vitest/config";

export default defineConfig({
  fileParallelism: false,
  test: {
    include: ["test/**/*.test.ts"],
    hookTimeout: 120000,
    testTimeout: 60000,
  },
});
