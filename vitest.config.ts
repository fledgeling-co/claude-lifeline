import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    // The gateway and daemon log at info by default; the harness only wants failures on stderr.
    env: { LIFELINE_LOG: "error" },
  },
});
