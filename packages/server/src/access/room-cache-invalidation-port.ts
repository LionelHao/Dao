import { createHash } from "node:crypto";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import type {
  AuthorityTransactionView,
  ParticipantRegistration,
  RoomCacheInvalidationPort,
  RoomCacheInvalidationResult,
} from "../room-governance/private-participant-contracts.js";

export const ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE room_access_authority (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0)
  ) STRICT`,
] as const;

export const ROOM_CACHE_INVALIDATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE room_cache_invalidation_intents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    reason TEXT NOT NULL CHECK (reason IN ('room_archived')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    last_error_code TEXT CHECK (
      last_error_code IS NULL OR last_error_code IN ('purge_failed', 'authority_unavailable')
    ),
    UNIQUE (room_id, lifecycle_generation, reason)
  ) STRICT`,
  `CREATE INDEX room_cache_invalidation_ready
   ON room_cache_invalidation_intents(status, available_at, created_at, id)`,
] as const;

interface ExistingInvalidationRow {
  readonly id: string;
  readonly lifecycle_generation: number;
  readonly access_revision: number;
}

interface AccessRevisionRow {
  readonly access_revision: number;
}

function invalidationIntentId(roomId: string, lifecycleGeneration: number): string {
  const digest = createHash("sha256")
    .update("room-cache-invalidation\0")
    .update(roomId)
    .update("\0")
    .update(String(lifecycleGeneration))
    .update("\0room_archived")
    .digest("hex");
  return `room-cache-invalidation-${digest}`;
}

const roomCacheInvalidationPort: RoomCacheInvalidationPort = Object.freeze({
  invalidateRoomCacheInTransaction(
    transaction: AuthorityTransactionView,
    input: Readonly<{
      roomId: string;
      lifecycleGeneration: number;
      reason: "room_archived";
    }>,
  ) {
    if (transaction.roomId !== input.roomId || !Number.isSafeInteger(input.lifecycleGeneration) ||
      input.lifecycleGeneration < 0 || input.reason !== "room_archived") {
      throw new TypeError("Room cache invalidation input is invalid");
    }
    return useAuthorityTransactionDatabase(transaction, (database) => {
      const existing = database.prepare(`
        SELECT id, lifecycle_generation, access_revision
        FROM room_cache_invalidation_intents
        WHERE room_id = ? AND lifecycle_generation = ? AND reason = ?
      `).get(
        input.roomId,
        input.lifecycleGeneration,
        input.reason,
      ) as ExistingInvalidationRow | undefined;
      if (existing !== undefined) {
        return successResult({
          roomId: input.roomId,
          lifecycleGeneration: existing.lifecycle_generation,
          invalidationIntentId: existing.id,
          accessRevision: existing.access_revision,
        });
      }

      const latest = database.prepare(`
        SELECT MAX(lifecycle_generation) AS lifecycle_generation
        FROM room_cache_invalidation_intents
        WHERE room_id = ?
      `).get(input.roomId) as { lifecycle_generation: number | null };
      if (latest.lifecycle_generation !== null &&
        latest.lifecycle_generation > input.lifecycleGeneration) {
        throw new Error("Room cache invalidation lifecycle generation is stale");
      }

      const revision = database.prepare(`
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        SELECT ?, COALESCE(MAX(access_revision), 0) + 1, 0
        FROM room_memberships
        WHERE room_id = ?
        ON CONFLICT(room_id) DO UPDATE SET
          access_revision = room_access_authority.access_revision + 1
        RETURNING access_revision
      `).get(input.roomId, input.roomId) as unknown as AccessRevisionRow;
      const id = invalidationIntentId(input.roomId, input.lifecycleGeneration);
      database.prepare(`
        INSERT INTO room_cache_invalidation_intents (
          id, room_id, lifecycle_generation, access_revision, reason
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, input.roomId, input.lifecycleGeneration, revision.access_revision, input.reason);

      return successResult({
        roomId: input.roomId,
        lifecycleGeneration: input.lifecycleGeneration,
        invalidationIntentId: id,
        accessRevision: revision.access_revision,
      });
    });
  },
});

function successResult(result: RoomCacheInvalidationResult) {
  return Object.freeze({ ok: true as const, result: Object.freeze(result) });
}

export const roomCacheInvalidationRegistration = Object.freeze({
  registrationId: "dao.access.room-cache-invalidation.v1",
  feature: "room-cache-invalidation",
  version: 1,
  enabled: true,
  participant: roomCacheInvalidationPort,
}) satisfies ParticipantRegistration<RoomCacheInvalidationPort>;

export interface CommittedRoomCacheInvalidationIntent {
  readonly invalidationIntentId: string;
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly reason: "room_archived";
}

export interface RoomCacheInvalidationIntentAuthority {
  listCommittedReady(limit: number): Promise<readonly CommittedRoomCacheInvalidationIntent[]>;
  markCompleted(invalidationIntentId: string): Promise<void>;
  markFailed(
    invalidationIntentId: string,
    errorCode: "purge_failed" | "authority_unavailable",
  ): Promise<void>;
}

export interface RoomCachePurgeAdapter {
  purgeCommittedRoom(intent: CommittedRoomCacheInvalidationIntent): Promise<void>;
}

export interface RoomCacheInvalidationDispatchResult {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

export class RoomCacheInvalidationPostCommitDispatcher {
  readonly #authority: RoomCacheInvalidationIntentAuthority;
  readonly #purge: RoomCachePurgeAdapter;
  readonly #batchLimit: number;

  constructor(options: Readonly<{
    authority: RoomCacheInvalidationIntentAuthority;
    purge: RoomCachePurgeAdapter;
    batchLimit: number;
  }>) {
    if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit <= 0) {
      throw new TypeError("Room cache invalidation batch limit is invalid");
    }
    this.#authority = options.authority;
    this.#purge = options.purge;
    this.#batchLimit = options.batchLimit;
  }

  async dispatchReadyBatch(): Promise<RoomCacheInvalidationDispatchResult> {
    const intents = await this.#authority.listCommittedReady(this.#batchLimit);
    if (!Array.isArray(intents) || intents.length > this.#batchLimit ||
      !intents.every(isCommittedInvalidationIntent)) {
      throw new TypeError("Committed room cache invalidation batch is malformed");
    }

    let completed = 0;
    let failed = 0;
    for (const intent of intents) {
      try {
        await this.#purge.purgeCommittedRoom(intent);
        await this.#authority.markCompleted(intent.invalidationIntentId);
        completed += 1;
      } catch {
        await this.#authority.markFailed(intent.invalidationIntentId, "purge_failed");
        failed += 1;
      }
    }
    return Object.freeze({ attempted: intents.length, completed, failed });
  }
}

function isCommittedInvalidationIntent(
  value: unknown,
): value is CommittedRoomCacheInvalidationIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<CommittedRoomCacheInvalidationIntent>;
  return Object.keys(value).length === 5 &&
    typeof candidate.invalidationIntentId === "string" && candidate.invalidationIntentId.length > 0 &&
    typeof candidate.roomId === "string" && candidate.roomId.length > 0 &&
    Number.isSafeInteger(candidate.lifecycleGeneration) && candidate.lifecycleGeneration! >= 0 &&
    Number.isSafeInteger(candidate.accessRevision) && candidate.accessRevision! >= 0 &&
    candidate.reason === "room_archived";
}
