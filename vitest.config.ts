import { configDefaults, defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    projects: [
      defineProject({
        test: {
          name: "parallel",
          environment: "jsdom",
          include: ["packages/**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "packages/server/src/authority.e2e.test.ts",
            "packages/server/src/persistence/legacy-importer.test.ts",
            "packages/server/src/persistence/schema.test.ts",
            "packages/server/src/persistence/snapshot-worker-client.test.ts",
            "packages/server/src/sync-service.test.ts",
          ],
          sequence: { groupOrder: 0 },
        },
      }),
      defineProject({
        test: {
          name: "worker-persistence",
          environment: "jsdom",
          include: [
            "packages/server/src/persistence/legacy-importer.test.ts",
            "packages/server/src/persistence/schema.test.ts",
          ],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      }),
      defineProject({
        test: {
          name: "heavy-persistence-e2e",
          environment: "jsdom",
          include: [
            "packages/server/src/authority.e2e.test.ts",
            "packages/server/src/persistence/snapshot-worker-client.test.ts",
            "packages/server/src/sync-service.test.ts",
          ],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 15_000,
          sequence: { groupOrder: 2 },
        },
      }),
    ],
  },
});
