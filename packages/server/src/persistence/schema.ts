import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const AUTHORITY_SCHEMA_VERSION = 2 as const;

export interface MigrationFaultOptions {
  readonly failAfterStatement?: number;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  readonly checksum: string;
}

const AUTHORITY_BUSY_TIMEOUT_MS = 5_000;
const V1_MIGRATION_CHECKSUM =
  "34117e7de4fb7c8eb36b5363bc178e45a82b08c668ca712a7b7e5e82343a6358";
const SCHEMA_FINGERPRINTS = {
  1: "03f2bbba4aa7082ec01819824726ce1bd9b4bd14cebea71afc93c6821dbf405c",
  2: "01c37d92ec2f303613a7bb8b592ca846fbea7c829b3c81fe4521699db949dfcc",
} as const;

const V1_STATEMENTS = [
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    display_name TEXT NOT NULL,
    reachability TEXT,
    readiness TEXT,
    tool_permissions_json TEXT NOT NULL DEFAULT '[]'
  ) STRICT`,
  `CREATE TABLE sessions (
    family_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES actors(id),
    access_token_hash TEXT PRIMARY KEY,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    access_expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT`,
  `CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE room_memberships (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    role TEXT,
    participation TEXT,
    tool_permissions_json TEXT NOT NULL DEFAULT '[]',
    joined_at TEXT,
    configured_at TEXT,
    PRIMARY KEY (room_id, actor_id)
  ) STRICT`,
  `CREATE TABLE room_invitations (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    inviter_actor_id TEXT NOT NULL REFERENCES actors(id),
    invitee_actor_id TEXT NOT NULL REFERENCES actors(id),
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL,
    decision_actor_id TEXT REFERENCES actors(id),
    decided_at TEXT
  ) STRICT`,
  `CREATE TABLE room_audit (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (
      'room.created', 'room.renamed', 'room.archived', 'room.human.invited',
      'room.invitation.accepted', 'room.invitation.rejected',
      'room.agent.configured', 'room.member.removed', 'room.member.role.changed'
    )),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    result TEXT NOT NULL CHECK (result IN (
      'created', 'renamed', 'archived', 'pending', 'accepted', 'rejected',
      'configured', 'removed', 'role-changed'
    )),
    timestamp TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    author_id TEXT NOT NULL REFERENCES actors(id),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL
  ) STRICT`,
] as const;

const V2_STATEMENTS = [
  `ALTER TABLE actors
   ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0
   CHECK (catalog_revision >= 0)`,
  `ALTER TABLE room_memberships
   ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0
   CHECK (access_revision >= 0)`,
  `CREATE TABLE human_read_receipts (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    read_at TEXT NOT NULL,
    PRIMARY KEY (room_id, actor_id)
  ) STRICT`,
  `CREATE TABLE agent_judgments (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    message_id TEXT REFERENCES messages(id),
    judgment_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE open_items (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT REFERENCES messages(id),
    assigned_actor_id TEXT REFERENCES actors(id),
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  ) STRICT`,
  `CREATE TABLE agent_executions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    trigger_message_id TEXT REFERENCES messages(id),
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result_json TEXT
  ) STRICT`,
  `CREATE TABLE calibration_signals (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    judgment_id TEXT REFERENCES agent_judgments(id),
    signal TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE streams (
    stream_kind TEXT NOT NULL CHECK (stream_kind IN ('room', 'identity')),
    stream_id TEXT NOT NULL,
    head_seq INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
    retained_from_seq INTEGER NOT NULL DEFAULT 1
      CHECK (retained_from_seq >= 1 AND retained_from_seq <= head_seq + 1),
    PRIMARY KEY (stream_kind, stream_id)
  ) STRICT`,
  `CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    stream_kind TEXT NOT NULL CHECK (stream_kind IN ('room', 'identity')),
    stream_id TEXT NOT NULL,
    stream_seq INTEGER NOT NULL CHECK (stream_seq >= 1),
    room_id TEXT REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (stream_kind, stream_id, stream_seq),
    FOREIGN KEY (stream_kind, stream_id)
      REFERENCES streams(stream_kind, stream_id),
    CHECK (
      (stream_kind = 'room' AND room_id IS NOT NULL AND room_id = stream_id)
      OR (stream_kind = 'identity' AND room_id IS NULL)
    )
  ) STRICT`,
  `CREATE TABLE idempotency_records (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  ) STRICT`,
  `CREATE TABLE outbox_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(event_id),
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    delivered_at TEXT,
    last_error TEXT,
    UNIQUE (event_id, destination)
  ) STRICT`,
  `INSERT INTO streams (
     stream_kind, stream_id, head_seq, retained_from_seq
   )
   SELECT 'room', id, 0, 1 FROM rooms`,
  `INSERT INTO streams (
     stream_kind, stream_id, head_seq, retained_from_seq
   )
   SELECT 'identity', id, 0, 1 FROM actors`,
  `CREATE TRIGGER actors_prevent_kind_change
   BEFORE UPDATE OF kind ON actors
   WHEN NEW.kind <> OLD.kind
   BEGIN
     SELECT RAISE(ABORT, 'actor kind is immutable');
   END`,
  `CREATE TRIGGER sessions_validate_insert
   BEFORE INSERT ON sessions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
   BEGIN
     SELECT RAISE(ABORT, 'session actor must be human');
   END`,
  `CREATE TRIGGER sessions_validate_update
   BEFORE UPDATE OF actor_id ON sessions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
   BEGIN
     SELECT RAISE(ABORT, 'session actor must be human');
   END`,
  `CREATE TRIGGER room_memberships_validate_insert
   BEFORE INSERT ON room_memberships
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> NEW.kind
   BEGIN
     SELECT RAISE(ABORT, 'membership kind must match actor kind');
   END`,
  `CREATE TRIGGER room_memberships_validate_update
   BEFORE UPDATE OF actor_id, kind ON room_memberships
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> NEW.kind
   BEGIN
     SELECT RAISE(ABORT, 'membership kind must match actor kind');
   END`,
  `CREATE TRIGGER messages_validate_insert
   BEFORE INSERT ON messages
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.author_id), '')
        <> NEW.author_kind
   BEGIN
     SELECT RAISE(ABORT, 'message author kind must match actor kind');
   END`,
  `CREATE TRIGGER messages_validate_update
   BEFORE UPDATE OF room_id, author_id, author_kind ON messages
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.author_id), '')
          <> NEW.author_kind
      OR EXISTS (
        SELECT 1 FROM human_read_receipts
        WHERE message_id = OLD.id AND room_id <> NEW.room_id
      )
      OR EXISTS (
        SELECT 1 FROM agent_judgments
        WHERE message_id = OLD.id AND room_id <> NEW.room_id
      )
      OR EXISTS (
        SELECT 1 FROM open_items
        WHERE source_message_id = OLD.id AND room_id <> NEW.room_id
      )
      OR EXISTS (
        SELECT 1 FROM agent_executions
        WHERE trigger_message_id = OLD.id AND room_id <> NEW.room_id
      )
   BEGIN
     SELECT RAISE(ABORT, 'message update would break authority references');
   END`,
  `CREATE TRIGGER room_invitations_validate_insert
   BEFORE INSERT ON room_invitations
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.inviter_actor_id), '')
          <> 'human'
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.invitee_actor_id), '')
          <> 'human'
      OR (NEW.decision_actor_id IS NOT NULL
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.decision_actor_id), '')
              <> 'human')
   BEGIN
     SELECT RAISE(ABORT, 'invitation actors must be human');
   END`,
  `CREATE TRIGGER room_invitations_validate_update
   BEFORE UPDATE OF inviter_actor_id, invitee_actor_id, decision_actor_id
   ON room_invitations
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.inviter_actor_id), '')
          <> 'human'
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.invitee_actor_id), '')
          <> 'human'
      OR (NEW.decision_actor_id IS NOT NULL
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.decision_actor_id), '')
              <> 'human')
   BEGIN
     SELECT RAISE(ABORT, 'invitation actors must be human');
   END`,
  `CREATE TRIGGER human_read_receipts_validate_insert
   BEFORE INSERT ON human_read_receipts
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
      OR COALESCE((SELECT room_id FROM messages WHERE id = NEW.message_id), '')
          <> NEW.room_id
   BEGIN
     SELECT RAISE(ABORT, 'read receipt must reference a human and room message');
   END`,
  `CREATE TRIGGER human_read_receipts_validate_update
   BEFORE UPDATE OF room_id, actor_id, message_id ON human_read_receipts
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
      OR COALESCE((SELECT room_id FROM messages WHERE id = NEW.message_id), '')
          <> NEW.room_id
   BEGIN
     SELECT RAISE(ABORT, 'read receipt must reference a human and room message');
   END`,
  `CREATE TRIGGER agent_judgments_validate_insert
   BEFORE INSERT ON agent_judgments
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.message_id), '')
              <> NEW.room_id)
   BEGIN
     SELECT RAISE(ABORT, 'agent judgment must reference an agent and room message');
   END`,
  `CREATE TRIGGER agent_judgments_validate_update
   BEFORE UPDATE OF room_id, agent_id, message_id ON agent_judgments
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.message_id), '')
              <> NEW.room_id)
      OR EXISTS (
        SELECT 1 FROM calibration_signals
        WHERE judgment_id = OLD.id
          AND (room_id <> NEW.room_id OR agent_id <> NEW.agent_id)
      )
   BEGIN
     SELECT RAISE(ABORT, 'agent judgment update would break authority references');
   END`,
  `CREATE TRIGGER open_items_validate_insert
   BEFORE INSERT ON open_items
   WHEN NEW.source_message_id IS NOT NULL
    AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '')
        <> NEW.room_id
   BEGIN
     SELECT RAISE(ABORT, 'open item source must belong to its room');
   END`,
  `CREATE TRIGGER open_items_validate_update
   BEFORE UPDATE OF room_id, source_message_id ON open_items
   WHEN NEW.source_message_id IS NOT NULL
    AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '')
        <> NEW.room_id
   BEGIN
     SELECT RAISE(ABORT, 'open item source must belong to its room');
   END`,
  `CREATE TRIGGER agent_executions_validate_insert
   BEFORE INSERT ON agent_executions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.trigger_message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.trigger_message_id), '')
              <> NEW.room_id)
   BEGIN
     SELECT RAISE(ABORT, 'agent execution must reference an agent and room message');
   END`,
  `CREATE TRIGGER agent_executions_validate_update
   BEFORE UPDATE OF room_id, agent_id, trigger_message_id ON agent_executions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.trigger_message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.trigger_message_id), '')
              <> NEW.room_id)
   BEGIN
     SELECT RAISE(ABORT, 'agent execution must reference an agent and room message');
   END`,
  `CREATE TRIGGER calibration_signals_validate_insert
   BEFORE INSERT ON calibration_signals
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.judgment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_judgments
        WHERE id = NEW.judgment_id
          AND room_id = NEW.room_id
          AND agent_id = NEW.agent_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'calibration signal must match an agent judgment');
   END`,
  `CREATE TRIGGER calibration_signals_validate_update
   BEFORE UPDATE OF room_id, agent_id, judgment_id ON calibration_signals
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.judgment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_judgments
        WHERE id = NEW.judgment_id
          AND room_id = NEW.room_id
          AND agent_id = NEW.agent_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'calibration signal must match an agent judgment');
   END`,
  `CREATE TRIGGER events_validate_insert
   BEFORE INSERT ON events
   WHEN NOT EXISTS (
     SELECT 1 FROM streams AS stream
     WHERE stream.stream_kind = NEW.stream_kind
       AND stream.stream_id = NEW.stream_id
       AND NEW.stream_seq = stream.head_seq
       AND NEW.stream_seq >= stream.retained_from_seq
       AND (
         NEW.stream_seq = stream.retained_from_seq
         OR EXISTS (
           SELECT 1 FROM events AS previous
           WHERE previous.stream_kind = NEW.stream_kind
             AND previous.stream_id = NEW.stream_id
             AND previous.stream_seq = NEW.stream_seq - 1
         )
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'event sequence is outside the current stream window');
   END`,
  `CREATE TRIGGER events_prevent_update
   BEFORE UPDATE ON events
   BEGIN
     SELECT RAISE(ABORT, 'events are immutable');
   END`,
  `CREATE TRIGGER events_validate_delete
   BEFORE DELETE ON events
   WHEN EXISTS (
     SELECT 1 FROM streams AS stream
     WHERE stream.stream_kind = OLD.stream_kind
       AND stream.stream_id = OLD.stream_id
       AND OLD.stream_seq >= stream.retained_from_seq
       AND OLD.stream_seq <= stream.head_seq
   )
   BEGIN
     SELECT RAISE(ABORT, 'event inside retained window cannot be deleted');
   END`,
] as const;

function migrationChecksum(
  version: number,
  name: string,
  statements: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version, name, statements }))
    .digest("hex");
}

function defineMigration(
  version: number,
  name: string,
  statements: readonly string[],
  historicalChecksum?: string,
): Migration {
  const checksum = migrationChecksum(version, name, statements);
  if (historicalChecksum !== undefined && checksum !== historicalChecksum) {
    throw new Error(`Historical migration ${version} no longer matches its checksum`);
  }
  return {
    version,
    name,
    statements,
    checksum: historicalChecksum ?? checksum,
  };
}

const MIGRATIONS = [
  defineMigration(1, "initial-authority", V1_STATEMENTS, V1_MIGRATION_CHECKSUM),
  defineMigration(2, "collaboration-facts-and-streams", V2_STATEMENTS),
] as const satisfies readonly Migration[];

const V1_SCHEMA_CONTRACT = {
  actors: [
    "id",
    "kind",
    "display_name",
    "reachability",
    "readiness",
    "tool_permissions_json",
  ],
  messages: ["id", "room_id", "author_id", "author_kind", "body", "sent_at"],
  room_audit: [
    "id",
    "type",
    "room_id",
    "actor_id",
    "result",
    "timestamp",
    "details_json",
  ],
  room_invitations: [
    "id",
    "room_id",
    "inviter_actor_id",
    "invitee_actor_id",
    "token_hash",
    "status",
    "created_at",
    "decision_actor_id",
    "decided_at",
  ],
  room_memberships: [
    "room_id",
    "actor_id",
    "kind",
    "role",
    "participation",
    "tool_permissions_json",
    "joined_at",
    "configured_at",
  ],
  rooms: ["id", "name", "status", "created_at"],
  schema_migrations: ["version", "name", "checksum", "applied_at"],
  sessions: [
    "family_id",
    "account_id",
    "actor_id",
    "access_token_hash",
    "refresh_token_hash",
    "access_expires_at",
    "refresh_expires_at",
    "revoked_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V2_SCHEMA_CONTRACT = {
  ...V1_SCHEMA_CONTRACT,
  actors: [...V1_SCHEMA_CONTRACT.actors, "catalog_revision"],
  agent_executions: [
    "id",
    "room_id",
    "agent_id",
    "trigger_message_id",
    "status",
    "started_at",
    "completed_at",
    "result_json",
  ],
  agent_judgments: [
    "id",
    "room_id",
    "agent_id",
    "message_id",
    "judgment_json",
    "created_at",
  ],
  calibration_signals: [
    "id",
    "room_id",
    "agent_id",
    "judgment_id",
    "signal",
    "created_at",
  ],
  events: [
    "event_id",
    "stream_kind",
    "stream_id",
    "stream_seq",
    "room_id",
    "actor_id",
    "event_type",
    "occurred_at",
    "payload_json",
  ],
  human_read_receipts: ["room_id", "actor_id", "message_id", "read_at"],
  idempotency_records: [
    "scope",
    "key",
    "request_hash",
    "response_json",
    "status_code",
    "created_at",
    "expires_at",
  ],
  open_items: [
    "id",
    "room_id",
    "source_message_id",
    "assigned_actor_id",
    "status",
    "body",
    "created_at",
    "resolved_at",
  ],
  outbox_deliveries: [
    "id",
    "event_id",
    "destination",
    "status",
    "attempts",
    "available_at",
    "delivered_at",
    "last_error",
  ],
  room_memberships: [...V1_SCHEMA_CONTRACT.room_memberships, "access_revision"],
  streams: [
    "stream_kind",
    "stream_id",
    "head_seq",
    "retained_from_seq",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const SCHEMA_CONTRACTS = {
  1: V1_SCHEMA_CONTRACT,
  2: V2_SCHEMA_CONTRACT,
} as const;

function readPragmaNumber(database: DatabaseSync, pragma: string, field: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[field];
  if (typeof value !== "number") {
    throw new Error(`Unable to read PRAGMA ${pragma}`);
  }
  return value;
}

function readPragmaString(database: DatabaseSync, pragma: string, field: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[field];
  if (typeof value !== "string") {
    throw new Error(`Unable to read PRAGMA ${pragma}`);
  }
  return value;
}

export function configureAuthorityConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("PRAGMA journal_mode = WAL").get();
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`PRAGMA busy_timeout = ${AUTHORITY_BUSY_TIMEOUT_MS}`);

  const foreignKeys = readPragmaNumber(database, "foreign_keys", "foreign_keys");
  const journalMode = readPragmaString(database, "journal_mode", "journal_mode");
  const synchronous = readPragmaNumber(database, "synchronous", "synchronous");
  const busyTimeout = readPragmaNumber(database, "busy_timeout", "timeout");

  if (
    foreignKeys !== 1 ||
    journalMode.toLowerCase() !== "wal" ||
    synchronous !== 2 ||
    busyTimeout !== AUTHORITY_BUSY_TIMEOUT_MS
  ) {
    throw new Error("Authority SQLite connection configuration could not be verified");
  }
}

export function readSchemaVersion(database: DatabaseSync): number {
  return readPragmaNumber(database, "user_version", "user_version");
}

export function listAuthorityTables(database: DatabaseSync): readonly string[] {
  return database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
}

function validateFaultOptions(fault: MigrationFaultOptions | undefined): void {
  if (
    fault?.failAfterStatement !== undefined &&
    (!Number.isSafeInteger(fault.failAfterStatement) || fault.failAfterStatement <= 0)
  ) {
    throw new TypeError("failAfterStatement must be a positive safe integer");
  }
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function readTableColumns(database: DatabaseSync, tableName: string): readonly string[] {
  return database
    .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .all(tableName)
    .map((row) => String(row.name));
}

function canonicalSchemaSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1");
}

function readSchemaFingerprint(database: DatabaseSync): string {
  const artifact = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map((row) => {
      if (
        typeof row.type !== "string" ||
        typeof row.name !== "string" ||
        typeof row.tbl_name !== "string" ||
        typeof row.sql !== "string"
      ) {
        throw new Error("Refusing unknown physical schema metadata");
      }
      return {
        type: row.type,
        name: row.name,
        table: row.tbl_name,
        sql: canonicalSchemaSql(row.sql),
      };
    });
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}

function requireNoRows(database: DatabaseSync, sql: string, invariant: string): void {
  if (database.prepare(sql).get() !== undefined) {
    throw new Error(`Authority invariant failed: ${invariant}`);
  }
}

function validateSqliteIntegrity(database: DatabaseSync): void {
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== "ok"
    ) {
      throw new Error("PRAGMA integrity_check did not return exactly ok");
    }
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("PRAGMA foreign_key_check returned violations");
    }
  } catch (error: unknown) {
    throw new Error("Authority integrity check failed", { cause: error });
  }
}

function validateAuthorityData(database: DatabaseSync, schemaVersion: number): void {
  validateSqliteIntegrity(database);
  requireNoRows(
    database,
    `SELECT 1
     FROM sessions AS session
     LEFT JOIN actors AS actor ON actor.id = session.actor_id
     WHERE actor.id IS NULL OR actor.kind <> 'human'
     LIMIT 1`,
    "sessions must reference human actors",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM room_memberships AS membership
     LEFT JOIN rooms AS room ON room.id = membership.room_id
     LEFT JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE room.id IS NULL OR actor.id IS NULL OR membership.kind <> actor.kind
     LIMIT 1`,
    "memberships must reference matching rooms and actor kinds",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM messages AS message
     LEFT JOIN rooms AS room ON room.id = message.room_id
     LEFT JOIN actors AS actor ON actor.id = message.author_id
     WHERE room.id IS NULL OR actor.id IS NULL OR message.author_kind <> actor.kind
     LIMIT 1`,
    "messages must reference matching rooms and author kinds",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM room_invitations AS invitation
     LEFT JOIN actors AS inviter ON inviter.id = invitation.inviter_actor_id
     LEFT JOIN actors AS invitee ON invitee.id = invitation.invitee_actor_id
     LEFT JOIN actors AS decision ON decision.id = invitation.decision_actor_id
     WHERE inviter.kind <> 'human'
        OR invitee.kind <> 'human'
        OR (invitation.decision_actor_id IS NOT NULL AND decision.kind <> 'human')
     LIMIT 1`,
    "invitation actors must be human",
  );

  if (schemaVersion < 2) {
    return;
  }

  requireNoRows(
    database,
    `SELECT 1 FROM actors
     WHERE catalog_revision IS NULL OR catalog_revision < 0
     LIMIT 1`,
    "actor catalog revisions must be nonnegative",
  );
  requireNoRows(
    database,
    `SELECT 1 FROM room_memberships
     WHERE access_revision IS NULL OR access_revision < 0
     LIMIT 1`,
    "membership access revisions must be nonnegative",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM actors AS actor
     LEFT JOIN streams AS stream
       ON stream.stream_kind = 'identity' AND stream.stream_id = actor.id
     WHERE stream.stream_id IS NULL
     LIMIT 1`,
    "every actor must have an identity stream",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM rooms AS room
     LEFT JOIN streams AS stream
       ON stream.stream_kind = 'room' AND stream.stream_id = room.id
     WHERE stream.stream_id IS NULL
     LIMIT 1`,
    "every room must have a room stream",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM streams AS stream
     LEFT JOIN actors AS actor
       ON stream.stream_kind = 'identity' AND actor.id = stream.stream_id
     LEFT JOIN rooms AS room
       ON stream.stream_kind = 'room' AND room.id = stream.stream_id
     WHERE stream.stream_kind NOT IN ('room', 'identity')
        OR (stream.stream_kind = 'identity' AND actor.id IS NULL)
        OR (stream.stream_kind = 'room' AND room.id IS NULL)
        OR stream.head_seq < 0
        OR stream.retained_from_seq < 1
        OR stream.retained_from_seq > stream.head_seq + 1
     LIMIT 1`,
    "streams must be closed, owned, and internally ordered",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM events AS event
     LEFT JOIN streams AS stream
       ON stream.stream_kind = event.stream_kind
      AND stream.stream_id = event.stream_id
     LEFT JOIN actors AS actor ON actor.id = event.actor_id
     WHERE stream.stream_id IS NULL
        OR actor.id IS NULL
        OR event.stream_seq < 1
        OR event.stream_seq < stream.retained_from_seq
        OR event.stream_seq > stream.head_seq
        OR NOT json_valid(event.payload_json)
        OR (event.stream_kind = 'room'
            AND (event.room_id IS NULL OR event.room_id <> event.stream_id))
        OR (event.stream_kind = 'identity' AND event.room_id IS NOT NULL)
     LIMIT 1`,
    "events must reference a valid closed stream envelope",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM streams AS stream
     WHERE (stream.retained_from_seq <= stream.head_seq
            AND (SELECT COUNT(*)
                 FROM events AS event
                 WHERE event.stream_kind = stream.stream_kind
                   AND event.stream_id = stream.stream_id
                   AND event.stream_seq >= stream.retained_from_seq
                   AND event.stream_seq <= stream.head_seq)
                <> stream.head_seq - stream.retained_from_seq + 1)
        OR (stream.head_seq = 0 AND EXISTS (
          SELECT 1 FROM events AS event
          WHERE event.stream_kind = stream.stream_kind
            AND event.stream_id = stream.stream_id
        ))
     LIMIT 1`,
    "retained event windows must be complete and continuous",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM human_read_receipts AS receipt
     JOIN actors AS actor ON actor.id = receipt.actor_id
     JOIN messages AS message ON message.id = receipt.message_id
     WHERE actor.kind <> 'human' OR message.room_id <> receipt.room_id
     LIMIT 1`,
    "human read receipts must reference humans and room messages",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM agent_judgments AS judgment
     JOIN actors AS actor ON actor.id = judgment.agent_id
     LEFT JOIN messages AS message ON message.id = judgment.message_id
     WHERE actor.kind <> 'agent'
        OR (message.id IS NOT NULL AND message.room_id <> judgment.room_id)
     LIMIT 1`,
    "agent judgments must reference agents and room messages",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM open_items AS item
     LEFT JOIN messages AS message ON message.id = item.source_message_id
     WHERE item.source_message_id IS NOT NULL AND message.room_id <> item.room_id
     LIMIT 1`,
    "open item sources must belong to their rooms",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM agent_executions AS execution
     JOIN actors AS actor ON actor.id = execution.agent_id
     LEFT JOIN messages AS message ON message.id = execution.trigger_message_id
     WHERE actor.kind <> 'agent'
        OR (message.id IS NOT NULL AND message.room_id <> execution.room_id)
     LIMIT 1`,
    "agent executions must reference agents and room messages",
  );
  requireNoRows(
    database,
    `SELECT 1
     FROM calibration_signals AS signal
     JOIN actors AS actor ON actor.id = signal.agent_id
     LEFT JOIN agent_judgments AS judgment ON judgment.id = signal.judgment_id
     WHERE actor.kind <> 'agent'
        OR (judgment.id IS NOT NULL
            AND (judgment.room_id <> signal.room_id
                 OR judgment.agent_id <> signal.agent_id))
     LIMIT 1`,
    "calibration signals must reference matching agent judgments",
  );
}

function validateExistingSchema(database: DatabaseSync, currentVersion: number): void {
  if (currentVersion > AUTHORITY_SCHEMA_VERSION) {
    throw new Error(`Refusing future schema version ${currentVersion}`);
  }

  const tables = listAuthorityTables(database);
  if (currentVersion === 0) {
    if (tables.length !== 0) {
      throw new Error("Refusing unknown schema without migration history");
    }
    return;
  }

  const contract = SCHEMA_CONTRACTS[currentVersion as keyof typeof SCHEMA_CONTRACTS];
  if (contract === undefined) {
    throw new Error(`Refusing unknown schema version ${currentVersion}`);
  }
  const expectedTables = Object.keys(contract).sort();
  if (!sameStrings(tables, expectedTables)) {
    throw new Error(`Refusing unknown schema tables at version ${currentVersion}`);
  }
  for (const tableName of expectedTables) {
    const expectedColumns = contract[tableName as keyof typeof contract];
    if (!sameStrings(readTableColumns(database, tableName), expectedColumns)) {
      throw new Error(
        `Refusing unknown schema columns for ${tableName} at version ${currentVersion}`,
      );
    }
  }
  const expectedFingerprint =
    SCHEMA_FINGERPRINTS[currentVersion as keyof typeof SCHEMA_FINGERPRINTS];
  if (readSchemaFingerprint(database) !== expectedFingerprint) {
    throw new Error(
      `Refusing unknown schema physical contract at version ${currentVersion}`,
    );
  }

  const history = database
    .prepare(
      `SELECT version, name, checksum
       FROM schema_migrations ORDER BY version`,
    )
    .all();
  if (history.length !== currentVersion) {
    throw new Error("Refusing unknown schema migration history");
  }

  for (let index = 0; index < history.length; index += 1) {
    const actual = history[index];
    const expected = MIGRATIONS[index];
    if (
      actual === undefined ||
      expected === undefined ||
      actual.version !== expected.version ||
      actual.name !== expected.name
    ) {
      throw new Error("Refusing unknown schema migration history");
    }
    if (actual.checksum !== expected.checksum) {
      throw new Error(`Migration checksum mismatch at version ${expected.version}`);
    }
  }
  validateAuthorityData(database, currentVersion);
}

function appliedAt(): string {
  return new Date().toISOString();
}

export function migrateAuthorityDatabase(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void {
  validateFaultOptions(fault);
  configureAuthorityConnection(database);

  let statementCount = 0;
  // Node 22.13 has no DatabaseSync.isTransaction; this module owns the transaction.
  let transactionOpen = false;
  database.exec("BEGIN IMMEDIATE");
  transactionOpen = true;
  try {
    const currentVersion = readSchemaVersion(database);
    validateExistingSchema(database, currentVersion);
    if (currentVersion === AUTHORITY_SCHEMA_VERSION) {
      database.exec("COMMIT");
      transactionOpen = false;
      return;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }

      for (const statement of migration.statements) {
        database.exec(statement);
        statementCount += 1;
        if (fault?.failAfterStatement === statementCount) {
          throw new Error(
            `Injected migration failure after statement ${statementCount}`,
          );
        }
      }

      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(migration.version, migration.name, migration.checksum, appliedAt());
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }

    validateExistingSchema(database, AUTHORITY_SCHEMA_VERSION);
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Authority database migration failed and rollback failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
}
