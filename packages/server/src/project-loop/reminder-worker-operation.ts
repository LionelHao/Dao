import type { DatabaseSync } from "node:sqlite";
import {
  createProjectReminderDatabaseAuthorityPort,
  type ProjectReminderAgentIntentWriter,
} from "./boundary-authority.js";
import {
  PROJECT_REMINDER_SCAN_LIMITS,
  scanCurrentProjectReminderBuckets,
  type ProjectReminderScanResult,
} from "./project-boundary-runtime-service.js";

export type ProjectReminderWorkerOperationInput = Readonly<{
  now: string;
  limit: number;
}>;

export type ProjectReminderWorkerOperation = Readonly<{
  execute(input: ProjectReminderWorkerOperationInput): Promise<ProjectReminderScanResult>;
}>;

function validate(input: ProjectReminderWorkerOperationInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 ||
      input.limit > PROJECT_REMINDER_SCAN_LIMITS.maxBoundaries ||
      !Number.isFinite(Date.parse(input.now)) || new Date(Date.parse(input.now)).toISOString() !== input.now) {
    throw new TypeError("Project reminder Worker operation input was invalid");
  }
}

/** Synchronously binds the database and mandatory FT-08 transaction writer. */
export function createProjectReminderWorkerOperation(
  database: DatabaseSync,
  writeAgentInvocationIntentInTransaction: ProjectReminderAgentIntentWriter,
): ProjectReminderWorkerOperation {
  if (typeof writeAgentInvocationIntentInTransaction !== "function") {
    throw new TypeError("Project reminder Agent intent writer is required");
  }
  const authority = createProjectReminderDatabaseAuthorityPort(database, {
    writeAgentInvocationIntentInTransaction,
  });
  return Object.freeze({
    async execute(input: ProjectReminderWorkerOperationInput) {
      validate(input);
      return scanCurrentProjectReminderBuckets({ authority, now: input.now, limit: input.limit });
    },
  });
}

/** Executes one bounded global recovery/timer scan. It never invokes an Agent provider. */
export async function executeProjectReminderWorkerOperation(
  database: DatabaseSync,
  input: ProjectReminderWorkerOperationInput,
  writeAgentInvocationIntentInTransaction: ProjectReminderAgentIntentWriter,
): Promise<ProjectReminderScanResult> {
  return createProjectReminderWorkerOperation(
    database,
    writeAgentInvocationIntentInTransaction,
  ).execute(input);
}
