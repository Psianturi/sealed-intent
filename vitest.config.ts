import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    // the same result with or without a developer .env; live tests opt back in
    env: process.env.SEALED_LIVE_TESTS === "1" ? {} : { SEALED_SKIP_DOTENV: "1" },
  },
});
