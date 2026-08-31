import { configDefaults, defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    // Vitest 3.2.7 sorts groupOrder with the default lexicographic Array.sort.
    // Keep latency-sensitive real-process projects at 0-3, then 4 and 40-50.
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
            "packages/server/src/project-loop/database-authority.test.ts",
            "packages/server/src/persistence/legacy-importer.test.ts",
            "packages/server/src/persistence/context-snapshot-database-authority.test.ts",
            "packages/server/src/persistence/schema*.test.ts",
            "packages/server/src/persistence/snapshot-worker-client.test.ts",
            "packages/server/src/persistence/worker-database-client.test.ts",
            "packages/server/src/sync-service.test.ts",
          ],
          sequence: { groupOrder: 4 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-recent",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-recent.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 40 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-foundations",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-foundations.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 41 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-integrity",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-integrity.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 42 },
        },
      }),
      defineProject({
        test: {
          name: "legacy-importer",
          environment: "jsdom",
          include: ["packages/server/src/persistence/legacy-importer.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 43 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v26-rollback-01",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v26-rollback-01.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 44 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v26-rollback-02",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v26-rollback-02.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 45 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v26-rollback-03",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v26-rollback-03.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 46 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v26-rollback-04",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v26-rollback-04.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 47 },
        },
      }),
      defineProject({
        test: {
          name: "authority-human-preemption",
          environment: "jsdom",
          include: [
            "packages/server/src/agent-runtime/human-preemption-authority.test.ts",
          ],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      }),
      defineProject({
        test: {
          name: "authority-schema-v27",
          environment: "jsdom",
          include: ["packages/server/src/persistence/schema-v27.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 2 },
        },
      }),
      defineProject({
        test: {
          name: "project-loop-database-authority",
          environment: "jsdom",
          include: ["packages/server/src/project-loop/database-authority.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 3 },
        },
      }),
      defineProject({
        test: {
          name: "worker-persistence",
          environment: "jsdom",
          include: [
            "packages/server/src/persistence/context-snapshot-database-authority.test.ts",
            "packages/server/src/persistence/schema-v*.test.ts",
            "packages/server/src/persistence/worker-database-client.test.ts",
          ],
          exclude: [
            "packages/server/src/persistence/schema-v26-rollback-*.test.ts",
            "packages/server/src/persistence/schema-v27.test.ts",
          ],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 48 },
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
          sequence: { groupOrder: 0 },
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
          sequence: { groupOrder: 49 },
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
          sequence: { groupOrder: 50 },
        },
      }),
    ],
  },
});
