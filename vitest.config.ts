import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["packages/**/*.test.ts"],
  },
});
