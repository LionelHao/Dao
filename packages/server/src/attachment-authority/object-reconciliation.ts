import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type { AttachmentObjectStore } from "./object-store.js";

export interface AttachmentObjectReconciliationOptions {
  readonly database: Pick<WorkerDatabaseClient, "executeAttachment">;
  readonly objectStore: Pick<AttachmentObjectStore, "reconcileOrphans">;
  readonly nowMs: () => number;
  readonly maxPasses: number;
}

export async function reconcileAttachmentObjectStore(
  options: AttachmentObjectReconciliationOptions,
): Promise<Readonly<{ deletedEntries: number; deletedBytes: number; passes: number }>> {
  if (!Number.isSafeInteger(options.maxPasses) || options.maxPasses < 1 || options.maxPasses > 64) {
    throw new TypeError("attachment_reconciliation_configuration");
  }
  const now = options.nowMs();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("attachment_reconciliation_clock");
  }
  const result = await options.database.executeAttachment({
    kind: "object-references",
    context: { kind: "attachment-worker", workerId: "attachment-object-reconciler" },
  }, now);
  if (!("referencedUploadIds" in result)) {
    throw new TypeError("attachment_reconciliation_protocol");
  }
  const references = Object.freeze({
    referencedUploadIds: new Set(result.referencedUploadIds),
    referencedQuarantineAttachmentIds: new Set(result.referencedQuarantineAttachmentIds),
    referencedObjectKeys: new Set(result.referencedObjectKeys),
  });
  let deletedEntries = 0;
  let deletedBytes = 0;
  for (let pass = 1; pass <= options.maxPasses; pass += 1) {
    const reconciled = await options.objectStore.reconcileOrphans(references);
    deletedEntries += reconciled.deletedEntries;
    deletedBytes += reconciled.deletedBytes;
    if (!Number.isSafeInteger(deletedEntries) || !Number.isSafeInteger(deletedBytes)) {
      throw new TypeError("attachment_reconciliation_accounting");
    }
    if (!reconciled.limitReached) {
      return Object.freeze({ deletedEntries, deletedBytes, passes: pass });
    }
  }
  throw new Error("attachment_reconciliation_limit");
}
