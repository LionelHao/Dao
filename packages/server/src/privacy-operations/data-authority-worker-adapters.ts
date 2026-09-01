import type {
  DiagnosticsArtifactCommit,
  DiagnosticsServiceAuthority,
} from "./diagnostics-service.js";
import type {
  PrivacyDataAuthorityOperation,
  PrivacyDataAuthorityResult,
} from "./data-authority-protocol.js";
import type { RoomExportAuthorityPorts } from "./room-export-authority-adapter.js";

export interface PrivacyDataAuthorityWorkerPort {
  executePrivacyData(operation: PrivacyDataAuthorityOperation): Promise<PrivacyDataAuthorityResult>;
}

/** Server-private artifact sink; implementations must not expose a caller-selected path. */
export interface DiagnosticsArtifactStore {
  commit(input: Parameters<DiagnosticsServiceAuthority["commitArtifact"]>[0]): Promise<DiagnosticsArtifactCommit>;
  discard(input: Parameters<DiagnosticsServiceAuthority["discardArtifact"]>[0]): Promise<void>;
}

export type PrivacyOperationsMetadataAuditRecord =
  | Readonly<{
      kind: "diagnostics";
      event: Parameters<DiagnosticsServiceAuthority["audit"]>[0];
    }>
  | Readonly<{
      kind: "room_export";
      event: Parameters<RoomExportAuthorityPorts["audit"]["append"]>[0];
    }>;

export interface PrivacyOperationsMetadataAuditSink {
  append(record: PrivacyOperationsMetadataAuditRecord): Promise<void>;
}

function unexpectedResult(): never {
  throw new TypeError("AuthorityWorker returned an unexpected privacy data result");
}

export function createDiagnosticsAuthorityWorkerAdapter(options: Readonly<{
  worker: PrivacyDataAuthorityWorkerPort;
  artifacts: DiagnosticsArtifactStore;
  audit: PrivacyOperationsMetadataAuditSink;
  nowMs?: () => number;
}>): DiagnosticsServiceAuthority {
  const nowMs = options.nowMs ?? Date.now;
  return Object.freeze({
    async authorize(input: Parameters<DiagnosticsServiceAuthority["authorize"]>[0]) {
      const result = await options.worker.executePrivacyData({
        version: 1,
        type: "privacy.diagnostics.authorize",
        actorId: input.actorId,
        sessionFamilyId: input.sessionFamilyId,
        sessionId: input.sessionId,
        now: nowMs(),
      });
      if (result.kind !== "diagnostics-principal") return unexpectedResult();
      return Object.freeze({
        actorId: result.actorId,
        sessionFamilyId: result.sessionFamilyId,
        sessionId: result.sessionId,
        principalKind: result.principalKind,
      });
    },
    async readClosedEntries(input: Parameters<DiagnosticsServiceAuthority["readClosedEntries"]>[0]) {
      const result = await options.worker.executePrivacyData({
        version: 1,
        type: "privacy.diagnostics.read-closed",
        actorId: input.principal.actorId,
        sessionFamilyId: input.principal.sessionFamilyId,
        sessionId: input.principal.sessionId,
        limit: input.limit,
        now: nowMs(),
      });
      if (result.kind !== "diagnostics-entries") return unexpectedResult();
      return result.entries;
    },
    commitArtifact(input: Parameters<DiagnosticsServiceAuthority["commitArtifact"]>[0]) {
      return options.artifacts.commit(input);
    },
    discardArtifact(input: Parameters<DiagnosticsServiceAuthority["discardArtifact"]>[0]) {
      return options.artifacts.discard(input);
    },
    audit(event: Parameters<DiagnosticsServiceAuthority["audit"]>[0]) {
      return options.audit.append(Object.freeze({ kind: "diagnostics", event }));
    },
  });
}

export function createRoomExportAuthorityWorkerPorts(options: Readonly<{
  worker: PrivacyDataAuthorityWorkerPort;
  audit: PrivacyOperationsMetadataAuditSink;
  nowMs?: () => number;
}>): RoomExportAuthorityPorts {
  const nowMs = options.nowMs ?? Date.now;
  return Object.freeze({
    sessions: Object.freeze({
      async inspect(input: Parameters<RoomExportAuthorityPorts["sessions"]["inspect"]>[0]) {
        const result = await options.worker.executePrivacyData({
          version: 1,
          type: "privacy.room-export.inspect-session",
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          now: nowMs(),
        });
        if (result.kind !== "room-export-session") return unexpectedResult();
        return result.session;
      },
    }),
    roomAccess: Object.freeze({
      async inspect(input: Parameters<RoomExportAuthorityPorts["roomAccess"]["inspect"]>[0]) {
        const result = await options.worker.executePrivacyData({
          version: 1,
          type: "privacy.room-export.inspect-access",
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          roomId: input.roomId,
          now: nowMs(),
        });
        if (result.kind !== "room-export-access") return unexpectedResult();
        return result.access;
      },
    }),
    snapshots: Object.freeze({
      async begin(input: Parameters<RoomExportAuthorityPorts["snapshots"]["begin"]>[0]) {
        const result = await options.worker.executePrivacyData({
          version: 1,
          type: "privacy.room-export.begin",
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          roomId: input.roomId,
          tenantId: input.tenantId,
          accessRevision: input.accessRevision,
          lifecycle: input.lifecycle,
          now: nowMs(),
        });
        if (result.kind !== "room-export-snapshot") return unexpectedResult();
        return result.snapshot;
      },
      async reauthorize(
        input: Parameters<RoomExportAuthorityPorts["snapshots"]["reauthorize"]>[0],
      ) {
        const result = await options.worker.executePrivacyData({
          version: 1,
          type: "privacy.room-export.reauthorize",
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          exportId: input.exportId,
          roomId: input.roomId,
          tenantId: input.tenantId,
          accessRevision: input.accessRevision,
          lifecycle: input.lifecycle,
          watermark: input.watermark,
          startedAt: input.startedAt,
          now: nowMs(),
        });
        if (result.kind !== "room-export-reauthorized") return unexpectedResult();
      },
    }),
    projections: Object.freeze({
      async readPage(input: Parameters<RoomExportAuthorityPorts["projections"]["readPage"]>[0]) {
        const result = await options.worker.executePrivacyData({
          version: 1,
          type: "privacy.room-export.read-page",
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          exportId: input.exportId,
          roomId: input.roomId,
          tenantId: input.tenantId,
          accessRevision: input.accessRevision,
          lifecycle: input.lifecycle,
          watermark: input.watermark,
          startedAt: input.startedAt,
          ...(input.after === undefined ? {} : { after: input.after }),
          limit: input.limit,
          now: nowMs(),
        });
        if (result.kind !== "room-export-page") return unexpectedResult();
        return Object.freeze({
          records: result.records,
          ...(result.next === undefined ? {} : { next: result.next }),
        });
      },
    }),
    audit: Object.freeze({
      append(event: Parameters<RoomExportAuthorityPorts["audit"]["append"]>[0]) {
        return options.audit.append(Object.freeze({ kind: "room_export", event }));
      },
    }),
  });
}
