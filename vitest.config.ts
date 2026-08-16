import { defineConfig } from "vitest/config";

const neonContract = Boolean(process.env.TEST_DATABASE_URL?.trim());

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    fileParallelism: false,
    sequence: { concurrent: false },
    ...(neonContract ? { testTimeout: 120_000, hookTimeout: 60_000 } : {}),
  },
});
