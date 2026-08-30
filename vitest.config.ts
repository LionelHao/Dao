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
            "packages/server/src/agent-runtime/human-preemption-authority.test.ts",
            "packages/server/src/persistence/legacy-importer.test.ts",
            "packages/server/src/persistence/context-snapshot-database-authority.test.ts",
            "packages/server/src/persistence/schema*.test.ts",
            "packages/server/src/persistence/snapshot-worker-client.test.ts",
            "packages/server/src/persistence/worker-database-client.test.ts",
            "packages/server/src/sync-service.test.ts",
          ],
          sequence: { groupOrder: 0 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-recent",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-recent.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-foundations",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-foundations.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 2 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-integrity",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-integrity.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 3 },
        },
      }),
      defineProject({
        test: {
          name: "legacy-importer",
          environment: "jsdom",
          include: ["packages/server/src/persistence/legacy-importer.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 4 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v26-rollback",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v26-rollback.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 5 },
        },
      }),
      defineProject({
        test: {
          name: "worker-persistence",
          environment: "jsdom",
          include: [
            "packages/server/src/agent-runtime/human-preemption-authority.test.ts",
            "packages/server/src/persistence/context-snapshot-database-authority.test.ts",
            "packages/server/src/persistence/schema-v*.test.ts",
            "packages/server/src/persistence/worker-database-client.test.ts",
          ],
          exclude: ["packages/server/src/persistence/schema-v26-rollback.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 6 },
        },
      }),
      defineProject({
        test: {
          name: "authority-real-process-e2e",
          environment: "jsdom",
          include: ["packages/server/src/authority.e2e.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 15_000,
          sequence: { groupOrder: 7 },
        },
      }),
      defineProject({
        test: {
          name: "snapshot-worker-e2e",
          environment: "jsdom",
          include: ["packages/server/src/persistence/snapshot-worker-client.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 15_000,
          sequence: { groupOrder: 8 },
        },
      }),
      defineProject({
        test: {
          name: "sync-service-e2e",
          environment: "jsdom",
          include: ["packages/server/src/sync-service.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 15_000,
          sequence: { groupOrder: 9 },
        },
      }),
    ],
  },
});
