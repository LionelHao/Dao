import {
  isProjectEvent,
  isProjectRepairRecord,
  isProjectSnapshot,
  type ProjectEvent,
  type ProjectRepairRecord,
  type ProjectSnapshot,
} from "@native-im/core";

export class ProjectLoopReplicaError extends Error {
  readonly code = "project_loop_invalid_authority_input";
  constructor() {
    super("Project Loop authority input was invalid");
    this.name = "ProjectLoopReplicaError";
  }
}

export interface ProjectLoopReplica {
  snapshot(): ProjectSnapshot | undefined;
  replaceFromQuery(value: unknown): ProjectSnapshot;
  replaceFromRepair(value: unknown): ProjectSnapshot;
  observeStableEvent(value: unknown): Readonly<{ needsRefresh: boolean; event?: ProjectEvent }>;
  clear(): void;
}

export function createProjectLoopReplica(roomId: string): ProjectLoopReplica {
  let current: ProjectSnapshot | undefined;
  const replace = (snapshot: unknown): ProjectSnapshot => {
    if (!isProjectSnapshot(snapshot) || snapshot.roomId !== roomId || snapshot.projectId !== roomId) {
      throw new ProjectLoopReplicaError();
    }
    const next = structuredClone(snapshot);
    current = next;
    return structuredClone(next);
  };
  return Object.freeze({
    snapshot: () => current === undefined ? undefined : structuredClone(current),
    replaceFromQuery: replace,
    replaceFromRepair(value: unknown) {
      if (!isProjectRepairRecord(value, roomId)) throw new ProjectLoopReplicaError();
      const record = value as ProjectRepairRecord;
      return replace(record.value);
    },
    observeStableEvent(value: unknown) {
      if (!isProjectEvent(value) || value.roomId !== roomId || value.projectId !== roomId) {
        throw new ProjectLoopReplicaError();
      }
      if (current !== undefined && value.streamSeq <= current.watermark) {
        return Object.freeze({ needsRefresh: false as const });
      }
      return Object.freeze({ needsRefresh: true as const, event: structuredClone(value) });
    },
    clear() { current = undefined; },
  });
}
