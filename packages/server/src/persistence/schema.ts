import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const AUTHORITY_SCHEMA_VERSION = 6 as const;

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
const V2_MIGRATION_CHECKSUM =
  "b7521b7e6095e01834c2f4183dc5c04c52848f9c76483c344e111b5c03662c1c";
const V3_MIGRATION_CHECKSUM =
  "0f4ba33b182ae9b5c84874961265a4739a23cc80db4d8c6675af47646ceb81ee";
const V4_MIGRATION_CHECKSUM =
  "28a42b0ccfdc0d5c2eb111bc783cdd30c2678eb162cf9d77dcc2b6b3823f169c";
const V5_MIGRATION_CHECKSUM =
  "3f90cdeb9b7c9e04f432aac809f340033f6d9a2ea1a6a5bd8d9ab50fab8d891d";
const V6_MIGRATION_CHECKSUM =
  "f068c43f2e3e479a4fbf5c36903a3481d2cf6d9f62b3957815359f4084280468";
const SCHEMA_FINGERPRINTS = {
  1: "03f2bbba4aa7082ec01819824726ce1bd9b4bd14cebea71afc93c6821dbf405c",
  2: "01c37d92ec2f303613a7bb8b592ca846fbea7c829b3c81fe4521699db949dfcc",
  3: "8653114fb3c00fcbddc386c16693d98ce6f226695f1941ac73dc341aa5fc7a61",
  4: "b2d08fa3332bf0dc7fd4f0594210550089ed867a51b5da63be0e89830743d3ac",
  5: "b804592978b0afde52b64574534f355eaaf12db2d3401f0ebdf3d09373ca40a0",
  6: "4257f86aea6183e12471aaee30a32590a88ecf52c17596a8b46c9ef9b607280a",
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

const V3_STATEMENTS = [
  `CREATE UNIQUE INDEX events_event_id_stream_seq
   ON events(event_id, stream_seq)`,
  `ALTER TABLE outbox_deliveries RENAME TO outbox_deliveries_v2`,
  `CREATE TABLE outbox_deliveries (
    id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL REFERENCES events(event_id),
    target_kind TEXT NOT NULL CHECK (
      target_kind IN ('room', 'principal', 'session-family')
    ),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    stream_seq INTEGER NOT NULL CHECK (stream_seq >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    delivered_at TEXT,
    last_error TEXT,
    PRIMARY KEY (event_id, target_kind, target_id),
    FOREIGN KEY (event_id, stream_seq)
      REFERENCES events(event_id, stream_seq)
  ) STRICT`,
  `INSERT INTO outbox_deliveries (
     id, event_id, target_kind, target_id, stream_seq, status,
     attempts, available_at, delivered_at, last_error
   )
   SELECT
     delivery.id,
     delivery.event_id,
     substr(delivery.destination, 1, instr(delivery.destination, ':') - 1),
     substr(delivery.destination, instr(delivery.destination, ':') + 1),
     event.stream_seq,
     delivery.status,
     delivery.attempts,
     delivery.available_at,
     delivery.delivered_at,
     delivery.last_error
   FROM outbox_deliveries_v2 AS delivery
   JOIN events AS event ON event.event_id = delivery.event_id`,
  `DROP TABLE outbox_deliveries_v2`,
] as const;

const V4_STATEMENTS = [
  `ALTER TABLE open_items
   ADD COLUMN requester_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE open_items
   ADD COLUMN transfer_chain_json TEXT NOT NULL DEFAULT '[]'
   CHECK (json_valid(transfer_chain_json) AND json_type(transfer_chain_json) = 'array')`,
  `ALTER TABLE open_items
   ADD COLUMN responded_at TEXT`,
  `UPDATE open_items
   SET requester_actor_id = (
     SELECT author_id FROM messages WHERE messages.id = open_items.source_message_id
   ), responded_at = resolved_at`,
  `ALTER TABLE agent_executions
   ADD COLUMN requester_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE agent_executions
   ADD COLUMN tool_name TEXT NOT NULL DEFAULT 'legacy-unknown'
   CHECK (length(trim(tool_name)) > 0)`,
  `UPDATE agent_executions
   SET requester_actor_id = (
     SELECT author_id FROM messages
     WHERE messages.id = agent_executions.trigger_message_id
   )`,
  `ALTER TABLE calibration_signals
   ADD COLUMN source_message_id TEXT REFERENCES messages(id)`,
  `ALTER TABLE calibration_signals
   ADD COLUMN actor_id TEXT REFERENCES actors(id)`,
  `CREATE TRIGGER calibration_signals_v4_validate_insert
   BEFORE INSERT ON calibration_signals
   WHEN NEW.source_message_id IS NULL
      OR NEW.actor_id IS NULL
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM messages
        WHERE id = NEW.source_message_id
          AND room_id = NEW.room_id
          AND author_id = NEW.agent_id
          AND author_kind = 'agent'
      )
      OR NEW.signal NOT IN ('👍', '👎')
   BEGIN
     SELECT RAISE(ABORT, 'canonical calibration signal is invalid');
   END`,
  `CREATE TRIGGER calibration_signals_v4_validate_update
   BEFORE UPDATE OF room_id, agent_id, signal, source_message_id, actor_id
   ON calibration_signals
   WHEN NEW.source_message_id IS NULL
      OR NEW.actor_id IS NULL
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM messages
        WHERE id = NEW.source_message_id
          AND room_id = NEW.room_id
          AND author_id = NEW.agent_id
          AND author_kind = 'agent'
      )
      OR NEW.signal NOT IN ('👍', '👎')
   BEGIN
     SELECT RAISE(ABORT, 'canonical calibration signal is invalid');
   END`,
] as const;

const V5_STATEMENTS = [
  `CREATE INDEX messages_room_id_id ON messages(room_id, id)`,
  `CREATE INDEX agent_judgments_room_id_id ON agent_judgments(room_id, id)`,
  `CREATE INDEX open_items_room_id_id ON open_items(room_id, id)`,
  `CREATE INDEX agent_executions_room_id_id ON agent_executions(room_id, id)`,
  `CREATE INDEX calibration_signals_room_id_id
   ON calibration_signals(room_id, id)`,
  `CREATE INDEX room_memberships_catalog_actor_kind_room
   ON room_memberships(actor_id, kind, room_id)`,
] as const;

const V6_STATEMENTS = [
  `CREATE TABLE agent_executions_v6 (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    requester_actor_id TEXT NOT NULL REFERENCES actors(id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
    tool_dispatch_phase TEXT CHECK (tool_dispatch_phase IN ('not_started', 'dispatched', 'finished')),
    current_tool_id TEXT CHECK (current_tool_id IS NULL OR length(trim(current_tool_id)) > 0),
    current_attempt_seq INTEGER NOT NULL CHECK (current_attempt_seq BETWEEN 1 AND 9007199254740991),
    retry_cycle INTEGER NOT NULL CHECK (retry_cycle BETWEEN 1 AND 9007199254740991),
    retry_ordinal INTEGER NOT NULL CHECK (retry_ordinal BETWEEN 1 AND 3),
    provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
    model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
    recovery_cursor INTEGER NOT NULL CHECK (recovery_cursor BETWEEN 0 AND 9007199254740991),
    queued_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancellation_reason TEXT,
    terminal_error_code TEXT,
    dead_lettered_at TEXT,
    result_message_id TEXT REFERENCES messages(id),
    manual_retry_of_execution_id TEXT REFERENCES agent_executions_v6(id),
    compensates_execution_id TEXT REFERENCES agent_executions_v6(id),
    legacy_result_json TEXT,
    supersedes_execution_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(supersedes_execution_ids_json) AND json_type(supersedes_execution_ids_json) = 'array'),
    CHECK (length(CAST(supersedes_execution_ids_json AS BLOB)) <= 65536),
    CHECK (json_array_length(supersedes_execution_ids_json) <= 256),
    CHECK (
      (action_category = 'tool_call' AND (
        (tool_dispatch_phase IS NULL AND current_tool_id IS NULL)
        OR (tool_dispatch_phase IS NOT NULL AND current_tool_id IS NOT NULL)
      ))
      OR (action_category <> 'tool_call' AND tool_dispatch_phase IS NULL AND current_tool_id IS NULL)
    ),
    CHECK (
      (state = 'queued' AND started_at IS NULL AND completed_at IS NULL
       AND cancellation_reason IS NULL AND terminal_error_code IS NULL
       AND dead_lettered_at IS NULL AND result_message_id IS NULL)
      OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NULL
          AND dead_lettered_at IS NULL AND result_message_id IS NULL)
      OR (state = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NULL
          AND dead_lettered_at IS NULL)
      OR (state = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NOT NULL
          AND result_message_id IS NULL)
      OR (state = 'cancelled' AND completed_at IS NOT NULL
          AND cancellation_reason IS NOT NULL AND terminal_error_code IS NULL
          AND dead_lettered_at IS NULL AND result_message_id IS NULL)
    ),
    CHECK (state <> 'queued' OR tool_dispatch_phase IS NULL OR tool_dispatch_phase = 'not_started')
    ,CHECK (length(queued_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', queued_at) = queued_at, 0))
    ,CHECK (length(updated_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0))
    ,CHECK (started_at IS NULL OR (length(started_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at, 0)))
    ,CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at, 0)))
    ,CHECK (dead_lettered_at IS NULL OR (length(dead_lettered_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', dead_lettered_at) = dead_lettered_at, 0)))
    ,CHECK (cancellation_reason IS NULL OR length(trim(cancellation_reason)) > 0)
    ,CHECK (terminal_error_code IS NULL OR length(trim(terminal_error_code)) > 0)
    ,CHECK (queued_at <= updated_at
       AND (started_at IS NULL OR queued_at <= started_at AND started_at <= updated_at)
       AND (completed_at IS NULL OR queued_at <= completed_at
            AND (started_at IS NULL OR started_at <= completed_at) AND completed_at <= updated_at)
       AND (dead_lettered_at IS NULL OR completed_at <= dead_lettered_at AND dead_lettered_at <= updated_at))
  ) STRICT`,
  `INSERT INTO agent_executions_v6 (
    id, room_id, agent_id, source_message_id, requester_actor_id, state,
    action_category, tool_dispatch_phase, current_tool_id,
    current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
    recovery_cursor, queued_at, started_at, updated_at, completed_at,
    cancellation_reason, terminal_error_code, dead_lettered_at, result_message_id,
    manual_retry_of_execution_id, compensates_execution_id,
    supersedes_execution_ids_json, legacy_result_json
  )
  SELECT
    id, room_id, agent_id, trigger_message_id, requester_actor_id,
    CASE status
      WHEN 'completed' THEN 'completed'
      WHEN 'failed' THEN 'failed'
      WHEN 'interrupted' THEN 'cancelled'
      WHEN 'running' THEN 'failed'
      ELSE NULL
    END,
    'tool_call', 'finished', tool_name,
    1, 1, 1, 'legacy-v5', 'no-model', 0,
    started_at, started_at,
    CASE
      WHEN status IN ('completed', 'failed') THEN completed_at
      ELSE COALESCE(completed_at, started_at)
    END,
    CASE
      WHEN status IN ('completed', 'failed') THEN completed_at
      ELSE COALESCE(completed_at, started_at)
    END,
    CASE WHEN status = 'interrupted' THEN 'legacy_interrupted' ELSE NULL END,
    CASE
      WHEN status = 'running' THEN 'side_effect_outcome_unknown'
      WHEN status = 'failed' THEN 'legacy_failed'
      ELSE NULL
    END,
    CASE WHEN status = 'running' THEN COALESCE(completed_at, started_at) ELSE NULL END,
    NULL, NULL, NULL, '[]', result_json
  FROM agent_executions`,
  `DROP TRIGGER messages_validate_update`,
  `DROP TABLE agent_executions`,
  `ALTER TABLE agent_executions_v6 RENAME TO agent_executions`,
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
        WHERE source_message_id = OLD.id AND room_id <> NEW.room_id
      )
   BEGIN
     SELECT RAISE(ABORT, 'message update would break authority references');
   END`,
  `CREATE TRIGGER agent_executions_validate_insert
   BEFORE INSERT ON agent_executions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.source_message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '') <> NEW.room_id)
      OR (NEW.requester_actor_id IS NOT NULL
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_actor_id), '') NOT IN ('human', 'agent'))
      OR (NEW.result_message_id IS NOT NULL
          AND (COALESCE((SELECT room_id FROM messages WHERE id = NEW.result_message_id), '') <> NEW.room_id
               OR COALESCE((SELECT author_id FROM messages WHERE id = NEW.result_message_id), '') <> NEW.agent_id
               OR COALESCE((SELECT author_kind FROM messages WHERE id = NEW.result_message_id), '') <> 'agent'))
   BEGIN
     SELECT RAISE(ABORT, 'agent execution must reference closed actors and room messages');
   END`,
  `CREATE TRIGGER agent_executions_validate_update
   BEFORE UPDATE OF room_id, agent_id, source_message_id, requester_actor_id, result_message_id
   ON agent_executions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_id), '') <> 'agent'
      OR (NEW.source_message_id IS NOT NULL
          AND COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '') <> NEW.room_id)
      OR (NEW.requester_actor_id IS NOT NULL
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_actor_id), '') NOT IN ('human', 'agent'))
      OR (NEW.result_message_id IS NOT NULL
          AND (COALESCE((SELECT room_id FROM messages WHERE id = NEW.result_message_id), '') <> NEW.room_id
               OR COALESCE((SELECT author_id FROM messages WHERE id = NEW.result_message_id), '') <> NEW.agent_id
               OR COALESCE((SELECT author_kind FROM messages WHERE id = NEW.result_message_id), '') <> 'agent'))
   BEGIN
     SELECT RAISE(ABORT, 'agent execution must reference closed actors and room messages');
   END`,
  `CREATE TABLE agent_invocation_intents (
    id TEXT PRIMARY KEY,
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    target_agent_id TEXT NOT NULL REFERENCES actors(id),
    intent_kind TEXT NOT NULL CHECK (intent_kind IN ('direct_mention', 'structured_help', 'routed_candidate')),
    execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id),
    created_at TEXT NOT NULL,
    UNIQUE (source_message_id, target_agent_id),
    CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0))
  ) STRICT`,
  `CREATE TABLE agent_execution_attempts (
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq BETWEEN 1 AND 9007199254740991),
    retry_cycle INTEGER NOT NULL CHECK (retry_cycle BETWEEN 1 AND 9007199254740991),
    retry_ordinal INTEGER NOT NULL CHECK (retry_ordinal BETWEEN 1 AND 3),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
    tool_dispatch_phase TEXT CHECK (tool_dispatch_phase IN ('not_started', 'dispatched', 'finished')),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    next_retry_at INTEGER,
    recovery_cursor INTEGER NOT NULL CHECK (recovery_cursor BETWEEN 0 AND 9007199254740991),
    enqueue_stream_seq INTEGER NOT NULL DEFAULT 0
      CHECK (enqueue_stream_seq BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (execution_id, attempt_seq),
    CHECK (
      (action_category = 'tool_call')
      OR (action_category <> 'tool_call' AND tool_dispatch_phase IS NULL)
    ),
    CHECK (
      (state = 'queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL)
      OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL)
      OR (state = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL)
      OR (state = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NOT NULL)
      OR (state = 'cancelled' AND finished_at IS NOT NULL AND error_code IS NULL)
    )
    ,CHECK (state <> 'queued' OR enqueue_stream_seq > 0)
    ,CHECK (next_retry_at IS NULL OR next_retry_at BETWEEN 0 AND 9007199254740991)
    ,CHECK (started_at IS NULL OR (length(started_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at, 0)))
    ,CHECK (finished_at IS NULL OR (length(finished_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) = finished_at, 0)))
    ,CHECK (error_code IS NULL OR length(trim(error_code)) > 0)
  ) STRICT`,
  `INSERT INTO agent_execution_attempts (
    execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
    action_category, tool_dispatch_phase, started_at, finished_at,
    error_code, next_retry_at, recovery_cursor
  )
  SELECT id, room_id, 1, 1, 1, state, action_category, tool_dispatch_phase,
         started_at, completed_at, terminal_error_code, NULL, recovery_cursor
  FROM agent_executions`,
  `CREATE TABLE agent_execution_steps (
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    step_seq INTEGER NOT NULL CHECK (step_seq BETWEEN 1 AND 9007199254740991),
    step_kind TEXT NOT NULL CHECK (step_kind IN ('model_generation', 'tool_call', 'tool_result')),
    canonical_tool_call_json TEXT,
    bounded_tool_result_json TEXT,
    dispatch_id TEXT UNIQUE REFERENCES agent_tool_dispatches(id),
    input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'),
    completed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, attempt_seq, step_seq),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (canonical_tool_call_json IS NULL OR json_valid(canonical_tool_call_json)),
    CHECK (bounded_tool_result_json IS NULL OR json_valid(bounded_tool_result_json)),
    CHECK (
      (step_kind = 'model_generation'
       AND canonical_tool_call_json IS NULL AND bounded_tool_result_json IS NULL AND dispatch_id IS NULL)
      OR (step_kind = 'tool_call'
          AND canonical_tool_call_json IS NOT NULL AND bounded_tool_result_json IS NULL AND dispatch_id IS NULL)
      OR (step_kind = 'tool_result'
          AND canonical_tool_call_json IS NULL AND bounded_tool_result_json IS NOT NULL AND dispatch_id IS NOT NULL)
    ),
    CHECK (length(CAST(COALESCE(canonical_tool_call_json, '') AS BLOB)) <= 65536),
    CHECK (length(CAST(COALESCE(bounded_tool_result_json, '') AS BLOB)) <= 65536),
    CHECK (length(completed_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at, 0))
  ) STRICT`,
  `CREATE TABLE agent_execution_completions (
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    completed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, attempt_seq),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (length(completed_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at, 0))
  ) STRICT`,
  `CREATE TABLE agent_tool_grants (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    tool_call_step_seq INTEGER NOT NULL CHECK (tool_call_step_seq BETWEEN 1 AND 9007199254740991),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    tool_id TEXT NOT NULL CHECK (length(trim(tool_id)) > 0),
    parameter_hash TEXT NOT NULL CHECK (length(parameter_hash) = 64 AND parameter_hash NOT GLOB '*[^0-9a-f]*'),
    tool_plan_hash TEXT NOT NULL CHECK (length(tool_plan_hash) = 64 AND tool_plan_hash NOT GLOB '*[^0-9a-f]*'),
    confirmation_requirement TEXT NOT NULL
      CHECK (confirmation_requirement IN ('read_only', 'side_effect')),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    FOREIGN KEY (execution_id, attempt_seq, tool_call_step_seq)
      REFERENCES agent_execution_steps(execution_id, attempt_seq, step_seq),
    CHECK (length(issued_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at, 0)),
    CHECK (length(expires_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
    CHECK (consumed_at IS NULL OR (length(consumed_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at, 0)))
  ) STRICT`,
  `CREATE TABLE agent_tool_confirmations (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    grant_id TEXT NOT NULL UNIQUE REFERENCES agent_tool_grants(id),
    tool_id TEXT NOT NULL CHECK (length(trim(tool_id)) > 0),
    parameter_hash TEXT NOT NULL CHECK (length(parameter_hash) = 64 AND parameter_hash NOT GLOB '*[^0-9a-f]*'),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    human_principal_id TEXT NOT NULL REFERENCES actors(id),
    session_family_id TEXT NOT NULL CHECK (length(trim(session_family_id)) > 0),
    target TEXT NOT NULL CHECK (length(trim(target)) > 0),
    impact TEXT NOT NULL CHECK (length(trim(impact)) > 0),
    reversibility TEXT NOT NULL CHECK (reversibility IN ('compensatable', 'irreversible')),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (length(expires_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
    CHECK (consumed_at IS NULL OR (length(consumed_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at, 0)))
  ) STRICT`,
  `CREATE TABLE agent_tool_dispatches (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    grant_id TEXT NOT NULL UNIQUE REFERENCES agent_tool_grants(id),
    tool_id TEXT NOT NULL CHECK (length(trim(tool_id)) > 0),
    parameter_hash TEXT NOT NULL CHECK (length(parameter_hash) = 64 AND parameter_hash NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('dispatched', 'succeeded', 'failed', 'outcome_unknown')),
    dispatched_at TEXT NOT NULL,
    settled_at TEXT,
    closed_summary TEXT,
    sealed_compensation TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (
      (state = 'dispatched' AND settled_at IS NULL)
      OR (state <> 'dispatched' AND settled_at IS NOT NULL)
    ),
    CHECK (length(dispatched_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at, 0)),
    CHECK (settled_at IS NULL OR (length(settled_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', settled_at) = settled_at, 0))),
    CHECK (length(CAST(COALESCE(closed_summary, '') AS BLOB)) <= 65536),
    CHECK (length(CAST(COALESCE(sealed_compensation, '') AS BLOB)) <= 65536)
  ) STRICT`,
  `CREATE TABLE agent_compensation_requests (
    execution_id TEXT PRIMARY KEY REFERENCES agent_executions(id),
    original_execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    original_dispatch_id TEXT NOT NULL UNIQUE REFERENCES agent_tool_dispatches(id),
    requester_actor_id TEXT NOT NULL REFERENCES actors(id),
    session_family_id TEXT NOT NULL CHECK (length(trim(session_family_id)) > 0),
    created_at TEXT NOT NULL,
    CHECK (execution_id <> original_execution_id),
    CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0))
  ) STRICT`,
  `CREATE TABLE agent_fence_replacements (
    id TEXT PRIMARY KEY,
    fence_message_id TEXT NOT NULL REFERENCES messages(id),
    old_execution_id TEXT NOT NULL,
    old_attempt_seq INTEGER NOT NULL CHECK (old_attempt_seq BETWEEN 1 AND 9007199254740991),
    route_job_id TEXT,
    selected_agent_id TEXT REFERENCES actors(id),
    expected_judgment_id TEXT,
    replacement_execution_id TEXT REFERENCES agent_executions(id),
    created_at TEXT NOT NULL,
    FOREIGN KEY (old_execution_id, old_attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (
      (route_job_id IS NULL
       AND selected_agent_id IS NULL
       AND expected_judgment_id IS NULL
       AND replacement_execution_id IS NULL)
      OR (route_job_id IS NOT NULL
          AND length(trim(route_job_id)) > 0
          AND selected_agent_id IS NOT NULL
          AND expected_judgment_id IS NOT NULL
          AND length(trim(expected_judgment_id)) > 0
          AND replacement_execution_id IS NOT NULL)
    ),
    UNIQUE (fence_message_id, old_execution_id, old_attempt_seq),
    UNIQUE (fence_message_id, old_execution_id),
    UNIQUE (fence_message_id, route_job_id, selected_agent_id),
    CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0))
  ) STRICT`,
  `CREATE INDEX agent_executions_room_queue
   ON agent_executions(room_id, state, queued_at, current_attempt_seq)`,
  `CREATE INDEX agent_executions_room_id_id ON agent_executions(room_id, id)`,
  `CREATE INDEX agent_executions_recovery
   ON agent_executions(state, action_category, updated_at)`,
  `CREATE INDEX agent_executions_agent_recovery
   ON agent_executions(agent_id, state, action_category, room_id, queued_at, id)`,
  `CREATE INDEX agent_executions_agent_state_id
   ON agent_executions(agent_id, state, id, current_attempt_seq)`,
  `CREATE INDEX agent_execution_attempts_recovery
   ON agent_execution_attempts(state, next_retry_at, execution_id, attempt_seq)`,
  `CREATE INDEX agent_execution_attempts_room_enqueue
   ON agent_execution_attempts(room_id, state, enqueue_stream_seq, execution_id, attempt_seq)`,
  `CREATE INDEX agent_execution_steps_execution_attempt
   ON agent_execution_steps(execution_id, attempt_seq, step_seq)`,
  `CREATE INDEX agent_tool_grants_expiry
   ON agent_tool_grants(expires_at, consumed_at)`,
  `CREATE INDEX agent_tool_confirmations_expiry
   ON agent_tool_confirmations(expires_at, consumed_at)`,
  `CREATE INDEX agent_tool_grants_recovery_expiry
   ON agent_tool_grants(agent_id, confirmation_requirement, consumed_at, expires_at, execution_id, attempt_seq)`,
  `CREATE INDEX agent_tool_grants_recovery_binding
   ON agent_tool_grants(execution_id, attempt_seq, tool_id, parameter_hash,
                        confirmation_requirement, consumed_at)`,
  `CREATE INDEX agent_tool_grants_execution_step
   ON agent_tool_grants(execution_id, attempt_seq, tool_call_step_seq,
                        confirmation_requirement, id)`,
  `CREATE INDEX agent_tool_confirmations_recovery_expiry
   ON agent_tool_confirmations(consumed_at, expires_at, execution_id, attempt_seq,
                               tool_id, parameter_hash)`,
  `CREATE INDEX agent_tool_dispatches_state
   ON agent_tool_dispatches(state, dispatched_at)`,
  `CREATE UNIQUE INDEX agent_tool_dispatches_one_unsettled
   ON agent_tool_dispatches(execution_id, attempt_seq) WHERE state = 'dispatched'`,
  `CREATE INDEX agent_fence_replacements_replay
   ON agent_fence_replacements(fence_message_id, route_job_id, selected_agent_id)`,
  `CREATE INDEX agent_fence_replacements_replacement_old
   ON agent_fence_replacements(replacement_execution_id, old_execution_id)`,
] as const;

export const AUTHORITY_SCHEMA_V6_STATEMENT_COUNT_FOR_TEST = V6_STATEMENTS.length;

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
    throw new Error(
      `Historical migration ${version} no longer matches its checksum (${checksum})`,
    );
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
  defineMigration(
    2,
    "collaboration-facts-and-streams",
    V2_STATEMENTS,
    V2_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    3,
    "closed-outbox-targets",
    V3_STATEMENTS,
    V3_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    4,
    "canonical-collaboration-facts",
    V4_STATEMENTS,
    V4_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    5,
    "streaming-keyset-indexes",
    V5_STATEMENTS,
    V5_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    6,
    "agent-runtime-authority",
    V6_STATEMENTS,
    V6_MIGRATION_CHECKSUM,
  ),
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

const V3_SCHEMA_CONTRACT = {
  ...V2_SCHEMA_CONTRACT,
  outbox_deliveries: [
    "id",
    "event_id",
    "target_kind",
    "target_id",
    "stream_seq",
    "status",
    "attempts",
    "available_at",
    "delivered_at",
    "last_error",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V4_SCHEMA_CONTRACT = {
  ...V3_SCHEMA_CONTRACT,
  agent_executions: [
    ...V3_SCHEMA_CONTRACT.agent_executions,
    "requester_actor_id",
    "tool_name",
  ],
  calibration_signals: [
    ...V3_SCHEMA_CONTRACT.calibration_signals,
    "source_message_id",
    "actor_id",
  ],
  open_items: [
    ...V3_SCHEMA_CONTRACT.open_items,
    "requester_actor_id",
    "transfer_chain_json",
    "responded_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V6_SCHEMA_CONTRACT = {
  ...V4_SCHEMA_CONTRACT,
  agent_executions: [
    "id",
    "room_id",
    "agent_id",
    "source_message_id",
    "requester_actor_id",
    "state",
    "action_category",
    "tool_dispatch_phase",
    "current_tool_id",
    "current_attempt_seq",
    "retry_cycle",
    "retry_ordinal",
    "provider_id",
    "model_id",
    "recovery_cursor",
    "queued_at",
    "started_at",
    "updated_at",
    "completed_at",
    "cancellation_reason",
    "terminal_error_code",
    "dead_lettered_at",
    "result_message_id",
    "manual_retry_of_execution_id",
    "compensates_execution_id",
    "legacy_result_json",
    "supersedes_execution_ids_json",
  ],
  agent_execution_attempts: [
    "execution_id",
    "room_id",
    "attempt_seq",
    "retry_cycle",
    "retry_ordinal",
    "state",
    "action_category",
    "tool_dispatch_phase",
    "started_at",
    "finished_at",
    "error_code",
    "next_retry_at",
    "recovery_cursor",
    "enqueue_stream_seq",
  ],
  agent_execution_steps: [
    "execution_id",
    "attempt_seq",
    "step_seq",
    "step_kind",
    "canonical_tool_call_json",
    "bounded_tool_result_json",
    "dispatch_id",
    "input_sha256",
    "output_sha256",
    "completed_at",
  ],
  agent_execution_completions: [
    "execution_id",
    "attempt_seq",
    "message_id",
    "request_hash",
    "completed_at",
  ],
  agent_compensation_requests: [
    "execution_id",
    "original_execution_id",
    "original_dispatch_id",
    "requester_actor_id",
    "session_family_id",
    "created_at",
  ],
  agent_fence_replacements: [
    "id",
    "fence_message_id",
    "old_execution_id",
    "old_attempt_seq",
    "route_job_id",
    "selected_agent_id",
    "expected_judgment_id",
    "replacement_execution_id",
    "created_at",
  ],
  agent_invocation_intents: [
    "id",
    "source_message_id",
    "target_agent_id",
    "intent_kind",
    "execution_id",
    "created_at",
  ],
  agent_tool_confirmations: [
    "id",
    "execution_id",
    "attempt_seq",
    "grant_id",
    "tool_id",
    "parameter_hash",
    "room_id",
    "human_principal_id",
    "session_family_id",
    "target",
    "impact",
    "reversibility",
    "expires_at",
    "consumed_at",
  ],
  agent_tool_dispatches: [
    "id",
    "execution_id",
    "attempt_seq",
    "grant_id",
    "tool_id",
    "parameter_hash",
    "state",
    "dispatched_at",
    "settled_at",
    "closed_summary",
    "sealed_compensation",
  ],
  agent_tool_grants: [
    "id",
    "execution_id",
    "attempt_seq",
    "tool_call_step_seq",
    "agent_id",
    "room_id",
    "tool_id",
    "parameter_hash",
    "tool_plan_hash",
    "confirmation_requirement",
    "issued_at",
    "expires_at",
    "consumed_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const SCHEMA_CONTRACTS = {
  1: V1_SCHEMA_CONTRACT,
  2: V2_SCHEMA_CONTRACT,
  3: V3_SCHEMA_CONTRACT,
  4: V4_SCHEMA_CONTRACT,
  5: V4_SCHEMA_CONTRACT,
  6: V6_SCHEMA_CONTRACT,
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
  if (schemaVersion < 6) {
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
  }
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
  if (schemaVersion >= 4) {
    requireNoRows(
      database,
      `SELECT 1
       FROM calibration_signals AS signal
       LEFT JOIN actors AS calibration_actor ON calibration_actor.id = signal.actor_id
       LEFT JOIN messages AS source ON source.id = signal.source_message_id
       WHERE (signal.source_message_id IS NULL AND signal.actor_id IS NOT NULL)
          OR (signal.source_message_id IS NOT NULL AND signal.actor_id IS NULL)
          OR (signal.source_message_id IS NOT NULL
              AND signal.actor_id IS NOT NULL
              AND (calibration_actor.kind <> 'human'
                   OR source.id IS NULL
                   OR source.room_id <> signal.room_id
                   OR source.author_kind <> 'agent'
                   OR source.author_id <> signal.agent_id
                   OR signal.signal NOT IN ('👍', '👎')))
       LIMIT 1`,
      "canonical calibration signals must reference a human actor and same-room Agent message",
    );
  }
  if (schemaVersion >= 6) {
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_executions AS execution
       JOIN actors AS agent ON agent.id = execution.agent_id
       LEFT JOIN actors AS requester ON requester.id = execution.requester_actor_id
       LEFT JOIN messages AS source ON source.id = execution.source_message_id
       LEFT JOIN messages AS result ON result.id = execution.result_message_id
       WHERE agent.kind <> 'agent'
          OR execution.requester_actor_id IS NULL
          OR requester.id IS NULL OR requester.kind NOT IN ('human', 'agent')
          OR execution.source_message_id IS NULL
          OR source.id IS NULL OR source.room_id <> execution.room_id
          OR (execution.result_message_id IS NOT NULL
              AND (result.id IS NULL OR result.room_id <> execution.room_id
                   OR result.author_id <> execution.agent_id OR result.author_kind <> 'agent'))
          OR execution.state NOT IN ('queued', 'running', 'completed', 'failed', 'cancelled')
          OR execution.action_category NOT IN ('model_generation', 'tool_call', 'waiting_upstream')
          OR execution.current_attempt_seq < 1 OR execution.retry_cycle < 1
          OR execution.current_attempt_seq > 9007199254740991 OR execution.retry_cycle > 9007199254740991
          OR execution.retry_ordinal NOT BETWEEN 1 AND 3
          OR execution.recovery_cursor NOT BETWEEN 0 AND 9007199254740991
          OR execution.current_tool_id IS NOT NULL AND length(trim(execution.current_tool_id)) = 0
          OR length(execution.queued_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', execution.queued_at) IS NOT execution.queued_at
          OR length(execution.updated_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', execution.updated_at) IS NOT execution.updated_at
          OR (execution.started_at IS NOT NULL AND (length(execution.started_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', execution.started_at) IS NOT execution.started_at))
          OR (execution.completed_at IS NOT NULL AND (length(execution.completed_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', execution.completed_at) IS NOT execution.completed_at))
          OR (execution.dead_lettered_at IS NOT NULL AND (length(execution.dead_lettered_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', execution.dead_lettered_at) IS NOT execution.dead_lettered_at))
          OR (execution.cancellation_reason IS NOT NULL AND length(trim(execution.cancellation_reason)) = 0)
          OR (execution.terminal_error_code IS NOT NULL AND length(trim(execution.terminal_error_code)) = 0)
          OR execution.queued_at > execution.updated_at
          OR (execution.started_at IS NOT NULL AND (execution.queued_at > execution.started_at OR execution.started_at > execution.updated_at))
          OR (execution.completed_at IS NOT NULL AND (execution.queued_at > execution.completed_at
              OR (execution.started_at IS NOT NULL AND execution.started_at > execution.completed_at)
              OR execution.completed_at > execution.updated_at))
          OR (execution.dead_lettered_at IS NOT NULL AND (execution.completed_at IS NULL
              OR execution.completed_at > execution.dead_lettered_at OR execution.dead_lettered_at > execution.updated_at))
          OR (execution.action_category = 'tool_call'
              AND NOT ((execution.tool_dispatch_phase IS NULL AND execution.current_tool_id IS NULL)
                       OR (execution.tool_dispatch_phase IS NOT NULL AND execution.current_tool_id IS NOT NULL)))
          OR (execution.action_category <> 'tool_call'
              AND (execution.tool_dispatch_phase IS NOT NULL OR execution.current_tool_id IS NOT NULL))
          OR (execution.state = 'queued' AND (execution.started_at IS NOT NULL
              OR execution.completed_at IS NOT NULL OR execution.cancellation_reason IS NOT NULL
              OR execution.terminal_error_code IS NOT NULL OR execution.dead_lettered_at IS NOT NULL
              OR execution.result_message_id IS NOT NULL
              OR (execution.tool_dispatch_phase IS NOT NULL AND execution.tool_dispatch_phase <> 'not_started')))
          OR (execution.state = 'running' AND (execution.started_at IS NULL
              OR execution.completed_at IS NOT NULL OR execution.cancellation_reason IS NOT NULL
              OR execution.terminal_error_code IS NOT NULL OR execution.dead_lettered_at IS NOT NULL
              OR execution.result_message_id IS NOT NULL))
          OR (execution.state = 'completed' AND (execution.started_at IS NULL
              OR execution.completed_at IS NULL OR execution.cancellation_reason IS NOT NULL
              OR execution.terminal_error_code IS NOT NULL OR execution.dead_lettered_at IS NOT NULL))
          OR (execution.state = 'failed' AND (execution.started_at IS NULL
              OR execution.completed_at IS NULL OR execution.cancellation_reason IS NOT NULL
              OR execution.terminal_error_code IS NULL OR execution.result_message_id IS NOT NULL))
          OR (execution.state = 'cancelled' AND (execution.completed_at IS NULL
              OR execution.cancellation_reason IS NULL OR execution.terminal_error_code IS NOT NULL
              OR execution.dead_lettered_at IS NOT NULL OR execution.result_message_id IS NOT NULL))
       LIMIT 1`,
      "v6 executions must be closed canonical records",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_attempts AS attempt
       LEFT JOIN agent_executions AS execution ON execution.id = attempt.execution_id
       WHERE execution.id IS NULL
          OR attempt.room_id <> execution.room_id
          OR attempt.attempt_seq NOT BETWEEN 1 AND 9007199254740991
          OR attempt.retry_cycle NOT BETWEEN 1 AND 9007199254740991
          OR attempt.retry_ordinal NOT BETWEEN 1 AND 3
          OR attempt.state NOT IN ('queued', 'running', 'completed', 'failed', 'cancelled')
          OR attempt.action_category NOT IN ('model_generation', 'tool_call', 'waiting_upstream')
          OR (attempt.action_category = 'tool_call' AND attempt.tool_dispatch_phase IS NOT NULL
              AND attempt.tool_dispatch_phase NOT IN ('not_started', 'dispatched', 'finished'))
          OR (attempt.action_category <> 'tool_call' AND attempt.tool_dispatch_phase IS NOT NULL)
          OR (attempt.state = 'queued' AND (attempt.started_at IS NOT NULL
              OR attempt.finished_at IS NOT NULL OR attempt.error_code IS NOT NULL))
          OR (attempt.state = 'running' AND (attempt.started_at IS NULL
              OR attempt.finished_at IS NOT NULL OR attempt.error_code IS NOT NULL))
          OR (attempt.state = 'completed' AND (attempt.started_at IS NULL
              OR attempt.finished_at IS NULL OR attempt.error_code IS NOT NULL))
          OR (attempt.state = 'failed' AND (attempt.started_at IS NULL
              OR attempt.finished_at IS NULL OR attempt.error_code IS NULL))
          OR (attempt.state = 'cancelled' AND (attempt.finished_at IS NULL OR attempt.error_code IS NOT NULL))
          OR attempt.recovery_cursor NOT BETWEEN 0 AND 9007199254740991
          OR attempt.enqueue_stream_seq NOT BETWEEN 0 AND 9007199254740991
          OR (attempt.state = 'queued' AND attempt.enqueue_stream_seq = 0)
          OR (attempt.next_retry_at IS NOT NULL AND attempt.next_retry_at NOT BETWEEN 0 AND 9007199254740991)
          OR (attempt.started_at IS NOT NULL AND (length(attempt.started_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', attempt.started_at) IS NOT attempt.started_at))
          OR (attempt.finished_at IS NOT NULL AND (length(attempt.finished_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', attempt.finished_at) IS NOT attempt.finished_at))
          OR (attempt.error_code IS NOT NULL AND length(trim(attempt.error_code)) = 0)
          OR (attempt.attempt_seq = execution.current_attempt_seq
              AND (attempt.retry_cycle <> execution.retry_cycle
                   OR attempt.retry_ordinal <> execution.retry_ordinal
                   OR attempt.state <> execution.state
                   OR attempt.action_category <> execution.action_category
                   OR attempt.tool_dispatch_phase IS NOT execution.tool_dispatch_phase
                   OR attempt.recovery_cursor <> execution.recovery_cursor))
       LIMIT 1`,
      "v6 attempts must close and match their current execution",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_attempts AS attempt
       JOIN agent_executions AS execution ON execution.id = attempt.execution_id
       WHERE attempt.attempt_seq > execution.current_attempt_seq
          OR (attempt.attempt_seq < execution.current_attempt_seq
              AND attempt.state NOT IN ('completed', 'failed', 'cancelled'))
       LIMIT 1`,
      "v6 attempt sequence must be closed below the current attempt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_executions AS execution
       LEFT JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = execution.id
        AND attempt.attempt_seq = execution.current_attempt_seq
       WHERE attempt.execution_id IS NULL
       LIMIT 1`,
      "every v6 execution must have its current attempt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_steps AS step
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = step.execution_id
        AND attempt.attempt_seq = step.attempt_seq
       WHERE step.step_kind NOT IN ('model_generation', 'tool_call', 'tool_result')
          OR (step.step_kind = 'model_generation'
              AND (step.canonical_tool_call_json IS NOT NULL
                   OR step.bounded_tool_result_json IS NOT NULL))
          OR (step.step_kind = 'tool_call'
              AND (step.canonical_tool_call_json IS NULL
                   OR step.bounded_tool_result_json IS NOT NULL))
          OR (step.step_kind = 'tool_result'
              AND (step.canonical_tool_call_json IS NOT NULL
                   OR step.bounded_tool_result_json IS NULL))
          OR step.step_seq NOT BETWEEN 1 AND 9007199254740991
          OR length(step.input_sha256) <> 64 OR step.input_sha256 GLOB '*[^0-9a-f]*'
          OR length(step.output_sha256) <> 64 OR step.output_sha256 GLOB '*[^0-9a-f]*'
          OR step.step_seq > attempt.recovery_cursor
          OR length(step.completed_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', step.completed_at) IS NOT step.completed_at
       LIMIT 1`,
      "v6 checkpoints must be bounded by their attempt cursor",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_tool_grants
       WHERE length(issued_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS NOT issued_at
          OR length(expires_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT expires_at
          OR (consumed_at IS NOT NULL AND (length(consumed_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT consumed_at))
       LIMIT 1`,
      "v6 grants must use canonical timestamps",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_tool_confirmations
       WHERE length(expires_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT expires_at
          OR (consumed_at IS NOT NULL AND (length(consumed_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT consumed_at))
       LIMIT 1`,
      "v6 confirmations must use canonical timestamps",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_tool_dispatches
       WHERE length(dispatched_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) IS NOT dispatched_at
          OR (settled_at IS NOT NULL AND (length(settled_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', settled_at) IS NOT settled_at))
          OR length(CAST(COALESCE(closed_summary, '') AS BLOB)) > 65536
          OR length(CAST(COALESCE(sealed_compensation, '') AS BLOB)) > 65536
       LIMIT 1`,
      "v6 dispatches must use canonical timestamps and bounded settlement fields",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_tool_dispatches
       WHERE state = 'dispatched'
       GROUP BY execution_id, attempt_seq
       HAVING COUNT(*) > 1
       LIMIT 1`,
      "v6 attempts may have only one unsettled dispatch",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_fence_replacements
       WHERE length(created_at) <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT created_at
       LIMIT 1`,
      "v6 fences must use canonical timestamps",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_attempts AS attempt
       LEFT JOIN agent_execution_steps AS step
         ON step.execution_id = attempt.execution_id AND step.attempt_seq = attempt.attempt_seq
       GROUP BY attempt.execution_id, attempt.attempt_seq, attempt.recovery_cursor
       HAVING (attempt.recovery_cursor = 0 AND COUNT(step.step_seq) <> 0)
          OR (attempt.recovery_cursor > 0
              AND (COUNT(step.step_seq) <> attempt.recovery_cursor
                   OR MIN(step.step_seq) <> 1 OR MAX(step.step_seq) <> attempt.recovery_cursor))
       LIMIT 1`,
      "v6 attempt recovery cursors must exactly cover their own contiguous steps",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_completions AS completion
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = completion.execution_id
        AND attempt.attempt_seq = completion.attempt_seq
       JOIN agent_executions AS execution ON execution.id = completion.execution_id
       JOIN messages AS message ON message.id = completion.message_id
       WHERE length(completion.request_hash) <> 64
          OR completion.request_hash GLOB '*[^0-9a-f]*'
          OR execution.state <> 'completed'
          OR attempt.state <> 'completed'
          OR execution.result_message_id <> completion.message_id
          OR message.room_id <> execution.room_id
          OR message.author_id <> execution.agent_id
          OR message.author_kind <> 'agent'
          OR length(completion.completed_at) <> 24
          OR strftime('%Y-%m-%dT%H:%M:%fZ', completion.completed_at) IS NOT completion.completed_at
       LIMIT 1`,
      "v6 completion records must bind one completed Agent message and attempt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_tool_grants AS grant
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = grant.execution_id
        AND attempt.attempt_seq = grant.attempt_seq
       JOIN agent_executions AS execution ON execution.id = grant.execution_id
       JOIN actors AS agent ON agent.id = grant.agent_id
       JOIN agent_execution_steps AS step
         ON step.execution_id = grant.execution_id
        AND step.attempt_seq = grant.attempt_seq
        AND step.step_seq = grant.tool_call_step_seq
       WHERE agent.kind <> 'agent' OR grant.agent_id <> execution.agent_id
          OR grant.room_id <> execution.room_id OR length(grant.parameter_hash) <> 64
          OR grant.parameter_hash GLOB '*[^0-9a-f]*'
          OR length(grant.tool_plan_hash) <> 64 OR grant.tool_plan_hash GLOB '*[^0-9a-f]*'
          OR step.step_kind <> 'tool_call'
          OR json_extract(step.canonical_tool_call_json, '$.toolId') IS NOT grant.tool_id
          OR step.output_sha256 IS NOT grant.parameter_hash
          OR grant.confirmation_requirement NOT IN ('read_only', 'side_effect')
       LIMIT 1`,
      "v6 grants must bind the current execution identity",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_tool_confirmations AS confirmation
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = confirmation.execution_id
        AND attempt.attempt_seq = confirmation.attempt_seq
       JOIN agent_executions AS execution ON execution.id = confirmation.execution_id
       JOIN actors AS principal ON principal.id = confirmation.human_principal_id
       JOIN agent_tool_grants AS grant ON grant.id = confirmation.grant_id
       WHERE principal.kind <> 'human' OR confirmation.room_id <> execution.room_id
          OR confirmation.execution_id <> grant.execution_id
          OR confirmation.attempt_seq <> grant.attempt_seq
          OR confirmation.tool_id <> grant.tool_id
          OR confirmation.parameter_hash <> grant.parameter_hash
          OR length(confirmation.parameter_hash) <> 64
          OR confirmation.parameter_hash GLOB '*[^0-9a-f]*'
          OR confirmation.reversibility NOT IN ('compensatable', 'irreversible')
       LIMIT 1`,
      "v6 confirmations must bind human principal and execution room",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = dispatch.execution_id
        AND attempt.attempt_seq = dispatch.attempt_seq
       WHERE dispatch.execution_id <> grant.execution_id
          OR dispatch.attempt_seq <> grant.attempt_seq
          OR dispatch.tool_id <> grant.tool_id
          OR dispatch.parameter_hash <> grant.parameter_hash
          OR length(dispatch.parameter_hash) <> 64 OR dispatch.parameter_hash GLOB '*[^0-9a-f]*'
          OR dispatch.state NOT IN ('dispatched', 'succeeded', 'failed', 'outcome_unknown')
          OR ((dispatch.state = 'dispatched') <> (dispatch.settled_at IS NULL))
          OR (grant.confirmation_requirement = 'side_effect' AND NOT EXISTS (
            SELECT 1 FROM agent_tool_confirmations AS confirmation
            WHERE confirmation.grant_id = grant.id
              AND confirmation.execution_id = dispatch.execution_id
              AND confirmation.attempt_seq = dispatch.attempt_seq
              AND confirmation.tool_id = dispatch.tool_id
              AND confirmation.parameter_hash = dispatch.parameter_hash
              AND confirmation.consumed_at IS NOT NULL
          ))
       LIMIT 1`,
      "v6 dispatches must remain append-only grant facts",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_invocation_intents AS intent
       JOIN agent_executions AS execution ON execution.id = intent.execution_id
       JOIN actors AS target ON target.id = intent.target_agent_id
       LEFT JOIN messages AS source ON source.id = intent.source_message_id
       WHERE intent.intent_kind NOT IN ('direct_mention', 'structured_help', 'routed_candidate')
          OR target.kind <> 'agent'
          OR execution.source_message_id IS NULL
          OR intent.target_agent_id <> execution.agent_id
          OR intent.source_message_id <> execution.source_message_id
          OR source.id IS NULL OR source.room_id <> execution.room_id
          OR length(intent.created_at) <> 24
          OR strftime('%Y-%m-%dT%H:%M:%fZ', intent.created_at) IS NOT intent.created_at
       LIMIT 1`,
      "v6 invocation intents must bind the execution target and source message",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_tool_grants AS grant
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = grant.execution_id
        AND attempt.attempt_seq = grant.attempt_seq
       JOIN agent_executions AS execution ON execution.id = grant.execution_id
       WHERE (attempt.action_category NOT IN ('tool_call', 'waiting_upstream')
              AND NOT (attempt.action_category = 'model_generation'
                       AND EXISTS (
                         SELECT 1 FROM agent_execution_steps AS step
                         WHERE step.execution_id = grant.execution_id
                           AND step.attempt_seq = grant.attempt_seq
                           AND step.step_kind = 'tool_result'
                       )
                       AND EXISTS (
                         SELECT 1 FROM agent_tool_dispatches AS result_dispatch
                         WHERE result_dispatch.grant_id = grant.id
                           AND ((grant.confirmation_requirement = 'read_only'
                                 AND result_dispatch.state <> 'dispatched')
                                OR (grant.confirmation_requirement = 'side_effect'
                                    AND result_dispatch.state IN ('succeeded', 'failed')))
                       )))
          OR grant.agent_id <> execution.agent_id OR grant.room_id <> execution.room_id
          OR (grant.confirmation_requirement = 'read_only'
              AND attempt.action_category <> 'tool_call'
              AND NOT (attempt.action_category = 'model_generation'
                       AND EXISTS (
                         SELECT 1 FROM agent_execution_steps AS step
                         WHERE step.execution_id = grant.execution_id
                           AND step.attempt_seq = grant.attempt_seq
                           AND step.step_kind = 'tool_result'
                       )))
          OR (grant.confirmation_requirement = 'side_effect'
              AND attempt.action_category NOT IN ('waiting_upstream', 'tool_call')
              AND NOT (attempt.action_category = 'model_generation'
                       AND EXISTS (
                         SELECT 1 FROM agent_execution_steps AS step
                         WHERE step.execution_id = grant.execution_id
                           AND step.attempt_seq = grant.attempt_seq
                           AND step.step_kind = 'tool_result'
                       )
                       AND EXISTS (
                         SELECT 1 FROM agent_tool_dispatches AS result_dispatch
                         WHERE result_dispatch.grant_id = grant.id
                           AND result_dispatch.state IN ('succeeded', 'failed')
                       )))
       LIMIT 1`,
      "v6 grants require a matching tool-call attempt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = dispatch.execution_id
        AND attempt.attempt_seq = dispatch.attempt_seq
       WHERE NOT (
         (attempt.action_category = 'tool_call'
          AND attempt.tool_dispatch_phase IN ('dispatched', 'finished'))
         OR (dispatch.state IN ('succeeded', 'failed')
             AND EXISTS (
               SELECT 1 FROM agent_execution_steps AS step
               WHERE step.execution_id = dispatch.execution_id
                 AND step.attempt_seq = dispatch.attempt_seq
                 AND step.step_kind = 'tool_result'
                 AND step.dispatch_id = dispatch.id
             ))
         OR (dispatch.state = 'outcome_unknown'
             AND attempt.state = 'failed'
             AND attempt.error_code = 'side_effect_outcome_unknown')
       )
       LIMIT 1`,
      "v6 dispatches require a dispatched or finished tool attempt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_executions AS execution
       LEFT JOIN agent_executions AS manual ON manual.id = execution.manual_retry_of_execution_id
       LEFT JOIN agent_executions AS compensation ON compensation.id = execution.compensates_execution_id
       WHERE ((execution.manual_retry_of_execution_id IS NOT NULL)
              + (execution.compensates_execution_id IS NOT NULL)
              + (json_array_length(execution.supersedes_execution_ids_json) > 0)) > 1
          OR execution.manual_retry_of_execution_id = execution.id
          OR execution.compensates_execution_id = execution.id
          OR (execution.manual_retry_of_execution_id IS NOT NULL
              AND (manual.id IS NULL OR manual.state <> 'failed'
                   OR manual.dead_lettered_at IS NULL))
          OR (execution.compensates_execution_id IS NOT NULL
              AND (compensation.id IS NULL
                   OR compensation.state NOT IN ('completed', 'failed', 'cancelled')))
          OR NOT json_valid(execution.supersedes_execution_ids_json)
          OR json_type(execution.supersedes_execution_ids_json) <> 'array'
          OR length(CAST(execution.supersedes_execution_ids_json AS BLOB)) > 65536
          OR CASE WHEN json_valid(execution.supersedes_execution_ids_json)
                  THEN json_array_length(execution.supersedes_execution_ids_json) > 256 ELSE 1 END
          OR EXISTS (
            SELECT 1
            FROM json_each(execution.supersedes_execution_ids_json) AS supersedes
            LEFT JOIN agent_executions AS old ON old.id = supersedes.value
            WHERE supersedes.type <> 'text'
               OR length(supersedes.value) = 0
               OR supersedes.value = execution.id
               OR old.id IS NULL OR old.state <> 'cancelled'
          )
          OR EXISTS (
            SELECT 1 FROM json_each(execution.supersedes_execution_ids_json)
            GROUP BY value HAVING COUNT(*) > 1
          )
          OR EXISTS (
            SELECT 1
            FROM json_each(execution.supersedes_execution_ids_json) AS supersedes
            WHERE NOT EXISTS (
              SELECT 1 FROM agent_fence_replacements AS fence
              WHERE fence.replacement_execution_id = execution.id
                AND fence.old_execution_id = supersedes.value
            )
          )
       LIMIT 1`,
      "v6 execution lineage must be unique, non-self, and terminally closed",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_compensation_requests AS request
       JOIN agent_executions AS execution ON execution.id = request.execution_id
       JOIN agent_executions AS original ON original.id = request.original_execution_id
       JOIN agent_tool_dispatches AS dispatch ON dispatch.id = request.original_dispatch_id
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_tool_confirmations AS confirmation ON confirmation.grant_id = grant.id
       WHERE execution.compensates_execution_id <> request.original_execution_id
          OR execution.requester_actor_id <> request.requester_actor_id
          OR original.state NOT IN ('completed', 'failed', 'cancelled')
          OR dispatch.execution_id <> request.original_execution_id
          OR dispatch.state <> 'succeeded'
          OR dispatch.sealed_compensation IS NULL
          OR length(trim(dispatch.sealed_compensation)) = 0
          OR confirmation.reversibility <> 'compensatable'
          OR NOT EXISTS (
            SELECT 1 FROM sessions AS session
            WHERE session.family_id = request.session_family_id
              AND session.actor_id = request.requester_actor_id
          )
       LIMIT 1`,
      "v6 compensation requests must bind one terminal compensatable side effect",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_fence_replacements AS fence
       JOIN agent_execution_attempts AS old_attempt
         ON old_attempt.execution_id = fence.old_execution_id
        AND old_attempt.attempt_seq = fence.old_attempt_seq
       JOIN agent_executions AS old_execution ON old_execution.id = fence.old_execution_id
       JOIN messages AS message ON message.id = fence.fence_message_id
       LEFT JOIN actors AS selected ON selected.id = fence.selected_agent_id
       LEFT JOIN agent_judgments AS judgment ON judgment.id = fence.expected_judgment_id
       LEFT JOIN agent_executions AS replacement ON replacement.id = fence.replacement_execution_id
       LEFT JOIN agent_execution_attempts AS replacement_attempt
         ON replacement_attempt.execution_id = replacement.id
        AND replacement_attempt.attempt_seq = replacement.current_attempt_seq
       WHERE old_execution.state <> 'cancelled' OR old_attempt.state <> 'cancelled'
          OR NOT (
            old_attempt.started_at IS NULL
            OR old_attempt.action_category = 'waiting_upstream'
            OR (old_attempt.action_category = 'tool_call'
                AND old_attempt.tool_dispatch_phase = 'not_started')
          )
          OR message.author_kind <> 'human' OR message.room_id <> old_execution.room_id
          OR (fence.selected_agent_id IS NOT NULL
              AND (selected.id IS NULL OR selected.kind <> 'agent'))
          OR (fence.expected_judgment_id IS NOT NULL
              AND (judgment.id IS NULL OR judgment.room_id <> old_execution.room_id
                   OR judgment.agent_id <> fence.selected_agent_id
                   OR judgment.message_id <> fence.fence_message_id
                   OR NOT json_valid(judgment.judgment_json)
                   OR json_extract(judgment.judgment_json, '$.outcome') IS NOT 'will_respond'))
          OR (fence.replacement_execution_id IS NOT NULL
              AND (replacement.id IS NULL OR replacement.room_id <> old_execution.room_id
                   OR replacement.agent_id <> fence.selected_agent_id
                   OR replacement.state <> 'queued'
                   OR replacement.current_attempt_seq <> 1
                   OR replacement.retry_ordinal <> 1
                   OR replacement_attempt.execution_id IS NULL
                   OR replacement_attempt.state <> 'queued'
                   OR NOT EXISTS (
                     SELECT 1 FROM json_each(replacement.supersedes_execution_ids_json)
                     WHERE value = fence.old_execution_id
                   )))
       LIMIT 1`,
      "v6 fences must close the old attempt before a same-room replacement",
    );
  }
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
  const actualFingerprint = readSchemaFingerprint(database);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(
      `Refusing unknown schema physical contract at version ${currentVersion} (${actualFingerprint})`,
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

function migrateAuthorityDatabaseToVersion(
  database: DatabaseSync,
  targetVersion: number,
  fault?: MigrationFaultOptions,
): void {
  validateFaultOptions(fault);
  if (
    !Number.isSafeInteger(targetVersion) ||
    targetVersion < 1 ||
    targetVersion > AUTHORITY_SCHEMA_VERSION
  ) {
    throw new TypeError("targetVersion must name a supported authority schema");
  }
  configureAuthorityConnection(database);

  let statementCount = 0;
  // Node 22.13 has no DatabaseSync.isTransaction; this module owns the transaction.
  let transactionOpen = false;
  database.exec("BEGIN IMMEDIATE");
  transactionOpen = true;
  try {
    const currentVersion = readSchemaVersion(database);
    validateExistingSchema(database, currentVersion);
    if (currentVersion > targetVersion) {
      throw new Error(`Refusing to downgrade schema version ${currentVersion}`);
    }
    if (currentVersion === targetVersion) {
      database.exec("COMMIT");
      transactionOpen = false;
      return;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion || migration.version > targetVersion) {
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

    validateExistingSchema(database, targetVersion);
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

export function migrateAuthorityDatabase(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void {
  migrateAuthorityDatabaseToVersion(database, AUTHORITY_SCHEMA_VERSION, fault);
}

export function migrateAuthorityDatabaseToPreviousVersionForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, AUTHORITY_SCHEMA_VERSION - 1);
}

export function migrateAuthorityDatabaseToVersion4ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 4);
}

export function migrateAuthorityDatabaseToVersion3ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 3);
}

export function migrateAuthorityDatabaseToVersion2ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 2);
}

export const SNAPSHOT_CACHE_SCHEMA_VERSION = 1 as const;
export const SNAPSHOT_CACHE_BUSY_TIMEOUT_MS = 5_000;
const SNAPSHOT_CACHE_SCHEMA_FINGERPRINT =
  "bc416cc7c65942d8eb36036eb43d70e039eea6703b94222d5185147f309a01dc";

const SNAPSHOT_CACHE_TABLES = [
  "expired_snapshot_tombstones",
  "repair_snapshot_pages",
  "repair_snapshots",
] as const;

export function configureSnapshotCacheConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("PRAGMA journal_mode = WAL").get();
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`PRAGMA busy_timeout = ${SNAPSHOT_CACHE_BUSY_TIMEOUT_MS}`);
  if (
    readPragmaNumber(database, "foreign_keys", "foreign_keys") !== 1 ||
    readPragmaString(database, "journal_mode", "journal_mode").toLowerCase() !== "wal" ||
    readPragmaNumber(database, "synchronous", "synchronous") !== 2 ||
    readPragmaNumber(database, "busy_timeout", "timeout") !== SNAPSHOT_CACHE_BUSY_TIMEOUT_MS
  ) {
    throw new Error("Snapshot cache SQLite configuration could not be verified");
  }
}

export function listSnapshotCacheTables(database: DatabaseSync): readonly string[] {
  return database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all().map((row) => String(row.name));
}

function snapshotCacheColumns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => String(row.name));
}

function validateSnapshotCacheIntegrity(database: DatabaseSync): void {
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("PRAGMA integrity_check did not return exactly ok");
    }
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("PRAGMA foreign_key_check returned violations");
    }
  } catch (error: unknown) {
    throw new Error("Snapshot cache integrity check failed", { cause: error });
  }
}

export function validateSnapshotCachePhysicalSchema(database: DatabaseSync): void {
  if (readSchemaVersion(database) !== SNAPSHOT_CACHE_SCHEMA_VERSION) {
    throw new Error("Snapshot cache schema version is incompatible");
  }
  if (!sameStrings(listSnapshotCacheTables(database), SNAPSHOT_CACHE_TABLES)) {
    throw new Error("Snapshot cache table contract is corrupt");
  }
  if (!sameStrings(snapshotCacheColumns(database, "repair_snapshots"), [
    "snapshot_id", "kind", "principal_id", "session_family_id", "room_id",
    "access_revision", "watermark", "catalog_revision", "checksum",
    "page_count", "expires_at", "reuse_key", "complete", "invalid",
  ]) || !sameStrings(snapshotCacheColumns(database, "repair_snapshot_pages"), [
    "snapshot_id", "page_number", "payload_json", "canonical_bytes",
  ]) || !sameStrings(snapshotCacheColumns(database, "expired_snapshot_tombstones"), [
    "snapshot_id", "retain_until",
  ])) {
    throw new Error("Snapshot cache column contract is corrupt");
  }
  if (readSchemaFingerprint(database) !== SNAPSHOT_CACHE_SCHEMA_FINGERPRINT) {
    throw new Error("Snapshot cache physical contract is corrupt");
  }
}

export function validateSnapshotCacheSchema(database: DatabaseSync): void {
  validateSnapshotCachePhysicalSchema(database);
  validateSnapshotCacheIntegrity(database);
}

export function migrateSnapshotCacheDatabase(database: DatabaseSync): void {
  configureSnapshotCacheConnection(database);
  const version = readSchemaVersion(database);
  if (version === SNAPSHOT_CACHE_SCHEMA_VERSION) {
    validateSnapshotCacheSchema(database);
    return;
  }
  if (version !== 0 || listSnapshotCacheTables(database).length !== 0) {
    throw new Error("Snapshot cache schema version is incompatible");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE TABLE repair_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('room', 'catalog')),
      principal_id TEXT NOT NULL,
      session_family_id TEXT NOT NULL,
      room_id TEXT,
      access_revision INTEGER,
      watermark INTEGER,
      catalog_revision INTEGER,
      checksum TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK (page_count >= 1),
      expires_at INTEGER NOT NULL,
      reuse_key TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      invalid INTEGER NOT NULL DEFAULT 0 CHECK (invalid IN (0, 1)),
      CHECK (
        (kind = 'room' AND room_id IS NOT NULL AND access_revision IS NOT NULL
          AND watermark IS NOT NULL AND catalog_revision IS NULL)
        OR
        (kind = 'catalog' AND room_id IS NULL AND access_revision IS NULL
          AND watermark IS NULL AND catalog_revision IS NOT NULL)
      )
    ) STRICT`);
    database.exec(`CREATE INDEX repair_snapshots_reuse
      ON repair_snapshots(reuse_key, complete, invalid, expires_at)`);
    database.exec(`CREATE TABLE repair_snapshot_pages (
      snapshot_id TEXT NOT NULL REFERENCES repair_snapshots(snapshot_id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL CHECK (page_number >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes >= 0),
      PRIMARY KEY (snapshot_id, page_number)
    ) STRICT`);
    database.exec(`CREATE TABLE expired_snapshot_tombstones (
      snapshot_id TEXT PRIMARY KEY,
      retain_until INTEGER NOT NULL
    ) STRICT`);
    database.exec(`PRAGMA user_version = ${SNAPSHOT_CACHE_SCHEMA_VERSION}`);
    validateSnapshotCacheSchema(database);
    database.exec("COMMIT");
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the schema failure.
    }
    throw error;
  }
}
