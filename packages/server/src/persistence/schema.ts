import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_ACTIVE_SESSION_FAMILIES } from "./contracts.js";
import {
  ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS,
  ROOM_CACHE_INVALIDATION_SCHEMA_STATEMENTS,
} from "../access/room-cache-invalidation-port.js";
import { OFFLINE_READ_LEASE_SCHEMA_STATEMENTS } from "../access/offline-lease-invalidation-port.js";

export const AUTHORITY_SCHEMA_VERSION = 25 as const;

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
  "87b3d62db40e9e7f8fa3e643315a62c26f01968d4065fb743fa502a7251d9257";
const V7_MIGRATION_CHECKSUM =
  "4ad86ad359400228cf5428d7bb59c5fc371009904fe50cfedd4641e79e6d4977";
const V8_MIGRATION_CHECKSUM =
  "b0eb63981b5ee92cfd51133972e78c4054c3fdf155cee58ce4c029564ed6d1d1";
const V9_MIGRATION_CHECKSUM =
  "802bd498bf342a575fa21fb46e18b7a375259bd40a571844bb375d756c0616b2";
const V10_MIGRATION_CHECKSUM =
  "a7a668d54ddd3636f2e2bafcb7e55be8c9771d56c19a6ca5e3c79027a6647105";
const V11_MIGRATION_CHECKSUM =
  "3ef3ca9216e684ec3d9e4097fe8a2e7148c75d5bb4b23ed7bf5a0eb5edc970a1";
const V12_MIGRATION_CHECKSUM =
  "66276cc21f02f19f5e60758039acd43030ba8a9666b37c0fef65ad30852929fa";
const V13_MIGRATION_CHECKSUM =
  "0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e";
const V15_MIGRATION_CHECKSUM =
  "41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9";
const V16_MIGRATION_CHECKSUM =
  "51e5b5114b90bc8407d7eec86a559da0170cec1ec0bfc1c5587d828a5765f1a7";
const SCHEMA_FINGERPRINTS = {
  1: "03f2bbba4aa7082ec01819824726ce1bd9b4bd14cebea71afc93c6821dbf405c",
  2: "01c37d92ec2f303613a7bb8b592ca846fbea7c829b3c81fe4521699db949dfcc",
  3: "8653114fb3c00fcbddc386c16693d98ce6f226695f1941ac73dc341aa5fc7a61",
  4: "b2d08fa3332bf0dc7fd4f0594210550089ed867a51b5da63be0e89830743d3ac",
  5: "b804592978b0afde52b64574534f355eaaf12db2d3401f0ebdf3d09373ca40a0",
  6: "0e5c764a0fae33f00eae7bfd2e21dbbc4d54781d43ef5aa967c6dfeef8c58035",
  7: "9827d65dd5eac378112a51859251ac842d4393c518f21f8862956aa6ebd0edae",
  8: "7dcef5f3d765e7d19015f19aca2d033aee0f0b3c07f53c4934e3c1d2b6053f20",
  9: "0374dbc27aa894ec239c89bcc6682fc53b219c8a2e150dfea3389beb7bf8e4e7",
  10: "7fd3399cc25e505de80d69adae24f7fc5a027de57cfb3e0b56df294e454c91fb",
  11: "83e48fc5a4b1b1c19863efd785ea098308d100c1899d638d2b5f95c5b0c119a6",
  12: "7232d27114e9acf32dcfbc2d59f3c3128eed10955de3cc2703ddeedf92892741",
  13: "037df6a2818f2a90b7394240a4cf71d77949faf31df6534c5546c9ed6b7e7191",
  14: "b4f1034ce034203fd14f5bc32391cb8855f7d6eed64c0b01f75d41e331a8b5c5",
  15: "e8010dc3c03c71d51f20ef4054a815d3580abdcbd0762791508226a68918b426",
  16: "86a3512dcb625bc3e0f3d79e5a5d6542819523bee8ac851990148bcad8e38737",
  17: "cc4b260ec841765f0349040a238a44281aa3ed9a792623ebd6540fd3e9f6b0b0",
  18: "d1344ba94d7dd4253f2dcc9e392c3bc4b8b1ec5b4fbba614e3fe2a10392797e5",
  19: "e458dedc7c0d85c04bca92dc2f6289b02367fb97fc7edbe1c7dba011470812b7",
  20: "1ca2a806a52cd2ce9632b02e215a25ba13bc3ebc4336f5152c48f21d60faa2a0",
  21: "dca0a24a346060b1e04b98ee5a73e016421796d6c13bd0bd2841179f405c44af",
  22: "cbf4ccb27b52c3b88d61667f94811501d36a54795391e0044bbb0b2f41d3c7ce",
  23: "532b7c0589c5ae2f4cb96c43747b19e3a7c83c2f04fd9fea663191ea5a46aced",
  24: "ef4c3593ee4384350f57c1f92e6d229c523b4c99817f95222718c4abe10db896",
  25: "e0cd0a610c4777209877535e0d5651498984681bf9b3c3f825724f4946191815",
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
  `ALTER TABLE agent_executions
   ADD COLUMN action_category TEXT NOT NULL DEFAULT 'tool_call'
   CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream'))`,
  `ALTER TABLE agent_executions
   ADD COLUMN tool_dispatch_phase TEXT
   CHECK (tool_dispatch_phase IS NULL OR tool_dispatch_phase IN ('not_started', 'dispatched', 'finished'))`,
  `ALTER TABLE agent_executions
   ADD COLUMN current_attempt_seq INTEGER NOT NULL DEFAULT 1
   CHECK (current_attempt_seq >= 1)`,
  `ALTER TABLE agent_executions
   ADD COLUMN retry_cycle INTEGER NOT NULL DEFAULT 1
   CHECK (retry_cycle >= 1)`,
  `ALTER TABLE agent_executions
   ADD COLUMN retry_ordinal INTEGER NOT NULL DEFAULT 1
   CHECK (retry_ordinal BETWEEN 1 AND 3)`,
  `ALTER TABLE agent_executions ADD COLUMN provider_id TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN model_id TEXT`,
  `ALTER TABLE agent_executions
   ADD COLUMN recovery_cursor INTEGER NOT NULL DEFAULT 0
   CHECK (recovery_cursor >= 0)`,
  `ALTER TABLE agent_executions ADD COLUMN queued_at TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN updated_at TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN cancellation_reason TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN terminal_error_code TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN dead_lettered_at TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN result_message_id TEXT REFERENCES messages(id)`,
  `ALTER TABLE agent_executions ADD COLUMN next_retry_at TEXT`,
  `ALTER TABLE agent_executions ADD COLUMN manual_retry_of_execution_id TEXT REFERENCES agent_executions(id)`,
  `ALTER TABLE agent_executions ADD COLUMN compensates_execution_id TEXT REFERENCES agent_executions(id)`,
  `UPDATE agent_executions
   SET status = CASE status WHEN 'interrupted' THEN 'cancelled' ELSE status END,
       tool_dispatch_phase = CASE WHEN status = 'running' THEN 'dispatched' ELSE 'finished' END,
       queued_at = started_at,
       updated_at = COALESCE(completed_at, started_at),
       cancellation_reason = CASE WHEN status = 'interrupted' THEN 'legacy_interrupted' ELSE NULL END,
       terminal_error_code = CASE WHEN status = 'failed' THEN 'legacy_failure' ELSE NULL END`,
  `CREATE TABLE agent_invocation_intents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    target_agent_id TEXT NOT NULL REFERENCES actors(id),
    requester_actor_id TEXT NOT NULL REFERENCES actors(id),
    intent_kind TEXT NOT NULL CHECK (intent_kind IN ('direct_mention', 'structured_help', 'routed_candidate')),
    execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id),
    created_at TEXT NOT NULL,
    UNIQUE (source_message_id, target_agent_id)
  ) STRICT`,
  `CREATE TABLE agent_execution_attempts (
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    retry_cycle INTEGER NOT NULL CHECK (retry_cycle >= 1),
    retry_ordinal INTEGER NOT NULL CHECK (retry_ordinal BETWEEN 1 AND 3),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    next_retry_at TEXT,
    recovery_cursor INTEGER NOT NULL DEFAULT 0 CHECK (recovery_cursor >= 0),
    PRIMARY KEY (execution_id, attempt_seq)
  ) STRICT`,
  `INSERT INTO agent_execution_attempts (
     execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
     action_category, started_at, finished_at, error_code, next_retry_at,
     recovery_cursor
   )
   SELECT id, 1, 1, 1, status, 'tool_call', started_at, completed_at,
          CASE WHEN status = 'failed' THEN 'legacy_failure' ELSE NULL END,
          NULL, 0
   FROM agent_executions`,
  `CREATE TABLE agent_execution_steps (
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    step_seq INTEGER NOT NULL CHECK (step_seq >= 1),
    step_kind TEXT NOT NULL CHECK (step_kind IN ('model', 'tool')),
    tool_call_json TEXT CHECK (tool_call_json IS NULL OR json_valid(tool_call_json)),
    bounded_tool_result_json TEXT CHECK (bounded_tool_result_json IS NULL OR json_valid(bounded_tool_result_json)),
    input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
    output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
    completed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, attempt_seq, step_seq),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TABLE agent_execution_grants (
    grant_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    agent_id TEXT NOT NULL REFERENCES actors(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    tool_id TEXT NOT NULL CHECK (tool_id IN ('http-json.read', 'repository.git-status', 'sandbox-file.write')),
    parameter_sha256 TEXT NOT NULL CHECK (length(parameter_sha256) = 64),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TABLE tool_confirmations (
    confirmation_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    tool_id TEXT NOT NULL CHECK (tool_id IN ('sandbox-file.write')),
    parameter_sha256 TEXT NOT NULL CHECK (length(parameter_sha256) = 64),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    human_principal_id TEXT NOT NULL REFERENCES actors(id),
    session_family_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    target TEXT NOT NULL,
    impact TEXT NOT NULL,
    reversibility TEXT NOT NULL CHECK (reversibility IN ('compensatable', 'irreversible')),
    consumed_at TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TABLE tool_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL,
    grant_id TEXT NOT NULL UNIQUE REFERENCES agent_execution_grants(grant_id),
    tool_id TEXT NOT NULL CHECK (tool_id IN ('http-json.read', 'repository.git-status', 'sandbox-file.write')),
    parameter_sha256 TEXT NOT NULL CHECK (length(parameter_sha256) = 64),
    state TEXT NOT NULL CHECK (state IN ('dispatched', 'succeeded', 'failed', 'outcome_unknown')),
    dispatched_at TEXT NOT NULL,
    settled_at TEXT,
    closed_summary_json TEXT CHECK (closed_summary_json IS NULL OR json_valid(closed_summary_json)),
    sealed_compensation TEXT,
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TABLE agent_human_fences (
    fence_message_id TEXT NOT NULL REFERENCES messages(id),
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    old_attempt_seq INTEGER NOT NULL CHECK (old_attempt_seq >= 1),
    cancelled_at TEXT NOT NULL,
    PRIMARY KEY (fence_message_id, execution_id, old_attempt_seq)
  ) STRICT`,
  `CREATE TABLE agent_fence_replacements (
    fence_message_id TEXT NOT NULL,
    old_execution_id TEXT NOT NULL,
    old_attempt_seq INTEGER NOT NULL CHECK (old_attempt_seq >= 1),
    route_job_id TEXT NOT NULL,
    selected_agent_id TEXT NOT NULL REFERENCES actors(id),
    replacement_execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (fence_message_id, old_execution_id),
    FOREIGN KEY (fence_message_id, old_execution_id, old_attempt_seq)
      REFERENCES agent_human_fences(fence_message_id, execution_id, old_attempt_seq)
  ) STRICT`,
  `CREATE INDEX agent_executions_room_queue_v6
   ON agent_executions(room_id, status, queued_at, id)`,
  `CREATE INDEX agent_execution_attempts_retry_v6
   ON agent_execution_attempts(status, next_retry_at, execution_id, attempt_seq)`,
  `CREATE TRIGGER agent_executions_v6_validate_insert
   BEFORE INSERT ON agent_executions
   WHEN NEW.status NOT IN ('queued', 'running', 'completed', 'failed', 'cancelled')
      OR NEW.queued_at IS NULL OR NEW.updated_at IS NULL
      OR (NEW.action_category = 'tool_call' AND NEW.tool_dispatch_phase IS NULL)
      OR (NEW.action_category <> 'tool_call' AND NEW.tool_dispatch_phase IS NOT NULL)
      OR (NEW.status = 'cancelled' AND NEW.cancellation_reason IS NULL)
      OR (NEW.status = 'failed' AND NEW.terminal_error_code IS NULL)
   BEGIN
     SELECT RAISE(ABORT, 'canonical Agent execution is invalid');
   END`,
  `CREATE TRIGGER agent_executions_v6_validate_update
   BEFORE UPDATE ON agent_executions
   WHEN NEW.status NOT IN ('queued', 'running', 'completed', 'failed', 'cancelled')
      OR NEW.queued_at IS NULL OR NEW.updated_at IS NULL
      OR (NEW.action_category = 'tool_call' AND NEW.tool_dispatch_phase IS NULL)
      OR (NEW.action_category <> 'tool_call' AND NEW.tool_dispatch_phase IS NOT NULL)
      OR (NEW.status = 'cancelled' AND NEW.cancellation_reason IS NULL)
      OR (NEW.status = 'failed' AND NEW.terminal_error_code IS NULL)
   BEGIN
     SELECT RAISE(ABORT, 'canonical Agent execution is invalid');
   END`,
] as const;

const V7_STATEMENTS = [
  `CREATE TABLE route_jobs (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    current_attempt INTEGER NOT NULL DEFAULT 1 CHECK (current_attempt BETWEEN 1 AND 3),
    topic_key TEXT NOT NULL,
    embedding_model_version TEXT NOT NULL CHECK (embedding_model_version = 'dao-topic-embedding-v1'),
    window_size INTEGER NOT NULL CHECK (window_size = 8),
    cosine_threshold REAL NOT NULL CHECK (cosine_threshold = 0.82),
    room_phase TEXT NOT NULL CHECK (room_phase IN ('discussion', 'execution')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    terminal_error_code TEXT,
    next_retry_at TEXT
  ) STRICT`,
  `CREATE TABLE route_job_agents (
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention', 'silent')),
    role TEXT NOT NULL,
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
    calibration_score INTEGER NOT NULL CHECK (calibration_score BETWEEN -4 AND 4),
    has_ball INTEGER NOT NULL CHECK (has_ball IN (0, 1)),
    PRIMARY KEY (route_job_id, agent_id)
  ) STRICT`,
  `CREATE TABLE route_attempts (
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq BETWEEN 1 AND 3),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    next_retry_at TEXT,
    PRIMARY KEY (route_job_id, attempt_seq)
  ) STRICT`,
  `CREATE TABLE route_judgments (
    id TEXT PRIMARY KEY,
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('will_respond', 'no_response_needed', 'suppressed')),
    reason_code TEXT NOT NULL CHECK (reason_code IN (
      'direct_mention', 'structured_help', 'domain_match', 'risk_detected', 'ball_due',
      'participation_silent', 'participation_on_mention', 'cooldown', 'agent_round_limit',
      'human_burst_soft_suppression', 'execution_phase', 'calibration_suppressed',
      'provider_omitted', 'provider_failed', 'permission_denied', 'not_selected'
    )),
    reason_text TEXT NOT NULL CHECK (length(trim(reason_text)) > 0),
    route_attempt INTEGER NOT NULL CHECK (route_attempt BETWEEN 1 AND 3),
    decided_at TEXT NOT NULL,
    UNIQUE (route_job_id, agent_id)
  ) STRICT`,
  `CREATE TABLE route_invocation_intents (
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    target_agent_id TEXT NOT NULL REFERENCES actors(id),
    intent_kind TEXT NOT NULL CHECK (intent_kind IN ('direct_mention', 'structured_help', 'routed_candidate')),
    reason_code TEXT NOT NULL CHECK (reason_code IN ('direct_mention', 'structured_help', 'domain_match', 'risk_detected', 'ball_due')),
    reason_text TEXT NOT NULL CHECK (length(trim(reason_text)) > 0),
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_message_id, target_agent_id)
  ) STRICT`,
  `CREATE TABLE message_topics (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    topic_key TEXT NOT NULL,
    embedding_model_version TEXT NOT NULL CHECK (embedding_model_version = 'dao-topic-embedding-v1'),
    window_size INTEGER NOT NULL CHECK (window_size = 8),
    cosine_threshold REAL NOT NULL CHECK (cosine_threshold = 0.82),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE route_calibration_facts (
    fact_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    human_actor_id TEXT NOT NULL REFERENCES actors(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    topic_key TEXT NOT NULL,
    weight INTEGER NOT NULL CHECK (weight IN (-2, -1, 1, 2)),
    kind TEXT NOT NULL CHECK (kind IN ('useful', 'not_needed', 'thumbs_up', 'thumbs_down')),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE route_calibration_scores (
    agent_id TEXT NOT NULL REFERENCES actors(id),
    topic_key TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN -4 AND 4),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, topic_key)
  ) STRICT`,
  `CREATE TABLE route_metrics (
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    metric_name TEXT NOT NULL CHECK (metric_name IN ('attempts_exhausted')),
    value INTEGER NOT NULL CHECK (value >= 0),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (route_job_id, metric_name)
  ) STRICT`,
  `CREATE INDEX route_jobs_room_queue_v7 ON route_jobs(room_id, status, created_at, id)`,
  `CREATE INDEX route_attempts_retry_v7 ON route_attempts(status, next_retry_at, route_job_id, attempt_seq)`,
  `CREATE INDEX route_judgments_message_v7 ON route_judgments(source_message_id, agent_id)`,
  `CREATE INDEX route_calibration_facts_agent_topic_v7 ON route_calibration_facts(agent_id, topic_key, created_at)`,
] as const;

const V8_STATEMENTS = [
  `DROP TRIGGER open_items_validate_insert`,
  `DROP TRIGGER open_items_validate_update`,
  `DROP TRIGGER messages_validate_update`,
  `ALTER TABLE open_items RENAME TO open_items_v7`,
  `CREATE TABLE open_items (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    current_owner_actor_id TEXT REFERENCES actors(id),
    status TEXT NOT NULL CHECK (status IN ('awaiting', 'answered', 'deferred', 'transferred')),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    created_at TEXT NOT NULL,
    responded_at TEXT,
    requester_actor_id TEXT NOT NULL REFERENCES actors(id),
    transfer_chain_json TEXT NOT NULL
      CHECK (json_valid(transfer_chain_json) AND json_type(transfer_chain_json) = 'array'),
    origin_kind TEXT NOT NULL CHECK (origin_kind IN ('human_mention', 'manual_unfinished', 'agent_proposal')),
    proposal_kind TEXT CHECK (proposal_kind IS NULL OR proposal_kind IN ('risk', 'challenge')),
    source_execution_id TEXT REFERENCES agent_executions(id),
    proposal_reason TEXT,
    CHECK (
      (status IN ('awaiting', 'transferred')
       AND current_owner_actor_id IS NOT NULL AND responded_at IS NULL)
      OR
      (status IN ('answered', 'deferred')
       AND current_owner_actor_id IS NULL AND responded_at IS NOT NULL)
    ),
    CHECK (
      (origin_kind = 'agent_proposal'
       AND proposal_kind IS NOT NULL
       AND source_execution_id IS NOT NULL
       AND proposal_reason IS NOT NULL
       AND length(trim(proposal_reason)) > 0)
      OR
      (origin_kind IN ('human_mention', 'manual_unfinished')
       AND proposal_kind IS NULL
       AND source_execution_id IS NULL
       AND proposal_reason IS NULL)
    ),
    CHECK (status <> 'awaiting' OR json_array_length(transfer_chain_json) = 0),
    CHECK (status <> 'transferred' OR json_array_length(transfer_chain_json) > 0)
  ) STRICT`,
  `INSERT INTO open_items (
     id, room_id, source_message_id, current_owner_actor_id, status, body,
     created_at, responded_at, requester_actor_id, transfer_chain_json,
     origin_kind, proposal_kind, source_execution_id, proposal_reason
   )
   SELECT id, room_id, source_message_id,
          CASE WHEN status IN ('responded', 'deferred') THEN NULL ELSE assigned_actor_id END,
          CASE status
            WHEN 'pending_response' THEN 'awaiting'
            WHEN 'responded' THEN 'answered'
            WHEN 'deferred' THEN 'deferred'
            WHEN 'transferred' THEN 'transferred'
          END,
          body, created_at,
          CASE WHEN status IN ('responded', 'deferred')
            THEN COALESCE(responded_at, resolved_at, created_at)
            ELSE NULL
          END,
          requester_actor_id, transfer_chain_json,
          'manual_unfinished', NULL, NULL, NULL
   FROM open_items_v7`,
  `DROP TABLE open_items_v7`,
  `CREATE INDEX open_items_room_id_id ON open_items(room_id, id)`,
  `CREATE INDEX open_items_active_owner_v8
   ON open_items(room_id, current_owner_actor_id, status, id)`,
  `CREATE TABLE open_item_agent_failures (
    id TEXT PRIMARY KEY,
    open_item_id TEXT NOT NULL REFERENCES open_items(id),
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
    failed_at TEXT NOT NULL,
    UNIQUE (open_item_id, execution_id, attempt_seq)
  ) STRICT`,
  `CREATE INDEX open_item_agent_failures_item_v8
   ON open_item_agent_failures(open_item_id, failed_at, id)`,
  `CREATE TRIGGER open_items_validate_insert_v8
   BEFORE INSERT ON open_items
   WHEN COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '') <> NEW.room_id
      OR NOT EXISTS (
        SELECT 1 FROM room_memberships
        WHERE room_id = NEW.room_id AND actor_id = NEW.requester_actor_id
      )
      OR (NEW.current_owner_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM room_memberships
        WHERE room_id = NEW.room_id AND actor_id = NEW.current_owner_actor_id
      ))
      OR (NEW.status = 'transferred' AND
          COALESCE(json_extract(NEW.transfer_chain_json, '$[#-1].toId'), '')
            <> NEW.current_owner_actor_id)
      OR (NEW.origin_kind = 'agent_proposal' AND NOT EXISTS (
        SELECT 1 FROM agent_executions AS execution
        WHERE execution.id = NEW.source_execution_id
          AND execution.room_id = NEW.room_id
          AND execution.trigger_message_id = NEW.source_message_id
          AND execution.agent_id = NEW.requester_actor_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'canonical open item is invalid');
   END`,
  `CREATE TRIGGER open_items_validate_update_v8
   BEFORE UPDATE ON open_items
   WHEN NEW.id <> OLD.id
      OR NEW.room_id <> OLD.room_id
      OR NEW.source_message_id <> OLD.source_message_id
      OR NEW.requester_actor_id <> OLD.requester_actor_id
      OR NEW.body <> OLD.body
      OR NEW.created_at <> OLD.created_at
      OR NEW.origin_kind <> OLD.origin_kind
      OR NEW.proposal_kind IS NOT OLD.proposal_kind
      OR NEW.source_execution_id IS NOT OLD.source_execution_id
      OR NEW.proposal_reason IS NOT OLD.proposal_reason
      OR OLD.status IN ('answered', 'deferred')
      OR json_array_length(NEW.transfer_chain_json) < json_array_length(OLD.transfer_chain_json)
      OR EXISTS (
        SELECT 1 FROM json_each(OLD.transfer_chain_json) AS old_transfer
        WHERE json_extract(NEW.transfer_chain_json, '$[' || old_transfer.key || ']')
          IS NOT old_transfer.value
      )
      OR (NEW.current_owner_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM room_memberships
        WHERE room_id = NEW.room_id AND actor_id = NEW.current_owner_actor_id
      ))
      OR (NEW.status = 'transferred' AND
          COALESCE(json_extract(NEW.transfer_chain_json, '$[#-1].toId'), '')
            <> NEW.current_owner_actor_id)
   BEGIN
     SELECT RAISE(ABORT, 'canonical open item update is invalid');
   END`,
  `CREATE TRIGGER open_item_agent_failures_validate_insert_v8
   BEFORE INSERT ON open_item_agent_failures
   WHEN NOT EXISTS (
     SELECT 1
     FROM open_items AS item
     JOIN actors AS owner ON owner.id = item.current_owner_actor_id
     JOIN agent_executions AS execution ON execution.id = NEW.execution_id
     WHERE item.id = NEW.open_item_id
       AND item.status IN ('awaiting', 'transferred')
       AND owner.kind = 'agent'
       AND execution.room_id = item.room_id
       AND execution.trigger_message_id = item.source_message_id
       AND execution.agent_id = item.current_owner_actor_id
       AND execution.status = 'failed'
       AND execution.current_attempt_seq = NEW.attempt_seq
   )
   BEGIN
     SELECT RAISE(ABORT, 'open item Agent failure is invalid');
   END`,
  `CREATE TRIGGER messages_validate_update_v8
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
] as const;

const V9_STATEMENTS = [
  `CREATE TABLE light_tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    claimant_actor_id TEXT REFERENCES actors(id),
    claimant_role_at_claim TEXT CHECK (
      claimant_role_at_claim IS NULL OR claimant_role_at_claim IN ('owner', 'admin', 'member')
    ),
    verifier_role TEXT NOT NULL CHECK (verifier_role IN ('owner', 'admin', 'member')),
    verifier_actor_id TEXT REFERENCES actors(id),
    criteria_json TEXT NOT NULL CHECK (
      json_valid(criteria_json) AND json_type(criteria_json) = 'array'
    ),
    status TEXT NOT NULL CHECK (status IN ('todo', 'claimed', 'delivered', 'verified')),
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    delivered_at TEXT,
    verified_at TEXT,
    CHECK (
      (status = 'todo' AND claimant_actor_id IS NULL AND claimant_role_at_claim IS NULL
       AND verifier_actor_id IS NULL AND claimed_at IS NULL AND delivered_at IS NULL
       AND verified_at IS NULL)
      OR
      (status = 'claimed' AND claimant_actor_id IS NOT NULL AND claimant_role_at_claim IS NOT NULL
       AND verifier_actor_id IS NULL AND claimed_at IS NOT NULL AND delivered_at IS NULL
       AND verified_at IS NULL)
      OR
      (status = 'delivered' AND claimant_actor_id IS NOT NULL AND claimant_role_at_claim IS NOT NULL
       AND verifier_actor_id IS NOT NULL AND claimed_at IS NOT NULL AND delivered_at IS NOT NULL
       AND verified_at IS NULL AND claimant_actor_id <> verifier_actor_id
       AND claimant_role_at_claim <> verifier_role)
      OR
      (status = 'verified' AND claimant_actor_id IS NOT NULL AND claimant_role_at_claim IS NOT NULL
       AND verifier_actor_id IS NOT NULL AND claimed_at IS NOT NULL AND delivered_at IS NOT NULL
       AND verified_at IS NOT NULL AND claimant_actor_id <> verifier_actor_id
       AND claimant_role_at_claim <> verifier_role)
    )
  ) STRICT`,
  `CREATE INDEX light_tasks_room_id_id_v9 ON light_tasks(room_id, id)`,
  `CREATE INDEX light_tasks_active_actor_v9
   ON light_tasks(room_id, status, claimant_actor_id, verifier_actor_id, id)`,
  `CREATE TRIGGER light_tasks_validate_insert_v9
   BEFORE INSERT ON light_tasks
   WHEN COALESCE((SELECT room_id FROM messages WHERE id = NEW.source_message_id), '') <> NEW.room_id
      OR (NEW.claimant_actor_id IS NOT NULL AND
          COALESCE((SELECT kind FROM actors WHERE id = NEW.claimant_actor_id), '') <> 'human')
      OR (NEW.verifier_actor_id IS NOT NULL AND
          COALESCE((SELECT kind FROM actors WHERE id = NEW.verifier_actor_id), '') <> 'human')
      OR (NEW.status = 'verified' AND EXISTS (
        SELECT 1 FROM json_each(NEW.criteria_json) AS criterion
        WHERE json_extract(criterion.value, '$.met') <> 1
      ))
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.criteria_json) AS criterion
        WHERE json_type(criterion.value) <> 'object'
           OR (SELECT COUNT(*) FROM json_each(criterion.value)) <> 3
           OR json_type(criterion.value, '$.id') <> 'text'
           OR json_type(criterion.value, '$.text') <> 'text'
           OR json_type(criterion.value, '$.met') NOT IN ('true', 'false')
           OR length(trim(COALESCE(json_extract(criterion.value, '$.id'), ''))) = 0
           OR length(trim(COALESCE(json_extract(criterion.value, '$.text'), ''))) = 0
      )
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.criteria_json) AS criterion
        GROUP BY json_extract(criterion.value, '$.id') HAVING COUNT(*) > 1
      )
   BEGIN
     SELECT RAISE(ABORT, 'canonical light task is invalid');
   END`,
  `CREATE TRIGGER light_tasks_validate_update_v9
   BEFORE UPDATE ON light_tasks
   WHEN NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id
      OR NEW.source_message_id <> OLD.source_message_id OR NEW.title <> OLD.title
      OR NEW.verifier_role <> OLD.verifier_role OR NEW.created_at <> OLD.created_at
      OR OLD.status = 'verified'
      OR (OLD.status = 'todo' AND NEW.status NOT IN ('todo', 'claimed'))
      OR (OLD.status = 'claimed' AND NEW.status NOT IN ('claimed', 'delivered'))
      OR (OLD.status = 'delivered' AND NEW.status NOT IN ('delivered', 'verified'))
      OR (OLD.claimant_actor_id IS NOT NULL AND NEW.claimant_actor_id IS NOT OLD.claimant_actor_id)
      OR (OLD.claimant_role_at_claim IS NOT NULL
          AND NEW.claimant_role_at_claim IS NOT OLD.claimant_role_at_claim)
      OR (OLD.verifier_actor_id IS NOT NULL AND NEW.verifier_actor_id IS NOT OLD.verifier_actor_id)
      OR (OLD.claimant_actor_id IS NULL AND NEW.claimant_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM room_memberships AS membership
        WHERE membership.room_id = NEW.room_id
          AND membership.actor_id = NEW.claimant_actor_id
          AND membership.kind = 'human'
          AND membership.role = NEW.claimant_role_at_claim
      ))
      OR (OLD.verifier_actor_id IS NULL AND NEW.verifier_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM room_memberships AS membership
        WHERE membership.room_id = NEW.room_id
          AND membership.actor_id = NEW.verifier_actor_id
          AND membership.kind = 'human'
          AND membership.role = NEW.verifier_role
      ))
      OR (NEW.status = 'verified' AND EXISTS (
        SELECT 1 FROM json_each(NEW.criteria_json) AS criterion
        WHERE json_extract(criterion.value, '$.met') <> 1
      ))
      OR (NEW.criteria_json <> OLD.criteria_json AND OLD.status <> 'delivered')
      OR json_array_length(NEW.criteria_json) <> json_array_length(OLD.criteria_json)
      OR EXISTS (
        SELECT 1 FROM json_each(OLD.criteria_json) AS criterion
        WHERE json_extract(NEW.criteria_json, '$[' || criterion.key || '].id')
                IS NOT json_extract(criterion.value, '$.id')
           OR json_extract(NEW.criteria_json, '$[' || criterion.key || '].text')
                IS NOT json_extract(criterion.value, '$.text')
      )
   BEGIN
     SELECT RAISE(ABORT, 'canonical light task update is invalid');
   END`,
  `CREATE TRIGGER messages_validate_light_tasks_update_v9
   BEFORE UPDATE OF room_id ON messages
   WHEN EXISTS (
     SELECT 1 FROM light_tasks
     WHERE source_message_id = OLD.id AND room_id <> NEW.room_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'message update would break light task references');
   END`,
] as const;

const V10_STATEMENTS = [
  `CREATE TABLE ball_boundary_claims (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'open-item', 'light-task', 'blueprint-task', 'blueprint-awaiting',
      'blueprint-blocked-mention'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
    holder_actor_id TEXT NOT NULL REFERENCES actors(id),
    holder_kind TEXT NOT NULL CHECK (holder_kind IN ('human', 'agent')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1024),
    since_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('agent_trigger', 'human_reminder')),
    claimed_at TEXT NOT NULL,
    route_consumed_at TEXT,
    UNIQUE (
      room_id, source_kind, source_id, holder_actor_id, since_at, boundary_kind
    )
  ) STRICT`,
  `CREATE INDEX ball_boundary_claims_room_holder_v10
   ON ball_boundary_claims(room_id, holder_actor_id, claimed_at, id)`,
] as const;

const V11_STATEMENTS = [
  `ALTER TABLE agent_executions
   ADD COLUMN supersedes_execution_ids_json TEXT
   CHECK (
     supersedes_execution_ids_json IS NULL OR (
       json_valid(supersedes_execution_ids_json)
       AND json_type(supersedes_execution_ids_json) = 'array'
       AND json_array_length(supersedes_execution_ids_json) BETWEEN 1 AND 32
     )
   )`,
  `ALTER TABLE agent_fence_replacements RENAME TO agent_fence_replacements_v10`,
  `CREATE TABLE agent_fence_replacements (
    fence_message_id TEXT NOT NULL,
    old_execution_id TEXT NOT NULL,
    old_attempt_seq INTEGER NOT NULL CHECK (old_attempt_seq >= 1),
    route_job_id TEXT NOT NULL,
    selected_agent_id TEXT NOT NULL REFERENCES actors(id),
    replacement_execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (fence_message_id, old_execution_id),
    FOREIGN KEY (fence_message_id, old_execution_id, old_attempt_seq)
      REFERENCES agent_human_fences(fence_message_id, execution_id, old_attempt_seq)
  ) STRICT`,
  `INSERT INTO agent_fence_replacements (
     fence_message_id, old_execution_id, old_attempt_seq, route_job_id,
     selected_agent_id, replacement_execution_id, created_at
   )
   SELECT fence_message_id, old_execution_id, old_attempt_seq, route_job_id,
          selected_agent_id, replacement_execution_id, created_at
   FROM agent_fence_replacements_v10`,
  `DROP TABLE agent_fence_replacements_v10`,
  `CREATE INDEX agent_fence_replacements_replacement_v11
   ON agent_fence_replacements(replacement_execution_id, old_execution_id)`,
  `CREATE TABLE human_preemption_fences (
    source_human_message_id TEXT PRIMARY KEY REFERENCES messages(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    human_actor_id TEXT NOT NULL REFERENCES actors(id),
    accepted_at TEXT NOT NULL,
    cancelled_count INTEGER NOT NULL CHECK (cancelled_count BETWEEN 0 AND 33),
    cancel_committed_at TEXT NOT NULL,
    route_job_id TEXT UNIQUE REFERENCES route_jobs(id),
    route_created_at TEXT,
    CHECK (
      (route_job_id IS NULL AND route_created_at IS NULL)
      OR (route_job_id IS NOT NULL AND route_created_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX human_preemption_fences_pending_route_v11
   ON human_preemption_fences(route_job_id, cancel_committed_at, source_human_message_id)`,
  `CREATE TRIGGER agent_executions_v11_validate_supersedes_insert
   BEFORE INSERT ON agent_executions
   WHEN NEW.supersedes_execution_ids_json IS NOT NULL AND (
     EXISTS (
       SELECT 1 FROM json_each(NEW.supersedes_execution_ids_json)
       WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) = 0 OR value = NEW.id
     )
     OR (SELECT COUNT(*) FROM json_each(NEW.supersedes_execution_ids_json)) <>
        (SELECT COUNT(DISTINCT value) FROM json_each(NEW.supersedes_execution_ids_json))
   )
   BEGIN
     SELECT RAISE(ABORT, 'execution supersedes lineage is invalid');
   END`,
  `CREATE TRIGGER agent_executions_v11_validate_supersedes_update
   BEFORE UPDATE OF supersedes_execution_ids_json ON agent_executions
   WHEN NEW.supersedes_execution_ids_json IS NOT NULL AND (
     EXISTS (
       SELECT 1 FROM json_each(NEW.supersedes_execution_ids_json)
       WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) = 0 OR value = NEW.id
     )
     OR (SELECT COUNT(*) FROM json_each(NEW.supersedes_execution_ids_json)) <>
        (SELECT COUNT(DISTINCT value) FROM json_each(NEW.supersedes_execution_ids_json))
   )
   BEGIN
     SELECT RAISE(ABORT, 'execution supersedes lineage is invalid');
   END`,
  `CREATE TRIGGER human_preemption_fences_validate_insert_v11
   BEFORE INSERT ON human_preemption_fences
   WHEN NOT EXISTS (
     SELECT 1
     FROM messages AS message
     JOIN actors AS actor ON actor.id = message.author_id AND actor.kind = 'human'
     JOIN events AS event
       ON event.stream_kind = 'room' AND event.stream_id = message.room_id
      AND event.room_id = message.room_id AND event.actor_id = message.author_id
      AND event.event_type = 'room.message.accepted'
      AND json_extract(event.payload_json, '$.id') = message.id
      AND event.occurred_at = NEW.accepted_at
     WHERE message.id = NEW.source_human_message_id
       AND message.room_id = NEW.room_id
       AND message.author_id = NEW.human_actor_id
       AND message.author_kind = 'human'
   )
   BEGIN
     SELECT RAISE(ABORT, 'human preemption requires a durable human message');
   END`,
  `CREATE TRIGGER human_preemption_fences_validate_update_v11
   BEFORE UPDATE ON human_preemption_fences
   WHEN NEW.source_human_message_id <> OLD.source_human_message_id
      OR NEW.room_id <> OLD.room_id
      OR NEW.human_actor_id <> OLD.human_actor_id
      OR NEW.accepted_at <> OLD.accepted_at
      OR NEW.cancelled_count <> OLD.cancelled_count
      OR NEW.cancel_committed_at <> OLD.cancel_committed_at
      OR (OLD.route_job_id IS NOT NULL AND (
        NEW.route_job_id IS NOT OLD.route_job_id OR NEW.route_created_at IS NOT OLD.route_created_at
      ))
      OR (NEW.route_job_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM route_jobs AS route
        WHERE route.id = NEW.route_job_id
          AND route.room_id = NEW.room_id
          AND route.source_message_id = NEW.source_human_message_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'human preemption fence update is invalid');
   END`,
] as const;

const V12_STATEMENTS = [
  `CREATE TABLE session_families (
    family_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 1 AND 128),
    account_id TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
    device_label TEXT NOT NULL CHECK (length(device_label) BETWEEN 1 AND 128),
    platform TEXT NOT NULL CHECK (platform IN ('macos', 'windows', 'linux', 'unknown')),
    created_at INTEGER CHECK (created_at IS NULL OR created_at >= 0),
    refresh_expires_at INTEGER NOT NULL CHECK (refresh_expires_at >= 0),
    revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
    UNIQUE (family_id, account_id, actor_id)
  ) STRICT`,
  `INSERT INTO session_families (
     family_id, public_id, account_id, actor_id, device_id, device_label,
     platform, created_at, refresh_expires_at, revoked_at
   )
   SELECT
     family_id,
     lower(hex(randomblob(32))),
     MIN(account_id),
     MIN(actor_id),
     'legacy',
     'Legacy device',
     'unknown',
     NULL,
     MAX(refresh_expires_at),
     CASE
       WHEN SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
       ELSE COALESCE(MAX(revoked_at), 0)
     END
   FROM sessions
   GROUP BY family_id`,
  `CREATE INDEX session_families_principal_active_v12
   ON session_families(account_id, actor_id, revoked_at, created_at DESC, public_id)`,
  `CREATE TRIGGER session_families_validate_insert_v12
   BEFORE INSERT ON session_families
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
   BEGIN
     SELECT RAISE(ABORT, 'session family actor must be human');
   END`,
  `CREATE TRIGGER session_families_validate_update_v12
   BEFORE UPDATE ON session_families
   WHEN NEW.family_id <> OLD.family_id
      OR NEW.public_id <> OLD.public_id
      OR NEW.account_id <> OLD.account_id
      OR NEW.actor_id <> OLD.actor_id
      OR NEW.device_id <> OLD.device_id
      OR NEW.device_label <> OLD.device_label
      OR NEW.platform <> OLD.platform
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.refresh_expires_at < OLD.refresh_expires_at
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
   BEGIN
     SELECT RAISE(ABORT, 'session family immutable fields cannot change');
   END`,
  `CREATE TRIGGER sessions_validate_family_insert_v12
   BEFORE INSERT ON sessions
   WHEN NOT EXISTS (
     SELECT 1 FROM session_families AS family
     WHERE family.family_id = NEW.family_id
       AND family.account_id = NEW.account_id
       AND family.actor_id = NEW.actor_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'session generation must match its family principal');
   END`,
  `CREATE TRIGGER sessions_validate_family_update_v12
   BEFORE UPDATE OF family_id, account_id, actor_id ON sessions
   WHEN NOT EXISTS (
     SELECT 1 FROM session_families AS family
     WHERE family.family_id = NEW.family_id
       AND family.account_id = NEW.account_id
       AND family.actor_id = NEW.actor_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'session generation must match its family principal');
   END`,
] as const;

const V13_STATEMENTS = [
  `ALTER TABLE rooms ADD COLUMN owner_actor_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN governance_revision INTEGER NOT NULL DEFAULT 0
   CHECK (governance_revision >= 0)`,
  `ALTER TABLE rooms ADD COLUMN archive_generation INTEGER NOT NULL DEFAULT 0
   CHECK (archive_generation >= 0)`,
  `ALTER TABLE rooms ADD COLUMN archived_at TEXT`,
  `UPDATE rooms
   SET owner_actor_id = (
     SELECT membership.actor_id
     FROM room_memberships AS membership
     WHERE membership.room_id = rooms.id
       AND membership.kind = 'human'
       AND membership.role = 'owner'
   ),
   archived_at = CASE WHEN status = 'archived' THEN created_at ELSE NULL END,
   archive_generation = CASE WHEN status = 'archived' THEN 1 ELSE 0 END`,
  `UPDATE room_memberships SET role = 'member'
   WHERE kind = 'human' AND role = 'owner'`,
  `UPDATE room_memberships
   SET role = 'owner'
   WHERE kind = 'human'
     AND actor_id = (SELECT owner_actor_id FROM rooms WHERE id = room_memberships.room_id)`,
  `CREATE UNIQUE INDEX room_memberships_v13_one_human_owner
   ON room_memberships(room_id) WHERE kind = 'human' AND role = 'owner'`,
  `CREATE TRIGGER room_memberships_v13_owner_role_insert
   BEFORE INSERT ON room_memberships
   WHEN NEW.role = 'owner' AND NEW.actor_id IS NOT (
     SELECT owner_actor_id FROM rooms WHERE id = NEW.room_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'owner role is controlled by canonical room ownership');
   END`,
  `CREATE TRIGGER room_memberships_v13_owner_role_update
   BEFORE UPDATE OF role ON room_memberships
   WHEN (NEW.role = 'owner' AND NEW.actor_id IS NOT (
          SELECT owner_actor_id FROM rooms WHERE id = NEW.room_id
        ))
      OR (OLD.actor_id = (SELECT owner_actor_id FROM rooms WHERE id = OLD.room_id)
          AND NEW.role <> 'owner')
   BEGIN
     SELECT RAISE(ABORT, 'owner role is controlled by canonical room ownership');
   END`,
  `CREATE TRIGGER rooms_v13_owner_validate_update
   BEFORE UPDATE OF owner_actor_id ON rooms
   WHEN NEW.owner_actor_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM room_memberships AS membership
     JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE membership.room_id = NEW.id
       AND membership.actor_id = NEW.owner_actor_id
       AND membership.kind = 'human'
       AND actor.kind = 'human'
   )
   BEGIN
     SELECT RAISE(ABORT, 'room owner must be a same-room Human member');
   END`,
  `CREATE TRIGGER rooms_v13_owner_role_sync
   AFTER UPDATE OF owner_actor_id ON rooms
   BEGIN
     UPDATE room_memberships
     SET role = CASE WHEN actor_id = NEW.owner_actor_id THEN 'owner' ELSE 'member' END
     WHERE room_id = NEW.id AND kind = 'human'
       AND (actor_id = NEW.owner_actor_id OR role = 'owner');
   END`,
  `CREATE TRIGGER room_memberships_v13_protect_owner_delete
   BEFORE DELETE ON room_memberships
   WHEN OLD.actor_id = (SELECT owner_actor_id FROM rooms WHERE id = OLD.room_id)
   BEGIN
     SELECT RAISE(ABORT, 'current room owner cannot be removed');
   END`,
  `CREATE TRIGGER room_memberships_v13_protect_owner_update
   BEFORE UPDATE OF room_id, actor_id, kind ON room_memberships
   WHEN OLD.actor_id = (SELECT owner_actor_id FROM rooms WHERE id = OLD.room_id)
   BEGIN
     SELECT RAISE(ABORT, 'current room owner membership cannot change identity');
   END`,
  `CREATE TABLE room_audit_v13 (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (
      'room.created', 'room.renamed', 'room.archived', 'room.human.invited',
      'room.invitation.accepted', 'room.invitation.rejected',
      'room.agent.configured', 'room.member.removed', 'room.member.role.changed',
      'room.ownership.transferred'
    )),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    result TEXT NOT NULL CHECK (result IN (
      'created', 'renamed', 'archived', 'pending', 'accepted', 'rejected',
      'configured', 'removed', 'role-changed', 'ownership-transferred'
    )),
    timestamp TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
  ) STRICT`,
  `INSERT INTO room_audit_v13
   SELECT id, type, room_id, actor_id, result, timestamp, details_json FROM room_audit`,
  `DROP TABLE room_audit`,
  `ALTER TABLE room_audit_v13 RENAME TO room_audit`,
  `CREATE TRIGGER room_audit_v13_immutable_update
   BEFORE UPDATE ON room_audit BEGIN SELECT RAISE(ABORT, 'room audit is immutable'); END`,
  `CREATE TRIGGER room_audit_v13_immutable_delete
   BEFORE DELETE ON room_audit BEGIN SELECT RAISE(ABORT, 'room audit is immutable'); END`,
] as const;

const V14_STATEMENTS = [
  `CREATE TABLE room_message_archive_gates (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    gate_generation INTEGER NOT NULL CHECK (gate_generation > 0),
    blocked_at TEXT NOT NULL
  ) STRICT`,
  `INSERT INTO room_message_archive_gates (
     room_id, gate_generation, blocked_at
   )
   SELECT id, archive_generation, archived_at
   FROM rooms
   WHERE status = 'archived'
     AND archive_generation > 0
     AND archived_at IS NOT NULL`,
  `ALTER TABLE agent_executions
   ADD COLUMN room_archive_generation INTEGER NOT NULL DEFAULT 0
   CHECK (room_archive_generation >= 0)`,
  `CREATE TABLE runtime_archive_fences (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    fenced_at TEXT NOT NULL,
    fenced_queued_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_queued_count >= 0),
    fenced_waiting_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_waiting_count >= 0),
    preserved_dispatched_count INTEGER NOT NULL DEFAULT 0
      CHECK (preserved_dispatched_count >= 0),
    preserved_outcome_review_count INTEGER NOT NULL DEFAULT 0
      CHECK (preserved_outcome_review_count >= 0),
    PRIMARY KEY (room_id, archive_generation)
  ) STRICT`,
  `CREATE TABLE runtime_archive_fence_members (
    room_id TEXT NOT NULL,
    archive_generation INTEGER NOT NULL,
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    disposition TEXT NOT NULL CHECK (disposition IN (
      'cancelled_queued', 'cancelled_waiting',
      'preserved_dispatched', 'preserved_outcome_review'
    )),
    fenced_at TEXT NOT NULL,
    PRIMARY KEY (room_id, archive_generation, execution_id),
    FOREIGN KEY (room_id, archive_generation)
      REFERENCES runtime_archive_fences(room_id, archive_generation),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE INDEX runtime_archive_fence_members_execution
   ON runtime_archive_fence_members(execution_id, archive_generation)`,
  `CREATE INDEX agent_executions_room_generation_status_v14
   ON agent_executions(room_id, room_archive_generation, status, queued_at, id)`,
  `CREATE INDEX tool_dispatches_execution_attempt_v14
   ON tool_dispatches(execution_id, attempt_seq, state)`,
  `ALTER TABLE tool_confirmations
   ADD COLUMN confirmation_state TEXT NOT NULL DEFAULT 'pending'
   CHECK (confirmation_state IN ('pending', 'confirmed', 'rejected', 'expired'))`,
  `ALTER TABLE tool_confirmations ADD COLUMN confirmation_reason TEXT`,
  `ALTER TABLE tool_confirmations
   ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 0
   CHECK (confirmation_revision >= 0)`,
  `ALTER TABLE tool_confirmations ADD COLUMN confirmation_changed_at TEXT`,
  `ALTER TABLE agent_execution_grants
   ADD COLUMN grant_state TEXT NOT NULL DEFAULT 'active'
   CHECK (grant_state IN ('active', 'claimed', 'revoked', 'expired'))`,
  `ALTER TABLE agent_execution_grants ADD COLUMN grant_reason TEXT`,
  `ALTER TABLE agent_execution_grants
   ADD COLUMN grant_revision INTEGER NOT NULL DEFAULT 0
   CHECK (grant_revision >= 0)`,
  `ALTER TABLE agent_execution_grants ADD COLUMN grant_changed_at TEXT`,
  `UPDATE tool_confirmations
   SET confirmation_state = CASE
         WHEN consumed_at IS NULL THEN 'rejected' ELSE 'confirmed' END,
       confirmation_reason = CASE
         WHEN consumed_at IS NULL THEN 'legacy_unbound' ELSE NULL END`,
  `UPDATE agent_execution_grants
   SET grant_state = CASE
         WHEN consumed_at IS NULL THEN 'revoked' ELSE 'claimed' END,
       grant_reason = CASE
         WHEN consumed_at IS NULL THEN 'legacy_unbound' ELSE NULL END`,
  `CREATE TABLE tool_archive_settlements (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    settled_at TEXT NOT NULL,
    rejected_pending_count INTEGER NOT NULL DEFAULT 0
      CHECK (rejected_pending_count >= 0),
    revoked_grant_count INTEGER NOT NULL DEFAULT 0 CHECK (revoked_grant_count >= 0),
    fenced_waiting_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_waiting_count >= 0),
    preserved_dispatched_count INTEGER NOT NULL DEFAULT 0
      CHECK (preserved_dispatched_count >= 0),
    PRIMARY KEY (room_id, archive_generation)
  ) STRICT`,
  `CREATE TABLE tool_archive_settlement_members (
    room_id TEXT NOT NULL,
    archive_generation INTEGER NOT NULL,
    subject_kind TEXT NOT NULL CHECK (
      subject_kind IN ('confirmation', 'grant', 'execution', 'dispatch')
    ),
    subject_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN (
      'rejected_pending', 'revoked_unclaimed', 'fenced_waiting', 'preserved_dispatched'
    )),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (room_id, archive_generation, subject_kind, subject_id),
    FOREIGN KEY (room_id, archive_generation)
      REFERENCES tool_archive_settlements(room_id, archive_generation)
  ) STRICT`,
  `CREATE INDEX tool_confirmations_departure_v14
   ON tool_confirmations(
     room_id, human_principal_id, confirmation_state, expires_at, confirmation_id
   )`,
  `CREATE INDEX agent_execution_grants_archive_v14
   ON agent_execution_grants(room_id, grant_state, grant_id)`,
  `CREATE INDEX tool_archive_settlement_members_disposition_v14
   ON tool_archive_settlement_members(
     room_id, archive_generation, disposition, subject_id
   )`,
  `CREATE TRIGGER tool_confirmations_binding_immutable_v14
   BEFORE UPDATE OF execution_id, attempt_seq, tool_id, parameter_sha256, room_id,
     human_principal_id, session_family_id, expires_at ON tool_confirmations
   BEGIN
     SELECT RAISE(ABORT, 'tool confirmation binding is immutable');
   END`,
  `CREATE TRIGGER tool_confirmations_state_insert_v14
   BEFORE INSERT ON tool_confirmations
   WHEN (NEW.confirmation_state = 'pending' AND NEW.consumed_at IS NOT NULL)
     OR (NEW.confirmation_state = 'confirmed' AND NEW.consumed_at IS NULL)
     OR (NEW.confirmation_state IN ('rejected', 'expired') AND NEW.consumed_at IS NOT NULL)
     OR (NEW.confirmation_revision > 0 AND NEW.confirmation_changed_at IS NULL)
   BEGIN
     SELECT RAISE(ABORT, 'tool confirmation state is invalid');
   END`,
  `CREATE TRIGGER tool_confirmations_state_update_v14
   BEFORE UPDATE OF confirmation_state, confirmation_reason, confirmation_revision,
     confirmation_changed_at, consumed_at ON tool_confirmations
   WHEN NOT (
     OLD.confirmation_state = 'pending'
     AND NEW.confirmation_state IN ('confirmed', 'rejected', 'expired')
     AND NEW.confirmation_revision = OLD.confirmation_revision + 1
     AND NEW.confirmation_changed_at IS NOT NULL
     AND (
       (NEW.confirmation_state = 'confirmed' AND NEW.consumed_at IS NOT NULL)
       OR (NEW.confirmation_state IN ('rejected', 'expired') AND NEW.consumed_at IS NULL)
     )
   )
   BEGIN
     SELECT RAISE(ABORT, 'tool confirmation transition is invalid');
   END`,
  `CREATE TRIGGER agent_execution_grants_binding_immutable_v14
   BEFORE UPDATE OF execution_id, attempt_seq, agent_id, room_id, tool_id,
     parameter_sha256, issued_at, expires_at ON agent_execution_grants
   BEGIN
     SELECT RAISE(ABORT, 'tool grant binding is immutable');
   END`,
  `CREATE TRIGGER agent_execution_grants_state_insert_v14
   BEFORE INSERT ON agent_execution_grants
   WHEN (NEW.grant_state = 'active' AND NEW.consumed_at IS NOT NULL)
     OR (NEW.grant_state = 'claimed' AND NEW.consumed_at IS NULL)
     OR (NEW.grant_state IN ('revoked', 'expired') AND NEW.consumed_at IS NOT NULL)
     OR (NEW.grant_revision > 0 AND NEW.grant_changed_at IS NULL)
   BEGIN
     SELECT RAISE(ABORT, 'tool grant state is invalid');
   END`,
  `CREATE TRIGGER agent_execution_grants_state_update_v14
   BEFORE UPDATE OF grant_state, grant_reason, grant_revision, grant_changed_at,
     consumed_at ON agent_execution_grants
   WHEN NOT (
     OLD.grant_state = 'active'
     AND NEW.grant_state IN ('claimed', 'revoked', 'expired')
     AND NEW.grant_revision = OLD.grant_revision + 1
     AND NEW.grant_changed_at IS NOT NULL
     AND (
       (NEW.grant_state = 'claimed' AND NEW.consumed_at IS NOT NULL)
       OR (NEW.grant_state IN ('revoked', 'expired') AND NEW.consumed_at IS NULL)
     )
   )
   BEGIN
     SELECT RAISE(ABORT, 'tool grant transition is invalid');
   END`,
  `CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
    capability_ceiling_json TEXT NOT NULL CHECK (
      json_valid(capability_ceiling_json) AND json_type(capability_ceiling_json) = 'array'
    ),
    tool_ceiling_json TEXT NOT NULL CHECK (
      json_valid(tool_ceiling_json) AND json_type(tool_ceiling_json) = 'array'
    )
  ) STRICT`,
  `CREATE TABLE room_agent_assignments (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('current', 'removed')),
    participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    capability_subset_json TEXT NOT NULL CHECK (
      json_valid(capability_subset_json) AND json_type(capability_subset_json) = 'array'
    ),
    tool_subset_json TEXT NOT NULL CHECK (
      json_valid(tool_subset_json) AND json_type(tool_subset_json) = 'array'
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX room_agent_assignments_one_current_agent_v14
   ON room_agent_assignments(room_id, agent_actor_id) WHERE status = 'current'`,
  `CREATE TRIGGER agent_profiles_agent_binding_insert_v14
   BEFORE INSERT ON agent_profiles
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'agent'
   BEGIN
     SELECT RAISE(ABORT, 'agent profile actor must be an Agent');
   END`,
  `CREATE TRIGGER agent_profiles_agent_binding_update_v14
   BEFORE UPDATE OF actor_id ON agent_profiles
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'agent'
   BEGIN
     SELECT RAISE(ABORT, 'agent profile actor must be an Agent');
   END`,
  `CREATE TRIGGER room_agent_assignments_authority_insert_v14
   BEFORE INSERT ON room_agent_assignments
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_actor_id), '') <> 'agent'
     OR COALESCE((SELECT actor_id FROM agent_profiles WHERE id = NEW.profile_id), '')
       <> NEW.agent_actor_id
     OR EXISTS (
       SELECT value FROM json_each(NEW.capability_subset_json)
       EXCEPT SELECT value FROM json_each((
         SELECT capability_ceiling_json FROM agent_profiles WHERE id = NEW.profile_id
       ))
     )
     OR EXISTS (
       SELECT value FROM json_each(NEW.tool_subset_json)
       EXCEPT SELECT value FROM json_each((
         SELECT tool_ceiling_json FROM agent_profiles WHERE id = NEW.profile_id
       ))
     )
   BEGIN
     SELECT RAISE(ABORT, 'Room Assignment exceeds its Agent Profile authority');
   END`,
  `CREATE TRIGGER room_agent_assignments_authority_update_v14
   BEFORE UPDATE OF profile_id, agent_actor_id, capability_subset_json, tool_subset_json
     ON room_agent_assignments
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.agent_actor_id), '') <> 'agent'
     OR COALESCE((SELECT actor_id FROM agent_profiles WHERE id = NEW.profile_id), '')
       <> NEW.agent_actor_id
     OR EXISTS (
       SELECT value FROM json_each(NEW.capability_subset_json)
       EXCEPT SELECT value FROM json_each((
         SELECT capability_ceiling_json FROM agent_profiles WHERE id = NEW.profile_id
       ))
     )
     OR EXISTS (
       SELECT value FROM json_each(NEW.tool_subset_json)
       EXCEPT SELECT value FROM json_each((
         SELECT tool_ceiling_json FROM agent_profiles WHERE id = NEW.profile_id
       ))
     )
   BEGIN
     SELECT RAISE(ABORT, 'Room Assignment exceeds its Agent Profile authority');
   END`,
  `CREATE TRIGGER agent_profiles_ceiling_update_v14
   BEFORE UPDATE OF actor_id, capability_ceiling_json, tool_ceiling_json ON agent_profiles
   WHEN EXISTS (
     SELECT 1 FROM room_agent_assignments AS assignment
     WHERE assignment.profile_id = OLD.id AND assignment.status = 'current'
       AND (
         assignment.agent_actor_id <> NEW.actor_id
         OR EXISTS (
           SELECT value FROM json_each(assignment.capability_subset_json)
           EXCEPT SELECT value FROM json_each(NEW.capability_ceiling_json)
         )
         OR EXISTS (
           SELECT value FROM json_each(assignment.tool_subset_json)
           EXCEPT SELECT value FROM json_each(NEW.tool_ceiling_json)
         )
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'Agent Profile update would exceed current Room Assignment authority');
   END`,
  `CREATE TABLE room_assignment_archive_policies (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 0),
    expansion_blocked INTEGER NOT NULL CHECK (expansion_blocked = 1),
    reduced_at TEXT NOT NULL,
    PRIMARY KEY (room_id, archive_generation),
    UNIQUE (room_id, policy_version)
  ) STRICT`,
  `CREATE TABLE room_business_timer_freeze_batches (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    suspended_at TEXT NOT NULL,
    suspended_count INTEGER NOT NULL CHECK (suspended_count >= 0),
    resumed_at TEXT,
    resumed_count INTEGER CHECK (resumed_count >= 0),
    descriptor_ids_json TEXT NOT NULL CHECK (
      json_valid(descriptor_ids_json) AND json_type(descriptor_ids_json) = 'array'
    ),
    PRIMARY KEY (room_id, archive_generation),
    CHECK ((resumed_at IS NULL) = (resumed_count IS NULL))
  ) STRICT`,
  `CREATE TABLE room_business_timer_freezes (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    descriptor_id TEXT NOT NULL CHECK (length(trim(descriptor_id)) > 0),
    timer_key TEXT NOT NULL CHECK (length(trim(timer_key)) > 0),
    source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
    original_due_at TEXT NOT NULL,
    remaining_ms INTEGER NOT NULL CHECK (remaining_ms >= 0),
    frozen_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('frozen', 'resumed', 'discarded')),
    resumed_due_at TEXT,
    resolved_at TEXT,
    PRIMARY KEY (room_id, archive_generation, timer_key),
    FOREIGN KEY (room_id, archive_generation)
      REFERENCES room_business_timer_freeze_batches(room_id, archive_generation),
    CHECK (
      (state = 'frozen' AND resumed_due_at IS NULL AND resolved_at IS NULL)
      OR (state = 'resumed' AND resumed_due_at IS NOT NULL AND resolved_at IS NOT NULL)
      OR (state = 'discarded' AND resumed_due_at IS NULL AND resolved_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX room_business_timer_freezes_latest_v14
   ON room_business_timer_freezes(
     room_id, descriptor_id, timer_key, archive_generation DESC
   )`,
  `CREATE INDEX room_business_timer_freezes_generation_state_v14
   ON room_business_timer_freezes(room_id, archive_generation, state)`,
  `CREATE TABLE project_requests (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    requester_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    target_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL CHECK (
      status IN ('pending_acceptance', 'accepted', 'rejected', 'cancelled')
    )
  ) STRICT`,
  `CREATE TABLE project_next_actions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('human', 'agent')),
    owner_actor_id TEXT NOT NULL REFERENCES actors(id),
    verifier_human_actor_id TEXT REFERENCES actors(id),
    status TEXT NOT NULL CHECK (status IN (
      'proposed', 'accepted', 'in_progress', 'delivered', 'done', 'rejected', 'cancelled'
    )),
    CHECK (owner_kind = 'human' OR verifier_human_actor_id IS NOT NULL)
  ) STRICT`,
  `CREATE TABLE project_obstacles (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('blocker', 'open_question')),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('human', 'agent')),
    owner_actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'deferred', 'cannot_answer'))
  ) STRICT`,
  `CREATE TABLE project_transfer_proposals (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    subject_kind TEXT NOT NULL CHECK (
      subject_kind IN ('next_action', 'blocker', 'open_question')
    ),
    subject_id TEXT NOT NULL,
    to_owner_kind TEXT NOT NULL CHECK (to_owner_kind IN ('human', 'agent')),
    to_owner_actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')
    )
  ) STRICT`,
  `CREATE INDEX project_requests_departure_v14
   ON project_requests(
     room_id, status, requester_human_actor_id, target_human_actor_id, id
   )`,
  `CREATE INDEX project_next_actions_departure_v14
   ON project_next_actions(
     room_id, status, owner_kind, owner_actor_id, verifier_human_actor_id, id
   )`,
  `CREATE INDEX project_obstacles_departure_v14
   ON project_obstacles(room_id, status, owner_kind, owner_actor_id, kind, id)`,
  `CREATE INDEX project_transfer_proposals_departure_v14
   ON project_transfer_proposals(
     room_id, status, to_owner_kind, to_owner_actor_id, id
   )`,
  `CREATE TRIGGER project_requests_actor_binding_insert_v14
   BEFORE INSERT ON project_requests
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_human_actor_id), '') <> 'human'
     OR COALESCE((SELECT kind FROM actors WHERE id = NEW.target_human_actor_id), '') <> 'human'
   BEGIN
     SELECT RAISE(ABORT, 'Project Request actors must be Human');
   END`,
  `CREATE TRIGGER project_requests_actor_binding_update_v14
   BEFORE UPDATE OF requester_human_actor_id, target_human_actor_id ON project_requests
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_human_actor_id), '') <> 'human'
     OR COALESCE((SELECT kind FROM actors WHERE id = NEW.target_human_actor_id), '') <> 'human'
   BEGIN
     SELECT RAISE(ABORT, 'Project Request actors must be Human');
   END`,
  `CREATE TRIGGER project_next_actions_actor_binding_insert_v14
   BEFORE INSERT ON project_next_actions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.owner_actor_id), '') <> NEW.owner_kind
     OR (NEW.verifier_human_actor_id IS NOT NULL AND
       COALESCE((SELECT kind FROM actors WHERE id = NEW.verifier_human_actor_id), '') <> 'human')
   BEGIN
     SELECT RAISE(ABORT, 'Project NextAction actors do not match their authority kinds');
   END`,
  `CREATE TRIGGER project_next_actions_actor_binding_update_v14
   BEFORE UPDATE OF owner_kind, owner_actor_id, verifier_human_actor_id ON project_next_actions
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.owner_actor_id), '') <> NEW.owner_kind
     OR (NEW.verifier_human_actor_id IS NOT NULL AND
       COALESCE((SELECT kind FROM actors WHERE id = NEW.verifier_human_actor_id), '') <> 'human')
   BEGIN
     SELECT RAISE(ABORT, 'Project NextAction actors do not match their authority kinds');
   END`,
  `CREATE TRIGGER project_obstacles_actor_binding_insert_v14
   BEFORE INSERT ON project_obstacles
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.owner_actor_id), '') <> NEW.owner_kind
   BEGIN
     SELECT RAISE(ABORT, 'Project Obstacle owner does not match its authority kind');
   END`,
  `CREATE TRIGGER project_obstacles_actor_binding_update_v14
   BEFORE UPDATE OF owner_kind, owner_actor_id ON project_obstacles
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.owner_actor_id), '') <> NEW.owner_kind
   BEGIN
     SELECT RAISE(ABORT, 'Project Obstacle owner does not match its authority kind');
   END`,
  `CREATE TRIGGER project_transfer_proposals_binding_insert_v14
   BEFORE INSERT ON project_transfer_proposals
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.to_owner_actor_id), '')
       <> NEW.to_owner_kind
     OR NOT (
       (NEW.subject_kind = 'next_action' AND EXISTS (
         SELECT 1 FROM project_next_actions
         WHERE id = NEW.subject_id AND room_id = NEW.room_id
       ))
       OR (NEW.subject_kind IN ('blocker', 'open_question') AND EXISTS (
         SELECT 1 FROM project_obstacles
         WHERE id = NEW.subject_id AND room_id = NEW.room_id AND kind = NEW.subject_kind
       ))
     )
   BEGIN
     SELECT RAISE(ABORT, 'Project TransferProposal binding is invalid');
   END`,
  `CREATE TRIGGER project_transfer_proposals_binding_update_v14
   BEFORE UPDATE OF room_id, subject_kind, subject_id, to_owner_kind, to_owner_actor_id
     ON project_transfer_proposals
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.to_owner_actor_id), '')
       <> NEW.to_owner_kind
     OR NOT (
       (NEW.subject_kind = 'next_action' AND EXISTS (
         SELECT 1 FROM project_next_actions
         WHERE id = NEW.subject_id AND room_id = NEW.room_id
       ))
       OR (NEW.subject_kind IN ('blocker', 'open_question') AND EXISTS (
         SELECT 1 FROM project_obstacles
         WHERE id = NEW.subject_id AND room_id = NEW.room_id AND kind = NEW.subject_kind
       ))
     )
   BEGIN
     SELECT RAISE(ABORT, 'Project TransferProposal binding is invalid');
   END`,
  ...ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS,
  ...ROOM_CACHE_INVALIDATION_SCHEMA_STATEMENTS,
  ...OFFLINE_READ_LEASE_SCHEMA_STATEMENTS,
] as const;

const V15_STATEMENTS = [
  `CREATE TABLE room_audit_v15 (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (
      'room.created', 'room.renamed', 'room.archived', 'room.reopened',
      'room.human.invited', 'room.invitation.accepted', 'room.invitation.rejected',
      'room.agent.configured', 'room.member.left', 'room.member.removed',
      'room.member.role.changed', 'room.ownership.transferred'
    )),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    result TEXT NOT NULL CHECK (result IN (
      'created', 'renamed', 'archived', 'reopened', 'pending', 'accepted',
      'rejected', 'configured', 'left', 'removed', 'role-changed',
      'ownership-transferred'
    )),
    timestamp TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
  ) STRICT`,
  `INSERT INTO room_audit_v15
   SELECT id, type, room_id, actor_id, result, timestamp, details_json FROM room_audit`,
  `DROP TABLE room_audit`,
  `ALTER TABLE room_audit_v15 RENAME TO room_audit`,
  `CREATE TRIGGER room_audit_v15_immutable_update
   BEFORE UPDATE ON room_audit BEGIN SELECT RAISE(ABORT, 'room audit is immutable'); END`,
  `CREATE TRIGGER room_audit_v15_immutable_delete
   BEFORE DELETE ON room_audit BEGIN SELECT RAISE(ABORT, 'room audit is immutable'); END`,
  `CREATE TABLE room_cache_invalidation_intents_v15 (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    reason TEXT NOT NULL CHECK (reason IN (
      'room_archived', 'member_removed', 'access_revoked'
    )),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    last_error_code TEXT CHECK (
      last_error_code IS NULL OR last_error_code IN ('purge_failed', 'authority_unavailable')
    ),
    target_actor_id TEXT REFERENCES actors(id),
    CHECK (
      (reason = 'room_archived' AND target_actor_id IS NULL) OR
      (reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO room_cache_invalidation_intents_v15 (
     id, room_id, lifecycle_generation, access_revision, reason,
     target_actor_id, status, attempts, available_at, created_at,
     completed_at, last_error_code
   )
   SELECT id, room_id, lifecycle_generation, access_revision, reason,
          NULL, status, attempts, available_at, created_at,
          completed_at, last_error_code
   FROM room_cache_invalidation_intents`,
  `DROP TABLE room_cache_invalidation_intents`,
  `ALTER TABLE room_cache_invalidation_intents_v15
   RENAME TO room_cache_invalidation_intents`,
  `CREATE UNIQUE INDEX room_cache_archive_invalidation_scope_v15
   ON room_cache_invalidation_intents(room_id, lifecycle_generation, reason)
   WHERE reason = 'room_archived' AND target_actor_id IS NULL`,
  `CREATE UNIQUE INDEX room_cache_target_invalidation_scope_v15
   ON room_cache_invalidation_intents(
     room_id, target_actor_id, access_revision, reason
   )
   WHERE reason IN ('member_removed', 'access_revoked')
     AND target_actor_id IS NOT NULL`,
  `CREATE INDEX room_cache_invalidation_ready
   ON room_cache_invalidation_intents(status, available_at, created_at, id)`,
  `CREATE TABLE offline_read_lease_invalidations_v15 (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
    revoked_lease_count INTEGER NOT NULL CHECK (revoked_lease_count >= 0),
    reason TEXT NOT NULL CHECK (reason IN (
      'room_archived', 'member_removed', 'access_revoked'
    )),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    target_actor_id TEXT REFERENCES actors(id),
    CHECK (
      (reason = 'room_archived' AND target_actor_id IS NULL) OR
      (reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO offline_read_lease_invalidations_v15 (
     id, room_id, lifecycle_generation, access_revision, lease_generation,
     revoked_lease_count, reason, target_actor_id, created_at
   )
   SELECT id, room_id, lifecycle_generation, access_revision, lease_generation,
          revoked_lease_count, reason, NULL, created_at
   FROM offline_read_lease_invalidations`,
  `DROP TABLE offline_read_lease_invalidations`,
  `ALTER TABLE offline_read_lease_invalidations_v15
   RENAME TO offline_read_lease_invalidations`,
  `CREATE UNIQUE INDEX offline_read_lease_archive_invalidation_scope_v15
   ON offline_read_lease_invalidations(room_id, lifecycle_generation, reason)
   WHERE reason = 'room_archived' AND target_actor_id IS NULL`,
  `CREATE UNIQUE INDEX offline_read_lease_target_invalidation_scope_v15
   ON offline_read_lease_invalidations(
     room_id, target_actor_id, access_revision, reason
   )
   WHERE reason IN ('member_removed', 'access_revoked')
     AND target_actor_id IS NOT NULL`,
] as const;

const V16_STATEMENTS = [
  `ALTER TABLE agent_executions
   ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 1
   CHECK (execution_generation >= 1)`,
  `CREATE UNIQUE INDEX messages_id_room_v16 ON messages(id, room_id)`,
  `CREATE TRIGGER messages_v16_body_immutable
   BEFORE UPDATE OF room_id, author_id, author_kind, body, sent_at ON messages
   BEGIN SELECT RAISE(ABORT, 'message source identity and body are immutable'); END`,
  `CREATE TRIGGER messages_v16_delete_immutable
   BEFORE DELETE ON messages
   BEGIN SELECT RAISE(ABORT, 'message source is immutable'); END`,
  `CREATE TABLE message_revisions (
    message_id TEXT NOT NULL REFERENCES messages(id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    body TEXT NOT NULL CHECK (length(body) > 0),
    revised_at TEXT NOT NULL CHECK (length(revised_at) > 0),
    revised_by_actor_id TEXT NOT NULL REFERENCES actors(id),
    PRIMARY KEY (message_id, revision)
  ) STRICT`,
  `INSERT INTO message_revisions (
     message_id, revision, body, revised_at, revised_by_actor_id
   )
   SELECT id, 1, body, sent_at, author_id FROM messages`,
  `CREATE TABLE message_envelopes (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    message_kind TEXT NOT NULL CHECK (
      message_kind IN ('human', 'agent-final', 'agent-correction')
    ),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'recalled')),
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    revision_count INTEGER NOT NULL CHECK (revision_count >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    recalled_at TEXT,
    recalled_by_actor_id TEXT REFERENCES actors(id),
    FOREIGN KEY (message_id, current_revision)
      REFERENCES message_revisions(message_id, revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (lifecycle = 'active' AND recalled_at IS NULL AND recalled_by_actor_id IS NULL)
      OR
      (lifecycle = 'recalled' AND message_kind = 'human'
       AND recalled_at IS NOT NULL AND recalled_by_actor_id IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO message_envelopes (
     message_id, room_id, message_kind, lifecycle, current_revision,
     revision_count, created_at, recalled_at, recalled_by_actor_id
   )
   SELECT id, room_id,
          CASE author_kind WHEN 'human' THEN 'human' ELSE 'agent-final' END,
          'active', 1, 1, sent_at, NULL, NULL
   FROM messages`,
  `CREATE UNIQUE INDEX message_envelopes_id_room_v16
   ON message_envelopes(message_id, room_id)`,
  `CREATE INDEX message_envelopes_room_created_v16
   ON message_envelopes(room_id, created_at, message_id)`,
  `CREATE INDEX message_revisions_revised_at_v16
   ON message_revisions(revised_at, message_id, revision)`,
  `CREATE TRIGGER message_revisions_v16_validate_insert
   BEFORE INSERT ON message_revisions
   WHEN length(NEW.message_id) = 0
      OR length(NEW.revised_by_actor_id) = 0
      OR COALESCE((SELECT author_id FROM messages WHERE id = NEW.message_id), '')
           <> NEW.revised_by_actor_id
      OR NEW.revision <> COALESCE((
           SELECT MAX(revision) + 1 FROM message_revisions
           WHERE message_id = NEW.message_id
         ), 1)
      OR (NEW.revision > 1 AND NOT EXISTS (
           SELECT 1 FROM message_envelopes AS envelope
           WHERE envelope.message_id = NEW.message_id
             AND envelope.message_kind = 'human'
             AND envelope.lifecycle = 'active'
             AND envelope.current_revision = NEW.revision - 1
             AND envelope.revision_count = NEW.revision - 1
         ))
   BEGIN
     SELECT RAISE(ABORT, 'message revision sequence or author is invalid');
   END`,
  `CREATE TRIGGER message_revisions_v16_immutable_update
   BEFORE UPDATE ON message_revisions
   BEGIN SELECT RAISE(ABORT, 'message revision is immutable'); END`,
  `CREATE TRIGGER message_revisions_v16_immutable_delete
   BEFORE DELETE ON message_revisions
   BEGIN SELECT RAISE(ABORT, 'message revision is immutable'); END`,
  `CREATE TRIGGER message_envelopes_v16_validate_insert
   BEFORE INSERT ON message_envelopes
   WHEN length(NEW.message_id) = 0 OR length(NEW.room_id) = 0
      OR NOT EXISTS (
        SELECT 1 FROM messages AS message
        WHERE message.id = NEW.message_id AND message.room_id = NEW.room_id
          AND ((message.author_kind = 'human' AND NEW.message_kind = 'human')
            OR (message.author_kind = 'agent'
                AND NEW.message_kind IN ('agent-final', 'agent-correction')))
      )
      OR NEW.current_revision <> NEW.revision_count
      OR NEW.current_revision <> COALESCE((
        SELECT MAX(revision) FROM message_revisions
        WHERE message_id = NEW.message_id
      ), 0)
   BEGIN
     SELECT RAISE(ABORT, 'message envelope binding is invalid');
   END`,
  `CREATE TRIGGER message_envelopes_v16_validate_update
   BEFORE UPDATE ON message_envelopes
   WHEN NEW.message_id <> OLD.message_id OR NEW.room_id <> OLD.room_id
      OR NEW.message_kind <> OLD.message_kind OR NEW.created_at <> OLD.created_at
      OR OLD.lifecycle = 'recalled'
      OR NEW.current_revision < OLD.current_revision
      OR NEW.revision_count < OLD.revision_count
      OR NEW.current_revision <> NEW.revision_count
      OR NEW.current_revision <> COALESCE((
        SELECT MAX(revision) FROM message_revisions
        WHERE message_id = NEW.message_id
      ), 0)
      OR (NEW.message_kind <> 'human'
          AND (NEW.current_revision <> OLD.current_revision
               OR NEW.lifecycle <> OLD.lifecycle))
      OR (NEW.lifecycle = 'recalled' AND (
        OLD.lifecycle <> 'active'
        OR NEW.recalled_at IS NULL OR NEW.recalled_by_actor_id IS NULL
        OR NEW.recalled_by_actor_id <> (
          SELECT author_id FROM messages WHERE id = NEW.message_id
        )
      ))
   BEGIN
     SELECT RAISE(ABORT, 'message envelope revision or recall transition is invalid');
   END`,
  `CREATE TRIGGER message_envelopes_v16_immutable_delete
   BEFORE DELETE ON message_envelopes
   BEGIN SELECT RAISE(ABORT, 'message envelope is immutable'); END`,
  `CREATE TABLE message_mentions (
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    target_kind TEXT NOT NULL CHECK (
      target_kind IN ('human-request', 'agent-invocation')
    ),
    target_actor_id TEXT NOT NULL REFERENCES actors(id),
    range_start_utf16 INTEGER NOT NULL CHECK (range_start_utf16 >= 0),
    range_end_utf16 INTEGER NOT NULL CHECK (range_end_utf16 > range_start_utf16),
    target_order INTEGER NOT NULL CHECK (target_order >= 0),
    PRIMARY KEY (message_id, target_id),
    UNIQUE (message_id, target_order),
    FOREIGN KEY (message_id, room_id)
      REFERENCES message_envelopes(message_id, room_id),
    FOREIGN KEY (message_id, target_id)
      REFERENCES message_target_outcomes(message_id, target_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE UNIQUE INDEX message_mentions_semantic_target_v16
   ON message_mentions(message_id, target_kind, target_actor_id)`,
  `CREATE UNIQUE INDEX message_mentions_outcome_binding_v16
   ON message_mentions(message_id, room_id, target_id, target_actor_id, target_kind)`,
  `CREATE UNIQUE INDEX message_mentions_actor_binding_v16
   ON message_mentions(message_id, target_id, target_actor_id)`,
  `CREATE TRIGGER message_mentions_v16_validate_insert
   BEFORE INSERT ON message_mentions
   WHEN NEW.target_order <> (
          SELECT COUNT(*) FROM message_mentions WHERE message_id = NEW.message_id
        )
      OR EXISTS (
        SELECT 1 FROM message_mentions AS existing
        WHERE existing.message_id = NEW.message_id
          AND NEW.range_start_utf16 < existing.range_end_utf16
          AND existing.range_start_utf16 < NEW.range_end_utf16
      )
      OR NOT EXISTS (
        SELECT 1 FROM message_envelopes AS envelope
        WHERE envelope.message_id = NEW.message_id
          AND envelope.room_id = NEW.room_id
          AND envelope.message_kind = 'human'
          AND envelope.lifecycle = 'active'
      )
   BEGIN
     SELECT RAISE(ABORT, 'message mention order or range overlap is invalid');
   END`,
  `CREATE TRIGGER message_mentions_v16_immutable_update
   BEFORE UPDATE ON message_mentions
   BEGIN SELECT RAISE(ABORT, 'message mention is immutable'); END`,
  `CREATE TRIGGER message_mentions_v16_immutable_delete
   BEFORE DELETE ON message_mentions
   BEGIN SELECT RAISE(ABORT, 'message mention is immutable'); END`,
  `ALTER TABLE agent_invocation_intents RENAME TO agent_invocation_intents_v6`,
  `CREATE TABLE agent_invocation_intents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    target_agent_id TEXT NOT NULL REFERENCES actors(id),
    requester_actor_id TEXT NOT NULL REFERENCES actors(id),
    intent_kind TEXT NOT NULL CHECK (
      intent_kind IN ('direct_mention', 'structured_help', 'routed_candidate')
    ),
    execution_id TEXT UNIQUE REFERENCES agent_executions(id),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    message_transaction_id TEXT,
    target_id TEXT,
    source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1),
    lineage_id TEXT,
    turn_id TEXT,
    origin_kind TEXT NOT NULL DEFAULT 'legacy_runtime' CHECK (
      origin_kind IN ('message_target', 'legacy_runtime')
    ),
    status TEXT NOT NULL DEFAULT 'claimed' CHECK (
      status IN ('pending', 'claimed', 'cancelled')
    ),
    claimed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT CHECK (
      cancellation_reason IS NULL OR cancellation_reason = 'message_recalled'
    ),
    supersedes_intent_id TEXT REFERENCES agent_invocation_intents(id),
    FOREIGN KEY (source_message_id, source_revision)
      REFERENCES message_revisions(message_id, revision),
    FOREIGN KEY (source_message_id, target_id, target_agent_id)
      REFERENCES message_mentions(message_id, target_id, target_actor_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (status = 'pending' AND claimed_at IS NULL
       AND cancelled_at IS NULL AND cancellation_reason IS NULL)
      OR
      (status = 'claimed' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
      OR
      (status = 'cancelled' AND cancelled_at IS NOT NULL
       AND cancellation_reason = 'message_recalled')
    ),
    CHECK (
      (origin_kind = 'legacy_runtime' AND target_id IS NULL
       AND message_transaction_id IS NULL)
      OR
      (origin_kind = 'message_target' AND target_id IS NOT NULL
       AND message_transaction_id IS NOT NULL AND lineage_id IS NOT NULL
       AND turn_id IS NOT NULL AND execution_id IS NULL)
    )
  ) STRICT`,
  `INSERT INTO agent_invocation_intents (
     id, room_id, source_message_id, target_agent_id, requester_actor_id,
     intent_kind, execution_id, created_at, message_transaction_id, target_id,
     source_revision, lineage_id, turn_id, origin_kind, status, claimed_at,
     cancelled_at, cancellation_reason, supersedes_intent_id
   )
   SELECT id, room_id, source_message_id, target_agent_id, requester_actor_id,
          intent_kind, execution_id, created_at, NULL, NULL, 1, id, 'legacy',
          'legacy_runtime', 'claimed', created_at, NULL, NULL, NULL
   FROM agent_invocation_intents_v6`,
  `DROP TABLE agent_invocation_intents_v6`,
  `CREATE UNIQUE INDEX agent_invocation_intents_message_target_v16
   ON agent_invocation_intents(message_transaction_id, target_id)
   WHERE origin_kind = 'message_target'`,
  `CREATE UNIQUE INDEX agent_invocation_intents_lineage_turn_v16
   ON agent_invocation_intents(lineage_id, turn_id, target_agent_id)
   WHERE lineage_id IS NOT NULL AND turn_id IS NOT NULL`,
  `CREATE UNIQUE INDEX agent_invocation_intents_outcome_binding_v16
   ON agent_invocation_intents(
     id, room_id, source_message_id, target_id, target_agent_id
   )`,
  `CREATE INDEX agent_invocation_intents_pending_v16
   ON agent_invocation_intents(status, created_at, id)`,
  `CREATE TRIGGER agent_invocation_intents_v16_validate_insert
   BEFORE INSERT ON agent_invocation_intents
   WHEN length(NEW.id) = 0 OR length(NEW.room_id) = 0
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.target_agent_id), '') <> 'agent'
      OR (NEW.origin_kind = 'message_target' AND (
        COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_actor_id), '') <> 'human'
        OR NOT EXISTS (
          SELECT 1 FROM messages AS source
          WHERE source.id = NEW.source_message_id
            AND source.room_id = NEW.room_id
            AND source.author_id = NEW.requester_actor_id
            AND source.author_kind = 'human'
        )
        OR NEW.status <> 'pending' OR NEW.execution_id IS NOT NULL
        OR NEW.intent_kind <> 'direct_mention'
        OR NEW.source_revision <> 1
        OR NEW.message_transaction_id <> NEW.source_message_id
        OR NOT EXISTS (
          SELECT 1 FROM message_mentions AS mention
          WHERE mention.message_id = NEW.source_message_id
            AND mention.target_id = NEW.target_id
            AND mention.target_kind = 'agent-invocation'
            AND mention.target_actor_id = NEW.target_agent_id
        )
      ))
      OR (NEW.origin_kind = 'legacy_runtime' AND (
        COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_actor_id), '')
          NOT IN ('human', 'agent')
        OR NOT EXISTS (
          SELECT 1
          FROM messages AS source
          JOIN actors AS requester ON requester.id = NEW.requester_actor_id
          WHERE source.id = NEW.source_message_id
            AND source.room_id = NEW.room_id
            AND source.author_id = requester.id
            AND source.author_kind = requester.kind
        )
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Agent invocation intent binding is invalid');
   END`,
  `CREATE TRIGGER agent_invocation_intents_v16_validate_update
   BEFORE UPDATE ON agent_invocation_intents
   WHEN NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id
      OR NEW.source_message_id <> OLD.source_message_id
      OR NEW.target_agent_id <> OLD.target_agent_id
      OR NEW.requester_actor_id <> OLD.requester_actor_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.message_transaction_id IS NOT OLD.message_transaction_id
      OR NEW.target_id IS NOT OLD.target_id
      OR NEW.source_revision <> OLD.source_revision
      OR NEW.lineage_id IS NOT OLD.lineage_id OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.origin_kind <> OLD.origin_kind
      OR NEW.execution_id IS NOT OLD.execution_id
      OR NEW.supersedes_intent_id IS NOT OLD.supersedes_intent_id
      OR OLD.status = 'cancelled'
      OR (OLD.status = 'claimed' AND NEW.status <> 'claimed')
   BEGIN
     SELECT RAISE(ABORT, 'Agent invocation intent binding or terminal state is immutable');
   END`,
  `CREATE TRIGGER agent_invocation_intents_v16_immutable_delete
   BEFORE DELETE ON agent_invocation_intents
   BEGIN SELECT RAISE(ABORT, 'Agent invocation intent is immutable'); END`,
  `CREATE TABLE human_request_intents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    target_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    requester_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    target_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'cancelled')),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    claimed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT CHECK (
      cancellation_reason IS NULL OR cancellation_reason = 'message_recalled'
    ),
    UNIQUE (source_message_id, target_id),
    FOREIGN KEY (source_message_id, source_revision)
      REFERENCES message_revisions(message_id, revision),
    FOREIGN KEY (source_message_id, target_id, target_human_actor_id)
      REFERENCES message_mentions(message_id, target_id, target_actor_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (status = 'pending' AND claimed_at IS NULL
       AND cancelled_at IS NULL AND cancellation_reason IS NULL)
      OR
      (status = 'claimed' AND claimed_at IS NOT NULL
       AND cancelled_at IS NULL AND cancellation_reason IS NULL)
      OR
      (status = 'cancelled' AND cancelled_at IS NOT NULL
       AND cancellation_reason = 'message_recalled')
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX human_request_intents_outcome_binding_v16
   ON human_request_intents(
     id, room_id, source_message_id, target_id, target_human_actor_id
   )`,
  `CREATE INDEX human_request_intents_pending_v16
   ON human_request_intents(status, created_at, id)`,
  `CREATE TRIGGER human_request_intents_v16_validate_insert
   BEFORE INSERT ON human_request_intents
   WHEN length(NEW.id) = 0
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.requester_human_actor_id), '') <> 'human'
      OR COALESCE((SELECT kind FROM actors WHERE id = NEW.target_human_actor_id), '') <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM messages AS source
        WHERE source.id = NEW.source_message_id
          AND source.room_id = NEW.room_id
          AND source.author_id = NEW.requester_human_actor_id
          AND source.author_kind = 'human'
      )
      OR NOT EXISTS (
        SELECT 1 FROM message_mentions AS mention
        WHERE mention.message_id = NEW.source_message_id
          AND mention.target_id = NEW.target_id
          AND mention.target_kind = 'human-request'
          AND mention.target_actor_id = NEW.target_human_actor_id
      )
   BEGIN
     SELECT RAISE(ABORT, 'Human Request intent binding is invalid');
   END`,
  `CREATE TRIGGER human_request_intents_v16_validate_update
   BEFORE UPDATE ON human_request_intents
   WHEN NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id
      OR NEW.source_message_id <> OLD.source_message_id
      OR NEW.target_id <> OLD.target_id OR NEW.source_revision <> OLD.source_revision
      OR NEW.requester_human_actor_id <> OLD.requester_human_actor_id
      OR NEW.target_human_actor_id <> OLD.target_human_actor_id
      OR NEW.created_at <> OLD.created_at OR OLD.status = 'cancelled'
      OR (OLD.status = 'claimed' AND NEW.status <> 'claimed')
   BEGIN
     SELECT RAISE(ABORT, 'Human Request intent binding or terminal state is immutable');
   END`,
  `CREATE TRIGGER human_request_intents_v16_immutable_delete
   BEFORE DELETE ON human_request_intents
   BEGIN SELECT RAISE(ABORT, 'Human Request intent is immutable'); END`,
  `CREATE TABLE message_target_outcomes (
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL REFERENCES actors(id),
    target_kind TEXT NOT NULL CHECK (
      target_kind IN ('human-request', 'agent-invocation')
    ),
    status TEXT NOT NULL CHECK (
      status IN ('request-created', 'invocation-intent-created', 'rejected')
    ),
    request_intent_id TEXT,
    invocation_intent_id TEXT,
    rejection_code TEXT CHECK (
      rejection_code IS NULL OR rejection_code IN (
        'target_not_member', 'target_kind_mismatch',
        'target_assignment_inactive', 'target_room_archived'
      )
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (message_id, target_id),
    FOREIGN KEY (message_id, room_id, target_id, target_actor_id, target_kind)
      REFERENCES message_mentions(
        message_id, room_id, target_id, target_actor_id, target_kind
      ),
    FOREIGN KEY (
      request_intent_id, room_id, message_id, target_id, target_actor_id
    )
      REFERENCES human_request_intents(
        id, room_id, source_message_id, target_id, target_human_actor_id
      ) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (
      invocation_intent_id, room_id, message_id, target_id, target_actor_id
    )
      REFERENCES agent_invocation_intents(
        id, room_id, source_message_id, target_id, target_agent_id
      ) DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (status = 'request-created' AND target_kind = 'human-request'
       AND request_intent_id IS NOT NULL AND invocation_intent_id IS NULL
       AND rejection_code IS NULL)
      OR
      (status = 'invocation-intent-created' AND target_kind = 'agent-invocation'
       AND request_intent_id IS NULL AND invocation_intent_id IS NOT NULL
       AND rejection_code IS NULL)
      OR
      (status = 'rejected' AND request_intent_id IS NULL
       AND invocation_intent_id IS NULL AND rejection_code IS NOT NULL)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX message_target_outcomes_request_binding_v16
   ON message_target_outcomes(
     message_id, room_id, target_id, target_actor_id, request_intent_id
   )`,
  `CREATE UNIQUE INDEX message_target_outcomes_invocation_binding_v16
   ON message_target_outcomes(
     message_id, room_id, target_id, target_actor_id, invocation_intent_id
   )`,
  `CREATE TRIGGER message_target_outcomes_v16_validate_insert
   BEFORE INSERT ON message_target_outcomes
   WHEN NEW.status = 'rejected' AND (
     EXISTS (
       SELECT 1 FROM human_request_intents AS intent
       WHERE intent.source_message_id = NEW.message_id
         AND intent.room_id = NEW.room_id
         AND intent.target_id = NEW.target_id
         AND intent.target_human_actor_id = NEW.target_actor_id
     )
     OR EXISTS (
       SELECT 1 FROM agent_invocation_intents AS intent
       WHERE intent.origin_kind = 'message_target'
         AND intent.source_message_id = NEW.message_id
         AND intent.room_id = NEW.room_id
         AND intent.target_id = NEW.target_id
         AND intent.target_agent_id = NEW.target_actor_id
     )
   )
   BEGIN
     SELECT RAISE(ABORT, 'rejected message target cannot retain an intent');
   END`,
  `CREATE TRIGGER human_request_intents_v16_outcome_consistency_insert
   BEFORE INSERT ON human_request_intents
   WHEN EXISTS (
     SELECT 1 FROM message_target_outcomes AS outcome
     WHERE outcome.message_id = NEW.source_message_id
       AND outcome.target_id = NEW.target_id
       AND (
         outcome.room_id <> NEW.room_id
         OR outcome.target_actor_id <> NEW.target_human_actor_id
         OR outcome.target_kind <> 'human-request'
         OR outcome.status <> 'request-created'
         OR outcome.request_intent_id <> NEW.id
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'Human Request intent outcome is already closed');
   END`,
  `CREATE TRIGGER agent_invocation_intents_v16_outcome_consistency_insert
   BEFORE INSERT ON agent_invocation_intents
   WHEN NEW.origin_kind = 'message_target' AND EXISTS (
     SELECT 1 FROM message_target_outcomes AS outcome
     WHERE outcome.message_id = NEW.source_message_id
       AND outcome.target_id = NEW.target_id
       AND (
         outcome.room_id <> NEW.room_id
         OR outcome.target_actor_id <> NEW.target_agent_id
         OR outcome.target_kind <> 'agent-invocation'
         OR outcome.status <> 'invocation-intent-created'
         OR outcome.invocation_intent_id <> NEW.id
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'Agent invocation intent outcome is already closed');
   END`,
  `CREATE INDEX message_target_outcomes_room_message_v16
   ON message_target_outcomes(room_id, message_id, target_id)`,
  `CREATE TRIGGER message_target_outcomes_v16_immutable_update
   BEFORE UPDATE ON message_target_outcomes
   BEGIN SELECT RAISE(ABORT, 'message target outcome is immutable'); END`,
  `CREATE TRIGGER message_target_outcomes_v16_immutable_delete
   BEFORE DELETE ON message_target_outcomes
   BEGIN SELECT RAISE(ABORT, 'message target outcome is immutable'); END`,
  `CREATE TABLE message_reply_links (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    reply_to_message_id TEXT NOT NULL CHECK (length(reply_to_message_id) > 0),
    FOREIGN KEY (message_id, room_id)
      REFERENCES message_envelopes(message_id, room_id),
    FOREIGN KEY (reply_to_message_id, room_id)
      REFERENCES message_envelopes(message_id, room_id)
  ) STRICT`,
  `CREATE INDEX message_reply_links_target_v16
   ON message_reply_links(room_id, reply_to_message_id, message_id)`,
  `CREATE TRIGGER message_reply_links_v16_immutable_update
   BEFORE UPDATE ON message_reply_links
   BEGIN SELECT RAISE(ABORT, 'message reply link is immutable'); END`,
  `CREATE TRIGGER message_reply_links_v16_immutable_delete
   BEFORE DELETE ON message_reply_links
   BEGIN SELECT RAISE(ABORT, 'message reply link is immutable'); END`,
  `CREATE TABLE message_attachment_links (
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL CHECK (length(attachment_id) > 0),
    operational_state TEXT NOT NULL DEFAULT 'active' CHECK (
      operational_state IN ('active', 'excluded_recalled')
    ),
    PRIMARY KEY (message_id, attachment_id),
    FOREIGN KEY (message_id, room_id)
      REFERENCES message_envelopes(message_id, room_id)
  ) STRICT`,
  `CREATE TRIGGER message_attachment_links_v16_validate_update
   BEFORE UPDATE ON message_attachment_links
   WHEN NEW.message_id <> OLD.message_id OR NEW.room_id <> OLD.room_id
      OR NEW.attachment_id <> OLD.attachment_id
      OR OLD.operational_state = 'excluded_recalled'
      OR NEW.operational_state <> 'excluded_recalled'
      OR NOT EXISTS (
        SELECT 1 FROM message_envelopes AS envelope
        WHERE envelope.message_id = NEW.message_id
          AND envelope.lifecycle = 'recalled'
      )
   BEGIN
     SELECT RAISE(ABORT, 'message attachment binding is immutable');
   END`,
  `CREATE TRIGGER message_attachment_links_v16_immutable_delete
   BEFORE DELETE ON message_attachment_links
   BEGIN SELECT RAISE(ABORT, 'message attachment link is immutable'); END`,
  `CREATE TABLE agent_execution_intent_links (
    intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id),
    execution_ordinal INTEGER NOT NULL CHECK (execution_ordinal >= 1),
    retry_of_execution_id TEXT REFERENCES agent_executions(id),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    linked_at TEXT NOT NULL CHECK (length(linked_at) > 0),
    PRIMARY KEY (intent_id, execution_ordinal)
  ) STRICT`,
  `INSERT INTO agent_execution_intent_links (
     intent_id, execution_id, execution_ordinal, retry_of_execution_id,
     source_revision, linked_at
   )
   SELECT id, execution_id, 1, NULL, source_revision, created_at
   FROM agent_invocation_intents WHERE execution_id IS NOT NULL`,
  `CREATE INDEX agent_execution_intent_links_intent_ordinal_v16
   ON agent_execution_intent_links(intent_id, execution_ordinal, execution_id)`,
  `CREATE TRIGGER agent_execution_intent_links_v16_validate_insert
   BEFORE INSERT ON agent_execution_intent_links
   WHEN NEW.execution_ordinal <> COALESCE((
          SELECT MAX(execution_ordinal) + 1 FROM agent_execution_intent_links
          WHERE intent_id = NEW.intent_id
        ), 1)
      OR NOT EXISTS (
        SELECT 1 FROM agent_invocation_intents AS intent
        JOIN agent_executions AS execution ON execution.id = NEW.execution_id
        WHERE intent.id = NEW.intent_id
          AND intent.room_id = execution.room_id
          AND intent.target_agent_id = execution.agent_id
          AND intent.source_message_id = execution.trigger_message_id
          AND intent.source_revision = NEW.source_revision
      )
   BEGIN
     SELECT RAISE(ABORT, 'Agent execution intent lineage is invalid');
   END`,
  `CREATE TRIGGER agent_execution_intent_links_v16_immutable_update
   BEFORE UPDATE ON agent_execution_intent_links
   BEGIN SELECT RAISE(ABORT, 'Agent execution intent lineage is immutable'); END`,
  `CREATE TRIGGER agent_execution_intent_links_v16_immutable_delete
   BEFORE DELETE ON agent_execution_intent_links
   BEGIN SELECT RAISE(ABORT, 'Agent execution intent lineage is immutable'); END`,
  `CREATE TABLE message_recall_fences (
    fence_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES message_envelopes(message_id),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    scope_kind TEXT NOT NULL CHECK (
      scope_kind IN ('message', 'invocation-intent', 'execution')
    ),
    invocation_intent_id TEXT REFERENCES agent_invocation_intents(id),
    execution_id TEXT REFERENCES agent_executions(id),
    reason TEXT NOT NULL CHECK (reason = 'message_recalled'),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    FOREIGN KEY (source_message_id, source_revision)
      REFERENCES message_revisions(message_id, revision),
    CHECK (
      (scope_kind = 'message' AND invocation_intent_id IS NULL AND execution_id IS NULL)
      OR
      (scope_kind = 'invocation-intent'
       AND invocation_intent_id IS NOT NULL AND execution_id IS NULL)
      OR
      (scope_kind = 'execution'
       AND invocation_intent_id IS NOT NULL AND execution_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX message_recall_fences_message_scope_v16
   ON message_recall_fences(source_message_id)
   WHERE scope_kind = 'message'`,
  `CREATE UNIQUE INDEX message_recall_fences_intent_scope_v16
   ON message_recall_fences(source_message_id, invocation_intent_id)
   WHERE scope_kind = 'invocation-intent'`,
  `CREATE UNIQUE INDEX message_recall_fences_execution_scope_v16
   ON message_recall_fences(source_message_id, invocation_intent_id, execution_id)
   WHERE scope_kind = 'execution'`,
  `CREATE TRIGGER message_recall_fences_v16_validate_insert
   BEFORE INSERT ON message_recall_fences
   WHEN length(NEW.fence_id) = 0
      OR NOT EXISTS (
        SELECT 1 FROM message_envelopes AS envelope
        WHERE envelope.message_id = NEW.source_message_id
          AND envelope.room_id = NEW.room_id
          AND envelope.message_kind = 'human'
          AND envelope.lifecycle = 'active'
          AND envelope.current_revision = NEW.source_revision
      )
      OR (NEW.invocation_intent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_invocation_intents AS intent
        WHERE intent.id = NEW.invocation_intent_id
          AND intent.room_id = NEW.room_id
          AND intent.source_message_id = NEW.source_message_id
      ))
      OR (NEW.execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_execution_intent_links AS link
        WHERE link.intent_id = NEW.invocation_intent_id
          AND link.execution_id = NEW.execution_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'message recall fence scope is invalid');
   END`,
  `CREATE TRIGGER message_recall_fences_v16_immutable_update
   BEFORE UPDATE ON message_recall_fences
   BEGIN SELECT RAISE(ABORT, 'message recall fence is immutable'); END`,
  `CREATE TRIGGER message_recall_fences_v16_immutable_delete
   BEFORE DELETE ON message_recall_fences
   BEGIN SELECT RAISE(ABORT, 'message recall fence is immutable'); END`,
  `CREATE TRIGGER message_envelopes_v16_recall_fence_update
   BEFORE UPDATE OF lifecycle ON message_envelopes
   WHEN NEW.lifecycle = 'recalled' AND (
     NOT EXISTS (
       SELECT 1 FROM message_recall_fences AS fence
       WHERE fence.source_message_id = NEW.message_id
         AND fence.source_revision = NEW.current_revision
         AND fence.scope_kind = 'message'
     )
     OR EXISTS (
       SELECT 1 FROM human_request_intents AS intent
       WHERE intent.source_message_id = NEW.message_id AND intent.status = 'pending'
     )
     OR EXISTS (
       SELECT 1 FROM agent_invocation_intents AS intent
       WHERE intent.source_message_id = NEW.message_id AND intent.status = 'pending'
     )
   )
   BEGIN
     SELECT RAISE(ABORT, 'message recall requires a durable fence and cancelled pending intents');
   END`,
  `CREATE UNIQUE INDEX agent_executions_result_message_binding_v16
   ON agent_executions(id, result_message_id)`,
  `CREATE TABLE agent_message_sources (
    message_id TEXT PRIMARY KEY REFERENCES message_envelopes(message_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    invocation_intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
    source_message_id TEXT NOT NULL REFERENCES message_envelopes(message_id),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    committed_at TEXT NOT NULL CHECK (length(committed_at) > 0),
    UNIQUE (execution_id),
    FOREIGN KEY (source_message_id, source_revision)
      REFERENCES message_revisions(message_id, revision),
    FOREIGN KEY (execution_id, message_id)
      REFERENCES agent_executions(id, result_message_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TRIGGER agent_message_sources_v16_validate_insert
   BEFORE INSERT ON agent_message_sources
   WHEN NOT EXISTS (
     SELECT 1
     FROM message_envelopes AS output
     JOIN messages AS output_message ON output_message.id = output.message_id
     JOIN agent_invocation_intents AS intent ON intent.id = NEW.invocation_intent_id
     JOIN agent_execution_intent_links AS link
       ON link.intent_id = intent.id AND link.execution_id = NEW.execution_id
     JOIN agent_executions AS execution ON execution.id = link.execution_id
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = NEW.attempt_seq
     JOIN message_envelopes AS source ON source.message_id = NEW.source_message_id
     WHERE output.message_id = NEW.message_id
       AND output.room_id = NEW.room_id
       AND output.message_kind IN ('agent-final', 'agent-correction')
       AND output_message.author_kind = 'agent'
       AND output_message.author_id = intent.target_agent_id
       AND intent.room_id = NEW.room_id
       AND intent.source_message_id = NEW.source_message_id
       AND intent.source_revision = NEW.source_revision
       AND intent.status = 'claimed'
       AND execution.status = 'running'
       AND execution.current_attempt_seq = NEW.attempt_seq
       AND execution.execution_generation = NEW.execution_generation
       AND attempt.status = 'running'
       AND source.lifecycle = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM message_recall_fences AS fence
         WHERE fence.source_message_id = NEW.source_message_id
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'Agent message source lineage or recall fence is invalid');
   END`,
  `CREATE TRIGGER agent_executions_v16_final_cas_update
   BEFORE UPDATE OF status, result_message_id, current_attempt_seq,
                    execution_generation ON agent_executions
   WHEN (OLD.result_message_id IS NOT NULL AND (
          NEW.result_message_id IS NOT OLD.result_message_id
          OR NEW.status <> OLD.status
          OR NEW.current_attempt_seq <> OLD.current_attempt_seq
          OR NEW.execution_generation <> OLD.execution_generation
        ))
      OR (NEW.result_message_id IS NOT NULL AND (
        NEW.status <> 'completed'
        OR NOT EXISTS (
          SELECT 1 FROM agent_message_sources AS source
          WHERE source.execution_id = NEW.id
            AND source.message_id = NEW.result_message_id
            AND source.attempt_seq = NEW.current_attempt_seq
            AND source.execution_generation = NEW.execution_generation
        )
        OR NOT EXISTS (
          SELECT 1 FROM agent_execution_attempts AS attempt
          WHERE attempt.execution_id = NEW.id
            AND attempt.attempt_seq = NEW.current_attempt_seq
            AND attempt.status = 'completed'
        )
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Agent final terminal CAS is invalid');
   END`,
  `CREATE TRIGGER agent_message_sources_v16_immutable_update
   BEFORE UPDATE ON agent_message_sources
   BEGIN SELECT RAISE(ABORT, 'Agent message source is immutable'); END`,
  `CREATE TRIGGER agent_message_sources_v16_immutable_delete
   BEFORE DELETE ON agent_message_sources
   BEGIN SELECT RAISE(ABORT, 'Agent message source is immutable'); END`,
  `CREATE TABLE agent_message_corrections (
    correction_message_id TEXT PRIMARY KEY REFERENCES message_envelopes(message_id),
    corrects_message_id TEXT NOT NULL REFERENCES message_envelopes(message_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    CHECK (correction_message_id <> corrects_message_id)
  ) STRICT`,
  `CREATE INDEX agent_message_corrections_source_v16
   ON agent_message_corrections(room_id, corrects_message_id, correction_message_id)`,
  `CREATE TRIGGER agent_message_corrections_v16_validate_insert
   BEFORE INSERT ON agent_message_corrections
   WHEN NOT EXISTS (
     SELECT 1
     FROM message_envelopes AS correction
     JOIN messages AS correction_message ON correction_message.id = correction.message_id
     JOIN message_envelopes AS original ON original.message_id = NEW.corrects_message_id
     JOIN messages AS original_message ON original_message.id = original.message_id
     WHERE correction.message_id = NEW.correction_message_id
       AND correction.room_id = NEW.room_id
       AND correction.message_kind = 'agent-correction'
       AND original.room_id = NEW.room_id
       AND original.message_kind = 'agent-final'
       AND correction_message.author_id = NEW.agent_actor_id
       AND original_message.author_id = NEW.agent_actor_id
       AND correction_message.author_kind = 'agent'
       AND original_message.author_kind = 'agent'
   )
   BEGIN
     SELECT RAISE(ABORT, 'Agent correction must append for the same Agent final');
   END`,
  `CREATE TRIGGER agent_message_corrections_v16_immutable_update
   BEFORE UPDATE ON agent_message_corrections
   BEGIN SELECT RAISE(ABORT, 'Agent correction lineage is immutable'); END`,
  `CREATE TRIGGER agent_message_corrections_v16_immutable_delete
   BEFORE DELETE ON agent_message_corrections
   BEGIN SELECT RAISE(ABORT, 'Agent correction lineage is immutable'); END`,
] as const;

const V17_STATEMENTS = [
  `CREATE TABLE attachment_uploads (
    upload_id TEXT PRIMARY KEY CHECK (length(trim(upload_id)) BETWEEN 1 AND 128),
    upload_key TEXT NOT NULL CHECK (length(trim(upload_key)) BETWEEN 1 AND 128),
    canonical_input_sha256 TEXT NOT NULL CHECK (
      length(canonical_input_sha256) = 64
      AND canonical_input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    uploader_actor_id TEXT NOT NULL REFERENCES actors(id),
    session_family_id TEXT NOT NULL REFERENCES session_families(family_id),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    expected_bytes INTEGER NOT NULL CHECK (
      expected_bytes > 0 AND expected_bytes <= 52428800
    ),
    received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
      received_bytes >= 0 AND received_bytes <= expected_bytes
    ),
    expected_sha256 TEXT NOT NULL CHECK (
      length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    original_filename TEXT NOT NULL CHECK (
      length(trim(original_filename)) BETWEEN 1 AND 255
      AND instr(original_filename, '/') = 0
      AND instr(original_filename, char(92)) = 0
    ),
    declared_mime TEXT CHECK (
      declared_mime IS NULL OR length(trim(declared_mime)) BETWEEN 1 AND 255
    ),
    format_hint TEXT NOT NULL CHECK (
      format_hint IN ('pdf', 'png', 'jpeg', 'docx', 'xlsx', 'txt', 'csv')
    ),
    status TEXT NOT NULL CHECK (
      status IN ('open', 'finalizing', 'accepted', 'cancelled', 'expired', 'rejected')
    ),
    terminal_reason_code TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    idle_expires_at TEXT NOT NULL CHECK (length(idle_expires_at) > 0),
    absolute_expires_at TEXT NOT NULL CHECK (length(absolute_expires_at) > 0),
    UNIQUE (uploader_actor_id, room_id, upload_key),
    CHECK (
      (status IN ('open', 'finalizing', 'accepted') AND terminal_reason_code IS NULL)
      OR (status = 'cancelled' AND terminal_reason_code = 'upload_cancelled')
      OR (status = 'expired' AND terminal_reason_code = 'upload_expired')
      OR (status = 'rejected' AND terminal_reason_code IN (
        'attachment_too_large', 'attachment_type_unsupported', 'type_mismatch',
        'hash_mismatch', 'attachment_malformed'
      ))
    )
  ) STRICT`,
  `CREATE INDEX attachment_uploads_active_v17
   ON attachment_uploads(
     room_id, uploader_actor_id, status, absolute_expires_at, upload_id
   )`,
  `CREATE TRIGGER attachment_uploads_v17_validate_insert
   BEFORE INSERT ON attachment_uploads
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.uploader_actor_id), '') <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM session_families AS family
        WHERE family.family_id = NEW.session_family_id
          AND family.actor_id = NEW.uploader_actor_id
          AND family.revoked_at IS NULL
      )
      OR NOT EXISTS (
        SELECT 1
        FROM rooms AS room
        JOIN room_memberships AS membership
          ON membership.room_id = room.id
         AND membership.actor_id = NEW.uploader_actor_id
         AND membership.kind = 'human'
        LEFT JOIN room_access_authority AS access ON access.room_id = room.id
        WHERE room.id = NEW.room_id
          AND room.status = 'active'
          AND room.archive_generation = NEW.lifecycle_generation
          AND CASE
                WHEN access.access_revision IS NULL
                  OR membership.access_revision > access.access_revision
                THEN membership.access_revision
                ELSE access.access_revision
              END = NEW.access_revision
      )
      OR NEW.received_bytes <> 0 OR NEW.status <> 'open'
      OR NEW.terminal_reason_code IS NOT NULL
   BEGIN
     SELECT RAISE(ABORT, 'attachment upload authority is invalid');
   END`,
  `CREATE TRIGGER attachment_uploads_v17_validate_update
   BEFORE UPDATE ON attachment_uploads
   WHEN NEW.upload_id <> OLD.upload_id OR NEW.upload_key <> OLD.upload_key
      OR NEW.canonical_input_sha256 <> OLD.canonical_input_sha256
      OR NEW.room_id <> OLD.room_id OR NEW.uploader_actor_id <> OLD.uploader_actor_id
      OR NEW.session_family_id <> OLD.session_family_id
      OR NEW.access_revision <> OLD.access_revision
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation
      OR NEW.expected_bytes <> OLD.expected_bytes
      OR NEW.expected_sha256 <> OLD.expected_sha256
      OR NEW.original_filename <> OLD.original_filename
      OR NEW.declared_mime IS NOT OLD.declared_mime OR NEW.format_hint <> OLD.format_hint
      OR NEW.created_at <> OLD.created_at OR NEW.idle_expires_at <> OLD.idle_expires_at
      OR NEW.absolute_expires_at <> OLD.absolute_expires_at
      OR NEW.received_bytes < OLD.received_bytes
      OR (NEW.received_bytes <> OLD.received_bytes AND (
        OLD.status <> 'open' OR NEW.status <> 'open'
        OR NEW.received_bytes <> COALESCE((
          SELECT MAX(byte_offset + byte_length)
          FROM attachment_upload_chunks WHERE upload_id = OLD.upload_id
        ), 0)
      ))
      OR (NEW.status = OLD.status
        AND NEW.terminal_reason_code IS NOT OLD.terminal_reason_code)
      OR NOT (
        (NEW.status = OLD.status)
        OR (OLD.status = 'open' AND NEW.status IN (
          'finalizing', 'cancelled', 'expired', 'rejected'
        ))
        OR (OLD.status = 'finalizing' AND NEW.status IN (
          'accepted', 'cancelled', 'rejected'
        ))
      )
      OR (OLD.status = 'open' AND NEW.status = 'finalizing' AND NOT EXISTS (
        SELECT 1
        FROM session_families AS family
        JOIN rooms AS room ON room.id = NEW.room_id
        JOIN room_memberships AS membership
          ON membership.room_id = room.id
         AND membership.actor_id = NEW.uploader_actor_id
         AND membership.kind = 'human'
        LEFT JOIN room_access_authority AS access ON access.room_id = room.id
        WHERE family.family_id = NEW.session_family_id
          AND family.actor_id = NEW.uploader_actor_id
          AND family.revoked_at IS NULL
          AND room.status = 'active'
          AND room.archive_generation = NEW.lifecycle_generation
          AND CASE
                WHEN access.access_revision IS NULL
                  OR membership.access_revision > access.access_revision
                THEN membership.access_revision
                ELSE access.access_revision
              END = NEW.access_revision
      ))
      OR (NEW.status = 'finalizing' AND NEW.received_bytes <> NEW.expected_bytes)
      OR (NEW.status = 'accepted' AND NOT EXISTS (
        SELECT 1 FROM attachments WHERE source_upload_id = NEW.upload_id
      ))
   BEGIN
     SELECT RAISE(ABORT, 'attachment upload transition is invalid');
   END`,
  `CREATE TRIGGER attachment_uploads_v17_immutable_delete
   BEFORE DELETE ON attachment_uploads
   BEGIN SELECT RAISE(ABORT, 'attachment upload authority is immutable'); END`,
  `CREATE TABLE attachment_upload_chunks (
    upload_id TEXT NOT NULL REFERENCES attachment_uploads(upload_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 1600),
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 32768),
    chunk_sha256 TEXT NOT NULL CHECK (
      length(chunk_sha256) = 64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    part_object_key TEXT NOT NULL UNIQUE CHECK (
      length(part_object_key) BETWEEN 1 AND 200
      AND instr(part_object_key, '/') = 0
      AND instr(part_object_key, char(92)) = 0
      AND instr(part_object_key, '..') = 0
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (upload_id, ordinal),
    UNIQUE (upload_id, byte_offset)
  ) STRICT`,
  `CREATE INDEX attachment_upload_chunks_offset_v17
   ON attachment_upload_chunks(upload_id, byte_offset, ordinal)`,
  `CREATE TRIGGER attachment_upload_chunks_v17_validate_insert
   BEFORE INSERT ON attachment_upload_chunks
   WHEN NOT EXISTS (
     SELECT 1
     FROM attachment_uploads AS upload
     JOIN session_families AS family ON family.family_id = upload.session_family_id
     JOIN rooms AS room ON room.id = upload.room_id
     JOIN room_memberships AS membership
       ON membership.room_id = room.id
      AND membership.actor_id = upload.uploader_actor_id
      AND membership.kind = 'human'
     LEFT JOIN room_access_authority AS access ON access.room_id = room.id
     WHERE upload.upload_id = NEW.upload_id
       AND upload.status = 'open'
       AND family.actor_id = upload.uploader_actor_id
       AND family.revoked_at IS NULL
       AND room.status = 'active'
       AND room.archive_generation = upload.lifecycle_generation
       AND CASE
             WHEN access.access_revision IS NULL
               OR membership.access_revision > access.access_revision
             THEN membership.access_revision
             ELSE access.access_revision
           END = upload.access_revision
       AND NEW.ordinal = COALESCE((
         SELECT MAX(chunk.ordinal) + 1
         FROM attachment_upload_chunks AS chunk
         WHERE chunk.upload_id = NEW.upload_id
       ), 0)
       AND NEW.byte_offset = upload.received_bytes
       AND NEW.byte_offset + NEW.byte_length <= upload.expected_bytes
   )
   BEGIN
     SELECT RAISE(ABORT, 'attachment upload chunk sequence is invalid');
   END`,
  `CREATE TRIGGER attachment_upload_chunks_v17_checkpoint_insert
   AFTER INSERT ON attachment_upload_chunks
   BEGIN
     UPDATE attachment_uploads
     SET received_bytes = NEW.byte_offset + NEW.byte_length,
         updated_at = NEW.created_at
     WHERE upload_id = NEW.upload_id;
   END`,
  `CREATE TRIGGER attachment_upload_chunks_v17_immutable_update
   BEFORE UPDATE ON attachment_upload_chunks
   BEGIN SELECT RAISE(ABORT, 'attachment upload chunk is immutable'); END`,
  `CREATE TRIGGER attachment_upload_chunks_v17_immutable_delete
   BEFORE DELETE ON attachment_upload_chunks
   BEGIN SELECT RAISE(ABORT, 'attachment upload chunk is immutable'); END`,
  `CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY CHECK (length(trim(attachment_id)) BETWEEN 1 AND 128),
    source_upload_id TEXT NOT NULL UNIQUE REFERENCES attachment_uploads(upload_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    uploader_actor_id TEXT NOT NULL REFERENCES actors(id),
    original_filename TEXT NOT NULL CHECK (
      length(trim(original_filename)) BETWEEN 1 AND 255
      AND instr(original_filename, '/') = 0
      AND instr(original_filename, char(92)) = 0
    ),
    declared_mime TEXT CHECK (
      declared_mime IS NULL OR length(trim(declared_mime)) BETWEEN 1 AND 255
    ),
    detected_mime TEXT NOT NULL CHECK (length(trim(detected_mime)) BETWEEN 1 AND 255),
    format TEXT NOT NULL CHECK (
      format IN ('pdf', 'png', 'jpeg', 'docx', 'xlsx', 'txt', 'csv')
    ),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    quarantine_object_key TEXT NOT NULL UNIQUE CHECK (
      length(quarantine_object_key) BETWEEN 1 AND 200
      AND instr(quarantine_object_key, '/') = 0
      AND instr(quarantine_object_key, char(92)) = 0
      AND instr(quarantine_object_key, '..') = 0
    ),
    object_key TEXT CHECK (
      object_key IS NULL OR (
        length(object_key) BETWEEN 1 AND 200
        AND instr(object_key, '/') = 0
        AND instr(object_key, char(92)) = 0
        AND instr(object_key, '..') = 0
      )
    ),
    processing_status TEXT NOT NULL CHECK (processing_status IN (
      'quarantined', 'scanning', 'extracting', 'ocr', 'ready',
      'retryable-failed', 'nonretryable-failed', 'malware-rejected', 'cancelled'
    )),
    processing_generation INTEGER NOT NULL CHECK (processing_generation >= 1),
    failure_code TEXT,
    source_message_id TEXT,
    source_operational_state TEXT NOT NULL CHECK (
      source_operational_state IN ('unbound', 'bound-active', 'excluded-recalled')
    ),
    source_bound_at TEXT,
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    ready_at TEXT,
    UNIQUE (attachment_id, room_id),
    FOREIGN KEY (source_message_id, room_id)
      REFERENCES message_envelopes(message_id, room_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (format = 'pdf' AND detected_mime = 'application/pdf')
      OR (format = 'png' AND detected_mime = 'image/png')
      OR (format = 'jpeg' AND detected_mime = 'image/jpeg')
      OR (format = 'docx' AND detected_mime =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      OR (format = 'xlsx' AND detected_mime =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      OR (format = 'txt' AND detected_mime = 'text/plain')
      OR (format = 'csv' AND detected_mime = 'text/csv')
    ),
    CHECK (
      (processing_status IN ('quarantined', 'scanning', 'extracting', 'ocr')
        AND failure_code IS NULL AND object_key IS NULL AND ready_at IS NULL)
      OR (processing_status = 'ready' AND failure_code IS NULL
        AND object_key IS NOT NULL AND ready_at IS NOT NULL)
      OR (processing_status IN (
          'retryable-failed', 'nonretryable-failed', 'malware-rejected', 'cancelled'
        ) AND length(trim(failure_code)) > 0 AND object_key IS NULL AND ready_at IS NULL)
    ),
    CHECK (processing_status <> 'malware-rejected' OR failure_code = 'malware_detected'),
    CHECK (
      (source_operational_state = 'unbound'
        AND source_message_id IS NULL AND source_bound_at IS NULL)
      OR (source_operational_state IN ('bound-active', 'excluded-recalled')
        AND processing_status = 'ready'
        AND source_message_id IS NOT NULL AND source_bound_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX attachments_room_source_v17
   ON attachments(room_id, source_operational_state, source_message_id, attachment_id)`,
  `CREATE INDEX attachments_processing_v17
   ON attachments(processing_status, processing_generation, updated_at, attachment_id)`,
  `CREATE TRIGGER attachments_v17_validate_insert
   BEFORE INSERT ON attachments
   WHEN NEW.processing_status <> 'quarantined' OR NEW.processing_generation <> 1
      OR NEW.source_operational_state <> 'unbound' OR NEW.source_message_id IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
        FROM attachment_uploads AS upload
        JOIN rooms AS room ON room.id = upload.room_id
        JOIN room_memberships AS membership
          ON membership.room_id = upload.room_id
         AND membership.actor_id = upload.uploader_actor_id
         AND membership.kind = 'human'
        LEFT JOIN room_access_authority AS access ON access.room_id = room.id
        WHERE upload.upload_id = NEW.source_upload_id
          AND upload.status = 'finalizing'
          AND upload.room_id = NEW.room_id
          AND upload.uploader_actor_id = NEW.uploader_actor_id
          AND upload.original_filename = NEW.original_filename
          AND upload.declared_mime IS NEW.declared_mime
          AND upload.format_hint = NEW.format
          AND upload.expected_bytes = NEW.byte_size
          AND upload.received_bytes = upload.expected_bytes
          AND upload.expected_sha256 = NEW.sha256
          AND upload.lifecycle_generation = NEW.lifecycle_generation
          AND upload.access_revision = NEW.access_revision
          AND room.status = 'active'
          AND room.archive_generation = NEW.lifecycle_generation
          AND CASE
                WHEN access.access_revision IS NULL
                  OR membership.access_revision > access.access_revision
                THEN membership.access_revision
                ELSE access.access_revision
              END = NEW.access_revision
      )
   BEGIN
     SELECT RAISE(ABORT, 'attachment finalize authority is invalid');
   END`,
  `CREATE TRIGGER attachments_v17_validate_update
   BEFORE UPDATE ON attachments
   WHEN NEW.attachment_id <> OLD.attachment_id
      OR NEW.source_upload_id <> OLD.source_upload_id
      OR NEW.room_id <> OLD.room_id OR NEW.uploader_actor_id <> OLD.uploader_actor_id
      OR NEW.original_filename <> OLD.original_filename
      OR NEW.declared_mime IS NOT OLD.declared_mime
      OR NEW.detected_mime <> OLD.detected_mime OR NEW.format <> OLD.format
      OR NEW.byte_size <> OLD.byte_size OR NEW.sha256 <> OLD.sha256
      OR NEW.quarantine_object_key <> OLD.quarantine_object_key
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation
      OR NEW.access_revision <> OLD.access_revision OR NEW.created_at <> OLD.created_at
      OR (OLD.object_key IS NOT NULL AND NEW.object_key IS NOT OLD.object_key)
      OR NOT (
        NEW.processing_status = OLD.processing_status
        OR (OLD.processing_status = 'quarantined'
          AND NEW.processing_status IN ('scanning', 'cancelled'))
        OR (OLD.processing_status = 'scanning' AND NEW.processing_status IN (
          'extracting', 'ocr', 'retryable-failed', 'nonretryable-failed',
          'malware-rejected', 'cancelled'
        ))
        OR (OLD.processing_status = 'extracting' AND NEW.processing_status IN (
          'ocr', 'ready', 'retryable-failed', 'nonretryable-failed', 'cancelled'
        ))
        OR (OLD.processing_status = 'ocr' AND NEW.processing_status IN (
          'ready', 'retryable-failed', 'nonretryable-failed', 'cancelled'
        ))
        OR (OLD.processing_status = 'retryable-failed'
          AND NEW.processing_status = 'quarantined')
      )
      OR (NEW.processing_status <> OLD.processing_status
        AND NEW.processing_status <> 'cancelled' AND NOT EXISTS (
          SELECT 1
          FROM rooms AS room
          JOIN room_memberships AS membership
            ON membership.room_id = room.id
           AND membership.actor_id = NEW.uploader_actor_id
           AND membership.kind = 'human'
          LEFT JOIN room_access_authority AS access ON access.room_id = room.id
          WHERE room.id = NEW.room_id
            AND room.status = 'active'
            AND room.archive_generation = NEW.lifecycle_generation
            AND CASE
                  WHEN access.access_revision IS NULL
                    OR membership.access_revision > access.access_revision
                  THEN membership.access_revision
                  ELSE access.access_revision
                END = NEW.access_revision
        ))
      OR (
        ((OLD.processing_status = 'retryable-failed'
            AND NEW.processing_status = 'quarantined')
          OR (OLD.processing_status <> 'cancelled'
            AND NEW.processing_status = 'cancelled'))
        AND NEW.processing_generation <> OLD.processing_generation + 1
      )
      OR (
        NOT ((OLD.processing_status = 'retryable-failed'
            AND NEW.processing_status = 'quarantined')
          OR (OLD.processing_status <> 'cancelled'
            AND NEW.processing_status = 'cancelled'))
        AND NEW.processing_generation <> OLD.processing_generation
      )
      OR (NEW.processing_status = OLD.processing_status
        AND NEW.failure_code IS NOT OLD.failure_code)
      OR (NEW.processing_status <> OLD.processing_status
        AND NEW.processing_status <> 'malware-rejected' AND EXISTS (
          SELECT 1 FROM attachment_processing_attempts AS attempt
          WHERE attempt.attachment_id = NEW.attachment_id
            AND attempt.processing_generation = NEW.processing_generation
            AND attempt.adapter_kind = 'scanner'
            AND attempt.status = 'malware-rejected'
        ))
      OR (NEW.processing_status = 'ready' AND OLD.processing_status <> 'ready' AND (
        NOT EXISTS (
          SELECT 1 FROM attachment_processing_attempts AS attempt
          WHERE attempt.attachment_id = NEW.attachment_id
            AND attempt.processing_generation = NEW.processing_generation
            AND attempt.adapter_kind = 'scanner' AND attempt.status = 'succeeded'
        )
        OR NOT EXISTS (
          SELECT 1 FROM attachment_processing_attempts AS attempt
          WHERE attempt.attachment_id = NEW.attachment_id
            AND attempt.processing_generation = NEW.processing_generation
            AND attempt.adapter_kind IN ('extractor', 'ocr')
            AND attempt.status = 'succeeded'
        )
        OR NOT EXISTS (
          SELECT 1 FROM attachment_extraction_artifacts AS artifact
          WHERE artifact.attachment_id = NEW.attachment_id
            AND artifact.processing_generation = NEW.processing_generation
        )
        OR EXISTS (
          SELECT 1 FROM attachment_processing_attempts AS attempt
          WHERE attempt.attachment_id = NEW.attachment_id
            AND attempt.processing_generation = NEW.processing_generation
            AND attempt.adapter_kind = 'scanner'
            AND attempt.status = 'malware-rejected'
        )
      ))
      OR (NEW.processing_status = 'malware-rejected'
        AND OLD.processing_status <> 'malware-rejected' AND NOT EXISTS (
          SELECT 1 FROM attachment_processing_attempts AS attempt
          WHERE attempt.attachment_id = NEW.attachment_id
            AND attempt.processing_generation = OLD.processing_generation
            AND attempt.adapter_kind = 'scanner'
            AND attempt.status = 'malware-rejected'
        ))
      OR NOT (
        (NEW.source_message_id IS OLD.source_message_id
          AND NEW.source_operational_state = OLD.source_operational_state
          AND NEW.source_bound_at IS OLD.source_bound_at)
        OR (OLD.source_operational_state = 'unbound'
          AND NEW.source_operational_state = 'bound-active'
          AND NEW.source_message_id IS NOT NULL AND NEW.source_bound_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM message_attachment_links AS link
            WHERE link.message_id = NEW.source_message_id
              AND link.room_id = NEW.room_id
              AND link.attachment_id = NEW.attachment_id
              AND link.operational_state = 'active'
          ))
        OR (OLD.source_operational_state = 'bound-active'
          AND NEW.source_operational_state = 'excluded-recalled'
          AND NEW.source_message_id = OLD.source_message_id
          AND NEW.source_bound_at = OLD.source_bound_at
          AND EXISTS (
            SELECT 1
            FROM message_attachment_links AS link
            JOIN message_envelopes AS envelope ON envelope.message_id = link.message_id
            WHERE link.message_id = NEW.source_message_id
              AND link.attachment_id = NEW.attachment_id
              AND link.operational_state = 'excluded_recalled'
              AND envelope.lifecycle = 'recalled'
          ))
      )
   BEGIN
     SELECT RAISE(ABORT, 'attachment processing or source transition is invalid');
   END`,
  `CREATE TRIGGER attachments_v17_immutable_delete
   BEFORE DELETE ON attachments
   BEGIN SELECT RAISE(ABORT, 'attachment authority is immutable'); END`,
  `CREATE TABLE attachment_processing_attempts (
    attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
    processing_generation INTEGER NOT NULL CHECK (processing_generation >= 1),
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('scanner', 'extractor', 'ocr')),
    adapter_name TEXT NOT NULL CHECK (length(trim(adapter_name)) BETWEEN 1 AND 128),
    adapter_version TEXT NOT NULL CHECK (length(trim(adapter_version)) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'succeeded', 'retryable-failed',
      'nonretryable-failed', 'malware-rejected', 'cancelled'
    )),
    failure_code TEXT,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0 AND timeout_ms <= 300000),
    stdout_limit_bytes INTEGER NOT NULL CHECK (
      stdout_limit_bytes >= 0 AND stdout_limit_bytes <= 8388608
    ),
    stderr_limit_bytes INTEGER NOT NULL CHECK (
      stderr_limit_bytes >= 0 AND stderr_limit_bytes <= 65536
    ),
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (attachment_id, processing_generation, attempt_number),
    CHECK (status <> 'malware-rejected' OR adapter_kind = 'scanner'),
    CHECK (
      (status = 'queued' AND failure_code IS NULL
        AND started_at IS NULL AND finished_at IS NULL)
      OR (status = 'running' AND failure_code IS NULL
        AND started_at IS NOT NULL AND finished_at IS NULL)
      OR (status = 'succeeded' AND failure_code IS NULL
        AND started_at IS NOT NULL AND finished_at IS NOT NULL)
      OR (status IN (
          'retryable-failed', 'nonretryable-failed', 'malware-rejected'
        ) AND length(trim(failure_code)) > 0
        AND started_at IS NOT NULL AND finished_at IS NOT NULL)
      OR (status = 'cancelled' AND failure_code = 'cancelled'
        AND finished_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX attachment_processing_attempts_status_v17
   ON attachment_processing_attempts(
     status, adapter_kind, attachment_id, processing_generation, attempt_number
   )`,
  `CREATE TRIGGER attachment_processing_attempts_v17_validate_insert
   BEFORE INSERT ON attachment_processing_attempts
   WHEN NOT EXISTS (
     SELECT 1 FROM attachments AS attachment
     WHERE attachment.attachment_id = NEW.attachment_id
       AND attachment.processing_generation = NEW.processing_generation
       AND attachment.processing_status NOT IN (
         'ready', 'nonretryable-failed', 'malware-rejected', 'cancelled'
       )
       AND NEW.attempt_number = COALESCE((
         SELECT MAX(attempt.attempt_number) + 1
         FROM attachment_processing_attempts AS attempt
         WHERE attempt.attachment_id = NEW.attachment_id
           AND attempt.processing_generation = NEW.processing_generation
       ), 1)
       AND (
         (NEW.adapter_kind = 'scanner'
           AND attachment.processing_status IN ('quarantined', 'scanning'))
         OR (NEW.adapter_kind = 'extractor'
           AND attachment.processing_status IN ('scanning', 'extracting'))
         OR (NEW.adapter_kind = 'ocr'
           AND attachment.processing_status IN ('scanning', 'extracting', 'ocr'))
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'attachment processing attempt authority is invalid');
   END`,
  `CREATE TRIGGER attachment_processing_attempts_v17_validate_update
   BEFORE UPDATE ON attachment_processing_attempts
   WHEN NEW.attachment_id <> OLD.attachment_id
      OR NEW.processing_generation <> OLD.processing_generation
      OR NEW.attempt_number <> OLD.attempt_number
      OR NEW.adapter_kind <> OLD.adapter_kind OR NEW.adapter_name <> OLD.adapter_name
      OR NEW.adapter_version <> OLD.adapter_version OR NEW.timeout_ms <> OLD.timeout_ms
      OR NEW.stdout_limit_bytes <> OLD.stdout_limit_bytes
      OR NEW.stderr_limit_bytes <> OLD.stderr_limit_bytes
      OR NOT EXISTS (
        SELECT 1 FROM attachments AS attachment
        WHERE attachment.attachment_id = NEW.attachment_id
          AND attachment.processing_generation = NEW.processing_generation
          AND attachment.processing_status NOT IN (
            'ready', 'nonretryable-failed', 'malware-rejected', 'cancelled'
          )
      )
      OR NOT (
        (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN (
          'succeeded', 'retryable-failed', 'nonretryable-failed',
          'malware-rejected', 'cancelled'
        ))
      )
   BEGIN
     SELECT RAISE(ABORT, 'attachment processing attempt transition is invalid');
   END`,
  `CREATE TRIGGER attachment_processing_attempts_v17_immutable_delete
   BEFORE DELETE ON attachment_processing_attempts
   BEGIN SELECT RAISE(ABORT, 'attachment processing attempt is immutable'); END`,
  `CREATE TABLE attachment_extraction_artifacts (
    artifact_id TEXT PRIMARY KEY CHECK (length(trim(artifact_id)) BETWEEN 1 AND 128),
    attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
    processing_generation INTEGER NOT NULL CHECK (processing_generation >= 1),
    method TEXT NOT NULL CHECK (
      method IN ('extracted-text', 'ocr-text', 'table-text')
    ),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) BETWEEN 1 AND 128),
    tool_version TEXT NOT NULL CHECK (length(trim(tool_version)) BETWEEN 1 AND 128),
    object_key TEXT NOT NULL CHECK (
      length(object_key) BETWEEN 1 AND 200
      AND instr(object_key, '/') = 0
      AND instr(object_key, char(92)) = 0
      AND instr(object_key, '..') = 0
    ),
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 8388608),
    page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1),
    page_end INTEGER CHECK (page_end IS NULL OR page_end >= page_start),
    range_start INTEGER CHECK (range_start IS NULL OR range_start >= 0),
    range_end INTEGER CHECK (range_end IS NULL OR range_end >= range_start),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    UNIQUE (attachment_id, processing_generation, method, object_key),
    CHECK ((page_start IS NULL) = (page_end IS NULL)),
    CHECK ((range_start IS NULL) = (range_end IS NULL))
  ) STRICT`,
  `CREATE INDEX attachment_extraction_artifacts_source_v17
   ON attachment_extraction_artifacts(
     attachment_id, processing_generation, method, artifact_id
   )`,
  `CREATE TRIGGER attachment_extraction_artifacts_v17_validate_insert
   BEFORE INSERT ON attachment_extraction_artifacts
   WHEN NOT EXISTS (
     SELECT 1 FROM attachments AS attachment
     WHERE attachment.attachment_id = NEW.attachment_id
       AND attachment.processing_generation = NEW.processing_generation
       AND (
         (NEW.method IN ('extracted-text', 'table-text')
           AND attachment.processing_status = 'extracting'
           AND EXISTS (
             SELECT 1 FROM attachment_processing_attempts AS attempt
             WHERE attempt.attachment_id = NEW.attachment_id
               AND attempt.processing_generation = NEW.processing_generation
               AND attempt.adapter_kind = 'extractor' AND attempt.status = 'succeeded'
           ))
         OR (NEW.method = 'ocr-text' AND attachment.processing_status = 'ocr'
           AND EXISTS (
             SELECT 1 FROM attachment_processing_attempts AS attempt
             WHERE attempt.attachment_id = NEW.attachment_id
               AND attempt.processing_generation = NEW.processing_generation
               AND attempt.adapter_kind = 'ocr' AND attempt.status = 'succeeded'
           ))
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'attachment extraction provenance is invalid');
   END`,
  `CREATE TRIGGER attachment_extraction_artifacts_v17_immutable_update
   BEFORE UPDATE ON attachment_extraction_artifacts
   BEGIN SELECT RAISE(ABORT, 'attachment extraction provenance is immutable'); END`,
  `CREATE TRIGGER attachment_extraction_artifacts_v17_immutable_delete
   BEFORE DELETE ON attachment_extraction_artifacts
   BEGIN SELECT RAISE(ABORT, 'attachment extraction provenance is immutable'); END`,
  `CREATE UNIQUE INDEX message_attachment_links_attachment_v17
   ON message_attachment_links(attachment_id)`,
  `CREATE TRIGGER message_attachment_links_v17_validate_insert
   BEFORE INSERT ON message_attachment_links
   WHEN NEW.operational_state <> 'active' OR NOT EXISTS (
     SELECT 1
     FROM attachments AS attachment
     JOIN rooms AS room ON room.id = attachment.room_id
     JOIN room_memberships AS membership
       ON membership.room_id = attachment.room_id
      AND membership.actor_id = attachment.uploader_actor_id
      AND membership.kind = 'human'
     LEFT JOIN room_access_authority AS access ON access.room_id = room.id
     JOIN message_envelopes AS envelope
       ON envelope.message_id = NEW.message_id AND envelope.room_id = NEW.room_id
     JOIN messages AS message ON message.id = envelope.message_id
     WHERE attachment.attachment_id = NEW.attachment_id
       AND attachment.room_id = NEW.room_id
       AND attachment.processing_status = 'ready'
       AND attachment.source_operational_state = 'unbound'
       AND attachment.source_message_id IS NULL
       AND envelope.message_kind = 'human' AND envelope.lifecycle = 'active'
       AND message.author_kind = 'human'
       AND message.author_id = attachment.uploader_actor_id
       AND room.status = 'active'
       AND room.archive_generation = attachment.lifecycle_generation
       AND CASE
             WHEN access.access_revision IS NULL
               OR membership.access_revision > access.access_revision
             THEN membership.access_revision
             ELSE access.access_revision
           END = attachment.access_revision
   )
   BEGIN
     SELECT RAISE(ABORT, 'message attachment source binding is invalid');
   END`,
  `CREATE TRIGGER message_attachment_links_v17_bind_source
   AFTER INSERT ON message_attachment_links
   BEGIN
     UPDATE attachments
     SET source_message_id = NEW.message_id,
         source_operational_state = 'bound-active',
         source_bound_at = (
           SELECT created_at FROM message_envelopes WHERE message_id = NEW.message_id
         ),
         updated_at = (
           SELECT created_at FROM message_envelopes WHERE message_id = NEW.message_id
         )
     WHERE attachment_id = NEW.attachment_id;
   END`,
  `CREATE TRIGGER message_attachment_links_v17_exclude_source
   AFTER UPDATE OF operational_state ON message_attachment_links
   WHEN OLD.operational_state = 'active' AND NEW.operational_state = 'excluded_recalled'
   BEGIN
     UPDATE attachments
     SET source_operational_state = 'excluded-recalled',
         updated_at = COALESCE((
           SELECT recalled_at FROM message_envelopes WHERE message_id = NEW.message_id
         ), updated_at)
     WHERE attachment_id = NEW.attachment_id
       AND source_message_id = NEW.message_id;
   END`,
] as const;

const V18_STATEMENTS = [
  `CREATE TABLE room_memory_stewards (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    steward_id TEXT NOT NULL UNIQUE CHECK (length(steward_id) BETWEEN 1 AND 256),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    memory_watermark INTEGER NOT NULL DEFAULT 0 CHECK (memory_watermark >= 0),
    corpus_head INTEGER NOT NULL DEFAULT 0 CHECK (corpus_head >= 0),
    health TEXT NOT NULL CHECK (
      health IN ('healthy', 'catching_up', 'noauth', 'degraded', 'failed')
    ),
    health_reason_code TEXT CHECK (
      health_reason_code IS NULL OR length(trim(health_reason_code)) BETWEEN 1 AND 128
    ),
    recovery_generation INTEGER NOT NULL DEFAULT 1 CHECK (recovery_generation >= 1),
    last_attempt_at TEXT,
    retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
    recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    CHECK (memory_watermark <= corpus_head),
    CHECK (
      (health = 'healthy' AND memory_watermark = corpus_head
        AND health_reason_code IS NULL AND recovery_required = 0)
      OR (health = 'catching_up' AND memory_watermark < corpus_head
        AND recovery_required = 0)
      OR (health IN ('noauth', 'degraded', 'failed')
        AND health_reason_code IS NOT NULL)
    ),
    CHECK (health <> 'failed' OR recovery_required = 1)
  ) STRICT`,
  `CREATE TRIGGER room_memory_stewards_v18_validate_insert
   BEFORE INSERT ON room_memory_stewards
   WHEN NEW.steward_id <> 'room-memory-steward:' || NEW.room_id
      OR EXISTS (SELECT 1 FROM actors WHERE id = NEW.steward_id)
      OR NOT EXISTS (
        SELECT 1 FROM rooms
        WHERE id = NEW.room_id AND archive_generation = NEW.lifecycle_generation
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory steward identity is invalid');
   END`,
  `CREATE TRIGGER room_memory_stewards_v18_validate_update
   BEFORE UPDATE ON room_memory_stewards
   WHEN NEW.room_id <> OLD.room_id OR NEW.steward_id <> OLD.steward_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.lifecycle_generation < OLD.lifecycle_generation
      OR NEW.lifecycle_generation <> COALESCE((
        SELECT archive_generation FROM rooms WHERE id = OLD.room_id
      ), -1)
      OR NEW.memory_watermark < OLD.memory_watermark
      OR NEW.corpus_head < OLD.corpus_head
      OR NEW.corpus_head > OLD.corpus_head + 1
      OR NEW.corpus_head <> COALESCE((
        SELECT MAX(corpus_seq) FROM room_memory_sources WHERE room_id = OLD.room_id
      ), 0)
      OR NEW.recovery_generation < OLD.recovery_generation
      OR NEW.recovery_generation > OLD.recovery_generation + 1
      OR (NEW.memory_watermark > OLD.memory_watermark AND NOT EXISTS (
        SELECT 1 FROM room_memory_jobs AS job
        WHERE job.room_id = OLD.room_id
          AND job.recovery_generation = NEW.recovery_generation
          AND job.from_watermark_exclusive = OLD.memory_watermark
          AND job.to_corpus_seq_inclusive = NEW.memory_watermark
          AND job.status = 'completed'
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Room memory steward checkpoint is invalid');
   END`,
  `CREATE TRIGGER room_memory_stewards_v18_immutable_delete
   BEFORE DELETE ON room_memory_stewards
   BEGIN SELECT RAISE(ABORT, 'Room memory steward is immutable'); END`,
  `CREATE TABLE room_memory_sources (
    room_id TEXT NOT NULL REFERENCES room_memory_stewards(room_id),
    corpus_seq INTEGER NOT NULL CHECK (corpus_seq >= 1),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message', 'message_revision', 'message_tombstone',
      'attachment_extraction', 'project_fact_checkpoint'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    server_stream_seq INTEGER NOT NULL CHECK (server_stream_seq >= 1),
    eligibility TEXT NOT NULL CHECK (eligibility IN (
      'eligible', 'excluded_recalled', 'excluded_revised', 'excluded_revoked',
      'excluded_unbound', 'excluded_unsafe', 'unavailable'
    )),
    availability TEXT NOT NULL CHECK (availability IN (
      'readable', 'tombstone', 'metadata_only', 'temporarily_unavailable'
    )),
    source_actor_id TEXT REFERENCES actors(id),
    safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
      json_valid(safe_metadata_json)
      AND json_type(safe_metadata_json) = 'object'
      AND length(CAST(safe_metadata_json AS BLOB)) <= 4096
    ),
    read_reference TEXT NOT NULL CHECK (
      length(trim(read_reference)) BETWEEN 1 AND 512
      AND instr(read_reference, '://') = 0
      AND instr(read_reference, '/') = 0
      AND instr(read_reference, char(92)) = 0
      AND instr(read_reference, '..') = 0
    ),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    PRIMARY KEY (room_id, source_kind, source_id, source_revision),
    UNIQUE (room_id, corpus_seq),
    CHECK (eligibility <> 'eligible' OR availability = 'readable')
  ) STRICT`,
  `CREATE INDEX room_memory_sources_eligibility_v18
   ON room_memory_sources(room_id, eligibility, availability, corpus_seq)`,
  `CREATE TRIGGER room_memory_sources_v18_validate_insert
   BEFORE INSERT ON room_memory_sources
   WHEN NEW.corpus_seq <> COALESCE((
     SELECT corpus_head + 1 FROM room_memory_stewards WHERE room_id = NEW.room_id
   ), -1)
   BEGIN
     SELECT RAISE(ABORT, 'Room memory corpus sequence is not contiguous');
   END`,
  `CREATE TRIGGER room_memory_sources_v18_validate_update
   BEFORE UPDATE ON room_memory_sources
   WHEN NEW.room_id <> OLD.room_id OR NEW.corpus_seq <> OLD.corpus_seq
      OR NEW.source_kind <> OLD.source_kind OR NEW.source_id <> OLD.source_id
      OR NEW.source_revision <> OLD.source_revision
      OR NEW.server_stream_seq <> OLD.server_stream_seq
      OR NEW.source_actor_id IS NOT OLD.source_actor_id
      OR NEW.safe_metadata_json <> OLD.safe_metadata_json
      OR NEW.read_reference <> OLD.read_reference
      OR NEW.occurred_at <> OLD.occurred_at
      OR (NEW.eligibility = OLD.eligibility AND NEW.availability = OLD.availability)
   BEGIN
     SELECT RAISE(ABORT, 'Room memory source identity is immutable');
   END`,
  `CREATE TRIGGER room_memory_sources_v18_immutable_delete
   BEFORE DELETE ON room_memory_sources
   BEGIN SELECT RAISE(ABORT, 'Room memory source identity is immutable'); END`,
  `CREATE TABLE room_memory_source_transitions (
    transition_id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    from_eligibility TEXT CHECK (from_eligibility IS NULL OR from_eligibility IN (
      'eligible', 'excluded_recalled', 'excluded_revised', 'excluded_revoked',
      'excluded_unbound', 'excluded_unsafe', 'unavailable'
    )),
    to_eligibility TEXT NOT NULL CHECK (to_eligibility IN (
      'eligible', 'excluded_recalled', 'excluded_revised', 'excluded_revoked',
      'excluded_unbound', 'excluded_unsafe', 'unavailable'
    )),
    from_availability TEXT CHECK (from_availability IS NULL OR from_availability IN (
      'readable', 'tombstone', 'metadata_only', 'temporarily_unavailable'
    )),
    to_availability TEXT NOT NULL CHECK (to_availability IN (
      'readable', 'tombstone', 'metadata_only', 'temporarily_unavailable'
    )),
    reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 128),
    transitioned_at TEXT NOT NULL CHECK (length(transitioned_at) > 0),
    FOREIGN KEY (room_id, source_kind, source_id, source_revision)
      REFERENCES room_memory_sources(room_id, source_kind, source_id, source_revision)
  ) STRICT`,
  `CREATE TRIGGER room_memory_source_transitions_v18_validate_insert
   BEFORE INSERT ON room_memory_source_transitions
   WHEN NOT EXISTS (
     SELECT 1 FROM room_memory_sources AS source
     WHERE source.room_id = NEW.room_id
       AND source.source_kind = NEW.source_kind
       AND source.source_id = NEW.source_id
       AND source.source_revision = NEW.source_revision
       AND source.eligibility = NEW.to_eligibility
       AND source.availability = NEW.to_availability
   )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory source transition is invalid');
   END`,
  `CREATE TRIGGER room_memory_source_transitions_v18_immutable_update
   BEFORE UPDATE ON room_memory_source_transitions
   BEGIN SELECT RAISE(ABORT, 'Room memory source transition is immutable'); END`,
  `CREATE TRIGGER room_memory_source_transitions_v18_immutable_delete
   BEFORE DELETE ON room_memory_source_transitions
   BEGIN SELECT RAISE(ABORT, 'Room memory source transition is immutable'); END`,
  `CREATE TRIGGER room_memory_sources_v18_audit_insert
   AFTER INSERT ON room_memory_sources
   BEGIN
     INSERT INTO room_memory_source_transitions (
       room_id, source_kind, source_id, source_revision,
       from_eligibility, to_eligibility, from_availability, to_availability,
       reason_code, transitioned_at
     ) VALUES (
       NEW.room_id, NEW.source_kind, NEW.source_id, NEW.source_revision,
       NULL, NEW.eligibility, NULL, NEW.availability, 'indexed', NEW.occurred_at
     );
   END`,
  `CREATE TRIGGER room_memory_sources_v18_audit_update
   AFTER UPDATE OF eligibility, availability ON room_memory_sources
   BEGIN
     INSERT INTO room_memory_source_transitions (
       room_id, source_kind, source_id, source_revision,
       from_eligibility, to_eligibility, from_availability, to_availability,
       reason_code, transitioned_at
     ) VALUES (
       NEW.room_id, NEW.source_kind, NEW.source_id, NEW.source_revision,
       OLD.eligibility, NEW.eligibility, OLD.availability, NEW.availability,
       NEW.eligibility, NEW.updated_at
     );
   END`,
  `CREATE TRIGGER room_memory_sources_v18_advance_head
   AFTER INSERT ON room_memory_sources
   BEGIN
     UPDATE room_memory_stewards
     SET corpus_head = NEW.corpus_seq,
         health = CASE WHEN health = 'healthy' THEN 'catching_up' ELSE health END,
         updated_at = NEW.updated_at
     WHERE room_id = NEW.room_id;
   END`,
  `CREATE TABLE room_memory_jobs (
    job_id TEXT PRIMARY KEY CHECK (length(trim(job_id)) BETWEEN 1 AND 256),
    room_id TEXT NOT NULL REFERENCES room_memory_stewards(room_id),
    recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 1),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    from_watermark_exclusive INTEGER NOT NULL CHECK (from_watermark_exclusive >= 0),
    to_corpus_seq_inclusive INTEGER NOT NULL CHECK (
      to_corpus_seq_inclusive > from_watermark_exclusive
    ),
    source_count INTEGER NOT NULL CHECK (source_count BETWEEN 1 AND 32),
    frozen_sources_json TEXT NOT NULL CHECK (
      json_valid(frozen_sources_json)
      AND json_type(frozen_sources_json) = 'array'
      AND json_array_length(frozen_sources_json) = source_count
      AND length(CAST(frozen_sources_json AS BLOB)) <= 65536
    ),
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled'
    )),
    current_attempt INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt BETWEEN 0 AND 3),
    available_at TEXT NOT NULL CHECK (length(available_at) > 0),
    claimed_at TEXT,
    completed_at TEXT,
    last_error_code TEXT CHECK (
      last_error_code IS NULL OR length(trim(last_error_code)) BETWEEN 1 AND 128
    ),
    result_sha256 TEXT CHECK (
      result_sha256 IS NULL OR (
        length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    UNIQUE (room_id, recovery_generation, from_watermark_exclusive, to_corpus_seq_inclusive),
    CHECK (source_count = to_corpus_seq_inclusive - from_watermark_exclusive),
    CHECK (
      (status = 'queued' AND current_attempt = 0 AND claimed_at IS NULL
        AND completed_at IS NULL AND last_error_code IS NULL AND result_sha256 IS NULL)
      OR (status = 'running' AND current_attempt BETWEEN 1 AND 3
        AND claimed_at IS NOT NULL AND completed_at IS NULL
        AND last_error_code IS NULL AND result_sha256 IS NULL)
      OR (status = 'retry_wait' AND current_attempt BETWEEN 1 AND 2
        AND claimed_at IS NOT NULL AND completed_at IS NULL
        AND last_error_code IS NOT NULL AND result_sha256 IS NULL)
      OR (status = 'completed' AND current_attempt BETWEEN 1 AND 3
        AND claimed_at IS NOT NULL AND completed_at IS NOT NULL
        AND last_error_code IS NULL AND result_sha256 IS NOT NULL)
      OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL
        AND last_error_code IS NOT NULL AND result_sha256 IS NULL)
    )
  ) STRICT`,
  `CREATE INDEX room_memory_jobs_recovery_v18
   ON room_memory_jobs(status, available_at, room_id, recovery_generation)`,
  `CREATE TRIGGER room_memory_jobs_v18_validate_insert
   BEFORE INSERT ON room_memory_jobs
   WHEN NEW.status <> 'queued' OR NEW.current_attempt <> 0
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_stewards AS steward
        JOIN rooms AS room ON room.id = steward.room_id
        WHERE steward.room_id = NEW.room_id
          AND steward.recovery_generation = NEW.recovery_generation
          AND steward.lifecycle_generation = NEW.lifecycle_generation
          AND steward.memory_watermark = NEW.from_watermark_exclusive
          AND steward.corpus_head >= NEW.to_corpus_seq_inclusive
          AND room.status = 'active'
          AND room.archive_generation = NEW.lifecycle_generation
      )
      OR (SELECT COUNT(*) FROM room_memory_sources AS source
          WHERE source.room_id = NEW.room_id
            AND source.corpus_seq > NEW.from_watermark_exclusive
            AND source.corpus_seq <= NEW.to_corpus_seq_inclusive) <> NEW.source_count
      OR EXISTS (
        SELECT 1 FROM room_memory_jobs AS job
        WHERE job.room_id = NEW.room_id
          AND job.recovery_generation = NEW.recovery_generation
          AND job.status IN ('queued', 'running', 'retry_wait')
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory job claim range or generation is invalid');
   END`,
  `CREATE TRIGGER room_memory_jobs_v18_validate_update
   BEFORE UPDATE ON room_memory_jobs
   WHEN NEW.job_id <> OLD.job_id OR NEW.room_id <> OLD.room_id
      OR NEW.recovery_generation <> OLD.recovery_generation
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation
      OR NEW.from_watermark_exclusive <> OLD.from_watermark_exclusive
      OR NEW.to_corpus_seq_inclusive <> OLD.to_corpus_seq_inclusive
      OR NEW.source_count <> OLD.source_count
      OR NEW.frozen_sources_json <> OLD.frozen_sources_json
      OR NEW.created_at <> OLD.created_at
      OR NEW.current_attempt < OLD.current_attempt
      OR NEW.current_attempt > OLD.current_attempt + 1
      OR NEW.recovery_generation <> COALESCE((
        SELECT recovery_generation FROM room_memory_stewards WHERE room_id = OLD.room_id
      ), -1)
      OR NOT (
        (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN (
          'retry_wait', 'completed', 'failed', 'cancelled'
        ))
        OR (OLD.status = 'retry_wait' AND NEW.status IN ('running', 'failed', 'cancelled'))
      )
      OR (NEW.status = 'running' AND NOT EXISTS (
        SELECT 1 FROM room_memory_attempts AS attempt
        WHERE attempt.job_id = OLD.job_id
          AND attempt.recovery_generation = OLD.recovery_generation
          AND attempt.attempt_number = NEW.current_attempt
          AND attempt.status = 'running'
      ))
      OR (NEW.status = 'completed' AND NOT EXISTS (
        SELECT 1 FROM room_memory_attempts AS attempt
        WHERE attempt.job_id = OLD.job_id
          AND attempt.recovery_generation = OLD.recovery_generation
          AND attempt.attempt_number = NEW.current_attempt
          AND attempt.status = 'succeeded'
          AND attempt.output_sha256 = NEW.result_sha256
      ))
      OR (NEW.status = 'retry_wait' AND NOT EXISTS (
        SELECT 1 FROM room_memory_attempts AS attempt
        WHERE attempt.job_id = OLD.job_id
          AND attempt.attempt_number = NEW.current_attempt
          AND attempt.status = 'retryable_failed'
          AND attempt.error_code = NEW.last_error_code
      ))
      OR (NEW.status = 'failed' AND NOT EXISTS (
        SELECT 1 FROM room_memory_attempts AS attempt
        WHERE attempt.job_id = OLD.job_id
          AND attempt.attempt_number = NEW.current_attempt
          AND attempt.status IN ('retryable_failed', 'terminal_failed')
          AND attempt.error_code = NEW.last_error_code
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Room memory job transition or generation is invalid');
   END`,
  `CREATE TRIGGER room_memory_jobs_v18_immutable_delete
   BEFORE DELETE ON room_memory_jobs
   BEGIN SELECT RAISE(ABORT, 'Room memory job is immutable'); END`,
  `CREATE TABLE room_memory_attempts (
    attempt_id TEXT PRIMARY KEY CHECK (length(trim(attempt_id)) BETWEEN 1 AND 256),
    job_id TEXT NOT NULL REFERENCES room_memory_jobs(job_id),
    room_id TEXT NOT NULL REFERENCES room_memory_stewards(room_id),
    recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 1),
    attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
    status TEXT NOT NULL CHECK (status IN (
      'running', 'succeeded', 'retryable_failed', 'terminal_failed', 'cancelled'
    )),
    input_sha256 TEXT NOT NULL CHECK (
      length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    output_sha256 TEXT CHECK (
      output_sha256 IS NULL OR (
        length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    error_code TEXT CHECK (
      error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 128
    ),
    started_at TEXT NOT NULL CHECK (length(started_at) > 0),
    finished_at TEXT,
    available_at TEXT NOT NULL CHECK (length(available_at) > 0),
    UNIQUE (job_id, attempt_number),
    CHECK (
      (status = 'running' AND output_sha256 IS NULL
        AND error_code IS NULL AND finished_at IS NULL)
      OR (status = 'succeeded' AND output_sha256 IS NOT NULL
        AND error_code IS NULL AND finished_at IS NOT NULL)
      OR (status IN ('retryable_failed', 'terminal_failed', 'cancelled')
        AND output_sha256 IS NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX room_memory_attempts_job_v18
   ON room_memory_attempts(job_id, attempt_number, status)`,
  `CREATE TRIGGER room_memory_attempts_v18_validate_insert
   BEFORE INSERT ON room_memory_attempts
   WHEN NEW.status <> 'running'
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_jobs AS job
        JOIN room_memory_stewards AS steward ON steward.room_id = job.room_id
        WHERE job.job_id = NEW.job_id
          AND job.room_id = NEW.room_id
          AND job.recovery_generation = NEW.recovery_generation
          AND steward.recovery_generation = NEW.recovery_generation
          AND job.status IN ('queued', 'retry_wait')
          AND NEW.attempt_number = job.current_attempt + 1
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory attempt sequence or generation is invalid');
   END`,
  `CREATE TRIGGER room_memory_attempts_v18_begin_job
   AFTER INSERT ON room_memory_attempts
   BEGIN
     UPDATE room_memory_jobs
     SET status = 'running', current_attempt = NEW.attempt_number,
         claimed_at = NEW.started_at, last_error_code = NULL,
         available_at = NEW.available_at, updated_at = NEW.started_at
     WHERE job_id = NEW.job_id;
   END`,
  `CREATE TRIGGER room_memory_attempts_v18_validate_update
   BEFORE UPDATE ON room_memory_attempts
   WHEN NEW.attempt_id <> OLD.attempt_id OR NEW.job_id <> OLD.job_id
      OR NEW.room_id <> OLD.room_id
      OR NEW.recovery_generation <> OLD.recovery_generation
      OR NEW.attempt_number <> OLD.attempt_number
      OR NEW.input_sha256 <> OLD.input_sha256
      OR NEW.started_at <> OLD.started_at OR NEW.available_at <> OLD.available_at
      OR OLD.status <> 'running'
      OR NEW.status NOT IN ('succeeded', 'retryable_failed', 'terminal_failed', 'cancelled')
      OR NEW.recovery_generation <> COALESCE((
        SELECT recovery_generation FROM room_memory_stewards WHERE room_id = OLD.room_id
      ), -1)
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_jobs AS job
        WHERE job.job_id = OLD.job_id
          AND job.room_id = OLD.room_id
          AND job.recovery_generation = OLD.recovery_generation
          AND job.current_attempt = OLD.attempt_number
          AND job.status = 'running'
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory attempt result is late or invalid');
   END`,
  `CREATE TRIGGER room_memory_attempts_v18_immutable_delete
   BEFORE DELETE ON room_memory_attempts
   BEGIN SELECT RAISE(ABORT, 'Room memory attempt is immutable'); END`,
  `CREATE TABLE room_memory_records (
    memory_record_id TEXT PRIMARY KEY CHECK (
      length(trim(memory_record_id)) BETWEEN 1 AND 256
    ),
    room_id TEXT NOT NULL REFERENCES room_memory_stewards(room_id),
    kind TEXT NOT NULL CHECK (kind IN (
      'goal', 'decision', 'context', 'next_action', 'open_question_or_blocker'
    )),
    dedupe_key TEXT NOT NULL CHECK (
      length(dedupe_key) BETWEEN 1 AND 128
      AND dedupe_key NOT GLOB '*[^ -~]*'
    ),
    current_version_id TEXT,
    current_version_number INTEGER NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    UNIQUE (room_id, memory_record_id),
    UNIQUE (room_id, kind, dedupe_key),
    CHECK (
      (current_version_number = 0 AND current_version_id IS NULL)
      OR (current_version_number >= 1 AND current_version_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX room_memory_records_projection_v18
   ON room_memory_records(room_id, kind, current_version_number, memory_record_id)`,
  `CREATE TRIGGER room_memory_records_v18_validate_insert
   BEFORE INSERT ON room_memory_records
   WHEN NEW.current_version_id IS NOT NULL OR NEW.current_version_number <> 0
   BEGIN
     SELECT RAISE(ABORT, 'Room memory record must begin without a current version');
   END`,
  `CREATE TRIGGER room_memory_records_v18_validate_update
   BEFORE UPDATE ON room_memory_records
   WHEN NEW.memory_record_id <> OLD.memory_record_id OR NEW.room_id <> OLD.room_id
      OR NEW.kind <> OLD.kind OR NEW.dedupe_key <> OLD.dedupe_key
      OR NEW.created_at <> OLD.created_at
      OR NEW.current_version_number <> OLD.current_version_number + 1
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_versions AS version
        WHERE version.memory_version_id = NEW.current_version_id
          AND version.memory_record_id = OLD.memory_record_id
          AND version.room_id = OLD.room_id
          AND version.kind = OLD.kind
          AND version.version_number = NEW.current_version_number
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory record version pointer is invalid');
   END`,
  `CREATE TRIGGER room_memory_records_v18_immutable_delete
   BEFORE DELETE ON room_memory_records
   BEGIN SELECT RAISE(ABORT, 'Room memory record is immutable'); END`,
  `CREATE TABLE room_memory_versions (
    memory_version_id TEXT PRIMARY KEY CHECK (
      length(trim(memory_version_id)) BETWEEN 1 AND 256
    ),
    memory_record_id TEXT NOT NULL REFERENCES room_memory_records(memory_record_id),
    room_id TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    kind TEXT NOT NULL CHECK (kind IN (
      'goal', 'decision', 'context', 'next_action', 'open_question_or_blocker'
    )),
    state TEXT NOT NULL CHECK (state IN (
      'proposal', 'active', 'disputed', 'review_required',
      'resolved', 'superseded', 'invalidated'
    )),
    derived_text TEXT NOT NULL CHECK (
      length(trim(derived_text)) > 0
      AND length(CAST(derived_text AS BLOB)) <= 4096
    ),
    proposal_id TEXT CHECK (
      proposal_id IS NULL OR length(trim(proposal_id)) BETWEEN 1 AND 256
    ),
    origin_kind TEXT NOT NULL CHECK (origin_kind IN (
      'steward', 'human_resolution', 'source_invalidation', 'project_checkpoint'
    )),
    created_by_actor_id TEXT REFERENCES actors(id),
    source_job_id TEXT REFERENCES room_memory_jobs(job_id),
    replaces_version_id TEXT REFERENCES room_memory_versions(memory_version_id),
    source_count INTEGER NOT NULL CHECK (source_count BETWEEN 1 AND 16),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    UNIQUE (memory_record_id, version_number),
    UNIQUE (room_id, memory_version_id),
    FOREIGN KEY (room_id, memory_record_id)
      REFERENCES room_memory_records(room_id, memory_record_id),
    CHECK (state <> 'active' OR kind = 'context'),
    CHECK (state <> 'disputed' OR kind = 'context'),
    CHECK (state <> 'resolved' OR kind = 'context'),
    CHECK (state <> 'proposal' OR kind <> 'context'),
    CHECK ((kind = 'context' AND proposal_id IS NULL)
      OR (kind <> 'context' AND proposal_id IS NOT NULL)),
    CHECK ((origin_kind = 'human_resolution' AND created_by_actor_id IS NOT NULL)
      OR (origin_kind <> 'human_resolution' AND created_by_actor_id IS NULL))
  ) STRICT`,
  `CREATE INDEX room_memory_versions_projection_v18
   ON room_memory_versions(room_id, kind, state, memory_record_id, version_number)`,
  `CREATE TRIGGER room_memory_versions_v18_validate_insert
   BEFORE INSERT ON room_memory_versions
   WHEN NOT EXISTS (
     SELECT 1 FROM room_memory_records AS record
     WHERE record.memory_record_id = NEW.memory_record_id
       AND record.room_id = NEW.room_id
       AND record.kind = NEW.kind
       AND NEW.version_number = record.current_version_number + 1
       AND NEW.replaces_version_id IS record.current_version_id
   )
      OR (NEW.origin_kind = 'human_resolution' AND NOT EXISTS (
        SELECT 1 FROM actors AS actor
        JOIN room_memberships AS membership ON membership.actor_id = actor.id
        WHERE actor.id = NEW.created_by_actor_id AND actor.kind = 'human'
          AND membership.room_id = NEW.room_id AND membership.kind = 'human'
      ))
      OR (NEW.version_number = 1 AND NOT (
        (NEW.kind = 'context' AND NEW.state = 'active' AND NEW.origin_kind = 'steward')
        OR (NEW.kind <> 'context' AND NEW.state = 'proposal'
          AND NEW.origin_kind IN ('steward', 'project_checkpoint'))
      ))
      OR (NEW.version_number > 1 AND NOT EXISTS (
        SELECT 1 FROM room_memory_versions AS previous
        WHERE previous.memory_version_id = NEW.replaces_version_id
          AND previous.memory_record_id = NEW.memory_record_id
          AND previous.version_number = NEW.version_number - 1
          AND (
            (previous.state = 'active'
              AND NEW.state IN ('disputed', 'review_required', 'superseded', 'invalidated'))
            OR (previous.state = 'disputed'
              AND NEW.state IN ('resolved', 'superseded', 'invalidated'))
            OR (previous.state = 'resolved'
              AND NEW.state IN ('active', 'superseded', 'invalidated'))
            OR (previous.state = 'review_required'
              AND NEW.state IN ('superseded', 'invalidated'))
            OR (previous.state = 'proposal'
              AND NEW.state IN ('superseded', 'review_required', 'invalidated'))
            OR (previous.state = 'superseded' AND (
              (NEW.kind = 'context' AND NEW.state = 'active')
              OR (NEW.kind <> 'context' AND NEW.state = 'proposal')
            ))
            OR (previous.state = 'invalidated' AND (
              (NEW.kind = 'context' AND NEW.state = 'active')
              OR (NEW.kind <> 'context' AND NEW.state = 'proposal')
            ))
          )
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Room memory version transition is invalid');
   END`,
  `CREATE TRIGGER room_memory_versions_v18_advance_record
   AFTER INSERT ON room_memory_versions
   BEGIN
     UPDATE room_memory_records
     SET current_version_id = NEW.memory_version_id,
         current_version_number = NEW.version_number,
         updated_at = NEW.created_at
     WHERE memory_record_id = NEW.memory_record_id;
   END`,
  `CREATE TRIGGER room_memory_versions_v18_immutable_update
   BEFORE UPDATE ON room_memory_versions
   BEGIN SELECT RAISE(ABORT, 'Room memory version is immutable'); END`,
  `CREATE TRIGGER room_memory_versions_v18_immutable_delete
   BEFORE DELETE ON room_memory_versions
   BEGIN SELECT RAISE(ABORT, 'Room memory version is immutable'); END`,
  `CREATE TABLE room_memory_source_edges (
    edge_id TEXT PRIMARY KEY CHECK (length(trim(edge_id)) BETWEEN 1 AND 256),
    memory_version_id TEXT NOT NULL REFERENCES room_memory_versions(memory_version_id),
    memory_record_id TEXT NOT NULL REFERENCES room_memory_records(memory_record_id),
    room_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    UNIQUE (memory_version_id, source_kind, source_id, source_revision),
    FOREIGN KEY (room_id, memory_record_id)
      REFERENCES room_memory_records(room_id, memory_record_id),
    FOREIGN KEY (room_id, source_kind, source_id, source_revision)
      REFERENCES room_memory_sources(room_id, source_kind, source_id, source_revision)
  ) STRICT`,
  `CREATE TRIGGER room_memory_source_edges_v18_validate_insert
   BEFORE INSERT ON room_memory_source_edges
   WHEN NOT EXISTS (
     SELECT 1 FROM room_memory_versions AS version
     JOIN room_memory_records AS record
       ON record.memory_record_id = version.memory_record_id
     JOIN room_memory_sources AS source
       ON source.room_id = NEW.room_id
      AND source.source_kind = NEW.source_kind
      AND source.source_id = NEW.source_id
      AND source.source_revision = NEW.source_revision
     WHERE version.memory_version_id = NEW.memory_version_id
       AND version.memory_record_id = NEW.memory_record_id
       AND version.room_id = NEW.room_id
       AND record.current_version_id = NEW.memory_version_id
       AND source.eligibility = 'eligible' AND source.availability = 'readable'
       AND (SELECT COUNT(*) FROM room_memory_source_edges AS edge
            WHERE edge.memory_version_id = NEW.memory_version_id) < version.source_count
   )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory source edge is cross-Room or ineligible');
   END`,
  `CREATE TRIGGER room_memory_source_edges_v18_immutable_update
   BEFORE UPDATE ON room_memory_source_edges
   BEGIN SELECT RAISE(ABORT, 'Room memory source edge is immutable'); END`,
  `CREATE TRIGGER room_memory_source_edges_v18_immutable_delete
   BEFORE DELETE ON room_memory_source_edges
   BEGIN SELECT RAISE(ABORT, 'Room memory source edge is immutable'); END`,
  `CREATE TABLE room_memory_disputes (
    dispute_id TEXT PRIMARY KEY CHECK (length(trim(dispute_id)) BETWEEN 1 AND 256),
    room_id TEXT NOT NULL,
    memory_record_id TEXT NOT NULL REFERENCES room_memory_records(memory_record_id),
    expected_version_id TEXT NOT NULL REFERENCES room_memory_versions(memory_version_id),
    disputed_version_id TEXT NOT NULL UNIQUE REFERENCES room_memory_versions(memory_version_id),
    expected_version_number INTEGER NOT NULL CHECK (expected_version_number >= 1),
    operator_kind TEXT NOT NULL CHECK (operator_kind = 'human'),
    operator_actor_id TEXT NOT NULL REFERENCES actors(id),
    reason TEXT NOT NULL CHECK (
      length(trim(reason)) > 0 AND length(CAST(reason AS BLOB)) <= 2048
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    FOREIGN KEY (room_id, memory_record_id)
      REFERENCES room_memory_records(room_id, memory_record_id)
  ) STRICT`,
  `CREATE TRIGGER room_memory_disputes_v18_validate_insert
   BEFORE INSERT ON room_memory_disputes
   WHEN NEW.operator_kind <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM actors AS actor
        JOIN room_memberships AS membership ON membership.actor_id = actor.id
        WHERE actor.id = NEW.operator_actor_id AND actor.kind = 'human'
          AND membership.room_id = NEW.room_id AND membership.kind = 'human'
      )
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_records AS record
        JOIN room_memory_versions AS expected
          ON expected.memory_version_id = NEW.expected_version_id
        JOIN room_memory_versions AS disputed
          ON disputed.memory_version_id = NEW.disputed_version_id
        WHERE record.memory_record_id = NEW.memory_record_id
          AND record.room_id = NEW.room_id AND record.kind = 'context'
          AND record.current_version_id = NEW.disputed_version_id
          AND expected.memory_record_id = record.memory_record_id
          AND expected.version_number = NEW.expected_version_number
          AND expected.state = 'active'
          AND disputed.memory_record_id = record.memory_record_id
          AND disputed.state = 'disputed'
          AND disputed.replaces_version_id = expected.memory_version_id
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory dispute operator or expected version is invalid');
   END`,
  `CREATE TRIGGER room_memory_disputes_v18_immutable_update
   BEFORE UPDATE ON room_memory_disputes
   BEGIN SELECT RAISE(ABORT, 'Room memory dispute is immutable'); END`,
  `CREATE TRIGGER room_memory_disputes_v18_immutable_delete
   BEFORE DELETE ON room_memory_disputes
   BEGIN SELECT RAISE(ABORT, 'Room memory dispute is immutable'); END`,
  `CREATE TABLE room_memory_resolutions (
    resolution_id TEXT PRIMARY KEY CHECK (length(trim(resolution_id)) BETWEEN 1 AND 256),
    dispute_id TEXT NOT NULL UNIQUE REFERENCES room_memory_disputes(dispute_id),
    room_id TEXT NOT NULL,
    memory_record_id TEXT NOT NULL REFERENCES room_memory_records(memory_record_id),
    expected_disputed_version_id TEXT NOT NULL REFERENCES room_memory_versions(memory_version_id),
    resolution_version_id TEXT NOT NULL UNIQUE REFERENCES room_memory_versions(memory_version_id),
    replacement_version_id TEXT UNIQUE REFERENCES room_memory_versions(memory_version_id),
    operator_kind TEXT NOT NULL CHECK (operator_kind = 'human'),
    operator_actor_id TEXT NOT NULL REFERENCES actors(id),
    resolution TEXT NOT NULL CHECK (resolution IN (
      'accept', 'replace', 'dismiss', 're_evaluate'
    )),
    reason TEXT NOT NULL CHECK (
      length(trim(reason)) > 0 AND length(CAST(reason AS BLOB)) <= 2048
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    FOREIGN KEY (room_id, memory_record_id)
      REFERENCES room_memory_records(room_id, memory_record_id)
  ) STRICT`,
  `CREATE TRIGGER room_memory_resolutions_v18_validate_insert
   BEFORE INSERT ON room_memory_resolutions
   WHEN NEW.operator_kind <> 'human'
      OR NOT EXISTS (
        SELECT 1 FROM actors AS actor
        JOIN room_memberships AS membership ON membership.actor_id = actor.id
        WHERE actor.id = NEW.operator_actor_id AND actor.kind = 'human'
          AND membership.room_id = NEW.room_id AND membership.kind = 'human'
      )
      OR NOT EXISTS (
        SELECT 1 FROM room_memory_disputes AS dispute
        JOIN room_memory_versions AS disputed
          ON disputed.memory_version_id = NEW.expected_disputed_version_id
        JOIN room_memory_versions AS resolution
          ON resolution.memory_version_id = NEW.resolution_version_id
        JOIN room_memory_records AS record
          ON record.memory_record_id = NEW.memory_record_id
        WHERE dispute.dispute_id = NEW.dispute_id
          AND dispute.room_id = NEW.room_id
          AND dispute.memory_record_id = NEW.memory_record_id
          AND dispute.disputed_version_id = NEW.expected_disputed_version_id
          AND disputed.state = 'disputed'
          AND resolution.memory_record_id = NEW.memory_record_id
          AND resolution.state IN ('resolved', 'superseded')
          AND resolution.replaces_version_id = disputed.memory_version_id
          AND (
            (NEW.replacement_version_id IS NULL
              AND record.current_version_id = resolution.memory_version_id)
            OR EXISTS (
              SELECT 1 FROM room_memory_versions AS replacement
              WHERE replacement.memory_version_id = NEW.replacement_version_id
                AND replacement.memory_record_id = NEW.memory_record_id
                AND replacement.state = 'active'
                AND replacement.replaces_version_id = resolution.memory_version_id
                AND record.current_version_id = replacement.memory_version_id
            )
          )
      )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory resolution operator or version chain is invalid');
   END`,
  `CREATE TRIGGER room_memory_resolutions_v18_immutable_update
   BEFORE UPDATE ON room_memory_resolutions
   BEGIN SELECT RAISE(ABORT, 'Room memory resolution is immutable'); END`,
  `CREATE TRIGGER room_memory_resolutions_v18_immutable_delete
   BEFORE DELETE ON room_memory_resolutions
   BEGIN SELECT RAISE(ABORT, 'Room memory resolution is immutable'); END`,
  `CREATE TABLE room_memory_idempotency (
    scope TEXT NOT NULL CHECK (scope IN (
      'memory_dispute', 'memory_resolve', 'memory_retry'
    )),
    idempotency_key TEXT NOT NULL CHECK (
      length(trim(idempotency_key)) BETWEEN 1 AND 256
    ),
    room_id TEXT NOT NULL REFERENCES room_memory_stewards(room_id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    request_sha256 TEXT NOT NULL CHECK (
      length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK (
      json_valid(response_json) AND json_type(response_json) = 'object'
      AND length(CAST(response_json AS BLOB)) <= 16384
    ),
    status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 599),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (
      expires_at_ms > created_at_ms
      AND expires_at_ms - created_at_ms <= 2592000000
    ),
    PRIMARY KEY (scope, idempotency_key)
  ) STRICT`,
  `CREATE TRIGGER room_memory_idempotency_v18_validate_insert
   BEFORE INSERT ON room_memory_idempotency
   WHEN NOT EXISTS (
     SELECT 1 FROM actors AS actor
     JOIN room_memberships AS membership ON membership.actor_id = actor.id
     WHERE actor.id = NEW.actor_id AND actor.kind = 'human'
       AND membership.room_id = NEW.room_id AND membership.kind = 'human'
   )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory idempotency actor is invalid');
   END`,
  `CREATE TRIGGER room_memory_idempotency_v18_immutable_update
   BEFORE UPDATE ON room_memory_idempotency
   BEGIN SELECT RAISE(ABORT, 'Room memory idempotency receipt is immutable'); END`,
  `CREATE TABLE room_memory_project_checkpoint (
    room_id TEXT PRIMARY KEY REFERENCES room_memory_stewards(room_id),
    mode TEXT NOT NULL CHECK (mode IN ('disabled', 'enabled')),
    participant_id TEXT CHECK (
      participant_id IS NULL OR length(trim(participant_id)) BETWEEN 1 AND 256
    ),
    checkpoint_id TEXT CHECK (
      checkpoint_id IS NULL OR length(trim(checkpoint_id)) BETWEEN 1 AND 256
    ),
    checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
    health TEXT NOT NULL CHECK (health IN ('disabled', 'ready', 'degraded')),
    health_reason_code TEXT CHECK (
      health_reason_code IS NULL OR length(trim(health_reason_code)) BETWEEN 1 AND 128
    ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    CHECK (
      (mode = 'disabled' AND participant_id IS NULL AND checkpoint_id IS NULL
        AND checkpoint_version = 0 AND health = 'disabled'
        AND health_reason_code IS NULL)
      OR (mode = 'enabled' AND participant_id IS NOT NULL AND checkpoint_id IS NOT NULL
        AND checkpoint_version >= 1 AND health IN ('ready', 'degraded'))
    ),
    CHECK (health <> 'degraded' OR health_reason_code IS NOT NULL)
  ) STRICT`,
  `CREATE TRIGGER room_memory_project_checkpoint_v18_validate_update
   BEFORE UPDATE ON room_memory_project_checkpoint
   WHEN NEW.room_id <> OLD.room_id
      OR (OLD.mode = 'enabled' AND NEW.mode = 'disabled')
      OR NEW.checkpoint_version < OLD.checkpoint_version
   BEGIN
     SELECT RAISE(ABORT, 'Room memory project checkpoint transition is invalid');
   END`,
  `CREATE TRIGGER room_memory_project_checkpoint_v18_immutable_delete
   BEFORE DELETE ON room_memory_project_checkpoint
   BEGIN SELECT RAISE(ABORT, 'Room memory project checkpoint is immutable'); END`,
  `CREATE TRIGGER room_memory_stewards_v18_create_project_checkpoint
   AFTER INSERT ON room_memory_stewards
   BEGIN
     INSERT INTO room_memory_project_checkpoint (
       room_id, mode, participant_id, checkpoint_id, checkpoint_version,
       health, health_reason_code, updated_at
     ) VALUES (NEW.room_id, 'disabled', NULL, NULL, 0, 'disabled', NULL, NEW.created_at);
   END`,
  `CREATE TRIGGER rooms_v18_create_memory_steward
   AFTER INSERT ON rooms
   BEGIN
     INSERT INTO room_memory_stewards (
       room_id, steward_id, lifecycle_generation, memory_watermark, corpus_head,
       health, health_reason_code, recovery_generation, last_attempt_at,
       retryable, recovery_required, created_at, updated_at
     ) VALUES (
       NEW.id, 'room-memory-steward:' || NEW.id, NEW.archive_generation, 0, 0,
       'healthy', NULL, 1, NULL, 0, 0, NEW.created_at, NEW.created_at
     );
   END`,
  `CREATE TRIGGER rooms_v18_advance_memory_lifecycle
   AFTER UPDATE OF archive_generation ON rooms
   WHEN NEW.archive_generation > OLD.archive_generation
   BEGIN
     UPDATE room_memory_stewards
     SET lifecycle_generation = NEW.archive_generation,
         updated_at = COALESCE(NEW.archived_at, updated_at)
     WHERE room_id = NEW.id;
   END`,
  `CREATE TRIGGER actors_v18_reject_memory_steward_identity
   BEFORE INSERT ON actors
   WHEN EXISTS (
     SELECT 1 FROM room_memory_stewards WHERE steward_id = NEW.id
   )
   BEGIN
     SELECT RAISE(ABORT, 'Room memory steward cannot be an actor');
   END`,
  `INSERT INTO room_memory_stewards (
     room_id, steward_id, lifecycle_generation, memory_watermark, corpus_head,
     health, health_reason_code, recovery_generation, last_attempt_at,
     retryable, recovery_required, created_at, updated_at
   )
   SELECT room.id, 'room-memory-steward:' || room.id, room.archive_generation, 0, 0,
          'healthy', NULL, 1, NULL, 0, 0, room.created_at, room.created_at
   FROM rooms AS room
   ORDER BY room.id`,
] as const;

const V19_STATEMENTS = [
  `CREATE TABLE context_snapshots (
    snapshot_id TEXT PRIMARY KEY CHECK (length(trim(snapshot_id)) BETWEEN 1 AND 256),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    invocation_intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    agent_id TEXT NOT NULL REFERENCES actors(id),
    provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) BETWEEN 1 AND 128),
    model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
    compiler_version TEXT NOT NULL CHECK (length(trim(compiler_version)) BETWEEN 1 AND 128),
    compiler_config_version TEXT NOT NULL CHECK (
      length(trim(compiler_config_version)) BETWEEN 1 AND 128
    ),
    estimator_version TEXT NOT NULL CHECK (estimator_version = 'deterministic_utf8_v1'),
    preparation_sha256 TEXT NOT NULL CHECK (
      length(preparation_sha256) = 64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    trigger_message_id TEXT NOT NULL REFERENCES message_envelopes(message_id),
    trigger_revision INTEGER NOT NULL CHECK (trigger_revision >= 1),
    trigger_reason TEXT NOT NULL CHECK (
      trigger_reason IN ('direct_mention', 'structured_help', 'routed_candidate')
    ),
    memory_watermark INTEGER NOT NULL CHECK (memory_watermark >= 0),
    corpus_head INTEGER NOT NULL CHECK (corpus_head >= memory_watermark),
    raw_delta_from_exclusive INTEGER NOT NULL CHECK (raw_delta_from_exclusive >= 0),
    raw_delta_to_inclusive INTEGER NOT NULL CHECK (
      raw_delta_to_inclusive >= raw_delta_from_exclusive
    ),
    room_lifecycle_generation INTEGER NOT NULL CHECK (room_lifecycle_generation >= 0),
    membership_access_revision INTEGER NOT NULL CHECK (membership_access_revision >= 0),
    tool_capability_revision INTEGER NOT NULL CHECK (tool_capability_revision >= 0),
    budget_json TEXT NOT NULL CHECK (
      json_valid(budget_json) AND json_type(budget_json) = 'object'
      AND length(CAST(budget_json AS BLOB)) BETWEEN 2 AND 32768
    ),
    manifest_sha256 TEXT NOT NULL CHECK (
      length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    envelope_sha256 TEXT NOT NULL CHECK (
      length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('active', 'invalidated', 'superseded', 'retired')),
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    invalidated_at TEXT,
    invalidation_reason TEXT CHECK (
      invalidation_reason IS NULL OR invalidation_reason IN (
        'message_recalled', 'message_revised', 'memory_invalidated',
        'attachment_invalidated', 'membership_revoked', 'room_archived',
        'source_gone', 'authorization_changed'
      )
    ),
    superseded_at TEXT,
    retired_at TEXT,
    retain_until TEXT,
    payload_retention_state TEXT NOT NULL CHECK (
      payload_retention_state IN ('required', 'purge_pending', 'purged')
    ),
    UNIQUE (snapshot_id, snapshot_generation),
    FOREIGN KEY (trigger_message_id, trigger_revision)
      REFERENCES message_revisions(message_id, revision),
    CHECK (raw_delta_from_exclusive = memory_watermark),
    CHECK (raw_delta_to_inclusive = corpus_head),
    CHECK (
      (state = 'active' AND invalidated_at IS NULL AND invalidation_reason IS NULL
        AND superseded_at IS NULL AND retired_at IS NULL)
      OR (state = 'invalidated' AND invalidated_at IS NOT NULL
        AND invalidation_reason IS NOT NULL AND superseded_at IS NULL AND retired_at IS NULL)
      OR (state = 'superseded' AND invalidated_at IS NULL
        AND invalidation_reason IS NULL AND superseded_at IS NOT NULL AND retired_at IS NULL)
      OR (state = 'retired' AND invalidated_at IS NULL
        AND invalidation_reason IS NULL AND superseded_at IS NULL AND retired_at IS NOT NULL)
    ),
    CHECK (
      (payload_retention_state = 'required' AND retain_until IS NULL)
      OR (payload_retention_state IN ('purge_pending', 'purged') AND retain_until IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX context_snapshots_room_state_v19
   ON context_snapshots(room_id, state, snapshot_generation, snapshot_id)`,
  `CREATE INDEX context_snapshots_retention_v19
   ON context_snapshots(payload_retention_state, retain_until, snapshot_id)`,
  `CREATE INDEX context_snapshots_trigger_v19
   ON context_snapshots(trigger_message_id, trigger_revision, state, snapshot_id)`,
  `CREATE TRIGGER context_snapshots_v19_validate_insert
   BEFORE INSERT ON context_snapshots
   WHEN NEW.state <> 'active' OR NEW.snapshot_generation <> 1
      OR NEW.payload_retention_state <> 'required'
      OR NOT EXISTS (
        SELECT 1
        FROM agent_invocation_intents AS intent
        JOIN rooms AS room ON room.id = intent.room_id
        JOIN actors AS agent ON agent.id = intent.target_agent_id
        JOIN room_memberships AS membership
          ON membership.room_id = intent.room_id
         AND membership.actor_id = intent.target_agent_id
         AND membership.kind = 'agent'
        JOIN message_envelopes AS trigger
          ON trigger.message_id = intent.source_message_id
        LEFT JOIN room_memory_stewards AS steward ON steward.room_id = intent.room_id
        WHERE intent.id = NEW.invocation_intent_id
          AND intent.room_id = NEW.room_id
          AND intent.target_agent_id = NEW.agent_id
          AND intent.source_message_id = NEW.trigger_message_id
          AND intent.source_revision = NEW.trigger_revision
          AND intent.intent_kind = NEW.trigger_reason
          AND intent.status = 'claimed'
          AND room.status = 'active'
          AND room.archive_generation = NEW.room_lifecycle_generation
          AND agent.kind = 'agent'
          AND agent.catalog_revision = NEW.tool_capability_revision
          AND membership.participation IN ('active', 'on-mention')
          AND membership.access_revision = NEW.membership_access_revision
          AND trigger.lifecycle = 'active'
          AND COALESCE(steward.memory_watermark, 0) = NEW.memory_watermark
          AND COALESCE(steward.corpus_head, 0) = NEW.corpus_head
      )
   BEGIN
     SELECT RAISE(ABORT, 'Context snapshot preparation authority is stale');
   END`,
  `CREATE TRIGGER context_snapshots_v19_validate_update
   BEFORE UPDATE ON context_snapshots
   WHEN NEW.snapshot_id <> OLD.snapshot_id OR NEW.room_id <> OLD.room_id
      OR NEW.invocation_intent_id <> OLD.invocation_intent_id
      OR NEW.agent_id <> OLD.agent_id OR NEW.provider_id <> OLD.provider_id
      OR NEW.model_id <> OLD.model_id OR NEW.compiler_version <> OLD.compiler_version
      OR NEW.compiler_config_version <> OLD.compiler_config_version
      OR NEW.estimator_version <> OLD.estimator_version
      OR NEW.preparation_sha256 <> OLD.preparation_sha256
      OR NEW.trigger_message_id <> OLD.trigger_message_id
      OR NEW.trigger_revision <> OLD.trigger_revision
      OR NEW.trigger_reason <> OLD.trigger_reason
      OR NEW.memory_watermark <> OLD.memory_watermark
      OR NEW.corpus_head <> OLD.corpus_head
      OR NEW.raw_delta_from_exclusive <> OLD.raw_delta_from_exclusive
      OR NEW.raw_delta_to_inclusive <> OLD.raw_delta_to_inclusive
      OR NEW.room_lifecycle_generation <> OLD.room_lifecycle_generation
      OR NEW.membership_access_revision <> OLD.membership_access_revision
      OR NEW.tool_capability_revision <> OLD.tool_capability_revision
      OR NEW.budget_json <> OLD.budget_json
      OR NEW.manifest_sha256 <> OLD.manifest_sha256
      OR NEW.envelope_sha256 <> OLD.envelope_sha256
      OR NEW.created_at <> OLD.created_at
      OR NOT (
        (NEW.state = OLD.state AND NEW.snapshot_generation = OLD.snapshot_generation
          AND NEW.invalidated_at IS OLD.invalidated_at
          AND NEW.invalidation_reason IS OLD.invalidation_reason
          AND NEW.superseded_at IS OLD.superseded_at
          AND NEW.retired_at IS OLD.retired_at
          AND ((OLD.payload_retention_state = 'required'
                AND NEW.payload_retention_state = 'purge_pending'
                AND OLD.retain_until IS NULL AND NEW.retain_until IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM agent_execution_context_bindings AS binding
                  JOIN agent_executions AS execution ON execution.id = binding.execution_id
                  WHERE binding.snapshot_id = OLD.snapshot_id
                    AND execution.status IN ('completed', 'failed', 'cancelled')
                ))
            OR (OLD.payload_retention_state = 'purge_pending'
                AND NEW.payload_retention_state = 'purged'
                AND NEW.retain_until = OLD.retain_until)))
        OR (OLD.state = 'active' AND NEW.snapshot_generation = OLD.snapshot_generation + 1
          AND NEW.payload_retention_state = OLD.payload_retention_state
          AND NEW.retain_until IS OLD.retain_until
          AND ((NEW.state = 'invalidated' AND NEW.invalidated_at IS NOT NULL
                AND NEW.invalidation_reason IS NOT NULL
                AND NEW.superseded_at IS NULL AND NEW.retired_at IS NULL)
            OR (NEW.state = 'superseded' AND NEW.invalidated_at IS NULL
                AND NEW.invalidation_reason IS NULL
                AND NEW.superseded_at IS NOT NULL AND NEW.retired_at IS NULL)
            OR (NEW.state = 'retired' AND NEW.invalidated_at IS NULL
                AND NEW.invalidation_reason IS NULL
                AND NEW.superseded_at IS NULL AND NEW.retired_at IS NOT NULL)))
      )
   BEGIN
     SELECT RAISE(ABORT, 'Context snapshot transition or retention CAS is invalid');
   END`,
  `CREATE TRIGGER context_snapshots_v19_immutable_delete
   BEFORE DELETE ON context_snapshots
   BEGIN SELECT RAISE(ABORT, 'Context snapshot metadata is immutable'); END`,
  `CREATE TRIGGER agent_executions_v19_schedule_context_retention
   AFTER UPDATE OF status ON agent_executions
   WHEN NEW.status IN ('completed', 'failed', 'cancelled')
     AND OLD.status NOT IN ('completed', 'failed', 'cancelled')
   BEGIN
     UPDATE context_snapshots
     SET payload_retention_state = 'purge_pending',
         retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '+30 days')
     WHERE snapshot_id IN (
       SELECT binding.snapshot_id FROM agent_execution_context_bindings AS binding
       WHERE binding.execution_id = NEW.id
     ) AND payload_retention_state = 'required';
   END`,
  `CREATE TABLE context_snapshot_transitions (
    transition_id INTEGER PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    from_state TEXT CHECK (from_state IS NULL OR from_state IN (
      'active', 'invalidated', 'superseded', 'retired'
    )),
    to_state TEXT NOT NULL CHECK (to_state IN (
      'active', 'invalidated', 'superseded', 'retired'
    )),
    from_generation INTEGER CHECK (from_generation IS NULL OR from_generation >= 1),
    to_generation INTEGER NOT NULL CHECK (to_generation >= 1),
    reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 128),
    transitioned_at TEXT NOT NULL CHECK (length(transitioned_at) > 0),
    UNIQUE (snapshot_id, to_generation),
    CHECK (
      (from_state IS NULL AND from_generation IS NULL
        AND to_state = 'active' AND to_generation = 1 AND reason_code = 'created')
      OR (from_state IS NOT NULL AND from_generation IS NOT NULL
        AND to_generation = from_generation + 1 AND to_state <> from_state)
    )
  ) STRICT`,
  `CREATE INDEX context_snapshot_transitions_snapshot_v19
   ON context_snapshot_transitions(snapshot_id, to_generation, transition_id)`,
  `CREATE TRIGGER context_snapshot_transitions_v19_validate_insert
   BEFORE INSERT ON context_snapshot_transitions
   WHEN NOT EXISTS (
     SELECT 1 FROM context_snapshots AS snapshot
     WHERE snapshot.snapshot_id = NEW.snapshot_id
       AND snapshot.state = NEW.to_state
       AND snapshot.snapshot_generation = NEW.to_generation
   )
   BEGIN SELECT RAISE(ABORT, 'Context snapshot transition does not match current state'); END`,
  `CREATE TRIGGER context_snapshot_transitions_v19_immutable_update
   BEFORE UPDATE ON context_snapshot_transitions
   BEGIN SELECT RAISE(ABORT, 'Context snapshot transition is immutable'); END`,
  `CREATE TRIGGER context_snapshot_transitions_v19_immutable_delete
   BEFORE DELETE ON context_snapshot_transitions
   BEGIN SELECT RAISE(ABORT, 'Context snapshot transition is immutable'); END`,
  `CREATE TRIGGER context_snapshots_v19_audit_insert
   AFTER INSERT ON context_snapshots
   BEGIN
     INSERT INTO context_snapshot_transitions (
       snapshot_id, from_state, to_state, from_generation, to_generation,
       reason_code, transitioned_at
     ) VALUES (
       NEW.snapshot_id, NULL, 'active', NULL, 1, 'created', NEW.created_at
     );
   END`,
  `CREATE TRIGGER context_snapshots_v19_audit_state_update
   AFTER UPDATE OF state, snapshot_generation ON context_snapshots
   WHEN NEW.state <> OLD.state OR NEW.snapshot_generation <> OLD.snapshot_generation
   BEGIN
     INSERT INTO context_snapshot_transitions (
       snapshot_id, from_state, to_state, from_generation, to_generation,
       reason_code, transitioned_at
     ) VALUES (
       NEW.snapshot_id, OLD.state, NEW.state, OLD.snapshot_generation,
       NEW.snapshot_generation,
       CASE NEW.state
         WHEN 'invalidated' THEN NEW.invalidation_reason
         WHEN 'superseded' THEN 'superseded'
         ELSE 'retention_expired'
       END,
       COALESCE(NEW.invalidated_at, NEW.superseded_at, NEW.retired_at)
     );
   END`,
  `CREATE TABLE context_manifests (
    manifest_id TEXT PRIMARY KEY CHECK (length(trim(manifest_id)) BETWEEN 1 AND 256),
    snapshot_id TEXT NOT NULL UNIQUE REFERENCES context_snapshots(snapshot_id),
    manifest_version TEXT NOT NULL CHECK (length(trim(manifest_version)) BETWEEN 1 AND 128),
    manifest_sha256 TEXT NOT NULL CHECK (
      length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    canonical_manifest_json TEXT NOT NULL CHECK (
      json_valid(canonical_manifest_json)
      AND json_type(canonical_manifest_json) = 'object'
      AND length(CAST(canonical_manifest_json AS BLOB)) BETWEEN 2 AND 131072
    ),
    item_count INTEGER NOT NULL CHECK (item_count >= 1 AND item_count <= 4096),
    total_original_bytes INTEGER NOT NULL CHECK (total_original_bytes >= 0),
    total_included_bytes INTEGER NOT NULL CHECK (total_included_bytes >= 0),
    total_original_tokens INTEGER NOT NULL CHECK (total_original_tokens >= 0),
    total_included_tokens INTEGER NOT NULL CHECK (total_included_tokens >= 0),
    accounting_json TEXT NOT NULL CHECK (
      json_valid(accounting_json) AND json_type(accounting_json) = 'object'
      AND length(CAST(accounting_json AS BLOB)) BETWEEN 2 AND 32768
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0)
  ) STRICT`,
  `CREATE TRIGGER context_manifests_v19_validate_insert
   BEFORE INSERT ON context_manifests
   WHEN NOT EXISTS (
     SELECT 1 FROM context_snapshots AS snapshot
     WHERE snapshot.snapshot_id = NEW.snapshot_id
       AND snapshot.manifest_sha256 = NEW.manifest_sha256
       AND snapshot.created_at = NEW.created_at
   )
   BEGIN SELECT RAISE(ABORT, 'Context manifest does not match snapshot'); END`,
  `CREATE TRIGGER context_manifests_v19_immutable_update
   BEFORE UPDATE ON context_manifests
   BEGIN SELECT RAISE(ABORT, 'Context manifest is immutable'); END`,
  `CREATE TRIGGER context_manifests_v19_immutable_delete
   BEFORE DELETE ON context_manifests
   BEGIN SELECT RAISE(ABORT, 'Context manifest is immutable'); END`,
  `CREATE TABLE context_manifest_items (
    manifest_id TEXT NOT NULL REFERENCES context_manifests(manifest_id),
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 4096),
    section TEXT NOT NULL CHECK (section IN (
      'trusted_system', 'trusted_developer', 'trigger', 'memory', 'delta',
      'retrieval', 'attachment', 'project', 'tools', 'degradation'
    )),
    disposition TEXT NOT NULL CHECK (disposition IN (
      'included', 'excerpted', 'segmented', 'digested', 'index_only',
      'omitted', 'unavailable', 'invalidated'
    )),
    canonical_sort_key TEXT NOT NULL CHECK (
      length(CAST(canonical_sort_key AS BLOB)) BETWEEN 1 AND 1024
    ),
    source_label_sha256 TEXT CHECK (
      source_label_sha256 IS NULL OR (
        length(source_label_sha256) = 64 AND source_label_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    source_kind TEXT CHECK (source_kind IN (
      'policy', 'trigger', 'message', 'message_revision', 'message_tombstone',
      'memory', 'attachment', 'attachment_extraction', 'project',
      'project_fact_checkpoint', 'tool', 'retrieval'
    )),
    source_id TEXT CHECK (source_id IS NULL OR length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER CHECK (source_revision IS NULL OR source_revision >= 0),
    content_sha256 TEXT CHECK (
      content_sha256 IS NULL OR (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
    included_bytes INTEGER NOT NULL CHECK (
      included_bytes >= 0 AND (disposition = 'index_only' OR included_bytes <= original_bytes)
    ),
    original_tokens INTEGER NOT NULL CHECK (original_tokens >= 0),
    included_tokens INTEGER NOT NULL CHECK (
      included_tokens >= 0 AND (disposition = 'index_only' OR included_tokens <= original_tokens)
    ),
    reason_code TEXT CHECK (reason_code IS NULL OR length(trim(reason_code)) BETWEEN 1 AND 128),
    segment_json TEXT CHECK (
      segment_json IS NULL OR (
        json_valid(segment_json) AND json_type(segment_json) = 'object'
        AND length(CAST(segment_json AS BLOB)) <= 4096
      )
    ),
    availability TEXT NOT NULL CHECK (
      availability IN ('readable', 'metadata_only', 'unavailable', 'invalidated')
    ),
    PRIMARY KEY (manifest_id, ordinal),
    UNIQUE (snapshot_id, ordinal),
    UNIQUE (manifest_id, canonical_sort_key),
    UNIQUE (snapshot_id, source_label_sha256),
    CHECK (
      (source_kind IS NULL AND source_id IS NULL AND source_revision IS NULL
        AND section = 'delta' AND disposition = 'index_only'
        AND source_label_sha256 IS NOT NULL AND segment_json IS NOT NULL)
      OR (source_kind IS NOT NULL AND source_id IS NOT NULL AND source_revision IS NOT NULL)
    ),
    CHECK (
      (disposition IN ('included', 'excerpted', 'segmented') AND included_bytes > 0)
      OR (disposition IN ('digested', 'index_only') AND included_bytes >= 0)
      OR (disposition IN ('omitted', 'unavailable', 'invalidated') AND included_bytes = 0)
    ),
    CHECK (
      reason_code IS NOT NULL
    )
  ) STRICT`,
  `CREATE INDEX context_manifest_items_source_v19
   ON context_manifest_items(source_kind, source_id, source_revision, snapshot_id)`,
  `CREATE TRIGGER context_manifest_items_v19_validate_insert
   BEFORE INSERT ON context_manifest_items
   WHEN NEW.ordinal <> (
       SELECT COUNT(*) FROM context_manifest_items WHERE manifest_id = NEW.manifest_id
     )
      OR NOT EXISTS (
        SELECT 1 FROM context_manifests AS manifest
        WHERE manifest.manifest_id = NEW.manifest_id
          AND manifest.snapshot_id = NEW.snapshot_id
          AND NEW.ordinal < manifest.item_count
      )
   BEGIN SELECT RAISE(ABORT, 'Context manifest item order or binding is invalid'); END`,
  `CREATE TRIGGER context_manifest_items_v19_immutable_update
   BEFORE UPDATE ON context_manifest_items
   BEGIN SELECT RAISE(ABORT, 'Context manifest item is immutable'); END`,
  `CREATE TRIGGER context_manifest_items_v19_immutable_delete
   BEFORE DELETE ON context_manifest_items
   BEGIN SELECT RAISE(ABORT, 'Context manifest item is immutable'); END`,
  `CREATE TABLE context_snapshot_sources (
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message_revision', 'message_tombstone', 'memory',
      'attachment_extraction', 'project_fact_checkpoint'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    source_label_sha256 TEXT CHECK (
      source_label_sha256 IS NULL OR (
        length(source_label_sha256) = 64 AND source_label_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    currently_required INTEGER NOT NULL CHECK (currently_required IN (0, 1)),
    authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (snapshot_id, source_kind, source_id, source_revision),
    UNIQUE (snapshot_id, source_label_sha256)
  ) STRICT`,
  `CREATE INDEX context_snapshot_sources_lookup_v19
   ON context_snapshot_sources(room_id, source_kind, source_id, source_revision, snapshot_id)`,
  `CREATE TRIGGER context_snapshot_sources_v19_validate_insert
   BEFORE INSERT ON context_snapshot_sources
   WHEN NOT EXISTS (
       SELECT 1 FROM context_snapshots AS snapshot
       WHERE snapshot.snapshot_id = NEW.snapshot_id
         AND snapshot.room_id = NEW.room_id AND snapshot.state = 'active'
         AND NEW.authorization_revision = CASE
           WHEN NEW.source_kind = 'attachment_extraction' AND NEW.currently_required = 1
             THEN COALESCE((
             SELECT attachment.access_revision FROM attachments AS attachment
             WHERE substr(NEW.source_id, 1, 22) = 'attachment-extraction:'
               AND attachment.attachment_id = substr(NEW.source_id, 23)
               AND attachment.room_id = NEW.room_id
           ), -1)
           ELSE snapshot.membership_access_revision
         END
     )
      OR (NEW.currently_required = 0 AND NEW.source_kind <> 'message_tombstone' AND (
        NOT EXISTS (
          SELECT 1 FROM context_manifest_items AS item
          WHERE item.snapshot_id = NEW.snapshot_id
            AND item.source_id = NEW.source_id
            AND item.source_revision = NEW.source_revision
            AND item.availability IN ('unavailable', 'invalidated')
            AND ((NEW.source_kind = 'message_revision'
                  AND item.source_kind IN ('message', 'trigger', 'message_revision'))
              OR (NEW.source_kind = 'attachment_extraction'
                  AND item.source_kind IN ('attachment', 'attachment_extraction'))
              OR (NEW.source_kind = 'project_fact_checkpoint'
                  AND item.source_kind IN ('project', 'project_fact_checkpoint'))
              OR item.source_kind = NEW.source_kind)
        )
        OR EXISTS (
          SELECT 1 FROM context_manifest_items AS item
          WHERE item.snapshot_id = NEW.snapshot_id
            AND item.source_id = NEW.source_id
            AND item.source_revision = NEW.source_revision
            AND item.availability IN ('readable', 'metadata_only')
            AND ((NEW.source_kind = 'message_revision'
                  AND item.source_kind IN ('message', 'trigger', 'message_revision'))
              OR (NEW.source_kind = 'attachment_extraction'
                  AND item.source_kind IN ('attachment', 'attachment_extraction'))
              OR (NEW.source_kind = 'project_fact_checkpoint'
                  AND item.source_kind IN ('project', 'project_fact_checkpoint'))
              OR item.source_kind = NEW.source_kind)
        )
      ))
      OR (NEW.currently_required = 1 AND (
        NEW.source_kind = 'message_tombstone'
        OR (
          EXISTS (
            SELECT 1 FROM context_manifest_items AS item
            WHERE item.snapshot_id = NEW.snapshot_id
              AND item.source_id = NEW.source_id
              AND item.source_revision = NEW.source_revision
              AND item.availability IN ('unavailable', 'invalidated')
              AND ((NEW.source_kind = 'message_revision'
                    AND item.source_kind IN ('message', 'trigger', 'message_revision'))
                OR (NEW.source_kind = 'attachment_extraction'
                    AND item.source_kind IN ('attachment', 'attachment_extraction'))
                OR (NEW.source_kind = 'project_fact_checkpoint'
                    AND item.source_kind IN ('project', 'project_fact_checkpoint'))
                OR item.source_kind = NEW.source_kind)
          )
          AND NOT EXISTS (
            SELECT 1 FROM context_manifest_items AS item
            WHERE item.snapshot_id = NEW.snapshot_id
              AND item.source_id = NEW.source_id
              AND item.source_revision = NEW.source_revision
              AND item.availability IN ('readable', 'metadata_only')
              AND ((NEW.source_kind = 'message_revision'
                    AND item.source_kind IN ('message', 'trigger', 'message_revision'))
                OR (NEW.source_kind = 'attachment_extraction'
                    AND item.source_kind IN ('attachment', 'attachment_extraction'))
                OR (NEW.source_kind = 'project_fact_checkpoint'
                    AND item.source_kind IN ('project', 'project_fact_checkpoint'))
                OR item.source_kind = NEW.source_kind)
          )
        )
      ))
      OR NOT (
        EXISTS (
          SELECT 1 FROM context_manifest_items AS item
          WHERE item.snapshot_id = NEW.snapshot_id
            AND item.source_label_sha256 IS NEW.source_label_sha256
            AND item.source_id = NEW.source_id
            AND item.source_revision = NEW.source_revision
            AND ((NEW.source_kind IN ('message_revision', 'message_tombstone')
                  AND item.source_kind IN (
                    'message', 'trigger', 'message_revision', 'message_tombstone'
                  ))
              OR (NEW.source_kind = 'attachment_extraction'
                  AND item.source_kind IN ('attachment', 'attachment_extraction'))
              OR (NEW.source_kind = 'project_fact_checkpoint'
                  AND item.source_kind IN ('project', 'project_fact_checkpoint'))
              OR item.source_kind = NEW.source_kind)
        )
        OR (NEW.source_label_sha256 IS NULL AND EXISTS (
          SELECT 1
          FROM context_snapshots AS snapshot
          JOIN room_memory_sources AS corpus
            ON corpus.room_id = snapshot.room_id
           AND corpus.source_revision = NEW.source_revision
           AND (corpus.source_id = NEW.source_id OR (
             NEW.source_kind IN ('message_revision', 'message_tombstone')
             AND json_extract(corpus.safe_metadata_json, '$.messageId') = NEW.source_id
           ))
          WHERE snapshot.snapshot_id = NEW.snapshot_id
            AND corpus.corpus_seq > snapshot.raw_delta_from_exclusive
            AND corpus.corpus_seq <= snapshot.raw_delta_to_inclusive
            AND ((NEW.source_kind IN ('message_revision', 'message_tombstone')
                  AND corpus.source_kind IN ('message', 'message_revision', 'message_tombstone'))
              OR corpus.source_kind = NEW.source_kind)
        ))
      )
      OR NOT (
        (NEW.source_kind = 'message_revision' AND EXISTS (
          SELECT 1 FROM message_envelopes AS envelope
          WHERE envelope.message_id = NEW.source_id
            AND envelope.room_id = NEW.room_id
            AND envelope.current_revision = NEW.source_revision
            AND envelope.lifecycle = 'active'
        ))
        OR (NEW.source_kind = 'message_tombstone' AND NEW.currently_required = 0
          AND EXISTS (
            SELECT 1 FROM message_envelopes AS envelope
            WHERE envelope.message_id = NEW.source_id
              AND envelope.room_id = NEW.room_id
              AND envelope.current_revision = NEW.source_revision
              AND envelope.lifecycle = 'recalled'
          ))
        OR (NEW.source_kind = 'memory' AND EXISTS (
          SELECT 1 FROM room_memory_versions AS version
          JOIN room_memory_records AS record
            ON record.memory_record_id = version.memory_record_id
           AND record.room_id = version.room_id
           AND record.current_version_id = version.memory_version_id
          WHERE version.memory_version_id = NEW.source_id
            AND version.room_id = NEW.room_id
            AND version.version_number = NEW.source_revision
            AND version.state = 'active'
        ))
        OR (NEW.source_kind = 'attachment_extraction' AND EXISTS (
          SELECT 1 FROM attachments AS attachment
          WHERE substr(NEW.source_id, 1, 22) = 'attachment-extraction:'
            AND attachment.attachment_id = substr(NEW.source_id, 23)
            AND attachment.room_id = NEW.room_id
            AND attachment.processing_generation = NEW.source_revision
            AND attachment.processing_status = 'ready'
            AND attachment.source_operational_state = 'bound-active'
        ))
        OR (NEW.source_kind = 'project_fact_checkpoint' AND EXISTS (
          SELECT 1 FROM room_memory_project_checkpoint AS checkpoint
          WHERE checkpoint.room_id = NEW.room_id AND checkpoint.mode = 'enabled'
            AND checkpoint.health IN ('ready', 'degraded')
            AND checkpoint.checkpoint_id = NEW.source_id
            AND checkpoint.checkpoint_version = NEW.source_revision
        ))
        OR (NEW.currently_required = 0 AND (
          (NEW.source_kind = 'message_revision' AND EXISTS (
            SELECT 1
            FROM message_revisions AS revision
            JOIN messages AS message ON message.id = revision.message_id
            WHERE revision.message_id = NEW.source_id
              AND revision.revision = NEW.source_revision
              AND message.room_id = NEW.room_id
          ))
          OR (NEW.source_kind = 'memory' AND EXISTS (
            SELECT 1 FROM room_memory_versions AS version
            WHERE version.memory_version_id = NEW.source_id
              AND version.room_id = NEW.room_id
              AND version.version_number = NEW.source_revision
          ))
          OR (NEW.source_kind = 'attachment_extraction' AND EXISTS (
            SELECT 1 FROM attachments AS attachment
            JOIN attachment_extraction_artifacts AS artifact
              ON artifact.attachment_id = attachment.attachment_id
             AND artifact.processing_generation = NEW.source_revision
            WHERE substr(NEW.source_id, 1, 22) = 'attachment-extraction:'
              AND attachment.attachment_id = substr(NEW.source_id, 23)
              AND attachment.room_id = NEW.room_id
          ))
        ))
      )
   BEGIN SELECT RAISE(ABORT, 'Context snapshot source is unavailable or cross-Room'); END`,
  `CREATE TRIGGER context_snapshot_sources_v19_immutable_update
   BEFORE UPDATE ON context_snapshot_sources
   BEGIN SELECT RAISE(ABORT, 'Context snapshot source is immutable'); END`,
  `CREATE TRIGGER context_snapshot_sources_v19_immutable_delete
   BEFORE DELETE ON context_snapshot_sources
   BEGIN SELECT RAISE(ABORT, 'Context snapshot source is immutable'); END`,
  `CREATE TABLE context_manifest_range_sources (
    manifest_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    range_ordinal INTEGER NOT NULL CHECK (range_ordinal >= 0 AND range_ordinal < 4096),
    range_label_sha256 TEXT NOT NULL CHECK (
      length(range_label_sha256) = 64 AND range_label_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    corpus_seq INTEGER NOT NULL CHECK (corpus_seq >= 1),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message_revision', 'message_tombstone', 'attachment_extraction'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    source_index_sha256 TEXT NOT NULL CHECK (
      length(source_index_sha256) = 64 AND source_index_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (snapshot_id, range_ordinal, corpus_seq),
    UNIQUE (snapshot_id, range_ordinal, source_kind, source_id, source_revision),
    FOREIGN KEY (manifest_id, range_ordinal)
      REFERENCES context_manifest_items(manifest_id, ordinal),
    FOREIGN KEY (snapshot_id, source_kind, source_id, source_revision)
      REFERENCES context_snapshot_sources(snapshot_id, source_kind, source_id, source_revision)
  ) STRICT`,
  `CREATE INDEX context_manifest_range_sources_lookup_v19
   ON context_manifest_range_sources(snapshot_id, range_label_sha256, corpus_seq)`,
  `CREATE TRIGGER context_manifest_range_sources_v19_validate_insert
   BEFORE INSERT ON context_manifest_range_sources
   WHEN NOT EXISTS (
     SELECT 1
     FROM context_manifest_items AS item
     JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = item.snapshot_id
     JOIN room_memory_sources AS corpus
       ON corpus.room_id = snapshot.room_id
      AND corpus.corpus_seq = NEW.corpus_seq
     WHERE item.manifest_id = NEW.manifest_id AND item.snapshot_id = NEW.snapshot_id
       AND item.ordinal = NEW.range_ordinal AND item.source_kind IS NULL
       AND item.section = 'delta' AND item.disposition = 'index_only'
       AND item.source_label_sha256 = NEW.range_label_sha256
       AND json_extract(item.segment_json, '$.sourceIndexHash') = NEW.source_index_sha256
       AND (corpus.source_id = NEW.source_id OR (
         NEW.source_kind IN ('message_revision', 'message_tombstone')
         AND json_extract(corpus.safe_metadata_json, '$.messageId') = NEW.source_id
       ))
       AND corpus.source_revision = NEW.source_revision
       AND ((NEW.source_kind IN ('message_revision', 'message_tombstone')
             AND corpus.source_kind IN ('message', 'message_revision', 'message_tombstone'))
         OR corpus.source_kind = NEW.source_kind)
   )
   BEGIN SELECT RAISE(ABORT, 'Context manifest range source index is forged'); END`,
  `CREATE TRIGGER context_manifest_range_sources_v19_immutable_update
   BEFORE UPDATE ON context_manifest_range_sources
   BEGIN SELECT RAISE(ABORT, 'Context manifest range source index is immutable'); END`,
  `CREATE TRIGGER context_manifest_range_sources_v19_immutable_delete
   BEFORE DELETE ON context_manifest_range_sources
   BEGIN SELECT RAISE(ABORT, 'Context manifest range source index is immutable'); END`,
  `CREATE TABLE context_snapshot_bodies (
    snapshot_id TEXT PRIMARY KEY REFERENCES context_snapshots(snapshot_id),
    envelope_schema_version TEXT NOT NULL CHECK (
      length(trim(envelope_schema_version)) BETWEEN 1 AND 128
    ),
    canonical_envelope_json TEXT NOT NULL CHECK (
      json_valid(canonical_envelope_json)
      AND json_type(canonical_envelope_json) = 'object'
      AND length(CAST(canonical_envelope_json AS BLOB)) BETWEEN 2 AND 262144
    ),
    envelope_sha256 TEXT NOT NULL CHECK (
      length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 2 AND 262144),
    token_count INTEGER NOT NULL CHECK (token_count BETWEEN 1 AND 65536),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0)
  ) STRICT`,
  `CREATE TRIGGER context_snapshot_bodies_v19_validate_insert
   BEFORE INSERT ON context_snapshot_bodies
   WHEN NEW.byte_count <> length(CAST(NEW.canonical_envelope_json AS BLOB))
      OR NOT EXISTS (
        SELECT 1 FROM context_snapshots AS snapshot
        WHERE snapshot.snapshot_id = NEW.snapshot_id
          AND snapshot.envelope_sha256 = NEW.envelope_sha256
          AND snapshot.created_at = NEW.created_at
          AND snapshot.state = 'active'
          AND snapshot.payload_retention_state = 'required'
      )
   BEGIN SELECT RAISE(ABORT, 'Restricted context body does not match snapshot'); END`,
  `CREATE TRIGGER context_snapshot_bodies_v19_immutable_update
   BEFORE UPDATE ON context_snapshot_bodies
   BEGIN SELECT RAISE(ABORT, 'Restricted context body is immutable'); END`,
  `CREATE TRIGGER context_snapshot_bodies_v19_validate_delete
   BEFORE DELETE ON context_snapshot_bodies
   WHEN NOT EXISTS (
     SELECT 1 FROM context_snapshots AS snapshot
     WHERE snapshot.snapshot_id = OLD.snapshot_id
       AND snapshot.payload_retention_state = 'purge_pending'
   )
   BEGIN SELECT RAISE(ABORT, 'Restricted context body is still required'); END`,
  `CREATE TRIGGER context_snapshot_bodies_v19_mark_purged
   AFTER DELETE ON context_snapshot_bodies
   BEGIN
     UPDATE context_snapshots SET payload_retention_state = 'purged'
     WHERE snapshot_id = OLD.snapshot_id AND payload_retention_state = 'purge_pending';
   END`,
  `CREATE TABLE agent_execution_context_bindings (
    execution_id TEXT PRIMARY KEY REFERENCES agent_executions(id),
    snapshot_id TEXT NOT NULL UNIQUE REFERENCES context_snapshots(snapshot_id),
    invocation_intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
    bound_at TEXT NOT NULL CHECK (length(bound_at) > 0),
    UNIQUE (execution_id, snapshot_id)
  ) STRICT`,
  `CREATE INDEX agent_execution_context_bindings_intent_v19
   ON agent_execution_context_bindings(invocation_intent_id, execution_id)`,
  `CREATE TRIGGER agent_execution_context_bindings_v19_validate_insert
   BEFORE INSERT ON agent_execution_context_bindings
   WHEN NOT EXISTS (
     SELECT 1
     FROM agent_executions AS execution
     JOIN agent_execution_intent_links AS link
       ON link.execution_id = execution.id
     JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
     JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = NEW.snapshot_id
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = 1
     WHERE execution.id = NEW.execution_id
       AND execution.execution_generation = NEW.execution_generation
       AND execution.room_id = snapshot.room_id
       AND execution.agent_id = snapshot.agent_id
       AND execution.trigger_message_id = snapshot.trigger_message_id
       AND execution.provider_id = snapshot.provider_id
       AND execution.model_id = snapshot.model_id
       AND link.intent_id = NEW.invocation_intent_id
       AND intent.id = snapshot.invocation_intent_id
       AND snapshot.state = 'active'
       AND snapshot.snapshot_generation = 1
       AND execution.status IN ('queued', 'running')
       AND attempt.status IN ('queued', 'running')
   )
   BEGIN SELECT RAISE(ABORT, 'Execution context binding is stale or divergent'); END`,
  `CREATE TRIGGER agent_execution_context_bindings_v19_immutable_update
   BEFORE UPDATE ON agent_execution_context_bindings
   BEGIN SELECT RAISE(ABORT, 'Execution context binding is immutable'); END`,
  `CREATE TRIGGER agent_execution_context_bindings_v19_immutable_delete
   BEFORE DELETE ON agent_execution_context_bindings
   BEGIN SELECT RAISE(ABORT, 'Execution context binding is immutable'); END`,
  `CREATE TABLE agent_execution_context_attempts (
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    snapshot_id TEXT NOT NULL,
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    reuse_kind TEXT NOT NULL CHECK (
      reuse_kind IN ('first', 'automatic_retry', 'crash_recovery')
    ),
    bound_at TEXT NOT NULL CHECK (length(bound_at) > 0),
    PRIMARY KEY (execution_id, attempt_seq),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    FOREIGN KEY (execution_id, snapshot_id)
      REFERENCES agent_execution_context_bindings(execution_id, snapshot_id)
  ) STRICT`,
  `CREATE INDEX agent_execution_context_attempts_snapshot_v19
   ON agent_execution_context_attempts(snapshot_id, attempt_seq, execution_id)`,
  `CREATE TRIGGER agent_execution_context_attempts_v19_validate_insert
   BEFORE INSERT ON agent_execution_context_attempts
   WHEN NOT EXISTS (
     SELECT 1
     FROM agent_execution_context_bindings AS binding
     JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = binding.snapshot_id
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = binding.execution_id
      AND attempt.attempt_seq = NEW.attempt_seq
     WHERE binding.execution_id = NEW.execution_id
       AND binding.snapshot_id = NEW.snapshot_id
       AND snapshot.snapshot_generation = NEW.snapshot_generation
       AND snapshot.state = 'active'
       AND ((NEW.attempt_seq = 1 AND NEW.reuse_kind = 'first')
         OR (NEW.attempt_seq > 1 AND NEW.reuse_kind IN (
           'automatic_retry', 'crash_recovery'
         )))
   )
   BEGIN SELECT RAISE(ABORT, 'Attempt context binding is stale or divergent'); END`,
  `CREATE TRIGGER agent_execution_context_attempts_v19_immutable_update
   BEFORE UPDATE ON agent_execution_context_attempts
   BEGIN SELECT RAISE(ABORT, 'Attempt context binding is immutable'); END`,
  `CREATE TRIGGER agent_execution_context_attempts_v19_immutable_delete
   BEFORE DELETE ON agent_execution_context_attempts
   BEGIN SELECT RAISE(ABORT, 'Attempt context binding is immutable'); END`,
  `CREATE TABLE context_snapshot_lineage (
    child_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    parent_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    child_execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    parent_execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    relation TEXT NOT NULL CHECK (relation IN ('manual_retry', 'supersede')),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    CHECK (child_snapshot_id <> parent_snapshot_id),
    CHECK (child_execution_id <> parent_execution_id),
    PRIMARY KEY (child_snapshot_id, parent_snapshot_id),
    UNIQUE (child_execution_id, parent_execution_id)
  ) STRICT`,
  `CREATE INDEX context_snapshot_lineage_parent_v19
   ON context_snapshot_lineage(parent_snapshot_id, child_snapshot_id)`,
  `CREATE UNIQUE INDEX context_snapshot_lineage_manual_parent_v19
   ON context_snapshot_lineage(child_snapshot_id)
   WHERE relation = 'manual_retry'`,
  `CREATE TRIGGER context_snapshot_lineage_v19_validate_insert
   BEFORE INSERT ON context_snapshot_lineage
   WHEN NOT EXISTS (
     SELECT 1
     FROM agent_execution_context_bindings AS child_binding
     JOIN agent_execution_context_bindings AS parent_binding
       ON parent_binding.execution_id = NEW.parent_execution_id
     JOIN context_snapshots AS child_snapshot
       ON child_snapshot.snapshot_id = child_binding.snapshot_id
     JOIN context_snapshots AS parent_snapshot
       ON parent_snapshot.snapshot_id = parent_binding.snapshot_id
     JOIN agent_executions AS child_execution
       ON child_execution.id = child_binding.execution_id
     LEFT JOIN agent_execution_intent_links AS child_link
       ON child_link.execution_id = child_execution.id
     WHERE child_binding.execution_id = NEW.child_execution_id
       AND child_binding.snapshot_id = NEW.child_snapshot_id
       AND parent_binding.snapshot_id = NEW.parent_snapshot_id
       AND child_snapshot.room_id = parent_snapshot.room_id
       AND child_snapshot.agent_id = parent_snapshot.agent_id
       AND ((NEW.relation = 'manual_retry'
             AND child_link.retry_of_execution_id = NEW.parent_execution_id
             AND child_execution.manual_retry_of_execution_id = NEW.parent_execution_id)
         OR (NEW.relation = 'supersede'
             AND EXISTS (
               SELECT 1 FROM json_each(child_execution.supersedes_execution_ids_json)
               WHERE value = NEW.parent_execution_id
             )))
   )
   BEGIN SELECT RAISE(ABORT, 'Context snapshot lineage is inconsistent with execution lineage'); END`,
  `CREATE TRIGGER context_snapshot_lineage_v19_immutable_update
   BEFORE UPDATE ON context_snapshot_lineage
   BEGIN SELECT RAISE(ABORT, 'Context snapshot lineage is immutable'); END`,
  `CREATE TRIGGER context_snapshot_lineage_v19_immutable_delete
   BEFORE DELETE ON context_snapshot_lineage
   BEGIN SELECT RAISE(ABORT, 'Context snapshot lineage is immutable'); END`,
  `CREATE TABLE context_source_read_grants (
    grant_id TEXT PRIMARY KEY CHECK (length(trim(grant_id)) BETWEEN 1 AND 256),
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    tool_id TEXT NOT NULL CHECK (tool_id = 'room-memory.read'),
    parameter_sha256 TEXT NOT NULL CHECK (
      length(parameter_sha256) = 64 AND parameter_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
    expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_context_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TRIGGER context_source_read_grants_v19_immutable_update
   BEFORE UPDATE ON context_source_read_grants
   BEGIN SELECT RAISE(ABORT, 'Context source read grant is immutable'); END`,
  `CREATE TRIGGER context_source_read_grants_v19_immutable_delete
   BEFORE DELETE ON context_source_read_grants
   BEGIN SELECT RAISE(ABORT, 'Context source read grant is immutable'); END`,
  `CREATE TABLE context_source_read_dispatches (
    dispatch_id TEXT PRIMARY KEY CHECK (length(trim(dispatch_id)) BETWEEN 1 AND 256),
    grant_id TEXT NOT NULL UNIQUE REFERENCES context_source_read_grants(grant_id),
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    call_id TEXT NOT NULL CHECK (length(trim(call_id)) BETWEEN 1 AND 256),
    tool_id TEXT NOT NULL CHECK (tool_id = 'room-memory.read'),
    request_sha256 TEXT NOT NULL CHECK (
      length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    dispatched_at TEXT NOT NULL CHECK (length(dispatched_at) > 0),
    UNIQUE (execution_id, attempt_seq, call_id),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_context_attempts(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE TRIGGER context_source_read_dispatches_v19_validate_insert
   BEFORE INSERT ON context_source_read_dispatches
   WHEN NOT EXISTS (
     SELECT 1 FROM context_source_read_grants AS grant
     WHERE grant.grant_id = NEW.grant_id
       AND grant.execution_id = NEW.execution_id
       AND grant.attempt_seq = NEW.attempt_seq
       AND grant.tool_id = NEW.tool_id
       AND grant.parameter_sha256 = NEW.request_sha256
       AND grant.issued_at <= NEW.dispatched_at
       AND grant.expires_at > NEW.dispatched_at
   )
   BEGIN SELECT RAISE(ABORT, 'Context source read dispatch is outside its grant'); END`,
  `CREATE TRIGGER context_source_read_dispatches_v19_immutable_update
   BEFORE UPDATE ON context_source_read_dispatches
   BEGIN SELECT RAISE(ABORT, 'Context source read dispatch is immutable'); END`,
  `CREATE TRIGGER context_source_read_dispatches_v19_immutable_delete
   BEFORE DELETE ON context_source_read_dispatches
   BEGIN SELECT RAISE(ABORT, 'Context source read dispatch is immutable'); END`,
  `CREATE TABLE context_source_reads (
    read_id TEXT PRIMARY KEY CHECK (length(trim(read_id)) BETWEEN 1 AND 256),
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    execution_id TEXT NOT NULL,
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    call_id TEXT NOT NULL CHECK (length(trim(call_id)) BETWEEN 1 AND 256),
    grant_id TEXT NOT NULL REFERENCES context_source_read_grants(grant_id),
    dispatch_id TEXT NOT NULL UNIQUE REFERENCES context_source_read_dispatches(dispatch_id),
    tool_id TEXT NOT NULL CHECK (tool_id = 'room-memory.read'),
    request_sha256 TEXT NOT NULL CHECK (
      length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_label_sha256 TEXT NOT NULL CHECK (
      length(source_label_sha256) = 64 AND source_label_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    mode TEXT NOT NULL CHECK (mode IN (
      'source', 'neighbors', 'attachment_segment', 'memory_sources', 'project_object'
    )),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message_revision', 'message_tombstone', 'memory',
      'attachment_extraction', 'project_fact_checkpoint', 'delta_range'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
    page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 8),
    page_offset INTEGER NOT NULL CHECK (page_offset BETWEEN 0 AND 262144),
    cursor_sha256 TEXT CHECK (
      cursor_sha256 IS NULL OR (
        length(cursor_sha256) = 64 AND cursor_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    artifact_sha256 TEXT CHECK (
      artifact_sha256 IS NULL OR (
        length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    artifact_range_start INTEGER CHECK (
      artifact_range_start IS NULL OR artifact_range_start >= 0
    ),
    artifact_range_end INTEGER CHECK (
      artifact_range_end IS NULL OR artifact_range_end > artifact_range_start
    ),
    status TEXT NOT NULL CHECK (status IN (
      'claimed', 'page_ready', 'completed', 'failed', 'invalidated'
    )),
    result_sha256 TEXT CHECK (
      result_sha256 IS NULL OR (
        length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
    result_bytes INTEGER CHECK (result_bytes IS NULL OR result_bytes BETWEEN 2 AND 32768),
    result_tokens INTEGER CHECK (result_tokens IS NULL OR result_tokens BETWEEN 1 AND 32768),
    accounted_bytes INTEGER CHECK (
      accounted_bytes IS NULL OR accounted_bytes BETWEEN 1 AND 262144
    ),
    error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    completed_at TEXT,
    UNIQUE (execution_id, attempt_seq, call_id),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_context_attempts(execution_id, attempt_seq),
    FOREIGN KEY (execution_id, attempt_seq, call_id)
      REFERENCES context_source_read_dispatches(execution_id, attempt_seq, call_id),
    CHECK (
      (artifact_sha256 IS NULL AND artifact_range_start IS NULL AND artifact_range_end IS NULL)
      OR (mode = 'attachment_segment' AND source_kind = 'attachment_extraction'
          AND artifact_sha256 IS NOT NULL AND artifact_range_start IS NOT NULL
          AND artifact_range_end IS NOT NULL)
    ),
    CHECK (
      (status = 'claimed' AND result_sha256 IS NULL AND result_bytes IS NULL
        AND result_tokens IS NULL AND accounted_bytes IS NULL
        AND error_code IS NULL AND completed_at IS NULL)
      OR (status = 'page_ready' AND result_sha256 IS NOT NULL AND result_bytes IS NOT NULL
        AND result_tokens IS NOT NULL AND accounted_bytes IS NOT NULL
        AND error_code IS NULL AND completed_at IS NOT NULL)
      OR (status = 'completed' AND result_sha256 IS NOT NULL AND result_bytes IS NOT NULL
        AND result_tokens IS NOT NULL AND accounted_bytes IS NOT NULL
        AND error_code IS NULL AND completed_at IS NOT NULL)
      OR (status IN ('failed', 'invalidated') AND result_sha256 IS NULL
        AND result_bytes IS NULL AND result_tokens IS NULL AND accounted_bytes IS NULL
        AND error_code IS NOT NULL AND completed_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX context_source_reads_snapshot_v19
   ON context_source_reads(snapshot_id, status, created_at, read_id)`,
  `CREATE TRIGGER context_source_reads_v19_validate_insert
   BEFORE INSERT ON context_source_reads
   WHEN NEW.status <> 'claimed'
      OR NOT EXISTS (
        SELECT 1
        FROM agent_execution_context_attempts AS attempt_binding
        JOIN context_snapshots AS snapshot
          ON snapshot.snapshot_id = attempt_binding.snapshot_id
        JOIN agent_execution_attempts AS attempt
          ON attempt.execution_id = attempt_binding.execution_id
         AND attempt.attempt_seq = attempt_binding.attempt_seq
        JOIN context_snapshot_sources AS source
          ON source.snapshot_id = attempt_binding.snapshot_id
        WHERE attempt_binding.execution_id = NEW.execution_id
          AND attempt_binding.attempt_seq = NEW.attempt_seq
          AND attempt_binding.snapshot_id = NEW.snapshot_id
          AND attempt_binding.snapshot_generation = NEW.snapshot_generation
          AND snapshot.state = 'active'
          AND attempt.status = 'running'
          AND ((source.source_label_sha256 = NEW.source_label_sha256
                AND source.source_kind = NEW.source_kind
                AND source.source_id = NEW.source_id
                AND source.source_revision = NEW.source_revision
                AND source.authorization_revision = NEW.authorization_epoch)
            OR (NEW.source_kind = 'delta_range'
                AND NEW.authorization_epoch = snapshot.membership_access_revision
                AND EXISTS (
                  SELECT 1 FROM context_manifest_range_sources AS range_source
                  WHERE range_source.snapshot_id = NEW.snapshot_id
                    AND range_source.range_label_sha256 = NEW.source_label_sha256
                    AND range_source.source_index_sha256 = NEW.source_id
                    AND range_source.range_ordinal + 1 = NEW.source_revision
                )))
      )
      OR (SELECT COUNT(*) FROM context_source_reads
          WHERE execution_id = NEW.execution_id) >= 32
      OR NOT EXISTS (
        SELECT 1
        FROM context_source_read_grants AS grant
        JOIN context_source_read_dispatches AS dispatch
          ON dispatch.grant_id = grant.grant_id
        WHERE grant.grant_id = NEW.grant_id
          AND dispatch.dispatch_id = NEW.dispatch_id
          AND grant.execution_id = NEW.execution_id
          AND dispatch.execution_id = NEW.execution_id
          AND grant.attempt_seq = NEW.attempt_seq
          AND dispatch.attempt_seq = NEW.attempt_seq
          AND dispatch.call_id = NEW.call_id
          AND grant.tool_id = NEW.tool_id
          AND dispatch.tool_id = NEW.tool_id
          AND grant.parameter_sha256 = dispatch.request_sha256
          AND grant.expires_at > NEW.created_at
      )
   BEGIN SELECT RAISE(ABORT, 'Context source read authority or capacity is invalid'); END`,
  `CREATE TRIGGER context_source_reads_v19_validate_update
   BEFORE UPDATE ON context_source_reads
   WHEN NEW.read_id <> OLD.read_id OR NEW.snapshot_id <> OLD.snapshot_id
      OR NEW.execution_id <> OLD.execution_id OR NEW.attempt_seq <> OLD.attempt_seq
      OR NEW.snapshot_generation <> OLD.snapshot_generation
      OR NEW.call_id <> OLD.call_id OR NEW.grant_id <> OLD.grant_id
      OR NEW.dispatch_id <> OLD.dispatch_id OR NEW.tool_id <> OLD.tool_id
      OR NEW.request_sha256 <> OLD.request_sha256
      OR NEW.source_label_sha256 <> OLD.source_label_sha256 OR NEW.mode <> OLD.mode
      OR NEW.source_kind <> OLD.source_kind OR NEW.source_id <> OLD.source_id
      OR NEW.source_revision <> OLD.source_revision
      OR NEW.authorization_epoch <> OLD.authorization_epoch
      OR NEW.page_size <> OLD.page_size OR NEW.page_offset <> OLD.page_offset
      OR NEW.cursor_sha256 IS NOT OLD.cursor_sha256 OR NEW.created_at <> OLD.created_at
      OR NOT ((OLD.status = 'claimed' AND NEW.status IN (
                'page_ready', 'failed', 'invalidated'
              ))
        OR (OLD.status = 'page_ready' AND NEW.status = 'completed'
            AND NEW.result_sha256 = OLD.result_sha256
            AND NEW.result_bytes = OLD.result_bytes
            AND NEW.result_tokens = OLD.result_tokens
            AND NEW.accounted_bytes = OLD.accounted_bytes
            AND NEW.completed_at = OLD.completed_at
            AND NEW.artifact_sha256 IS OLD.artifact_sha256
            AND NEW.artifact_range_start IS OLD.artifact_range_start
            AND NEW.artifact_range_end IS OLD.artifact_range_end)
        OR (OLD.status = 'page_ready' AND NEW.status IN ('failed', 'invalidated')
            AND NEW.result_sha256 IS NULL AND NEW.result_bytes IS NULL
            AND NEW.result_tokens IS NULL AND NEW.accounted_bytes IS NULL))
      OR (OLD.status <> 'claimed' AND (
            NEW.artifact_sha256 IS NOT OLD.artifact_sha256
            OR NEW.artifact_range_start IS NOT OLD.artifact_range_start
            OR NEW.artifact_range_end IS NOT OLD.artifact_range_end
          ))
      OR NOT EXISTS (
        SELECT 1 FROM context_snapshots AS snapshot
        WHERE snapshot.snapshot_id = OLD.snapshot_id
          AND snapshot.snapshot_generation = OLD.snapshot_generation
          AND (NEW.status = 'invalidated' OR snapshot.state = 'active')
      )
   BEGIN SELECT RAISE(ABORT, 'Context source read terminal CAS is invalid'); END`,
  `CREATE TRIGGER context_source_reads_v19_immutable_delete
   BEFORE DELETE ON context_source_reads
   BEGIN SELECT RAISE(ABORT, 'Context source read metadata is immutable'); END`,
  `CREATE TABLE context_source_read_payloads (
    read_id TEXT PRIMARY KEY REFERENCES context_source_reads(read_id),
    canonical_result_json TEXT NOT NULL CHECK (
      json_valid(canonical_result_json) AND json_type(canonical_result_json) = 'object'
      AND length(CAST(canonical_result_json AS BLOB)) BETWEEN 2 AND 32768
    ),
    result_sha256 TEXT NOT NULL CHECK (
      length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 2 AND 32768),
    token_count INTEGER NOT NULL CHECK (token_count BETWEEN 1 AND 32768),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0)
  ) STRICT`,
  `CREATE TRIGGER context_source_read_payloads_v19_validate_insert
   BEFORE INSERT ON context_source_read_payloads
   WHEN NEW.byte_count <> length(CAST(NEW.canonical_result_json AS BLOB))
      OR NOT EXISTS (
        SELECT 1 FROM context_source_reads AS source_read
        WHERE source_read.read_id = NEW.read_id
          AND source_read.status IN ('page_ready', 'completed')
          AND source_read.result_sha256 = NEW.result_sha256
          AND source_read.result_bytes = NEW.byte_count
          AND source_read.result_tokens = NEW.token_count
          AND source_read.completed_at = NEW.created_at
      )
   BEGIN SELECT RAISE(ABORT, 'Restricted source read payload does not match receipt'); END`,
  `CREATE TRIGGER context_source_read_payloads_v19_immutable_update
   BEFORE UPDATE ON context_source_read_payloads
   BEGIN SELECT RAISE(ABORT, 'Restricted source read payload is immutable'); END`,
  `CREATE TRIGGER context_source_read_payloads_v19_validate_delete
   BEFORE DELETE ON context_source_read_payloads
   WHEN EXISTS (
     SELECT 1
     FROM context_source_reads AS source_read
     JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = source_read.snapshot_id
     WHERE source_read.read_id = OLD.read_id
       AND snapshot.payload_retention_state = 'required'
       AND source_read.status NOT IN ('failed', 'invalidated')
   )
   BEGIN SELECT RAISE(ABORT, 'Restricted source read payload is still required'); END`,
  `CREATE TABLE context_source_read_receipts (
    receipt_id TEXT PRIMARY KEY CHECK (length(trim(receipt_id)) BETWEEN 1 AND 256),
    read_id TEXT NOT NULL UNIQUE REFERENCES context_source_reads(read_id),
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    call_id TEXT NOT NULL CHECK (length(trim(call_id)) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL UNIQUE REFERENCES context_source_read_dispatches(dispatch_id),
    source_label_sha256 TEXT NOT NULL CHECK (
      length(source_label_sha256) = 64 AND source_label_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'message_revision', 'message_tombstone', 'memory',
      'attachment_extraction', 'project_fact_checkpoint', 'delta_range'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    citation_label_sha256 TEXT NOT NULL CHECK (
      length(citation_label_sha256) = 64 AND citation_label_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    result_sha256 TEXT NOT NULL CHECK (
      length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    representation TEXT NOT NULL CHECK (representation IN (
      'source', 'neighbors', 'attachment_segment', 'memory_sources'
    )),
    range_text TEXT NOT NULL CHECK (length(trim(range_text)) BETWEEN 1 AND 1024),
    content_sha256 TEXT NOT NULL CHECK (
      length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 2 AND 32768),
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
    issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
    UNIQUE (snapshot_id, citation_label_sha256)
  ) STRICT`,
  `CREATE INDEX context_source_read_receipts_source_v19
   ON context_source_read_receipts(source_kind, source_id, source_revision, snapshot_id)`,
  `CREATE TRIGGER context_source_read_receipts_v19_validate_insert
   BEFORE INSERT ON context_source_read_receipts
   WHEN NOT EXISTS (
     SELECT 1
     FROM context_source_reads AS source_read
     JOIN context_source_read_payloads AS payload ON payload.read_id = source_read.read_id
     JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = source_read.snapshot_id
     WHERE source_read.read_id = NEW.read_id
       AND source_read.status = 'completed'
       AND source_read.snapshot_id = NEW.snapshot_id
       AND source_read.execution_id = NEW.execution_id
       AND snapshot.room_id = NEW.room_id
       AND source_read.attempt_seq = NEW.attempt_seq
       AND source_read.call_id = NEW.call_id
       AND source_read.dispatch_id = NEW.dispatch_id
       AND source_read.source_label_sha256 = NEW.source_label_sha256
       AND source_read.source_kind = NEW.source_kind
       AND source_read.source_id = NEW.source_id
       AND source_read.source_revision = NEW.source_revision
       AND source_read.snapshot_generation = NEW.snapshot_generation
       AND source_read.result_sha256 = NEW.result_sha256
       AND source_read.mode = NEW.representation
       AND source_read.authorization_epoch = NEW.authorization_epoch
       AND source_read.completed_at = NEW.issued_at
       AND payload.result_sha256 = NEW.result_sha256
       AND snapshot.state = 'active'
   )
   BEGIN SELECT RAISE(ABORT, 'Context source read receipt is forged or stale'); END`,
  `CREATE TRIGGER context_source_read_receipts_v19_immutable_update
   BEFORE UPDATE ON context_source_read_receipts
   BEGIN SELECT RAISE(ABORT, 'Context source read receipt is immutable'); END`,
  `CREATE TRIGGER context_source_read_receipts_v19_immutable_delete
   BEFORE DELETE ON context_source_read_receipts
   BEGIN SELECT RAISE(ABORT, 'Context source read receipt is immutable'); END`,
  `CREATE TABLE agent_message_citations (
    message_id TEXT NOT NULL REFERENCES agent_message_sources(message_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 4096),
    execution_id TEXT NOT NULL REFERENCES agent_executions(id),
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
    receipt_id TEXT REFERENCES context_source_read_receipts(receipt_id),
    manifest_item_ordinal INTEGER,
    citation_label_sha256 TEXT NOT NULL CHECK (
      length(citation_label_sha256) = 64 AND citation_label_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'policy', 'trigger', 'message', 'message_revision', 'message_tombstone',
      'memory', 'attachment', 'attachment_extraction', 'project',
      'project_fact_checkpoint', 'tool', 'retrieval', 'delta_range'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 512),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
    snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (message_id, ordinal),
    UNIQUE (message_id, citation_label_sha256),
    CHECK ((receipt_id IS NULL) <> (manifest_item_ordinal IS NULL))
  ) STRICT`,
  `CREATE INDEX agent_message_citations_snapshot_v19
   ON agent_message_citations(snapshot_id, source_kind, source_id, source_revision)`,
  `CREATE TRIGGER agent_message_citations_v19_validate_insert
   BEFORE INSERT ON agent_message_citations
   WHEN NEW.ordinal <> (
       SELECT COUNT(*) FROM agent_message_citations WHERE message_id = NEW.message_id
     )
      OR NOT EXISTS (
        SELECT 1
        FROM agent_message_sources AS message_source
        JOIN agent_execution_context_bindings AS binding
          ON binding.execution_id = message_source.execution_id
        JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = binding.snapshot_id
        WHERE message_source.message_id = NEW.message_id
          AND message_source.execution_id = NEW.execution_id
          AND binding.snapshot_id = NEW.snapshot_id
          AND snapshot.snapshot_generation = NEW.snapshot_generation
          AND snapshot.state = 'active'
      )
      OR NOT (
        (NEW.receipt_id IS NULL AND EXISTS (
          SELECT 1 FROM context_manifest_items AS item
          WHERE item.snapshot_id = NEW.snapshot_id
            AND item.ordinal = NEW.manifest_item_ordinal
            AND item.source_label_sha256 = NEW.citation_label_sha256
            AND item.source_kind = NEW.source_kind
            AND item.source_id = NEW.source_id
            AND item.source_revision = NEW.source_revision
            AND item.disposition NOT IN ('omitted', 'unavailable', 'invalidated')
        ))
        OR (NEW.manifest_item_ordinal IS NULL AND EXISTS (
          SELECT 1 FROM context_source_read_receipts AS receipt
          WHERE receipt.receipt_id = NEW.receipt_id
            AND receipt.snapshot_id = NEW.snapshot_id
            AND receipt.execution_id = NEW.execution_id
            AND receipt.citation_label_sha256 = NEW.citation_label_sha256
            AND receipt.source_kind = NEW.source_kind
            AND receipt.source_id = NEW.source_id
            AND receipt.source_revision = NEW.source_revision
            AND receipt.snapshot_generation = NEW.snapshot_generation
        ))
      )
   BEGIN SELECT RAISE(ABORT, 'Agent message citation is forged or stale'); END`,
  `CREATE TRIGGER agent_message_citations_v19_immutable_update
   BEFORE UPDATE ON agent_message_citations
   BEGIN SELECT RAISE(ABORT, 'Agent message citation is immutable'); END`,
  `CREATE TRIGGER agent_message_citations_v19_immutable_delete
   BEFORE DELETE ON agent_message_citations
   BEGIN SELECT RAISE(ABORT, 'Agent message citation is immutable'); END`,
  `CREATE TRIGGER message_envelopes_v19_invalidate_context_recall
   AFTER UPDATE OF lifecycle ON message_envelopes
   WHEN NEW.lifecycle = 'recalled' AND OLD.lifecycle = 'active'
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = NEW.recalled_at, invalidation_reason = 'message_recalled'
     WHERE state = 'active' AND (
       (trigger_message_id = NEW.message_id AND trigger_revision = NEW.current_revision)
       OR snapshot_id IN (
         SELECT source.snapshot_id FROM context_snapshot_sources AS source
         WHERE source.room_id = NEW.room_id
           AND source.currently_required = 1
           AND source.source_kind IN ('message_revision', 'message_tombstone')
           AND source.source_id = NEW.message_id
       )
     );
   END`,
  `CREATE TRIGGER message_envelopes_v19_invalidate_context_revision
   AFTER UPDATE OF current_revision ON message_envelopes
   WHEN NEW.current_revision <> OLD.current_revision
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = NEW.created_at, invalidation_reason = 'message_revised'
     WHERE state = 'active' AND (
       (trigger_message_id = NEW.message_id AND trigger_revision = OLD.current_revision)
       OR snapshot_id IN (
         SELECT source.snapshot_id FROM context_snapshot_sources AS source
         WHERE source.room_id = NEW.room_id AND source.currently_required = 1
           AND source.source_kind = 'message_revision'
           AND source.source_id = NEW.message_id
           AND source.source_revision = OLD.current_revision
       )
     );
   END`,
  `CREATE TRIGGER rooms_v19_invalidate_context_archive
   AFTER UPDATE OF status ON rooms
   WHEN NEW.status = 'archived' AND OLD.status = 'active'
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = COALESCE(NEW.archived_at, NEW.created_at),
         invalidation_reason = 'room_archived'
     WHERE room_id = NEW.id AND state = 'active';
   END`,
  `CREATE TRIGGER room_memberships_v19_invalidate_context_update
   AFTER UPDATE OF participation, access_revision, tool_permissions_json ON room_memberships
   WHEN NEW.kind = 'agent' AND (
     NEW.participation IS NOT OLD.participation
     OR NEW.access_revision <> OLD.access_revision
     OR NEW.tool_permissions_json <> OLD.tool_permissions_json
   )
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = COALESCE(NEW.configured_at, NEW.joined_at, created_at),
         invalidation_reason = 'authorization_changed'
     WHERE room_id = NEW.room_id AND agent_id = NEW.actor_id AND state = 'active';
   END`,
  `CREATE TRIGGER room_memberships_v19_invalidate_context_delete
   AFTER DELETE ON room_memberships
   WHEN OLD.kind = 'agent'
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = OLD.configured_at, invalidation_reason = 'membership_revoked'
     WHERE room_id = OLD.room_id AND agent_id = OLD.actor_id AND state = 'active';
   END`,
  `CREATE TRIGGER room_memory_sources_v19_invalidate_context
   AFTER UPDATE OF eligibility, availability ON room_memory_sources
   WHEN NEW.eligibility <> 'eligible' OR NEW.availability <> 'readable'
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = NEW.updated_at, invalidation_reason = 'memory_invalidated'
     WHERE state = 'active' AND snapshot_id IN (
       SELECT source.snapshot_id FROM context_snapshot_sources AS source
       WHERE source.room_id = NEW.room_id
         AND source.currently_required = 1
         AND ((source.source_kind = 'message_revision'
               AND NEW.source_kind IN ('message', 'message_revision'))
           OR (source.source_kind = 'message_tombstone'
               AND NEW.source_kind = 'message_tombstone')
           OR (source.source_kind = 'attachment_extraction'
               AND NEW.source_kind IN ('attachment', 'attachment_extraction')))
         AND source.source_id = CASE
           WHEN NEW.source_kind IN ('message', 'message_revision', 'message_tombstone')
             THEN COALESCE(json_extract(NEW.safe_metadata_json, '$.messageId'), NEW.source_id)
           ELSE NEW.source_id
         END
         AND source.source_revision = NEW.source_revision
     );
   END`,
  `CREATE TRIGGER room_memory_records_v19_invalidate_context
   AFTER UPDATE OF current_version_id ON room_memory_records
   WHEN NEW.current_version_id IS NOT OLD.current_version_id
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = NEW.updated_at, invalidation_reason = 'memory_invalidated'
     WHERE state = 'active' AND snapshot_id IN (
       SELECT source.snapshot_id FROM context_snapshot_sources AS source
       WHERE source.room_id = NEW.room_id AND source.currently_required = 1
         AND source.source_kind = 'memory'
         AND source.source_id = OLD.current_version_id
     );
   END`,
  `CREATE TRIGGER attachments_v19_invalidate_context
   AFTER UPDATE OF processing_status, processing_generation, source_operational_state ON attachments
   WHEN NEW.processing_status <> 'ready' OR NEW.source_operational_state <> 'bound-active'
      OR NEW.processing_generation <> OLD.processing_generation
   BEGIN
     UPDATE context_snapshots
     SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
         invalidated_at = NEW.updated_at, invalidation_reason = 'attachment_invalidated'
     WHERE state = 'active' AND snapshot_id IN (
       SELECT source.snapshot_id FROM context_snapshot_sources AS source
       WHERE source.room_id = NEW.room_id
         AND source.currently_required = 1
         AND source.source_kind = 'attachment_extraction'
         AND source.source_id = 'attachment-extraction:' || NEW.attachment_id
         AND source.source_revision = OLD.processing_generation
     );
   END`,
] as const;

const V20_STATEMENTS = [
  `ALTER TABLE agent_profiles ADD COLUMN display_name TEXT NOT NULL
   DEFAULT 'Migrated Agent' CHECK (
     length(trim(display_name)) BETWEEN 1 AND 120 AND display_name = trim(display_name)
   )`,
  `ALTER TABLE agent_profiles ADD COLUMN global_responsibility TEXT NOT NULL
   DEFAULT 'Review migrated Agent configuration before use.' CHECK (
     length(trim(global_responsibility)) BETWEEN 1 AND 4000
     AND global_responsibility = trim(global_responsibility)
   )`,
  `ALTER TABLE agent_profiles ADD COLUMN created_at TEXT NOT NULL
   DEFAULT '1970-01-01T00:00:00.000Z' CHECK (length(created_at) > 0)`,
  `ALTER TABLE agent_profiles ADD COLUMN updated_at TEXT NOT NULL
   DEFAULT '1970-01-01T00:00:00.000Z' CHECK (length(updated_at) > 0)`,
  `ALTER TABLE agent_profiles ADD COLUMN source_kind TEXT NOT NULL
   DEFAULT 'legacy_v20_migration' CHECK (
     source_kind IN ('legacy_v20_migration', 'administrator_command', 'static_bootstrap')
   )`,
  `ALTER TABLE room_agent_assignments ADD COLUMN room_responsibility TEXT NOT NULL
   DEFAULT 'Review migrated Room assignment before use.' CHECK (
     length(trim(room_responsibility)) BETWEEN 1 AND 4000
     AND room_responsibility = trim(room_responsibility)
   )`,
  `ALTER TABLE room_agent_assignments ADD COLUMN created_at TEXT NOT NULL
   DEFAULT '1970-01-01T00:00:00.000Z' CHECK (length(created_at) > 0)`,
  `ALTER TABLE room_agent_assignments ADD COLUMN updated_at TEXT NOT NULL
   DEFAULT '1970-01-01T00:00:00.000Z' CHECK (length(updated_at) > 0)`,
  `ALTER TABLE room_agent_assignments ADD COLUMN removed_at TEXT
   CHECK (removed_at IS NULL OR length(removed_at) > 0)`,
  `ALTER TABLE room_agent_assignments ADD COLUMN source_kind TEXT NOT NULL
   DEFAULT 'legacy_v20_migration' CHECK (
     source_kind IN ('legacy_v20_migration', 'room_command', 'static_bootstrap')
   )`,
  `CREATE TABLE agent_authority_migration_provenance (
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'existing_v14_profile', 'legacy_actor_profile', 'existing_v14_assignment',
      'legacy_room_membership_assignment', 'legacy_silent_assignment',
      'unknown_authority_reduction'
    )),
    source_object_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES actors(id),
    profile_id TEXT REFERENCES agent_profiles(id),
    room_id TEXT REFERENCES rooms(id),
    assignment_id TEXT REFERENCES room_agent_assignments(id),
    source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 19),
    source_participation TEXT CHECK (
      source_participation IS NULL OR source_participation IN ('active', 'on-mention', 'silent')
    ),
    source_authority_json TEXT NOT NULL CHECK (
      json_valid(source_authority_json) AND json_type(source_authority_json) = 'object'
    ),
    review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_kind, source_object_id)
  ) STRICT`,
  `INSERT INTO agent_authority_migration_provenance (
     source_kind, source_object_id, actor_id, profile_id, room_id, assignment_id,
     source_schema_version, source_participation, source_authority_json,
     review_required, migrated_at
   )
   SELECT 'existing_v14_profile', profile.id, profile.actor_id, profile.id, NULL, NULL,
     19, NULL, json_object(
       'capabilityCeiling', json(profile.capability_ceiling_json),
       'toolCeiling', json(profile.tool_ceiling_json)
     ),
     CASE WHEN EXISTS (
       SELECT 1 FROM json_each(profile.capability_ceiling_json)
       WHERE value NOT IN (
         'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
       )
     ) OR EXISTS (
       SELECT 1 FROM json_each(profile.tool_ceiling_json)
       WHERE value NOT IN (
         'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
       )
     ) THEN 1 ELSE 0 END,
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM agent_profiles AS profile`,
  `INSERT INTO agent_authority_migration_provenance (
     source_kind, source_object_id, actor_id, profile_id, room_id, assignment_id,
     source_schema_version, source_participation, source_authority_json,
     review_required, migrated_at
   )
   SELECT 'existing_v14_assignment', assignment.id, assignment.agent_actor_id,
     assignment.profile_id, assignment.room_id, assignment.id, 19,
     assignment.participation, json_object(
       'capabilitySubset', json(assignment.capability_subset_json),
       'toolSubset', json(assignment.tool_subset_json),
       'paused', json(assignment.paused)
     ),
     CASE WHEN EXISTS (
       SELECT 1 FROM json_each(assignment.capability_subset_json)
       WHERE value NOT IN (
         'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
       )
     ) OR EXISTS (
       SELECT 1 FROM json_each(assignment.tool_subset_json)
       WHERE value NOT IN (
         'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
       )
     ) THEN 1 ELSE 0 END,
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM room_agent_assignments AS assignment`,
  `INSERT INTO agent_authority_migration_provenance (
     source_kind, source_object_id, actor_id, profile_id, room_id, assignment_id,
     source_schema_version, source_participation, source_authority_json,
     review_required, migrated_at
   )
   SELECT 'legacy_silent_assignment', json_array(membership.room_id, membership.actor_id),
     membership.actor_id, profile.id, membership.room_id, assignment.id, 19,
     'silent', json_object('toolPermissions', json(membership.tool_permissions_json)),
     1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM room_memberships AS membership
   LEFT JOIN agent_profiles AS profile ON profile.actor_id = membership.actor_id
   LEFT JOIN room_agent_assignments AS assignment
     ON assignment.room_id = membership.room_id
    AND assignment.agent_actor_id = membership.actor_id
    AND assignment.status = 'current'
   WHERE membership.kind = 'agent' AND membership.participation = 'silent'`,
  `UPDATE room_agent_assignments
   SET paused = CASE
         WHEN EXISTS (
           SELECT 1 FROM json_each(capability_subset_json)
           WHERE value NOT IN (
             'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
           )
         ) OR EXISTS (
           SELECT 1 FROM json_each(tool_subset_json)
           WHERE value NOT IN (
             'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
           )
         ) THEN 1 ELSE paused END,
       capability_subset_json = COALESCE((
         SELECT json_group_array(value) FROM (
           SELECT DISTINCT value FROM json_each(capability_subset_json)
           WHERE value IN (
             'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
           ) ORDER BY value
         )
       ), '[]'),
       tool_subset_json = COALESCE((
         SELECT json_group_array(value) FROM (
           SELECT DISTINCT value FROM json_each(tool_subset_json)
           WHERE value IN (
             'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
           ) ORDER BY value
         )
       ), '[]'),
       removed_at = CASE WHEN status = 'removed' THEN COALESCE(removed_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE NULL END,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  `UPDATE agent_profiles
   SET display_name = (SELECT actor.display_name FROM actors AS actor
                       WHERE actor.id = agent_profiles.actor_id),
       status = CASE WHEN EXISTS (
         SELECT 1 FROM json_each(capability_ceiling_json)
         WHERE value NOT IN (
           'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
         )
       ) OR EXISTS (
         SELECT 1 FROM json_each(tool_ceiling_json)
         WHERE value NOT IN (
           'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
         )
       ) THEN 'disabled' ELSE status END,
       capability_ceiling_json = COALESCE((
         SELECT json_group_array(value) FROM (
           SELECT DISTINCT value FROM json_each(capability_ceiling_json)
           WHERE value IN (
             'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
           ) ORDER BY value
         )
       ), '[]'),
       tool_ceiling_json = COALESCE((
         SELECT json_group_array(value) FROM (
           SELECT DISTINCT value FROM json_each(tool_ceiling_json)
           WHERE value IN (
             'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
           ) ORDER BY value
         )
       ), '[]'),
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  `INSERT INTO agent_profiles (
     id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
     display_name, global_responsibility, created_at, updated_at, source_kind
   )
   SELECT 'legacy-profile:' || actor.id, actor.id, 1,
     CASE WHEN EXISTS (
       SELECT 1 FROM json_each(actor.tool_permissions_json)
       WHERE value NOT IN (
         'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
       )
     ) THEN 'disabled' ELSE 'enabled' END,
     '[]', COALESCE((
       SELECT json_group_array(value) FROM (
         SELECT DISTINCT value FROM json_each(actor.tool_permissions_json)
         WHERE value IN (
           'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
         ) ORDER BY value
       )
     ), '[]'), actor.display_name, 'Review migrated Agent configuration before use.',
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
     'legacy_v20_migration'
   FROM actors AS actor
   WHERE actor.kind = 'agent'
     AND NOT EXISTS (SELECT 1 FROM agent_profiles AS profile WHERE profile.actor_id = actor.id)`,
  `INSERT INTO agent_authority_migration_provenance (
     source_kind, source_object_id, actor_id, profile_id, room_id, assignment_id,
     source_schema_version, source_participation, source_authority_json,
     review_required, migrated_at
   )
   SELECT 'legacy_actor_profile', actor.id, actor.id, profile.id, NULL, NULL, 19,
     NULL, json_object(
       'displayName', actor.display_name,
       'toolPermissions', json(actor.tool_permissions_json),
       'legacyReadiness', actor.readiness
     ),
     CASE WHEN profile.status = 'disabled' THEN 1 ELSE 0 END,
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM actors AS actor
   JOIN agent_profiles AS profile ON profile.actor_id = actor.id
   WHERE actor.kind = 'agent'
     AND NOT EXISTS (
       SELECT 1 FROM agent_authority_migration_provenance AS provenance
       WHERE provenance.source_kind = 'existing_v14_profile'
         AND provenance.profile_id = profile.id
     )`,
  `INSERT INTO room_agent_assignments (
     id, room_id, profile_id, agent_actor_id, revision, status, participation,
     paused, capability_subset_json, tool_subset_json, room_responsibility,
     created_at, updated_at, removed_at, source_kind
   )
   SELECT 'legacy-assignment:' || membership.room_id || ':' || membership.actor_id,
     membership.room_id, profile.id, membership.actor_id, 1, 'current',
     CASE WHEN membership.participation = 'active' THEN 'active' ELSE 'on-mention' END,
     CASE WHEN membership.participation = 'silent' OR profile.status = 'disabled'
       OR EXISTS (
         SELECT 1 FROM json_each(membership.tool_permissions_json)
         WHERE value NOT IN (
           'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
         )
       ) THEN 1 ELSE 0 END,
     '[]', COALESCE((
       SELECT json_group_array(value) FROM (
         SELECT DISTINCT member_tool.value
         FROM json_each(membership.tool_permissions_json) AS member_tool
         JOIN json_each(profile.tool_ceiling_json) AS profile_tool
           ON profile_tool.value = member_tool.value
         ORDER BY member_tool.value
       )
     ), '[]'), 'Review migrated Room assignment before use.',
     COALESCE(membership.configured_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'legacy_v20_migration'
   FROM room_memberships AS membership
   JOIN agent_profiles AS profile ON profile.actor_id = membership.actor_id
   WHERE membership.kind = 'agent'
     AND NOT EXISTS (
       SELECT 1 FROM room_agent_assignments AS assignment
       WHERE assignment.room_id = membership.room_id
         AND assignment.agent_actor_id = membership.actor_id
         AND assignment.status = 'current'
     )`,
  `INSERT INTO agent_authority_migration_provenance (
     source_kind, source_object_id, actor_id, profile_id, room_id, assignment_id,
     source_schema_version, source_participation, source_authority_json,
     review_required, migrated_at
   )
   SELECT 'legacy_room_membership_assignment',
     json_array(membership.room_id, membership.actor_id), membership.actor_id,
     assignment.profile_id, membership.room_id, assignment.id, 19,
     membership.participation,
     json_object('toolPermissions', json(membership.tool_permissions_json)),
     CASE WHEN assignment.paused = 1 THEN 1 ELSE 0 END,
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   FROM room_memberships AS membership
   JOIN room_agent_assignments AS assignment
     ON assignment.room_id = membership.room_id
    AND assignment.agent_actor_id = membership.actor_id
    AND assignment.status = 'current'
   WHERE membership.kind = 'agent'
     AND NOT EXISTS (
       SELECT 1 FROM agent_authority_migration_provenance AS provenance
       WHERE provenance.source_kind = 'existing_v14_assignment'
         AND provenance.assignment_id = assignment.id
     )`,
  `UPDATE agent_authority_migration_provenance
   SET profile_id = (
         SELECT assignment.profile_id
         FROM room_agent_assignments AS assignment
         WHERE assignment.room_id = agent_authority_migration_provenance.room_id
           AND assignment.agent_actor_id = agent_authority_migration_provenance.actor_id
           AND assignment.status = 'current'
       ),
       assignment_id = (
         SELECT assignment.id
         FROM room_agent_assignments AS assignment
         WHERE assignment.room_id = agent_authority_migration_provenance.room_id
           AND assignment.agent_actor_id = agent_authority_migration_provenance.actor_id
           AND assignment.status = 'current'
       )
   WHERE source_kind = 'legacy_silent_assignment'`,
  `UPDATE room_memberships SET participation = 'on-mention'
   WHERE kind = 'agent' AND participation = 'silent'`,
  `CREATE TABLE agent_profile_revisions (
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    global_responsibility TEXT NOT NULL CHECK (
      length(trim(global_responsibility)) BETWEEN 1 AND 4000
    ),
    status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
    capability_ceiling_json TEXT NOT NULL CHECK (
      json_valid(capability_ceiling_json) AND json_type(capability_ceiling_json) = 'array'
    ),
    tool_ceiling_json TEXT NOT NULL CHECK (
      json_valid(tool_ceiling_json) AND json_type(tool_ceiling_json) = 'array'
    ),
    changed_by_human_actor_id TEXT REFERENCES actors(id),
    changed_at TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (
      operation IN (
        'create', 'update', 'enable', 'disable', 'legacy_migration', 'static_bootstrap'
      )
    ),
    PRIMARY KEY (profile_id, revision)
  ) STRICT`,
  `INSERT INTO agent_profile_revisions (
     profile_id, revision, actor_id, display_name, global_responsibility, status,
     capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
     changed_at, operation
   ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
     capability_ceiling_json, tool_ceiling_json, NULL, updated_at, 'legacy_migration'
   FROM agent_profiles`,
  `CREATE TABLE room_agent_assignment_revisions (
    assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    room_responsibility TEXT NOT NULL CHECK (
      length(trim(room_responsibility)) BETWEEN 1 AND 4000
    ),
    status TEXT NOT NULL CHECK (status IN ('current', 'removed')),
    participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    capability_subset_json TEXT NOT NULL CHECK (
      json_valid(capability_subset_json) AND json_type(capability_subset_json) = 'array'
    ),
    tool_subset_json TEXT NOT NULL CHECK (
      json_valid(tool_subset_json) AND json_type(tool_subset_json) = 'array'
    ),
    changed_by_human_actor_id TEXT REFERENCES actors(id),
    changed_at TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (
      operation IN ('create', 'update', 'pause', 'resume', 'remove', 'legacy_migration')
    ),
    PRIMARY KEY (assignment_id, revision)
  ) STRICT`,
  `INSERT INTO room_agent_assignment_revisions (
     assignment_id, revision, room_id, profile_id, agent_actor_id,
     room_responsibility, status, participation, paused, capability_subset_json,
     tool_subset_json, changed_by_human_actor_id, changed_at, operation
   ) SELECT id, revision, room_id, profile_id, agent_actor_id, room_responsibility,
     status, participation, paused, capability_subset_json, tool_subset_json,
     NULL, updated_at, 'legacy_migration' FROM room_agent_assignments`,
  `CREATE TABLE tenant_administrator_registry (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    bootstrap_configuration_sha256 TEXT NOT NULL CHECK (
      length(bootstrap_configuration_sha256) = 64
      AND bootstrap_configuration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE tenant_administrators (
    human_actor_id TEXT PRIMARY KEY REFERENCES actors(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('bootstrap', 'administrator_command')),
    created_by_human_actor_id TEXT REFERENCES actors(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    CHECK (
      (status = 'active' AND removed_at IS NULL)
      OR (status = 'removed' AND removed_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE tenant_administrator_revisions (
    human_actor_id TEXT NOT NULL REFERENCES tenant_administrators(human_actor_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    operation TEXT NOT NULL CHECK (operation IN ('bootstrap', 'add', 'remove')),
    changed_by_human_actor_id TEXT REFERENCES actors(id),
    changed_at TEXT NOT NULL,
    PRIMARY KEY (human_actor_id, revision)
  ) STRICT`,
  `CREATE TABLE deployment_idempotency_records (
    scope TEXT NOT NULL CHECK (scope IN (
      'administrator.bootstrap', 'administrator.add', 'administrator.remove',
      'profile.create', 'profile.update', 'profile.enable', 'profile.disable',
      'provider-configuration.disclose', 'provider-configuration.mutate'
    )),
    idempotency_key TEXT NOT NULL,
    principal_actor_id TEXT NOT NULL REFERENCES actors(id),
    request_sha256 TEXT NOT NULL CHECK (
      length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 599),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    PRIMARY KEY (scope, idempotency_key)
  ) STRICT`,
  `CREATE TABLE deployment_audit (
    audit_id TEXT PRIMARY KEY,
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'administrator.bootstrap', 'administrator.add', 'administrator.remove',
      'profile.create', 'profile.update', 'profile.enable', 'profile.disable',
      'provider-configuration.disclosed', 'provider-configuration.change-unsupported'
    )),
    principal_human_actor_id TEXT REFERENCES actors(id),
    subject_kind TEXT NOT NULL CHECK (
      subject_kind IN ('tenant_administrator', 'agent_profile', 'provider_configuration')
    ),
    subject_id TEXT NOT NULL,
    subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
    request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 200),
    occurred_at TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (
      json_valid(details_json) AND json_type(details_json) = 'object'
    )
  ) STRICT`,
  `CREATE TABLE deployment_stream (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
    retained_from_seq INTEGER NOT NULL CHECK (
      retained_from_seq >= 1 AND retained_from_seq <= head_seq + 1
    )
  ) STRICT`,
  `INSERT INTO deployment_stream (singleton_id, head_seq, retained_from_seq)
   VALUES (1, 0, 1)`,
  `CREATE TABLE deployment_agent_profile_events (
    event_id TEXT PRIMARY KEY,
    stream_seq INTEGER NOT NULL UNIQUE CHECK (stream_seq > 0),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'profile.created', 'profile.updated', 'profile.enabled', 'profile.disabled'
    )),
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json) AND json_type(payload_json) = 'object'
    ),
    payload_sha256 TEXT NOT NULL CHECK (
      length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    UNIQUE (profile_id, profile_revision)
  ) STRICT`,
  `CREATE TABLE deployment_profile_outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES deployment_agent_profile_events(event_id),
    recipient_human_actor_id TEXT NOT NULL REFERENCES tenant_administrators(human_actor_id),
    stream_seq INTEGER NOT NULL CHECK (stream_seq > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    delivered_at TEXT,
    last_error TEXT CHECK (
      last_error IS NULL OR last_error IN ('delivery_failed', 'recipient_unavailable')
    ),
    UNIQUE (event_id, recipient_human_actor_id)
  ) STRICT`,
  `CREATE INDEX deployment_profile_outbox_pending_v20
   ON deployment_profile_outbox(status, available_at, stream_seq, id)`,
  `CREATE TABLE deployment_agent_profile_repair_records (
    profile_id TEXT PRIMARY KEY REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    record_version INTEGER NOT NULL CHECK (record_version = 1),
    event_id TEXT NOT NULL UNIQUE REFERENCES deployment_agent_profile_events(event_id),
    stream_seq INTEGER NOT NULL UNIQUE CHECK (stream_seq > 0),
    projection_json TEXT NOT NULL CHECK (
      json_valid(projection_json) AND json_type(projection_json) = 'object'
    ),
    projection_sha256 TEXT NOT NULL CHECK (
      length(projection_sha256) = 64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE agent_profile_invalidation_facts (
    invalidation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    from_revision INTEGER NOT NULL CHECK (from_revision > 0),
    to_revision INTEGER NOT NULL CHECK (to_revision > from_revision),
    reason TEXT NOT NULL CHECK (
      reason IN ('profile_updated', 'profile_disabled', 'profile_enabled')
    ),
    invalidated_context_count INTEGER NOT NULL CHECK (invalidated_context_count >= 0),
    cancelled_route_intent_count INTEGER NOT NULL CHECK (cancelled_route_intent_count >= 0),
    affected_assignment_count INTEGER NOT NULL CHECK (affected_assignment_count >= 0),
    occurred_at TEXT NOT NULL,
    UNIQUE (profile_id, to_revision)
  ) STRICT`,
  `CREATE TRIGGER tenant_administrators_v20_validate_insert
   BEFORE INSERT ON tenant_administrators
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.human_actor_id), '') <> 'human'
      OR (NEW.source_kind = 'bootstrap' AND NEW.created_by_human_actor_id IS NOT NULL)
      OR (NEW.source_kind = 'administrator_command'
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.created_by_human_actor_id), '') <> 'human')
      OR NOT EXISTS (SELECT 1 FROM tenant_administrator_registry WHERE singleton_id = 1)
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator must bind current Human authority'); END`,
  `CREATE TRIGGER tenant_administrators_v20_validate_update
   BEFORE UPDATE ON tenant_administrators
   WHEN NEW.human_actor_id <> OLD.human_actor_id
      OR NEW.created_by_human_actor_id <> OLD.created_by_human_actor_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.revision <> OLD.revision + 1
      OR (OLD.status = 'active' AND NEW.status = 'removed' AND
          (SELECT COUNT(*) FROM tenant_administrators WHERE status = 'active') <= 1)
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator transition is invalid'); END`,
  `CREATE TRIGGER tenant_administrators_v20_immutable_delete
   BEFORE DELETE ON tenant_administrators
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator history is immutable'); END`,
  `CREATE TRIGGER tenant_administrator_registry_v20_validate_update
   BEFORE UPDATE ON tenant_administrator_registry
   WHEN NEW.singleton_id <> OLD.singleton_id
      OR NEW.bootstrap_configuration_sha256 <> OLD.bootstrap_configuration_sha256
      OR NEW.initialized_at <> OLD.initialized_at
      OR NEW.revision <> OLD.revision + 1
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator registry transition is invalid'); END`,
  `CREATE TRIGGER tenant_administrator_registry_v20_immutable_delete
   BEFORE DELETE ON tenant_administrator_registry
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator registry is immutable'); END`,
  `CREATE TRIGGER tenant_administrator_revisions_v20_validate_insert
   BEFORE INSERT ON tenant_administrator_revisions
   WHEN (NEW.operation = 'bootstrap' AND NEW.changed_by_human_actor_id IS NOT NULL)
      OR (NEW.operation <> 'bootstrap'
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.changed_by_human_actor_id), '') <> 'human')
      OR NOT EXISTS (
        SELECT 1 FROM tenant_administrators AS administrator
        WHERE administrator.human_actor_id = NEW.human_actor_id
          AND administrator.revision = NEW.revision
          AND administrator.status = NEW.status
      )
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator revision actor must be Human'); END`,
  `CREATE TRIGGER tenant_administrator_revisions_v20_immutable_update
   BEFORE UPDATE ON tenant_administrator_revisions
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator revisions are immutable'); END`,
  `CREATE TRIGGER tenant_administrator_revisions_v20_immutable_delete
   BEFORE DELETE ON tenant_administrator_revisions
   BEGIN SELECT RAISE(ABORT, 'Tenant Administrator revisions are immutable'); END`,
  `CREATE TRIGGER deployment_audit_v20_validate_insert
   BEFORE INSERT ON deployment_audit
   WHEN (NEW.event_kind = 'administrator.bootstrap'
         AND NEW.principal_human_actor_id IS NOT NULL)
      OR (NEW.event_kind <> 'administrator.bootstrap'
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.principal_human_actor_id), '') <> 'human')
      OR EXISTS (
        SELECT 1 FROM json_tree(NEW.details_json)
        WHERE lower(COALESCE(key, '')) IN (
          'secret', 'secretvalue', 'credential', 'apikey', 'authorization', 'token'
        )
      )
   BEGIN SELECT RAISE(ABORT, 'Deployment audit principal or secret boundary is invalid'); END`,
  `CREATE TRIGGER deployment_audit_v20_immutable_update
   BEFORE UPDATE ON deployment_audit
   BEGIN SELECT RAISE(ABORT, 'Deployment audit is immutable'); END`,
  `CREATE TRIGGER deployment_audit_v20_immutable_delete
   BEFORE DELETE ON deployment_audit
   BEGIN SELECT RAISE(ABORT, 'Deployment audit is immutable'); END`,
  `CREATE TRIGGER deployment_stream_v20_validate_update
   BEFORE UPDATE ON deployment_stream
   WHEN NEW.singleton_id <> OLD.singleton_id
      OR NEW.head_seq <> OLD.head_seq + 1
      OR NEW.retained_from_seq < OLD.retained_from_seq
      OR NEW.retained_from_seq > NEW.head_seq + 1
   BEGIN SELECT RAISE(ABORT, 'Deployment stream transition is invalid'); END`,
  `CREATE TRIGGER deployment_stream_v20_immutable_delete
   BEFORE DELETE ON deployment_stream
   BEGIN SELECT RAISE(ABORT, 'Deployment stream is immutable'); END`,
  `CREATE TRIGGER deployment_agent_profile_events_v20_validate_insert
   BEFORE INSERT ON deployment_agent_profile_events
   WHEN NEW.stream_seq <> COALESCE((
          SELECT head_seq FROM deployment_stream WHERE singleton_id = 1
        ), 0)
      OR NOT EXISTS (
        SELECT 1 FROM agent_profiles AS profile
        WHERE profile.id = NEW.profile_id
          AND profile.actor_id = NEW.actor_id
          AND profile.revision = NEW.profile_revision
          AND (NEW.event_kind <> 'profile.created' OR profile.revision = 1)
          AND (NEW.event_kind <> 'profile.enabled' OR profile.status = 'enabled')
          AND (NEW.event_kind <> 'profile.disabled' OR profile.status = 'disabled')
      )
      OR EXISTS (
        SELECT 1 FROM json_tree(NEW.payload_json)
        WHERE lower(COALESCE(key, '')) IN (
          'roomid', 'roomname', 'message', 'messages', 'member', 'members',
          'goal', 'ball', 'assignment', 'secret', 'secretvalue', 'credential',
          'apikey', 'authorization', 'token'
        )
      )
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile event is invalid'); END`,
  `CREATE TRIGGER deployment_agent_profile_events_v20_immutable_update
   BEFORE UPDATE ON deployment_agent_profile_events
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile event is immutable'); END`,
  `CREATE TRIGGER deployment_agent_profile_events_v20_immutable_delete
   BEFORE DELETE ON deployment_agent_profile_events
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile event is immutable'); END`,
  `CREATE TRIGGER deployment_profile_outbox_v20_validate_insert
   BEFORE INSERT ON deployment_profile_outbox
   WHEN NEW.status <> 'pending' OR NEW.attempts <> 0
      OR NEW.delivered_at IS NOT NULL OR NEW.last_error IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM deployment_agent_profile_events AS event
        WHERE event.event_id = NEW.event_id AND event.stream_seq = NEW.stream_seq
      )
      OR COALESCE((
        SELECT status FROM tenant_administrators
        WHERE human_actor_id = NEW.recipient_human_actor_id
      ), '') <> 'active'
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile outbox row is invalid'); END`,
  `CREATE TRIGGER deployment_profile_outbox_v20_validate_update
   BEFORE UPDATE ON deployment_profile_outbox
   WHEN NEW.id <> OLD.id OR NEW.event_id <> OLD.event_id
      OR NEW.recipient_human_actor_id <> OLD.recipient_human_actor_id
      OR NEW.stream_seq <> OLD.stream_seq OR NEW.available_at <> OLD.available_at
      OR OLD.status <> 'pending' OR NEW.status NOT IN ('pending', 'dispatched')
      OR NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1
      OR (NEW.status = 'dispatched' AND NEW.delivered_at IS NULL)
      OR (NEW.status = 'pending' AND NEW.delivered_at IS NOT NULL)
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile outbox transition is invalid'); END`,
  `CREATE TRIGGER deployment_profile_outbox_v20_immutable_delete
   BEFORE DELETE ON deployment_profile_outbox
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile outbox is immutable'); END`,
  `CREATE TRIGGER deployment_agent_profile_repair_v20_validate_insert
   BEFORE INSERT ON deployment_agent_profile_repair_records
   WHEN NOT EXISTS (
        SELECT 1 FROM deployment_agent_profile_events AS event
        JOIN agent_profiles AS profile ON profile.id = event.profile_id
        WHERE event.event_id = NEW.event_id AND event.stream_seq = NEW.stream_seq
          AND event.profile_id = NEW.profile_id
          AND event.profile_revision = NEW.profile_revision
          AND profile.revision = NEW.profile_revision
      )
      OR COALESCE(json_extract(NEW.projection_json, '$.profileId'), '') <> NEW.profile_id
      OR COALESCE(json_extract(NEW.projection_json, '$.revision'), 0) <> NEW.profile_revision
      OR EXISTS (
        SELECT 1 FROM json_tree(NEW.projection_json)
        WHERE lower(COALESCE(key, '')) IN (
          'roomid', 'roomname', 'message', 'messages', 'member', 'members',
          'goal', 'ball', 'assignment', 'secret', 'secretvalue', 'credential',
          'apikey', 'authorization', 'token'
        )
      )
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile repair record is invalid'); END`,
  `CREATE TRIGGER deployment_agent_profile_repair_v20_validate_update
   BEFORE UPDATE ON deployment_agent_profile_repair_records
   WHEN NEW.profile_id <> OLD.profile_id OR NEW.record_version <> OLD.record_version
      OR NEW.profile_revision <= OLD.profile_revision OR NEW.stream_seq <= OLD.stream_seq
      OR NOT EXISTS (
        SELECT 1 FROM deployment_agent_profile_events AS event
        JOIN agent_profiles AS profile ON profile.id = event.profile_id
        WHERE event.event_id = NEW.event_id AND event.stream_seq = NEW.stream_seq
          AND event.profile_id = NEW.profile_id
          AND event.profile_revision = NEW.profile_revision
          AND profile.revision = NEW.profile_revision
      )
      OR COALESCE(json_extract(NEW.projection_json, '$.profileId'), '') <> NEW.profile_id
      OR COALESCE(json_extract(NEW.projection_json, '$.revision'), 0) <> NEW.profile_revision
      OR EXISTS (
        SELECT 1 FROM json_tree(NEW.projection_json)
        WHERE lower(COALESCE(key, '')) IN (
          'roomid', 'roomname', 'message', 'messages', 'member', 'members',
          'goal', 'ball', 'assignment', 'secret', 'secretvalue', 'credential',
          'apikey', 'authorization', 'token'
        )
      )
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile repair transition is invalid'); END`,
  `CREATE TRIGGER deployment_agent_profile_repair_v20_immutable_delete
   BEFORE DELETE ON deployment_agent_profile_repair_records
   BEGIN SELECT RAISE(ABORT, 'Deployment Profile repair is immutable'); END`,
  `CREATE TRIGGER agent_profile_invalidation_facts_v20_validate_insert
   BEFORE INSERT ON agent_profile_invalidation_facts
   WHEN COALESCE((SELECT revision FROM agent_profiles WHERE id = NEW.profile_id), 0)
        <> NEW.to_revision
   BEGIN SELECT RAISE(ABORT, 'Profile invalidation fact is stale'); END`,
  `CREATE TRIGGER agent_profile_invalidation_facts_v20_immutable_update
   BEFORE UPDATE ON agent_profile_invalidation_facts
   BEGIN SELECT RAISE(ABORT, 'Profile invalidation facts are immutable'); END`,
  `CREATE TRIGGER agent_profile_invalidation_facts_v20_immutable_delete
   BEFORE DELETE ON agent_profile_invalidation_facts
   BEGIN SELECT RAISE(ABORT, 'Profile invalidation facts are immutable'); END`,
  `CREATE TRIGGER agent_profile_revisions_v20_validate_insert
   BEFORE INSERT ON agent_profile_revisions
   WHEN (NEW.operation IN ('legacy_migration', 'static_bootstrap')
         AND NEW.changed_by_human_actor_id IS NOT NULL)
      OR (NEW.operation NOT IN ('legacy_migration', 'static_bootstrap')
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.changed_by_human_actor_id), '') <> 'human')
      OR NOT EXISTS (
        SELECT 1 FROM agent_profiles AS profile
        WHERE profile.id = NEW.profile_id AND profile.revision = NEW.revision
          AND profile.actor_id = NEW.actor_id AND profile.display_name = NEW.display_name
          AND profile.global_responsibility = NEW.global_responsibility
          AND profile.status = NEW.status
          AND profile.capability_ceiling_json = NEW.capability_ceiling_json
          AND profile.tool_ceiling_json = NEW.tool_ceiling_json
      )
   BEGIN SELECT RAISE(ABORT, 'Agent Profile revision is not current Human authority'); END`,
  `CREATE TRIGGER agent_profile_revisions_v20_immutable_update
   BEFORE UPDATE ON agent_profile_revisions
   BEGIN SELECT RAISE(ABORT, 'Agent Profile revisions are immutable'); END`,
  `CREATE TRIGGER agent_profile_revisions_v20_immutable_delete
   BEFORE DELETE ON agent_profile_revisions
   BEGIN SELECT RAISE(ABORT, 'Agent Profile revisions are immutable'); END`,
  `CREATE TRIGGER room_agent_assignment_revisions_v20_validate_insert
   BEFORE INSERT ON room_agent_assignment_revisions
   WHEN (NEW.operation = 'legacy_migration' AND NEW.changed_by_human_actor_id IS NOT NULL)
      OR (NEW.operation <> 'legacy_migration'
          AND COALESCE((SELECT kind FROM actors WHERE id = NEW.changed_by_human_actor_id), '') <> 'human')
      OR NOT EXISTS (
        SELECT 1 FROM room_agent_assignments AS assignment
        WHERE assignment.id = NEW.assignment_id AND assignment.revision = NEW.revision
          AND assignment.room_id = NEW.room_id AND assignment.profile_id = NEW.profile_id
          AND assignment.agent_actor_id = NEW.agent_actor_id
          AND assignment.room_responsibility = NEW.room_responsibility
          AND assignment.status = NEW.status
          AND assignment.participation = NEW.participation
          AND assignment.paused = NEW.paused
          AND assignment.capability_subset_json = NEW.capability_subset_json
          AND assignment.tool_subset_json = NEW.tool_subset_json
      )
   BEGIN SELECT RAISE(ABORT, 'Room Assignment revision is not current Human authority'); END`,
  `CREATE TRIGGER room_agent_assignment_revisions_v20_immutable_update
   BEFORE UPDATE ON room_agent_assignment_revisions
   BEGIN SELECT RAISE(ABORT, 'Room Assignment revisions are immutable'); END`,
  `CREATE TRIGGER room_agent_assignment_revisions_v20_immutable_delete
   BEFORE DELETE ON room_agent_assignment_revisions
   BEGIN SELECT RAISE(ABORT, 'Room Assignment revisions are immutable'); END`,
  `CREATE TRIGGER agent_authority_migration_provenance_v20_immutable_update
   BEFORE UPDATE ON agent_authority_migration_provenance
   BEGIN SELECT RAISE(ABORT, 'Agent authority migration provenance is immutable'); END`,
  `CREATE TRIGGER agent_authority_migration_provenance_v20_immutable_delete
   BEFORE DELETE ON agent_authority_migration_provenance
   BEGIN SELECT RAISE(ABORT, 'Agent authority migration provenance is immutable'); END`,
  `CREATE TRIGGER deployment_idempotency_records_v20_validate_insert
   BEFORE INSERT ON deployment_idempotency_records
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.principal_actor_id), '') <> 'human'
   BEGIN SELECT RAISE(ABORT, 'Deployment idempotency principal must be Human'); END`,
  `CREATE TRIGGER agent_profiles_v20_validate_insert
   BEFORE INSERT ON agent_profiles
   WHEN EXISTS (
     SELECT 1 FROM json_each(NEW.capability_ceiling_json)
     WHERE typeof(value) <> 'text' OR value NOT IN (
       'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
     )
   ) OR EXISTS (
     SELECT 1 FROM json_each(NEW.tool_ceiling_json)
     WHERE typeof(value) <> 'text' OR value NOT IN (
       'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
     )
   ) OR EXISTS (
     SELECT 1 FROM json_each(NEW.capability_ceiling_json) AS entry
     JOIN json_each(NEW.capability_ceiling_json) AS successor
       ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
     WHERE entry.value >= successor.value
   ) OR EXISTS (
     SELECT 1 FROM json_each(NEW.tool_ceiling_json) AS entry
     JOIN json_each(NEW.tool_ceiling_json) AS successor
       ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
     WHERE entry.value >= successor.value
   )
   BEGIN SELECT RAISE(ABORT, 'Agent Profile authority set is not canonical'); END`,
  `CREATE TRIGGER agent_profiles_v20_validate_update
   BEFORE UPDATE ON agent_profiles
   WHEN NEW.id <> OLD.id OR NEW.actor_id <> OLD.actor_id
      OR NEW.created_at <> OLD.created_at
      OR (NEW.source_kind <> OLD.source_kind AND NOT (
        OLD.source_kind IN ('legacy_v20_migration', 'static_bootstrap')
        AND NEW.source_kind = 'administrator_command'
      ))
      OR NEW.revision <> OLD.revision + 1
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_ceiling_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_ceiling_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_ceiling_json) AS entry
        JOIN json_each(NEW.capability_ceiling_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_ceiling_json) AS entry
        JOIN json_each(NEW.tool_ceiling_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      )
   BEGIN SELECT RAISE(ABORT, 'Agent Profile transition or authority set is invalid'); END`,
  `CREATE TRIGGER room_agent_assignments_v20_validate_insert
   BEFORE INSERT ON room_agent_assignments
   WHEN (NEW.status = 'removed' AND (NEW.paused <> 1 OR NEW.removed_at IS NULL))
      OR (NEW.status = 'current' AND NEW.removed_at IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_subset_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_subset_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_subset_json) AS entry
        JOIN json_each(NEW.capability_subset_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_subset_json) AS entry
        JOIN json_each(NEW.tool_subset_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      )
   BEGIN SELECT RAISE(ABORT, 'Room Assignment lifecycle or authority set is invalid'); END`,
  `CREATE TRIGGER room_agent_assignments_v20_validate_update
   BEFORE UPDATE ON room_agent_assignments
   WHEN NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id
      OR NEW.profile_id <> OLD.profile_id OR NEW.agent_actor_id <> OLD.agent_actor_id
      OR NEW.created_at <> OLD.created_at
      OR (NEW.source_kind <> OLD.source_kind AND NOT (
        OLD.source_kind IN ('legacy_v20_migration', 'static_bootstrap')
        AND NEW.source_kind = 'room_command'
      ))
      OR NEW.revision <> OLD.revision + 1 OR OLD.status = 'removed'
      OR (NEW.status = 'removed' AND (NEW.paused <> 1 OR NEW.removed_at IS NULL))
      OR (NEW.status = 'current' AND NEW.removed_at IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_subset_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_subset_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.capability_subset_json) AS entry
        JOIN json_each(NEW.capability_subset_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.tool_subset_json) AS entry
        JOIN json_each(NEW.tool_subset_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      )
   BEGIN SELECT RAISE(ABORT, 'Room Assignment transition or authority set is invalid'); END`,
  `ALTER TABLE route_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
   CHECK (revision > 0)`,
  `CREATE TABLE route_candidate_snapshots (
    id TEXT PRIMARY KEY,
    route_job_id TEXT NOT NULL UNIQUE REFERENCES route_jobs(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    room_revision INTEGER NOT NULL CHECK (room_revision > 0),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    source_message_revision INTEGER NOT NULL CHECK (source_message_revision > 0),
    source_author_kind TEXT NOT NULL CHECK (source_author_kind IN ('human', 'agent')),
    source_message_kind TEXT NOT NULL CHECK (
      source_message_kind IN ('human', 'agent-final', 'agent-correction')
    ),
    snapshot_version INTEGER NOT NULL CHECK (snapshot_version = 1),
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    snapshot_sha256 TEXT NOT NULL CHECK (
      length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    UNIQUE (id, route_job_id),
    FOREIGN KEY (source_message_id, source_message_revision)
      REFERENCES message_revisions(message_id, revision)
  ) STRICT`,
  `CREATE TRIGGER route_candidate_snapshots_v20_validate_insert
   BEFORE INSERT ON route_candidate_snapshots
   WHEN NOT EXISTS (
     SELECT 1 FROM route_jobs AS job
     JOIN messages AS message ON message.id = job.source_message_id
     JOIN message_envelopes AS envelope ON envelope.message_id = message.id
     WHERE job.id = NEW.route_job_id
       AND job.room_id = NEW.room_id
       AND job.source_message_id = NEW.source_message_id
       AND message.room_id = NEW.room_id
       AND message.author_kind = NEW.source_author_kind
       AND envelope.message_kind = NEW.source_message_kind
       AND envelope.current_revision = NEW.source_message_revision
       AND envelope.lifecycle = 'active'
   )
   BEGIN SELECT RAISE(ABORT, 'Route candidate snapshot source is stale or invalid'); END`,
  `ALTER TABLE route_jobs ADD COLUMN candidate_snapshot_id TEXT
   REFERENCES route_candidate_snapshots(id)`,
  `CREATE UNIQUE INDEX route_jobs_candidate_snapshot_v20
   ON route_jobs(candidate_snapshot_id) WHERE candidate_snapshot_id IS NOT NULL`,
  `CREATE TRIGGER route_jobs_v20_validate_candidate_snapshot_update
   BEFORE UPDATE OF candidate_snapshot_id ON route_jobs
   WHEN (OLD.candidate_snapshot_id IS NOT NULL
         AND NEW.candidate_snapshot_id <> OLD.candidate_snapshot_id)
      OR (NEW.candidate_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM route_candidate_snapshots AS snapshot
        WHERE snapshot.id = NEW.candidate_snapshot_id
          AND snapshot.route_job_id = OLD.id
          AND snapshot.room_id = OLD.room_id
          AND snapshot.source_message_id = OLD.source_message_id
      ))
   BEGIN SELECT RAISE(ABORT, 'Route job candidate snapshot binding is invalid'); END`,
  `CREATE TABLE route_candidate_snapshot_agents (
    snapshot_id TEXT NOT NULL REFERENCES route_candidate_snapshots(id),
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
    assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
    availability TEXT NOT NULL CHECK (availability IN ('ready', 'busy', 'paused', 'noauth')),
    room_responsibility TEXT NOT NULL CHECK (length(trim(room_responsibility)) > 0),
    effective_capabilities_json TEXT NOT NULL CHECK (
      json_valid(effective_capabilities_json)
      AND json_type(effective_capabilities_json) = 'array'
    ),
    effective_tools_json TEXT NOT NULL CHECK (
      json_valid(effective_tools_json) AND json_type(effective_tools_json) = 'array'
    ),
    calibration_score INTEGER NOT NULL CHECK (calibration_score BETWEEN -3 AND 3),
    has_ball INTEGER NOT NULL CHECK (has_ball IN (0, 1)),
    goal_fact_revision INTEGER CHECK (goal_fact_revision > 0),
    project_fact_revision INTEGER CHECK (project_fact_revision > 0),
    ball_fact_revision INTEGER CHECK (ball_fact_revision > 0),
    candidate_order INTEGER NOT NULL CHECK (candidate_order >= 0),
    PRIMARY KEY (snapshot_id, agent_actor_id),
    UNIQUE (snapshot_id, candidate_order),
    FOREIGN KEY (snapshot_id, route_job_id)
      REFERENCES route_candidate_snapshots(id, route_job_id),
    CHECK ((has_ball = 1) = (ball_fact_revision IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE route_decisions (
    id TEXT PRIMARY KEY,
    route_job_id TEXT NOT NULL UNIQUE REFERENCES route_jobs(id),
    expected_route_job_revision INTEGER NOT NULL CHECK (expected_route_job_revision > 0),
    snapshot_id TEXT NOT NULL REFERENCES route_candidate_snapshots(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('selected', 'suppressed', 'failed')),
    reason_code TEXT NOT NULL CHECK (reason_code IN (
      'selected', 'candidate_not_found', 'revision_changed', 'not_active', 'unavailable',
      'missing_authority_facts', 'stale_authority_facts', 'ball_fact_unavailable',
      'source_not_human', 'provider_failed'
    )),
    decided_at TEXT NOT NULL,
    UNIQUE (id, route_job_id, snapshot_id)
  ) STRICT`,
  `CREATE TABLE routed_agent_invocation_intents (
    id TEXT PRIMARY KEY,
    route_decision_id TEXT NOT NULL REFERENCES route_decisions(id),
    route_job_id TEXT NOT NULL REFERENCES route_jobs(id),
    snapshot_id TEXT NOT NULL REFERENCES route_candidate_snapshots(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    source_message_revision INTEGER NOT NULL CHECK (source_message_revision > 0),
    target_agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
    assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('domain', 'risk', 'ball')),
    reason_text TEXT NOT NULL CHECK (length(trim(reason_text)) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'cancelled')),
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    UNIQUE (route_decision_id, target_agent_actor_id),
    FOREIGN KEY (route_decision_id, route_job_id, snapshot_id)
      REFERENCES route_decisions(id, route_job_id, snapshot_id),
    FOREIGN KEY (source_message_id, source_message_revision)
      REFERENCES message_revisions(message_id, revision),
    CHECK (
      (status = 'pending' AND claimed_at IS NULL AND cancelled_at IS NULL
       AND cancellation_reason IS NULL)
      OR (status = 'claimed' AND claimed_at IS NOT NULL AND cancelled_at IS NULL
          AND cancellation_reason IS NULL)
      OR (status = 'cancelled' AND cancelled_at IS NOT NULL
          AND cancellation_reason IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX routed_agent_invocation_intents_pending_v20
   ON routed_agent_invocation_intents(status, created_at, id)`,
  `CREATE TRIGGER route_candidate_snapshot_agents_v20_validate_insert
   BEFORE INSERT ON route_candidate_snapshot_agents
   WHEN NEW.participation <> 'active' OR NEW.availability <> 'ready'
      OR COALESCE((SELECT actor_id FROM agent_profiles WHERE id = NEW.profile_id), '')
         <> NEW.agent_actor_id
      OR COALESCE((SELECT revision FROM agent_profiles WHERE id = NEW.profile_id), 0)
         <> NEW.profile_revision
      OR COALESCE((SELECT status FROM agent_profiles WHERE id = NEW.profile_id), '')
         <> 'enabled'
      OR COALESCE((SELECT profile_id FROM room_agent_assignments WHERE id = NEW.assignment_id), '')
         <> NEW.profile_id
      OR COALESCE((SELECT agent_actor_id FROM room_agent_assignments WHERE id = NEW.assignment_id), '')
         <> NEW.agent_actor_id
      OR COALESCE((SELECT revision FROM room_agent_assignments WHERE id = NEW.assignment_id), 0)
         <> NEW.assignment_revision
      OR COALESCE((SELECT status FROM room_agent_assignments WHERE id = NEW.assignment_id), '')
         <> 'current'
      OR COALESCE((SELECT paused FROM room_agent_assignments WHERE id = NEW.assignment_id), 1)
         <> 0
      OR COALESCE((SELECT participation FROM room_agent_assignments WHERE id = NEW.assignment_id), '')
         <> 'active'
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.effective_capabilities_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.effective_tools_json)
        WHERE typeof(value) <> 'text' OR value NOT IN (
          'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
        )
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.effective_capabilities_json) AS entry
        JOIN json_each(NEW.effective_capabilities_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.effective_tools_json) AS entry
        JOIN json_each(NEW.effective_tools_json) AS successor
          ON CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
        WHERE entry.value >= successor.value
      )
   BEGIN SELECT RAISE(ABORT, 'Route candidate authority is invalid'); END`,
  `CREATE TRIGGER route_candidate_snapshots_v20_immutable_update
   BEFORE UPDATE ON route_candidate_snapshots
   BEGIN SELECT RAISE(ABORT, 'Route candidate snapshot is immutable'); END`,
  `CREATE TRIGGER route_candidate_snapshots_v20_immutable_delete
   BEFORE DELETE ON route_candidate_snapshots
   BEGIN SELECT RAISE(ABORT, 'Route candidate snapshot is immutable'); END`,
  `CREATE TRIGGER route_candidate_snapshot_agents_v20_immutable_update
   BEFORE UPDATE ON route_candidate_snapshot_agents
   BEGIN SELECT RAISE(ABORT, 'Route candidate is immutable'); END`,
  `CREATE TRIGGER route_candidate_snapshot_agents_v20_immutable_delete
   BEFORE DELETE ON route_candidate_snapshot_agents
   BEGIN SELECT RAISE(ABORT, 'Route candidate is immutable'); END`,
  `CREATE TRIGGER route_decisions_v20_validate_insert
   BEFORE INSERT ON route_decisions
   WHEN NOT EXISTS (
     SELECT 1 FROM route_candidate_snapshots AS snapshot
     JOIN route_jobs AS job ON job.id = snapshot.route_job_id
     WHERE snapshot.id = NEW.snapshot_id AND snapshot.route_job_id = NEW.route_job_id
       AND job.candidate_snapshot_id = snapshot.id
       AND snapshot.candidate_count = (
         SELECT COUNT(*) FROM route_candidate_snapshot_agents AS candidate
         WHERE candidate.snapshot_id = snapshot.id
       )
   ) OR COALESCE((SELECT revision FROM route_jobs WHERE id = NEW.route_job_id), 0)
        <> NEW.expected_route_job_revision
      OR (NEW.outcome = 'selected') <> (NEW.reason_code = 'selected')
   BEGIN SELECT RAISE(ABORT, 'Route decision provenance is stale or invalid'); END`,
  `CREATE TRIGGER route_decisions_v20_immutable_update
   BEFORE UPDATE ON route_decisions
   BEGIN SELECT RAISE(ABORT, 'Route decision is immutable'); END`,
  `CREATE TRIGGER route_decisions_v20_immutable_delete
   BEFORE DELETE ON route_decisions
   BEGIN SELECT RAISE(ABORT, 'Route decision is immutable'); END`,
  `CREATE TRIGGER routed_agent_invocation_intents_v20_validate_insert
   BEFORE INSERT ON routed_agent_invocation_intents
   WHEN NOT EXISTS (
     SELECT 1 FROM route_decisions AS decision
     JOIN route_candidate_snapshots AS snapshot ON snapshot.id = decision.snapshot_id
     WHERE decision.id = NEW.route_decision_id
       AND decision.route_job_id = NEW.route_job_id
       AND decision.snapshot_id = NEW.snapshot_id
       AND decision.outcome = 'selected'
       AND snapshot.room_id = NEW.room_id
       AND snapshot.source_message_id = NEW.source_message_id
       AND snapshot.source_message_revision = NEW.source_message_revision
   ) OR NOT EXISTS (
     SELECT 1 FROM route_candidate_snapshot_agents AS candidate
     WHERE candidate.snapshot_id = NEW.snapshot_id
       AND candidate.route_job_id = NEW.route_job_id
       AND candidate.agent_actor_id = NEW.target_agent_actor_id
       AND candidate.profile_id = NEW.profile_id
       AND candidate.profile_revision = NEW.profile_revision
       AND candidate.assignment_id = NEW.assignment_id
       AND candidate.assignment_revision = NEW.assignment_revision
       AND candidate.access_revision = NEW.access_revision
   )
   BEGIN SELECT RAISE(ABORT, 'Routed invocation is not bound to its candidate snapshot'); END`,
  `CREATE TRIGGER routed_agent_invocation_intents_v20_validate_update
   BEFORE UPDATE ON routed_agent_invocation_intents
   WHEN NEW.id <> OLD.id OR NEW.route_decision_id <> OLD.route_decision_id
      OR NEW.route_job_id <> OLD.route_job_id OR NEW.snapshot_id <> OLD.snapshot_id
      OR NEW.room_id <> OLD.room_id OR NEW.source_message_id <> OLD.source_message_id
      OR NEW.source_message_revision <> OLD.source_message_revision
      OR NEW.target_agent_actor_id <> OLD.target_agent_actor_id
      OR NEW.profile_id <> OLD.profile_id OR NEW.profile_revision <> OLD.profile_revision
      OR NEW.assignment_id <> OLD.assignment_id
      OR NEW.assignment_revision <> OLD.assignment_revision
      OR NEW.access_revision <> OLD.access_revision OR NEW.trigger_kind <> OLD.trigger_kind
      OR NEW.reason_text <> OLD.reason_text OR NEW.created_at <> OLD.created_at
      OR OLD.status <> 'pending' OR NEW.status NOT IN ('claimed', 'cancelled')
   BEGIN SELECT RAISE(ABORT, 'Routed invocation transition is invalid'); END`,
  `CREATE TRIGGER routed_agent_invocation_intents_v20_immutable_delete
   BEFORE DELETE ON routed_agent_invocation_intents
   BEGIN SELECT RAISE(ABORT, 'Routed invocation intent is immutable'); END`,
] as const;

export const AUTHORITY_V14_STATEMENT_COUNT_FOR_TEST = V14_STATEMENTS.length;
export const AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST = V15_STATEMENTS.length;
export const AUTHORITY_V16_STATEMENT_COUNT_FOR_TEST = V16_STATEMENTS.length;
export const AUTHORITY_V17_STATEMENT_COUNT_FOR_TEST = V17_STATEMENTS.length;
export const AUTHORITY_V18_STATEMENT_COUNT_FOR_TEST = V18_STATEMENTS.length;
export const AUTHORITY_V19_STATEMENT_COUNT_FOR_TEST = V19_STATEMENTS.length;
export const AUTHORITY_V20_STATEMENT_COUNT_FOR_TEST = V20_STATEMENTS.length;
export const AUTHORITY_V20_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  V20_STATEMENTS.filter((statement) => statement.startsWith("CREATE TRIGGER ")).length;
export const AUTHORITY_V20_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST = 9;
export const AUTHORITY_V20_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  AUTHORITY_V20_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST
  + AUTHORITY_V20_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST;
export const AUTHORITY_V20_ROLLBACK_ASSERTION_COUNT_FOR_TEST = V20_STATEMENTS.length;
export const AUTHORITY_V20_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  20,
  "agent-profile-routing-authority",
  V20_STATEMENTS,
);

const V21_STATEMENTS = [
  `CREATE TABLE direct_agent_invocation_authority_bindings (
    intent_id TEXT PRIMARY KEY REFERENCES agent_invocation_intents(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
    assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    FOREIGN KEY (profile_id, profile_revision)
      REFERENCES agent_profile_revisions(profile_id, revision),
    FOREIGN KEY (assignment_id, assignment_revision)
      REFERENCES room_agent_assignment_revisions(assignment_id, revision)
  ) STRICT`,
  `CREATE TRIGGER direct_agent_invocation_authority_bindings_v21_validate_insert
   BEFORE INSERT ON direct_agent_invocation_authority_bindings
   WHEN NOT EXISTS (
     SELECT 1
     FROM agent_invocation_intents AS intent
     JOIN message_mentions AS mention
       ON mention.message_id = intent.source_message_id
      AND mention.target_id = intent.target_id
      AND mention.target_actor_id = intent.target_agent_id
      AND mention.target_kind = 'agent-invocation'
     JOIN agent_profiles AS profile
       ON profile.id = NEW.profile_id
      AND profile.actor_id = intent.target_agent_id
      AND profile.revision = NEW.profile_revision
      AND profile.status = 'enabled'
     JOIN agent_profile_revisions AS profile_revision
       ON profile_revision.profile_id = NEW.profile_id
      AND profile_revision.revision = NEW.profile_revision
      AND profile_revision.actor_id = intent.target_agent_id
     JOIN room_agent_assignments AS assignment
       ON assignment.id = NEW.assignment_id
      AND assignment.room_id = intent.room_id
      AND assignment.profile_id = NEW.profile_id
      AND assignment.agent_actor_id = intent.target_agent_id
      AND assignment.revision = NEW.assignment_revision
      AND assignment.status = 'current'
      AND assignment.paused = 0
      AND assignment.participation IN ('active', 'on-mention')
     JOIN room_agent_assignment_revisions AS assignment_revision
       ON assignment_revision.assignment_id = NEW.assignment_id
      AND assignment_revision.revision = NEW.assignment_revision
      AND assignment_revision.room_id = intent.room_id
      AND assignment_revision.profile_id = NEW.profile_id
      AND assignment_revision.agent_actor_id = intent.target_agent_id
     JOIN room_memberships AS membership
       ON membership.room_id = intent.room_id
      AND membership.actor_id = intent.target_agent_id
      AND membership.kind = 'agent'
      AND membership.access_revision = NEW.access_revision
     WHERE intent.id = NEW.intent_id
       AND intent.origin_kind = 'message_target'
       AND intent.intent_kind = 'direct_mention'
       AND intent.message_transaction_id = intent.source_message_id
       AND intent.source_revision = 1
   )
   BEGIN
     SELECT RAISE(ABORT, 'Direct invocation authority binding is invalid or stale');
   END`,
  `CREATE TRIGGER direct_agent_invocation_authority_bindings_v21_immutable_update
   BEFORE UPDATE ON direct_agent_invocation_authority_bindings
   BEGIN SELECT RAISE(ABORT, 'Direct invocation authority binding is immutable'); END`,
  `CREATE TRIGGER direct_agent_invocation_authority_bindings_v21_immutable_delete
   BEFORE DELETE ON direct_agent_invocation_authority_bindings
   BEGIN SELECT RAISE(ABORT, 'Direct invocation authority binding is immutable'); END`,
  `CREATE TRIGGER message_target_outcomes_v21_require_direct_authority_binding
   BEFORE INSERT ON message_target_outcomes
   WHEN NEW.status = 'invocation-intent-created' AND NOT EXISTS (
     SELECT 1
     FROM direct_agent_invocation_authority_bindings AS binding
     JOIN agent_invocation_intents AS intent ON intent.id = binding.intent_id
     WHERE binding.intent_id = NEW.invocation_intent_id
       AND intent.room_id = NEW.room_id
       AND intent.source_message_id = NEW.message_id
       AND intent.target_id = NEW.target_id
       AND intent.target_agent_id = NEW.target_actor_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'Direct invocation outcome lacks immutable authority binding');
   END`,
  `CREATE TRIGGER agent_invocation_intents_v21_require_binding_before_claim
   BEFORE UPDATE OF status ON agent_invocation_intents
   WHEN OLD.origin_kind = 'message_target' AND OLD.status = 'pending'
      AND NEW.status = 'claimed'
      AND NOT EXISTS (
        SELECT 1 FROM direct_agent_invocation_authority_bindings AS binding
        WHERE binding.intent_id = OLD.id
      )
   BEGIN
     SELECT RAISE(ABORT, 'Direct invocation claim lacks immutable authority binding');
   END`,
] as const;

export const AUTHORITY_V21_STATEMENT_COUNT_FOR_TEST = V21_STATEMENTS.length;
export const AUTHORITY_V21_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  V21_STATEMENTS.filter((statement) => statement.startsWith("CREATE TRIGGER ")).length;
export const AUTHORITY_V21_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST = 1;
export const AUTHORITY_V21_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  AUTHORITY_V21_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST
  + AUTHORITY_V21_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST;
export const AUTHORITY_V21_ROLLBACK_ASSERTION_COUNT_FOR_TEST = V21_STATEMENTS.length;
export const AUTHORITY_V21_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  21,
  "direct-invocation-authority-binding",
  V21_STATEMENTS,
);

const V22_CANCELLATION_REASONS = [
  "human_cancelled",
  "reply_superseded",
  "correction_superseded",
  "intent_superseded",
  "message_recalled",
  "room_archived",
  "membership_revoked",
  "assignment_revoked",
  "profile_disabled",
  "capability_revoked",
  "source_ineligible",
  "runtime_shutdown",
] as const;

const V22_CANCELLATION_REASON_SQL = V22_CANCELLATION_REASONS
  .map((reason) => `'${reason}'`)
  .join(", ");

const V22_STATEMENTS = [
  `CREATE TABLE agent_invocation_intent_runtime_states (
    intent_id TEXT PRIMARY KEY REFERENCES agent_invocation_intents(id),
    public_status TEXT NOT NULL CHECK (public_status IN ('pending', 'claimed', 'cancelled')),
    authority_version INTEGER NOT NULL DEFAULT 1 CHECK (authority_version >= 1),
    claimed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT CHECK (
      cancellation_reason IS NULL OR cancellation_reason IN (${V22_CANCELLATION_REASON_SQL})
    ),
    updated_at TEXT NOT NULL,
    CHECK (
      (public_status = 'pending' AND claimed_at IS NULL AND cancelled_at IS NULL
       AND cancellation_reason IS NULL)
      OR (public_status = 'claimed' AND claimed_at IS NOT NULL AND cancelled_at IS NULL
          AND cancellation_reason IS NULL)
      OR (public_status = 'cancelled' AND cancelled_at IS NOT NULL
          AND cancellation_reason IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO agent_invocation_intent_runtime_states (
     intent_id, public_status, authority_version, claimed_at, cancelled_at,
     cancellation_reason, updated_at
   )
   SELECT id, status, 1, claimed_at, cancelled_at, cancellation_reason,
          COALESCE(cancelled_at, claimed_at, created_at)
   FROM agent_invocation_intents`,
  `CREATE INDEX agent_invocation_intent_runtime_states_pending_v22
   ON agent_invocation_intent_runtime_states(public_status, updated_at, intent_id)`,
  `CREATE TABLE agent_execution_runtime_states (
    execution_id TEXT PRIMARY KEY REFERENCES agent_executions(id),
    intent_id TEXT REFERENCES agent_invocation_intents(id),
    lineage_id TEXT,
    execution_ordinal INTEGER CHECK (execution_ordinal IS NULL OR execution_ordinal >= 1),
    retry_of_execution_id TEXT REFERENCES agent_executions(id),
    snapshot_id TEXT REFERENCES context_snapshots(snapshot_id),
    provider_id TEXT,
    model_id TEXT,
    public_status TEXT NOT NULL CHECK (
      public_status IN ('accepted', 'running', 'completed', 'failed', 'cancelled')
    ),
    phase TEXT NOT NULL CHECK (phase IN (
      'queued', 'retry_scheduled', 'recovery_queued', 'awaiting_capacity',
      'claiming', 'snapshot_frozen', 'model_generation', 'read_tool',
      'waiting_confirmation', 'side_effect_claimed', 'final_committing',
      'completed', 'failed', 'cancelled'
    )),
    current_attempt_seq INTEGER NOT NULL CHECK (current_attempt_seq >= 1),
    authority_version INTEGER NOT NULL DEFAULT 1 CHECK (authority_version >= 1),
    execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
    queued_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    terminal_reason TEXT,
    terminal_error_code TEXT,
    review_state TEXT NOT NULL DEFAULT 'none' CHECK (
      review_state IN ('none', 'needs_review', 'dead_letter', 'legacy_review_required')
    ),
    UNIQUE (intent_id, execution_ordinal),
    CHECK (
      (review_state = 'legacy_review_required') OR
      (intent_id IS NOT NULL AND lineage_id IS NOT NULL AND execution_ordinal IS NOT NULL
       AND snapshot_id IS NOT NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL)
    ),
    CHECK (
      (public_status = 'accepted' AND phase IN (
        'queued', 'retry_scheduled', 'recovery_queued', 'awaiting_capacity'
      ) AND completed_at IS NULL AND terminal_reason IS NULL)
      OR (public_status = 'running' AND phase IN (
        'claiming', 'snapshot_frozen', 'model_generation', 'read_tool',
        'waiting_confirmation', 'side_effect_claimed', 'final_committing'
      ) AND completed_at IS NULL AND terminal_reason IS NULL)
      OR (public_status = 'completed' AND phase = 'completed'
          AND completed_at IS NOT NULL AND terminal_reason IS NULL)
      OR (public_status = 'failed' AND phase = 'failed'
          AND completed_at IS NOT NULL AND terminal_error_code IS NOT NULL)
      OR (public_status = 'cancelled' AND phase = 'cancelled'
          AND completed_at IS NOT NULL AND terminal_reason IN (${V22_CANCELLATION_REASON_SQL}, 'legacy_interrupted'))
    )
  ) STRICT`,
  `INSERT INTO agent_execution_runtime_states (
     execution_id, intent_id, lineage_id, execution_ordinal, retry_of_execution_id,
     snapshot_id, provider_id, model_id, public_status, phase,
     current_attempt_seq, authority_version, execution_generation, queued_at,
     started_at, updated_at, completed_at, terminal_reason, terminal_error_code,
     review_state
   )
   SELECT execution.id, link.intent_id, intent.lineage_id, link.execution_ordinal,
          link.retry_of_execution_id, context.snapshot_id, execution.provider_id,
          execution.model_id,
          CASE execution.status WHEN 'queued' THEN 'accepted' ELSE execution.status END,
          CASE execution.status
            WHEN 'queued' THEN 'queued'
            WHEN 'running' THEN 'model_generation'
            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            ELSE 'cancelled'
          END,
          execution.current_attempt_seq, 1, execution.execution_generation,
          COALESCE(execution.queued_at, execution.started_at, CURRENT_TIMESTAMP),
          CASE WHEN execution.status = 'running' THEN execution.started_at ELSE NULL END,
          COALESCE(execution.updated_at, execution.completed_at,
                   execution.started_at, CURRENT_TIMESTAMP),
          CASE WHEN execution.status IN ('completed', 'failed', 'cancelled')
               THEN COALESCE(execution.completed_at, execution.updated_at,
                             execution.started_at, CURRENT_TIMESTAMP)
               ELSE NULL END,
          CASE WHEN execution.status = 'cancelled'
               THEN CASE
                 WHEN execution.cancellation_reason IN (${V22_CANCELLATION_REASON_SQL})
                 THEN execution.cancellation_reason
                 ELSE 'legacy_interrupted'
               END
               ELSE NULL END,
          CASE WHEN execution.status = 'failed'
               THEN COALESCE(execution.terminal_error_code, 'legacy_failure')
               ELSE NULL END,
          CASE WHEN link.intent_id IS NULL OR context.snapshot_id IS NULL
                    OR execution.provider_id IS NULL OR execution.model_id IS NULL
               THEN 'legacy_review_required' ELSE 'none' END
   FROM agent_executions AS execution
   LEFT JOIN agent_execution_intent_links AS link ON link.execution_id = execution.id
   LEFT JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
   LEFT JOIN agent_execution_context_bindings AS context
     ON context.execution_id = execution.id`,
  `CREATE INDEX agent_execution_runtime_states_admission_v22
   ON agent_execution_runtime_states(public_status, phase, queued_at, execution_id)`,
  `CREATE INDEX agent_execution_runtime_states_lineage_v22
   ON agent_execution_runtime_states(intent_id, execution_ordinal, execution_id)`,
  `CREATE TABLE agent_execution_attempt_runtime_states (
    execution_id TEXT NOT NULL REFERENCES agent_execution_runtime_states(execution_id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    public_status TEXT NOT NULL CHECK (
      public_status IN ('accepted', 'running', 'completed', 'failed', 'cancelled')
    ),
    phase TEXT NOT NULL CHECK (phase IN (
      'queued', 'retry_scheduled', 'recovery_queued', 'awaiting_capacity',
      'claiming', 'snapshot_frozen', 'model_generation', 'read_tool',
      'waiting_confirmation', 'side_effect_claimed', 'final_committing',
      'completed', 'failed', 'cancelled'
    )),
    attempt_version INTEGER NOT NULL DEFAULT 1 CHECK (attempt_version >= 1),
    reuse_kind TEXT NOT NULL CHECK (
      reuse_kind IN ('first', 'automatic_retry', 'crash_recovery', 'legacy_review')
    ),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    next_retry_at TEXT,
    PRIMARY KEY (execution_id, attempt_seq),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempts(execution_id, attempt_seq),
    CHECK (
      (public_status IN ('accepted', 'running') AND finished_at IS NULL)
      OR (public_status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO agent_execution_attempt_runtime_states (
     execution_id, attempt_seq, public_status, phase, attempt_version, reuse_kind,
     started_at, finished_at, error_code, next_retry_at
   )
   SELECT attempt.execution_id, attempt.attempt_seq,
          CASE attempt.status WHEN 'queued' THEN 'accepted' ELSE attempt.status END,
          CASE attempt.status
            WHEN 'queued' THEN 'queued'
            WHEN 'running' THEN 'model_generation'
            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            ELSE 'cancelled'
          END,
          1, COALESCE(context.reuse_kind, 'legacy_review'), attempt.started_at,
          CASE WHEN attempt.status IN ('completed', 'failed', 'cancelled')
               THEN COALESCE(attempt.finished_at, CURRENT_TIMESTAMP) ELSE NULL END,
          attempt.error_code, attempt.next_retry_at
   FROM agent_execution_attempts AS attempt
   LEFT JOIN agent_execution_context_attempts AS context
     ON context.execution_id = attempt.execution_id
    AND context.attempt_seq = attempt.attempt_seq`,
  `CREATE TABLE invocation_scoped_cancellation_fences (
    fence_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('intent', 'execution')),
    intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    execution_id TEXT REFERENCES agent_execution_runtime_states(execution_id),
    expected_authority_version INTEGER NOT NULL CHECK (expected_authority_version >= 1),
    reason TEXT NOT NULL CHECK (reason IN (${V22_CANCELLATION_REASON_SQL})),
    principal_human_actor_id TEXT REFERENCES actors(id),
    internal_capability TEXT CHECK (
      internal_capability IS NULL OR internal_capability IN (
        'message_authority', 'room_authority', 'membership_authority',
        'profile_authority', 'assignment_authority', 'runtime_supervisor'
      )
    ),
    committed_at TEXT NOT NULL,
    CHECK (
      (scope_kind = 'intent' AND execution_id IS NULL) OR
      (scope_kind = 'execution' AND execution_id IS NOT NULL)
    ),
    CHECK ((principal_human_actor_id IS NULL) <> (internal_capability IS NULL))
  ) STRICT`,
  `CREATE TABLE invocation_scoped_cancellation_targets (
    fence_id TEXT NOT NULL REFERENCES invocation_scoped_cancellation_fences(fence_id),
    execution_id TEXT NOT NULL REFERENCES agent_execution_runtime_states(execution_id),
    attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
    execution_version_before INTEGER NOT NULL CHECK (execution_version_before >= 1),
    execution_version_after INTEGER NOT NULL CHECK (
      execution_version_after = execution_version_before + 1
    ),
    PRIMARY KEY (fence_id, execution_id),
    FOREIGN KEY (execution_id, attempt_seq)
      REFERENCES agent_execution_attempt_runtime_states(execution_id, attempt_seq)
  ) STRICT`,
  `CREATE UNIQUE INDEX invocation_scoped_cancellation_intent_terminal_v22
   ON invocation_scoped_cancellation_fences(intent_id)
   WHERE scope_kind = 'intent'`,
  `CREATE TABLE invocation_cancellation_receipts (
    request_id TEXT PRIMARY KEY,
    fence_id TEXT NOT NULL UNIQUE REFERENCES invocation_scoped_cancellation_fences(fence_id),
    principal_actor_id TEXT REFERENCES actors(id),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    status_code INTEGER NOT NULL CHECK (status_code IN (200, 403, 404, 409, 410)),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    committed_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE invocation_recovery_queue (
    recovery_key INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE REFERENCES agent_execution_runtime_states(execution_id),
    execution_version INTEGER NOT NULL CHECK (execution_version >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'closed', 'dead_letter')),
    available_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    failure_code TEXT,
    review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state <> 'dead_letter' OR (failure_code IS NOT NULL AND review_required = 1))
  ) STRICT`,
  `CREATE INDEX invocation_recovery_queue_scan_v22
   ON invocation_recovery_queue(state, available_at, recovery_key)`,
  `CREATE TABLE invocation_recovery_cursors (
    worker_scope TEXT PRIMARY KEY CHECK (worker_scope = 'invocation-runtime'),
    last_recovery_key INTEGER NOT NULL DEFAULT 0 CHECK (last_recovery_key >= 0),
    scan_generation INTEGER NOT NULL DEFAULT 1 CHECK (scan_generation >= 1),
    updated_at TEXT NOT NULL
  ) STRICT`,
  `INSERT INTO invocation_recovery_cursors
   VALUES ('invocation-runtime', 0, 1, CURRENT_TIMESTAMP)`,
  `CREATE TABLE project_boundary_invocation_receipts (
    boundary_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    status TEXT NOT NULL CHECK (
      status IN ('dependency_unavailable', 'suppressed', 'consumed')
    ),
    invocation_intent_id TEXT UNIQUE REFERENCES agent_invocation_intents(id),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    recorded_at TEXT NOT NULL,
    CHECK ((status = 'consumed') = (invocation_intent_id IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE legacy_room_wide_preemption_markers (
    source_kind TEXT NOT NULL CHECK (
      source_kind IN ('human_preemption_fence', 'agent_human_fence')
    ),
    source_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    marked_at TEXT NOT NULL,
    production_reachable INTEGER NOT NULL DEFAULT 0 CHECK (production_reachable = 0),
    PRIMARY KEY (source_kind, source_id)
  ) STRICT`,
  `INSERT INTO legacy_room_wide_preemption_markers (
     source_kind, source_id, room_id, marked_at, production_reachable
   )
   SELECT 'human_preemption_fence', source_human_message_id, room_id,
          cancel_committed_at, 0 FROM human_preemption_fences`,
  `INSERT INTO legacy_room_wide_preemption_markers (
     source_kind, source_id, room_id, marked_at, production_reachable
   )
   SELECT 'agent_human_fence', fence_message_id || ':' || execution_id || ':' || old_attempt_seq,
          execution.room_id, fence.cancelled_at, 0
   FROM agent_human_fences AS fence
   JOIN agent_executions AS execution ON execution.id = fence.execution_id`,
  `CREATE TRIGGER agent_execution_runtime_states_v22_validate_update
   BEFORE UPDATE ON agent_execution_runtime_states
   WHEN NEW.execution_id <> OLD.execution_id
      OR NEW.intent_id IS NOT OLD.intent_id
      OR NEW.lineage_id IS NOT OLD.lineage_id
      OR NEW.execution_ordinal IS NOT OLD.execution_ordinal
      OR NEW.retry_of_execution_id IS NOT OLD.retry_of_execution_id
      OR (NEW.snapshot_id IS NOT OLD.snapshot_id AND NOT (
        OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL
        AND OLD.review_state = 'legacy_review_required' AND NEW.review_state = 'none'
      ))
      OR NEW.provider_id IS NOT OLD.provider_id
      OR NEW.model_id IS NOT OLD.model_id
      OR NEW.execution_generation <> OLD.execution_generation
      OR NEW.authority_version <> OLD.authority_version + 1
      OR OLD.public_status IN ('completed', 'failed', 'cancelled')
      OR (OLD.public_status = 'accepted' AND NEW.public_status NOT IN (
        'accepted', 'running', 'failed', 'cancelled'
      ))
      OR (OLD.public_status = 'running' AND NEW.public_status NOT IN (
        'accepted', 'running', 'completed', 'failed', 'cancelled'
      ))
   BEGIN SELECT RAISE(ABORT, 'Invocation execution CAS or terminal transition is invalid'); END`,
  `CREATE TRIGGER agent_invocation_intent_runtime_states_v22_validate_update
   BEFORE UPDATE ON agent_invocation_intent_runtime_states
   WHEN NEW.intent_id <> OLD.intent_id
      OR NEW.authority_version <> OLD.authority_version + 1
      OR OLD.public_status <> 'pending'
      OR NEW.public_status NOT IN ('claimed', 'cancelled')
   BEGIN SELECT RAISE(ABORT, 'Invocation intent CAS or terminal transition is invalid'); END`,
  `CREATE TRIGGER agent_invocation_intent_runtime_states_v22_immutable_delete
   BEFORE DELETE ON agent_invocation_intent_runtime_states
   BEGIN SELECT RAISE(ABORT, 'Invocation intent authority is immutable'); END`,
  `CREATE TRIGGER agent_execution_runtime_states_v22_immutable_delete
   BEFORE DELETE ON agent_execution_runtime_states
   BEGIN SELECT RAISE(ABORT, 'Invocation execution authority is immutable'); END`,
  `CREATE TRIGGER agent_execution_attempt_runtime_states_v22_validate_update
   BEFORE UPDATE ON agent_execution_attempt_runtime_states
   WHEN NEW.execution_id <> OLD.execution_id OR NEW.attempt_seq <> OLD.attempt_seq
      OR NEW.reuse_kind <> OLD.reuse_kind
      OR NEW.attempt_version <> OLD.attempt_version + 1
      OR OLD.public_status IN ('completed', 'failed', 'cancelled')
      OR (OLD.public_status = 'accepted' AND NEW.public_status NOT IN (
        'accepted', 'running', 'failed', 'cancelled'
      ))
      OR (OLD.public_status = 'running' AND NEW.public_status NOT IN (
        'accepted', 'running', 'completed', 'failed', 'cancelled'
      ))
   BEGIN SELECT RAISE(ABORT, 'Invocation attempt CAS or terminal transition is invalid'); END`,
  `CREATE TRIGGER agent_execution_attempt_runtime_states_v22_immutable_delete
   BEFORE DELETE ON agent_execution_attempt_runtime_states
   BEGIN SELECT RAISE(ABORT, 'Invocation attempt authority is immutable'); END`,
  `CREATE TRIGGER invocation_scoped_cancellation_fences_v22_validate_insert
   BEFORE INSERT ON invocation_scoped_cancellation_fences
   WHEN NOT EXISTS (
     SELECT 1 FROM agent_invocation_intents AS intent
     JOIN agent_invocation_intent_runtime_states AS intent_runtime
       ON intent_runtime.intent_id = intent.id
     LEFT JOIN agent_execution_runtime_states AS execution
       ON execution.execution_id = NEW.execution_id
     WHERE intent.id = NEW.intent_id AND intent.room_id = NEW.room_id
       AND ((NEW.execution_id IS NULL
             AND intent_runtime.authority_version = NEW.expected_authority_version
             AND intent_runtime.public_status = 'pending') OR (
         execution.intent_id = intent.id
         AND execution.authority_version = NEW.expected_authority_version
         AND execution.public_status IN ('accepted', 'running')
       ))
   ) OR (NEW.principal_human_actor_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM actors AS actor
     JOIN room_memberships AS membership ON membership.actor_id = actor.id
     WHERE actor.id = NEW.principal_human_actor_id AND actor.kind = 'human'
       AND membership.room_id = NEW.room_id AND membership.kind = 'human'
   ))
   BEGIN SELECT RAISE(ABORT, 'Scoped cancellation authority or version is invalid'); END`,
  `CREATE TRIGGER invocation_scoped_cancellation_fences_v22_immutable_update
   BEFORE UPDATE ON invocation_scoped_cancellation_fences
   BEGIN SELECT RAISE(ABORT, 'Scoped cancellation fence is immutable'); END`,
  `CREATE TRIGGER invocation_scoped_cancellation_fences_v22_immutable_delete
   BEFORE DELETE ON invocation_scoped_cancellation_fences
   BEGIN SELECT RAISE(ABORT, 'Scoped cancellation fence is immutable'); END`,
  `CREATE TRIGGER invocation_scoped_cancellation_targets_v22_immutable_update
   BEFORE UPDATE ON invocation_scoped_cancellation_targets
   BEGIN SELECT RAISE(ABORT, 'Scoped cancellation target is immutable'); END`,
  `CREATE TRIGGER invocation_scoped_cancellation_targets_v22_immutable_delete
   BEFORE DELETE ON invocation_scoped_cancellation_targets
   BEGIN SELECT RAISE(ABORT, 'Scoped cancellation target is immutable'); END`,
  `CREATE TRIGGER invocation_cancellation_receipts_v22_immutable_update
   BEFORE UPDATE ON invocation_cancellation_receipts
   BEGIN SELECT RAISE(ABORT, 'Cancellation receipt is immutable'); END`,
  `CREATE TRIGGER invocation_cancellation_receipts_v22_immutable_delete
   BEFORE DELETE ON invocation_cancellation_receipts
   BEGIN SELECT RAISE(ABORT, 'Cancellation receipt is immutable'); END`,
  `CREATE TRIGGER project_boundary_invocation_receipts_v22_immutable_update
   BEFORE UPDATE ON project_boundary_invocation_receipts
   BEGIN SELECT RAISE(ABORT, 'Project boundary receipt is immutable'); END`,
  `CREATE TRIGGER project_boundary_invocation_receipts_v22_immutable_delete
   BEFORE DELETE ON project_boundary_invocation_receipts
   BEGIN SELECT RAISE(ABORT, 'Project boundary receipt is immutable'); END`,
  `CREATE TRIGGER legacy_room_wide_preemption_markers_v22_immutable_update
   BEFORE UPDATE ON legacy_room_wide_preemption_markers
   BEGIN SELECT RAISE(ABORT, 'Legacy broad-preemption marker is immutable'); END`,
  `CREATE TRIGGER legacy_room_wide_preemption_markers_v22_immutable_delete
   BEFORE DELETE ON legacy_room_wide_preemption_markers
   BEGIN SELECT RAISE(ABORT, 'Legacy broad-preemption marker is immutable'); END`,
  `CREATE TRIGGER agent_invocation_intents_v22_create_runtime_state
   AFTER INSERT ON agent_invocation_intents
   BEGIN
     INSERT INTO agent_invocation_intent_runtime_states (
       intent_id, public_status, authority_version, claimed_at, cancelled_at,
       cancellation_reason, updated_at
     ) VALUES (
       NEW.id, NEW.status, 1, NEW.claimed_at, NEW.cancelled_at,
       NEW.cancellation_reason,
       COALESCE(NEW.cancelled_at, NEW.claimed_at, NEW.created_at)
     );
   END`,
  `CREATE TRIGGER agent_execution_context_bindings_v22_create_runtime_state
   AFTER INSERT ON agent_execution_context_bindings
   WHEN NOT EXISTS (
     SELECT 1 FROM agent_execution_runtime_states WHERE execution_id = NEW.execution_id
   )
   BEGIN
     INSERT INTO agent_execution_runtime_states (
       execution_id, intent_id, lineage_id, execution_ordinal, retry_of_execution_id,
       snapshot_id, provider_id, model_id, public_status, phase,
       current_attempt_seq, authority_version, execution_generation, queued_at,
       started_at, updated_at, completed_at, terminal_reason, terminal_error_code,
       review_state
     )
     SELECT execution.id, link.intent_id, intent.lineage_id, link.execution_ordinal,
            link.retry_of_execution_id, NEW.snapshot_id, execution.provider_id,
            execution.model_id,
            CASE execution.status WHEN 'queued' THEN 'accepted' ELSE execution.status END,
            CASE execution.status
              WHEN 'queued' THEN 'queued'
              WHEN 'running' THEN 'snapshot_frozen'
              WHEN 'completed' THEN 'completed'
              WHEN 'failed' THEN 'failed'
              ELSE 'cancelled'
            END,
            execution.current_attempt_seq, 1, execution.execution_generation,
            COALESCE(execution.queued_at, execution.started_at, CURRENT_TIMESTAMP),
            CASE WHEN execution.status = 'running' THEN execution.started_at ELSE NULL END,
            COALESCE(execution.updated_at, execution.started_at, CURRENT_TIMESTAMP),
            CASE WHEN execution.status IN ('completed', 'failed', 'cancelled')
                 THEN COALESCE(execution.completed_at, execution.updated_at, CURRENT_TIMESTAMP)
                 ELSE NULL END,
            CASE WHEN execution.status = 'cancelled' THEN
              CASE WHEN execution.cancellation_reason IN (${V22_CANCELLATION_REASON_SQL})
                   THEN execution.cancellation_reason ELSE 'source_ineligible' END
              ELSE NULL END,
            CASE WHEN execution.status = 'failed'
                 THEN COALESCE(execution.terminal_error_code, 'legacy_failure') ELSE NULL END,
            'none'
     FROM agent_executions AS execution
     JOIN agent_execution_intent_links AS link ON link.execution_id = execution.id
     JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
     WHERE execution.id = NEW.execution_id;

     INSERT INTO agent_execution_attempt_runtime_states (
       execution_id, attempt_seq, public_status, phase, attempt_version, reuse_kind,
       started_at, finished_at, error_code, next_retry_at
     )
     SELECT attempt.execution_id, attempt.attempt_seq,
            CASE attempt.status WHEN 'queued' THEN 'accepted' ELSE attempt.status END,
            CASE attempt.status
              WHEN 'queued' THEN 'queued'
              WHEN 'running' THEN 'snapshot_frozen'
              WHEN 'completed' THEN 'completed'
              WHEN 'failed' THEN 'failed'
              ELSE 'cancelled'
            END,
            1, COALESCE(context.reuse_kind, 'first'), attempt.started_at,
            CASE WHEN attempt.status IN ('completed', 'failed', 'cancelled')
                 THEN COALESCE(attempt.finished_at, CURRENT_TIMESTAMP) ELSE NULL END,
            attempt.error_code, attempt.next_retry_at
     FROM agent_execution_attempts AS attempt
     LEFT JOIN agent_execution_context_attempts AS context
       ON context.execution_id = attempt.execution_id
      AND context.attempt_seq = attempt.attempt_seq
     WHERE attempt.execution_id = NEW.execution_id;
   END`,
  `CREATE TRIGGER agent_execution_attempts_v22_create_runtime_state
   AFTER INSERT ON agent_execution_attempts
   WHEN EXISTS (
     SELECT 1 FROM agent_execution_runtime_states WHERE execution_id = NEW.execution_id
   ) AND NOT EXISTS (
     SELECT 1 FROM agent_execution_attempt_runtime_states
     WHERE execution_id = NEW.execution_id AND attempt_seq = NEW.attempt_seq
   )
   BEGIN
     INSERT INTO agent_execution_attempt_runtime_states (
       execution_id, attempt_seq, public_status, phase, attempt_version, reuse_kind,
       started_at, finished_at, error_code, next_retry_at
     ) VALUES (
       NEW.execution_id, NEW.attempt_seq,
       CASE NEW.status WHEN 'queued' THEN 'accepted' ELSE NEW.status END,
       CASE NEW.status
         WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'claiming'
         WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'cancelled'
       END,
       1, CASE WHEN NEW.attempt_seq = 1 THEN 'first' ELSE 'automatic_retry' END,
       NEW.started_at,
       CASE WHEN NEW.status IN ('completed', 'failed', 'cancelled')
            THEN COALESCE(NEW.finished_at, CURRENT_TIMESTAMP) ELSE NULL END,
       NEW.error_code, NEW.next_retry_at
     );
   END`,
  `CREATE TRIGGER agent_executions_v22_sync_runtime_state
   AFTER UPDATE ON agent_executions
   WHEN EXISTS (
     SELECT 1 FROM agent_execution_runtime_states WHERE execution_id = NEW.id
   )
   BEGIN
     UPDATE agent_execution_runtime_states
     SET public_status = CASE NEW.status WHEN 'queued' THEN 'accepted' ELSE NEW.status END,
         phase = CASE NEW.status
           WHEN 'queued' THEN CASE WHEN NEW.next_retry_at IS NULL
             THEN 'queued' ELSE 'retry_scheduled' END
           WHEN 'running' THEN CASE
             WHEN EXISTS (
               SELECT 1 FROM tool_confirmations
               WHERE execution_id = NEW.id AND attempt_seq = NEW.current_attempt_seq
                 AND confirmation_state = 'pending'
             ) THEN 'waiting_confirmation'
             WHEN NEW.action_category = 'model_generation' THEN 'model_generation'
             WHEN NEW.action_category = 'tool_call' AND NEW.tool_dispatch_phase = 'dispatched'
               THEN 'side_effect_claimed'
             WHEN NEW.action_category = 'tool_call' THEN 'read_tool'
             ELSE 'claiming' END
           WHEN 'completed' THEN 'completed'
           WHEN 'failed' THEN 'failed'
           ELSE 'cancelled' END,
         current_attempt_seq = NEW.current_attempt_seq,
         authority_version = authority_version + 1,
         started_at = CASE WHEN NEW.status = 'queued' THEN NULL ELSE NEW.started_at END,
         updated_at = COALESCE(NEW.updated_at, CURRENT_TIMESTAMP),
         completed_at = CASE WHEN NEW.status IN ('completed', 'failed', 'cancelled')
           THEN COALESCE(NEW.completed_at, NEW.updated_at, CURRENT_TIMESTAMP) ELSE NULL END,
         terminal_reason = CASE WHEN NEW.status = 'cancelled' THEN
           CASE WHEN NEW.cancellation_reason IN (${V22_CANCELLATION_REASON_SQL})
                THEN NEW.cancellation_reason ELSE 'source_ineligible' END ELSE NULL END,
         terminal_error_code = CASE WHEN NEW.status = 'failed'
           THEN COALESCE(NEW.terminal_error_code, 'runtime_failure') ELSE NULL END,
         review_state = CASE WHEN snapshot_id IS NULL THEN 'legacy_review_required' WHEN EXISTS (
           SELECT 1 FROM tool_dispatches
           WHERE execution_id = NEW.id AND state = 'outcome_unknown'
         ) THEN 'needs_review' WHEN NEW.dead_lettered_at IS NOT NULL
           THEN 'dead_letter' ELSE review_state END
     WHERE execution_id = NEW.id;
   END`,
  `CREATE TRIGGER agent_execution_attempts_v22_sync_runtime_state
   AFTER UPDATE ON agent_execution_attempts
   WHEN EXISTS (
     SELECT 1 FROM agent_execution_attempt_runtime_states
     WHERE execution_id = NEW.execution_id AND attempt_seq = NEW.attempt_seq
   )
   BEGIN
     UPDATE agent_execution_attempt_runtime_states
     SET public_status = CASE NEW.status WHEN 'queued' THEN 'accepted' ELSE NEW.status END,
         phase = CASE NEW.status
           WHEN 'queued' THEN CASE WHEN NEW.next_retry_at IS NULL
             THEN 'queued' ELSE 'retry_scheduled' END
           WHEN 'running' THEN 'model_generation'
           WHEN 'completed' THEN 'completed'
           WHEN 'failed' THEN 'failed'
           ELSE 'cancelled' END,
         attempt_version = attempt_version + 1,
         started_at = NEW.started_at,
         finished_at = CASE WHEN NEW.status IN ('completed', 'failed', 'cancelled')
           THEN COALESCE(NEW.finished_at, CURRENT_TIMESTAMP) ELSE NULL END,
         error_code = NEW.error_code,
         next_retry_at = NEW.next_retry_at
     WHERE execution_id = NEW.execution_id AND attempt_seq = NEW.attempt_seq;
   END`,
  `CREATE TABLE invocation_human_retry_receipts (
    request_id TEXT PRIMARY KEY,
    source_execution_id TEXT NOT NULL REFERENCES agent_execution_runtime_states(execution_id),
    source_expected_version INTEGER NOT NULL CHECK (source_expected_version >= 1),
    child_execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id),
    intent_id TEXT NOT NULL REFERENCES agent_invocation_intents(id),
    execution_ordinal INTEGER NOT NULL CHECK (execution_ordinal >= 2),
    principal_actor_id TEXT NOT NULL REFERENCES actors(id),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    committed_at TEXT NOT NULL,
    UNIQUE (intent_id, execution_ordinal)
  ) STRICT`,
  `CREATE INDEX invocation_human_retry_receipts_source_v22
   ON invocation_human_retry_receipts(source_execution_id, committed_at, request_id)`,
  `CREATE TRIGGER invocation_human_retry_receipts_v22_validate_insert
   BEFORE INSERT ON invocation_human_retry_receipts
   WHEN NOT EXISTS (
     SELECT 1
     FROM actors AS principal
     JOIN agent_execution_intent_links AS link
       ON link.execution_id = NEW.child_execution_id
     JOIN agent_execution_runtime_states AS runtime
       ON runtime.execution_id = NEW.child_execution_id
     JOIN agent_execution_runtime_states AS source_runtime
       ON source_runtime.execution_id = NEW.source_execution_id
     JOIN agent_executions AS execution
       ON execution.id = NEW.child_execution_id
     JOIN agent_invocation_intents AS intent
       ON intent.id = NEW.intent_id
     WHERE principal.id = NEW.principal_actor_id AND principal.kind = 'human'
       AND link.intent_id = NEW.intent_id
       AND link.execution_ordinal = NEW.execution_ordinal
       AND link.retry_of_execution_id = NEW.source_execution_id
       AND runtime.snapshot_id IS NOT NULL
       AND json_extract(NEW.response_json, '$.kind') = 'invocation'
       AND json_extract(NEW.response_json, '$.replayed') = 0
       AND json_extract(NEW.response_json, '$.execution.id') = NEW.child_execution_id
       AND json_extract(NEW.response_json, '$.execution.manualRetryOfExecutionId') =
           NEW.source_execution_id
       AND json_extract(NEW.response_json, '$.execution.roomId') = execution.room_id
       AND json_extract(NEW.response_json, '$.execution.queuedAt') = execution.queued_at
       AND json_extract(NEW.response_json, '$.intent.kind') = intent.intent_kind
       AND json_extract(NEW.response_json, '$.intent.roomId') = intent.room_id
       AND json_extract(NEW.response_json, '$.intent.sourceMessageId') =
           intent.source_message_id
       AND json_extract(NEW.response_json, '$.intent.targetAgentId') =
           intent.target_agent_id
       AND json_extract(NEW.response_json, '$.retryReceipt.requestId') = NEW.request_id
       AND json_extract(NEW.response_json, '$.retryReceipt.sourceExecutionId') =
           NEW.source_execution_id
       AND json_extract(NEW.response_json, '$.retryReceipt.executionId') =
           NEW.child_execution_id
       AND json_extract(NEW.response_json, '$.retryReceipt.intentId') = NEW.intent_id
       AND json_extract(NEW.response_json, '$.retryReceipt.lineageId') =
           source_runtime.lineage_id
       AND json_extract(NEW.response_json, '$.retryReceipt.roomId') = execution.room_id
       AND json_extract(NEW.response_json, '$.retryReceipt.executionOrdinal') =
           NEW.execution_ordinal
       AND json_extract(NEW.response_json, '$.retryReceipt.snapshotId') = runtime.snapshot_id
       AND json_extract(NEW.response_json, '$.retryReceipt.status') = 'accepted'
       AND json_extract(NEW.response_json, '$.retryReceipt.createdAt') = execution.queued_at
   )
   BEGIN SELECT RAISE(ABORT, 'Human retry receipt authority is inconsistent'); END`,
  `CREATE TRIGGER invocation_human_retry_receipts_v22_immutable_update
   BEFORE UPDATE ON invocation_human_retry_receipts
   BEGIN SELECT RAISE(ABORT, 'Human retry receipt is immutable'); END`,
  `CREATE TRIGGER invocation_human_retry_receipts_v22_immutable_delete
   BEFORE DELETE ON invocation_human_retry_receipts
   BEGIN SELECT RAISE(ABORT, 'Human retry receipt is immutable'); END`,
  `CREATE TRIGGER agent_execution_intent_links_v22_create_runtime_state
   AFTER INSERT ON agent_execution_intent_links
   WHEN NOT EXISTS (
     SELECT 1 FROM agent_execution_runtime_states WHERE execution_id = NEW.execution_id
   )
   BEGIN
     INSERT INTO agent_execution_runtime_states (
       execution_id, intent_id, lineage_id, execution_ordinal, retry_of_execution_id,
       snapshot_id, provider_id, model_id, public_status, phase,
       current_attempt_seq, authority_version, execution_generation, queued_at,
       started_at, updated_at, completed_at, terminal_reason, terminal_error_code,
       review_state
     )
     SELECT execution.id, NEW.intent_id, intent.lineage_id, NEW.execution_ordinal,
            NEW.retry_of_execution_id, NULL, execution.provider_id, execution.model_id,
            CASE execution.status WHEN 'queued' THEN 'accepted' ELSE execution.status END,
            CASE execution.status
              WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'claiming'
              WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
            execution.current_attempt_seq, 1, execution.execution_generation,
            COALESCE(execution.queued_at, execution.started_at, CURRENT_TIMESTAMP),
            CASE WHEN execution.status = 'running' THEN execution.started_at ELSE NULL END,
            COALESCE(execution.updated_at, execution.started_at, CURRENT_TIMESTAMP),
            CASE WHEN execution.status IN ('completed', 'failed', 'cancelled')
                 THEN COALESCE(execution.completed_at, execution.updated_at, CURRENT_TIMESTAMP)
                 ELSE NULL END,
            CASE WHEN execution.status = 'cancelled' THEN
              CASE WHEN execution.cancellation_reason IN (${V22_CANCELLATION_REASON_SQL})
                   THEN execution.cancellation_reason ELSE 'source_ineligible' END
              ELSE NULL END,
            CASE WHEN execution.status = 'failed'
                 THEN COALESCE(execution.terminal_error_code, 'legacy_failure') ELSE NULL END,
            'legacy_review_required'
     FROM agent_executions AS execution
     JOIN agent_invocation_intents AS intent ON intent.id = NEW.intent_id
     WHERE execution.id = NEW.execution_id;

     INSERT INTO agent_execution_attempt_runtime_states (
       execution_id, attempt_seq, public_status, phase, attempt_version, reuse_kind,
       started_at, finished_at, error_code, next_retry_at
     )
     SELECT attempt.execution_id, attempt.attempt_seq,
            CASE attempt.status WHEN 'queued' THEN 'accepted' ELSE attempt.status END,
            CASE attempt.status
              WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'claiming'
              WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
            1, CASE WHEN attempt.attempt_seq = 1 THEN 'first' ELSE 'automatic_retry' END,
            attempt.started_at,
            CASE WHEN attempt.status IN ('completed', 'failed', 'cancelled')
                 THEN COALESCE(attempt.finished_at, CURRENT_TIMESTAMP) ELSE NULL END,
            attempt.error_code, attempt.next_retry_at
     FROM agent_execution_attempts AS attempt WHERE attempt.execution_id = NEW.execution_id;
   END`,
  `CREATE TRIGGER agent_execution_context_bindings_v22_enrich_runtime_state
   AFTER INSERT ON agent_execution_context_bindings
   WHEN EXISTS (
     SELECT 1 FROM agent_execution_runtime_states
     WHERE execution_id = NEW.execution_id AND snapshot_id IS NULL
       AND review_state = 'legacy_review_required'
   )
   BEGIN
     UPDATE agent_execution_runtime_states
     SET snapshot_id = NEW.snapshot_id, authority_version = authority_version + 1,
         review_state = 'none', updated_at = NEW.bound_at
     WHERE execution_id = NEW.execution_id;
   END`,
] as const;

const V23_STATEMENTS = [
  `CREATE TABLE project_room_states (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    event_head_seq INTEGER NOT NULL DEFAULT 0 CHECK (event_head_seq >= 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
  ) STRICT`,
  `CREATE TABLE project_goals (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 512),
    description TEXT NOT NULL CHECK (length(description) <= 8192),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'rejected')),
    supersedes_goal_id TEXT REFERENCES project_goals(id),
    superseded_by_goal_id TEXT REFERENCES project_goals(id),
    supersede_reason TEXT CHECK (
      supersede_reason IS NULL OR length(trim(supersede_reason)) BETWEEN 1 AND 8192
    ),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy')),
    created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
    confirmed_by_human_actor_id TEXT REFERENCES actors(id),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    CHECK (
      (status = 'active' AND confirmed_by_human_actor_id IS NOT NULL AND superseded_by_goal_id IS NULL)
      OR (status = 'superseded' AND confirmed_by_human_actor_id IS NOT NULL AND superseded_by_goal_id IS NOT NULL)
      OR (status IN ('proposed', 'rejected') AND confirmed_by_human_actor_id IS NULL)
    ),
    CHECK (
      (status = 'active' AND supersedes_goal_id IS NULL AND supersede_reason IS NULL)
      OR (status = 'active' AND supersedes_goal_id IS NOT NULL AND supersede_reason IS NOT NULL)
      OR (status = 'superseded' AND supersede_reason IS NOT NULL)
      OR status IN ('proposed', 'rejected')
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX project_goals_one_active_v23
   ON project_goals(room_id) WHERE status = 'active'`,
  `CREATE TABLE project_decisions (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 512),
    rationale TEXT NOT NULL CHECK (length(rationale) <= 8192),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
    supersedes_decision_id TEXT REFERENCES project_decisions(id),
    superseded_by_decision_id TEXT REFERENCES project_decisions(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy')),
    created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
    confirmed_by_human_actor_id TEXT REFERENCES actors(id),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    CHECK (
      (status = 'confirmed' AND confirmed_by_human_actor_id IS NOT NULL AND superseded_by_decision_id IS NULL)
      OR (status = 'superseded' AND confirmed_by_human_actor_id IS NOT NULL AND superseded_by_decision_id IS NOT NULL)
      OR (status IN ('proposed', 'rejected') AND confirmed_by_human_actor_id IS NULL)
    )
  ) STRICT`,
  `ALTER TABLE project_requests ADD COLUMN title TEXT NOT NULL DEFAULT 'Legacy Request'
   CHECK (length(trim(title)) BETWEEN 1 AND 512)`,
  `ALTER TABLE project_requests ADD COLUMN description TEXT NOT NULL DEFAULT ''
   CHECK (length(description) <= 8192)`,
  `ALTER TABLE project_requests ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'legacy'
   CHECK (request_kind IN ('legacy', 'next_action', 'open_question', 'blocker'))`,
  `ALTER TABLE project_requests ADD COLUMN linked_fact_kind TEXT
   CHECK (linked_fact_kind IS NULL OR linked_fact_kind IN ('next_action', 'blocker', 'open_question'))`,
  `ALTER TABLE project_requests ADD COLUMN linked_fact_id TEXT`,
  `ALTER TABLE project_requests ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_v14'
   CHECK (source_kind IN ('legacy_v14', 'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'))`,
  `ALTER TABLE project_requests ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_requests ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_requests ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `UPDATE project_requests SET created_by_actor_id = requester_human_actor_id`,
  `ALTER TABLE project_next_actions ADD COLUMN title TEXT NOT NULL DEFAULT 'Legacy NextAction'
   CHECK (length(trim(title)) BETWEEN 1 AND 512)`,
  `ALTER TABLE project_next_actions ADD COLUMN description TEXT NOT NULL DEFAULT ''
   CHECK (length(description) <= 8192)`,
  `ALTER TABLE project_next_actions ADD COLUMN due_at TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT ''
   CHECK (length(acceptance_criteria) <= 8192)`,
  `ALTER TABLE project_next_actions ADD COLUMN deliverable TEXT
   CHECK (deliverable IS NULL OR length(deliverable) <= 8192)`,
  `ALTER TABLE project_next_actions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_v14'
   CHECK (source_kind IN ('legacy_v14', 'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'))`,
  `ALTER TABLE project_next_actions ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_next_actions ADD COLUMN accepted_by_human_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_next_actions ADD COLUMN verified_by_human_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_next_actions ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_next_actions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_next_actions ADD COLUMN accepted_at TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN delivery_source_kind TEXT
   CHECK (delivery_source_kind IS NULL OR delivery_source_kind IN (
     'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'
   ))`,
  `ALTER TABLE project_next_actions ADD COLUMN delivery_source_id TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN delivery_source_revision INTEGER
   CHECK (delivery_source_revision IS NULL OR delivery_source_revision > 0)`,
  `ALTER TABLE project_next_actions ADD COLUMN delivery_source_room_id TEXT REFERENCES rooms(id)`,
  `ALTER TABLE project_next_actions ADD COLUMN delivery_summary TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN completed_by_human_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_next_actions ADD COLUMN completed_at TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN status_reason TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN completion_note TEXT`,
  `ALTER TABLE project_next_actions ADD COLUMN completion_criteria_json TEXT
   CHECK (completion_criteria_json IS NULL OR json_valid(completion_criteria_json))`,
  `UPDATE project_next_actions SET created_by_actor_id = owner_actor_id`,
  `ALTER TABLE project_obstacles ADD COLUMN title TEXT NOT NULL DEFAULT 'Legacy Obstacle'
   CHECK (length(trim(title)) BETWEEN 1 AND 512)`,
  `ALTER TABLE project_obstacles ADD COLUMN description TEXT NOT NULL DEFAULT ''
   CHECK (length(description) <= 8192)`,
  `ALTER TABLE project_obstacles ADD COLUMN impact TEXT NOT NULL DEFAULT ''
   CHECK (length(impact) <= 8192)`,
  `ALTER TABLE project_obstacles ADD COLUMN due_at TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN review_at TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN resolution_criteria TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN question TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN result_source_kind TEXT
   CHECK (result_source_kind IS NULL OR result_source_kind IN (
     'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'
   ))`,
  `ALTER TABLE project_obstacles ADD COLUMN result_source_id TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN result_source_revision INTEGER
   CHECK (result_source_revision IS NULL OR result_source_revision > 0)`,
  `ALTER TABLE project_obstacles ADD COLUMN result_source_room_id TEXT REFERENCES rooms(id)`,
  `ALTER TABLE project_obstacles ADD COLUMN escalation_boundary_id TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN status_reason TEXT`,
  `ALTER TABLE project_obstacles ADD COLUMN escalation_emitted INTEGER NOT NULL DEFAULT 0
   CHECK (escalation_emitted IN (0, 1))`,
  `ALTER TABLE project_obstacles ADD COLUMN transfer_chain_json TEXT NOT NULL DEFAULT '[]'
   CHECK (json_valid(transfer_chain_json) AND json_type(transfer_chain_json) = 'array')`,
  `ALTER TABLE project_obstacles ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_v14'
   CHECK (source_kind IN ('legacy_v14', 'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'))`,
  `ALTER TABLE project_obstacles ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_obstacles ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_obstacles ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `UPDATE project_obstacles SET created_by_actor_id = owner_actor_id`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN from_owner_kind TEXT
   CHECK (from_owner_kind IS NULL OR from_owner_kind IN ('human', 'agent'))`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN from_owner_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN principal_human_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN reason TEXT NOT NULL DEFAULT 'Legacy transfer'
   CHECK (length(trim(reason)) BETWEEN 1 AND 2048)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_v14'
   CHECK (source_kind IN ('legacy_v14', 'message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy'))`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN subject_revision INTEGER
   CHECK (subject_revision IS NULL OR subject_revision > 0)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN expires_at TEXT`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN resolved_by_human_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN resolved_at TEXT`,
  `ALTER TABLE project_transfer_proposals ADD COLUMN resolution_reason TEXT`,
  `CREATE TABLE project_fact_proposals (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    fact_kind TEXT NOT NULL CHECK (fact_kind IN ('goal', 'decision', 'request', 'next_action', 'blocker', 'open_question')),
    fact_id TEXT NOT NULL CHECK (length(trim(fact_id)) BETWEEN 1 AND 128),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled', 'expired')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy')),
    proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('human', 'agent')),
    proposed_by_actor_id TEXT NOT NULL REFERENCES actors(id),
    principal_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution_reason TEXT,
    UNIQUE (room_id, fact_kind, fact_id, status)
  ) STRICT`,
  `CREATE INDEX project_fact_proposals_pending_v23
   ON project_fact_proposals(room_id, status, revision, id)`,
  `CREATE TABLE project_confirmations (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    proposal_id TEXT NOT NULL UNIQUE REFERENCES project_fact_proposals(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    principal_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    payload_digest TEXT NOT NULL CHECK (payload_digest GLOB 'sha256:[0-9a-f]*' AND length(payload_digest) = 71),
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'rejected', 'expired')),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_by_human_actor_id TEXT REFERENCES actors(id),
    resolved_at TEXT,
    resolution_reason TEXT,
    CHECK (
      (state = 'pending' AND resolved_by_human_actor_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
      OR (state = 'confirmed' AND resolved_by_human_actor_id = principal_human_actor_id AND resolved_at IS NOT NULL)
      OR (state = 'rejected' AND resolved_by_human_actor_id = principal_human_actor_id AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)
      OR (state = 'expired' AND resolved_by_human_actor_id IS NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE project_events (
    event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) BETWEEN 1 AND 192),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('proposal.created', 'proposal.confirmed', 'proposal.rejected', 'fact.created', 'fact.transitioned')),
    fact_kind TEXT NOT NULL CHECK (fact_kind IN ('goal', 'decision', 'request', 'next_action', 'blocker', 'open_question')),
    fact_id TEXT NOT NULL,
    fact_revision INTEGER NOT NULL CHECK (fact_revision > 0),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy')),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    source_visibility TEXT NOT NULL CHECK (source_visibility = 'room'),
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    UNIQUE (room_id, event_seq)
  ) STRICT`,
  `CREATE INDEX project_events_stable_page_v23 ON project_events(room_id, event_seq, event_id)`,
  `CREATE TRIGGER project_events_immutable_update_v23 BEFORE UPDATE ON project_events
   BEGIN SELECT RAISE(ABORT, 'Project event is immutable'); END`,
  `CREATE TRIGGER project_events_immutable_delete_v23 BEFORE DELETE ON project_events
   BEGIN SELECT RAISE(ABORT, 'Project event is immutable'); END`,
  `CREATE TABLE project_command_receipts (
    actor_id TEXT NOT NULL REFERENCES actors(id),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 256),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json) AND json_type(response_json) = 'object'),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
  ) STRICT`,
  `CREATE TRIGGER project_room_states_revision_update_v23
   BEFORE UPDATE OF revision, event_head_seq ON project_room_states
   WHEN NEW.revision <> OLD.revision + 1 OR NEW.event_head_seq <> OLD.event_head_seq + 1
   BEGIN SELECT RAISE(ABORT, 'Project authority revision must advance atomically'); END`,
  `ALTER TABLE project_goals ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1
   CHECK (source_revision > 0)`,
  `ALTER TABLE project_goals ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `UPDATE project_goals SET visibility_room_id = room_id`,
  `ALTER TABLE project_decisions ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1
   CHECK (source_revision > 0)`,
  `ALTER TABLE project_decisions ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `UPDATE project_decisions SET visibility_room_id = room_id`,
  `ALTER TABLE project_requests ADD COLUMN source_revision INTEGER
   CHECK (source_revision IS NULL OR source_revision > 0)`,
  `ALTER TABLE project_requests ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `ALTER TABLE project_requests ADD COLUMN source_request_intent_id TEXT
   REFERENCES human_request_intents(id)`,
  `ALTER TABLE project_requests ADD COLUMN source_target_id TEXT`,
  `ALTER TABLE project_requests ADD COLUMN frozen_responsibility_json TEXT
   CHECK (frozen_responsibility_json IS NULL OR (
     json_valid(frozen_responsibility_json) AND json_type(frozen_responsibility_json) = 'object'
   ))`,
  `ALTER TABLE project_requests ADD COLUMN frozen_responsibility_sha256 TEXT
   CHECK (frozen_responsibility_sha256 IS NULL OR (
     length(frozen_responsibility_sha256) = 64
     AND frozen_responsibility_sha256 NOT GLOB '*[^0-9a-f]*'
   ))`,
  `ALTER TABLE project_requests ADD COLUMN resolution_actor_kind TEXT
   CHECK (resolution_actor_kind IS NULL OR resolution_actor_kind IN ('human', 'agent'))`,
  `ALTER TABLE project_requests ADD COLUMN resolution_actor_id TEXT REFERENCES actors(id)`,
  `ALTER TABLE project_requests ADD COLUMN resolved_at TEXT`,
  `CREATE UNIQUE INDEX project_requests_source_intent_v23
   ON project_requests(room_id, source_request_intent_id)
   WHERE source_request_intent_id IS NOT NULL`,
  `CREATE TRIGGER project_requests_source_intent_insert_v23
   BEFORE INSERT ON project_requests
   WHEN (NEW.source_request_intent_id IS NULL) <> (NEW.source_target_id IS NULL)
      OR (NEW.source_request_intent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM human_request_intents AS intent
        WHERE intent.id = NEW.source_request_intent_id
          AND intent.room_id = NEW.room_id
          AND intent.source_message_id = NEW.source_id
          AND intent.target_id = NEW.source_target_id
          AND intent.source_revision = NEW.source_revision
          AND intent.requester_human_actor_id = NEW.requester_human_actor_id
          AND intent.target_human_actor_id = NEW.target_human_actor_id
      ))
   BEGIN SELECT RAISE(ABORT, 'Project Request source intent binding is invalid'); END`,
  `CREATE TRIGGER project_requests_source_intent_update_v23
   BEFORE UPDATE OF source_request_intent_id, source_target_id, source_id, source_revision,
                    requester_human_actor_id ON project_requests
   WHEN NEW.source_request_intent_id IS NOT OLD.source_request_intent_id
      OR NEW.source_target_id IS NOT OLD.source_target_id
      OR NEW.source_id <> OLD.source_id
      OR NEW.source_revision IS NOT OLD.source_revision
      OR NEW.requester_human_actor_id <> OLD.requester_human_actor_id
   BEGIN SELECT RAISE(ABORT, 'Project Request source intent binding is immutable'); END`,
  `ALTER TABLE project_next_actions ADD COLUMN source_revision INTEGER
   CHECK (source_revision IS NULL OR source_revision > 0)`,
  `ALTER TABLE project_next_actions ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `ALTER TABLE project_obstacles ADD COLUMN source_revision INTEGER
   CHECK (source_revision IS NULL OR source_revision > 0)`,
  `ALTER TABLE project_obstacles ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `ALTER TABLE project_fact_proposals ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1
   CHECK (source_revision > 0)`,
  `ALTER TABLE project_fact_proposals ADD COLUMN visibility_room_id TEXT REFERENCES rooms(id)`,
  `UPDATE project_fact_proposals SET visibility_room_id = room_id`,
  `CREATE TABLE project_transfer_chain (
    transfer_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('request', 'next_action', 'blocker', 'open_question')),
    subject_id TEXT NOT NULL,
    subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
    from_owner_kind TEXT NOT NULL CHECK (from_owner_kind IN ('human', 'agent')),
    from_owner_actor_id TEXT NOT NULL REFERENCES actors(id),
    to_owner_kind TEXT NOT NULL CHECK (to_owner_kind IN ('human', 'agent')),
    to_owner_actor_id TEXT NOT NULL REFERENCES actors(id),
    accepted_by_human_actor_id TEXT NOT NULL REFERENCES actors(id),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2048),
    transferred_at TEXT NOT NULL,
    UNIQUE (room_id, subject_kind, subject_id, subject_revision)
  ) STRICT`,
  `CREATE TRIGGER project_transfer_chain_immutable_update_v23 BEFORE UPDATE ON project_transfer_chain
   BEGIN SELECT RAISE(ABORT, 'Project transfer chain is immutable'); END`,
  `CREATE TRIGGER project_transfer_chain_immutable_delete_v23 BEFORE DELETE ON project_transfer_chain
   BEGIN SELECT RAISE(ABORT, 'Project transfer chain is immutable'); END`,
  `CREATE TABLE project_ball_boundaries (
    boundary_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'request', 'next_action', 'blocker', 'open_question',
      'confirmation', 'transfer', 'review', 'due'
    )),
    source_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    lifecycle_generation INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0),
    holder_kind TEXT NOT NULL CHECK (holder_kind IN ('human', 'agent')),
    holder_actor_id TEXT NOT NULL REFERENCES actors(id),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2048),
    since TEXT NOT NULL,
    due_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'superseded')),
    released_at TEXT,
    UNIQUE (room_id, source_kind, source_id, source_revision, lifecycle_generation),
    CHECK ((status = 'active') = (released_at IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX project_ball_one_active_source_v23
   ON project_ball_boundaries(room_id, source_kind, source_id) WHERE status = 'active'`,
  `CREATE TABLE project_due_reminder_claims (
    claim_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    boundary_id TEXT NOT NULL REFERENCES project_ball_boundaries(boundary_id),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    reminder_kind TEXT NOT NULL CHECK (reminder_kind IN ('initial_due', 'repeat_24h', 'review')),
    reminder_ordinal INTEGER NOT NULL CHECK (reminder_ordinal >= 0),
    boundary_at TEXT NOT NULL,
    holder_kind TEXT NOT NULL CHECK (holder_kind IN ('human', 'agent')),
    holder_actor_id TEXT NOT NULL REFERENCES actors(id),
    recipient_actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'cancelled')),
    claimed_at TEXT NOT NULL,
    dispatched_at TEXT,
    UNIQUE (room_id, boundary_id, reminder_kind, reminder_ordinal, recipient_actor_id)
  ) STRICT`,
  `CREATE TABLE project_event_outbox (
    event_id TEXT PRIMARY KEY REFERENCES project_events(event_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    dispatched_at TEXT,
    UNIQUE (room_id, event_seq)
  ) STRICT`,
  `CREATE TABLE project_transition_audit (
    audit_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    event_id TEXT NOT NULL UNIQUE REFERENCES project_events(event_id),
    operation TEXT NOT NULL,
    fact_kind TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    transition_json TEXT NOT NULL CHECK (json_valid(transition_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (room_id, project_revision)
  ) STRICT`,
  `CREATE TRIGGER project_transition_audit_immutable_update_v23 BEFORE UPDATE ON project_transition_audit
   BEGIN SELECT RAISE(ABORT, 'Project transition audit is immutable'); END`,
  `CREATE TRIGGER project_transition_audit_immutable_delete_v23 BEFORE DELETE ON project_transition_audit
   BEGIN SELECT RAISE(ABORT, 'Project transition audit is immutable'); END`,
  `CREATE TABLE project_fact_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
    projection_json TEXT NOT NULL CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'),
    projection_sha256 TEXT NOT NULL CHECK (length(projection_sha256) = 64),
    created_at TEXT NOT NULL,
    UNIQUE (room_id, project_revision)
  ) STRICT`,
  `CREATE TABLE project_archive_suspensions (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
    suspended_project_revision INTEGER NOT NULL CHECK (suspended_project_revision >= 0),
    suspended_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('suspended', 'resumed')),
    resumed_at TEXT,
    PRIMARY KEY (room_id, archive_generation),
    CHECK ((status = 'resumed') = (resumed_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE project_agent_boundary_claims (
    boundary_id TEXT NOT NULL REFERENCES project_ball_boundaries(boundary_id),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    holder_agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'consumed', 'cancelled')),
    attempted_at TEXT NOT NULL,
    consumed_at TEXT,
    PRIMARY KEY (boundary_id, source_revision),
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
  ) STRICT`,
] as const;

export const AUTHORITY_V23_STATEMENT_COUNT_FOR_TEST = V23_STATEMENTS.length;
export const AUTHORITY_V23_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  23,
  "project-loop-authority",
  V23_STATEMENTS,
);

const V24_STATEMENTS = [
  `CREATE UNIQUE INDEX project_ball_boundaries_invocation_binding_v24
   ON project_ball_boundaries (
     boundary_id, room_id, project_id, source_kind, source_id, source_revision,
     lifecycle_generation, holder_actor_id
   )`,
  `CREATE TABLE project_boundary_agent_invocation_intents (
    intent_id TEXT PRIMARY KEY CHECK (length(trim(intent_id)) BETWEEN 1 AND 256),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    boundary_id TEXT NOT NULL REFERENCES project_ball_boundaries(boundary_id),
    boundary_kind TEXT NOT NULL CHECK (
      boundary_kind IN ('checkpoint', 'due', 'blocker', 'agent_ball')
    ),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'request', 'next_action', 'blocker', 'open_question',
      'confirmation', 'transfer', 'review', 'due'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    target_agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
    assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lineage_id TEXT NOT NULL CHECK (length(trim(lineage_id)) BETWEEN 1 AND 256),
    turn_id TEXT NOT NULL CHECK (length(trim(turn_id)) BETWEEN 1 AND 256),
    request_sha256 TEXT NOT NULL CHECK (
      length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'cancelled')),
    authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    claimed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT CHECK (
      cancellation_reason IS NULL OR cancellation_reason IN (
        'room_archived', 'membership_revoked', 'assignment_revoked',
        'profile_disabled', 'capability_revoked', 'source_ineligible',
        'runtime_shutdown', 'boundary_superseded', 'boundary_resolved'
      )
    ),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    UNIQUE (boundary_id, source_revision, lifecycle_generation),
    UNIQUE (intent_id, source_revision, lifecycle_generation),
    FOREIGN KEY (
      boundary_id, room_id, project_id, source_kind, source_id, source_revision,
      lifecycle_generation, target_agent_actor_id
    ) REFERENCES project_ball_boundaries (
      boundary_id, room_id, project_id, source_kind, source_id, source_revision,
      lifecycle_generation, holder_actor_id
    ),
    FOREIGN KEY (boundary_id, source_revision)
      REFERENCES project_agent_boundary_claims(boundary_id, source_revision),
    FOREIGN KEY (profile_id, profile_revision)
      REFERENCES agent_profile_revisions(profile_id, revision),
    FOREIGN KEY (assignment_id, assignment_revision)
      REFERENCES room_agent_assignment_revisions(assignment_id, revision),
    CHECK (
      (status = 'pending' AND claimed_at IS NULL AND cancelled_at IS NULL
       AND cancellation_reason IS NULL)
      OR (status = 'claimed' AND claimed_at IS NOT NULL AND cancelled_at IS NULL
          AND cancellation_reason IS NULL)
      OR (status = 'cancelled' AND cancelled_at IS NOT NULL
          AND cancellation_reason IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX project_boundary_agent_invocation_pending_v24
   ON project_boundary_agent_invocation_intents (
     status, created_at, intent_id
   )`,
  `CREATE TRIGGER project_boundary_agent_invocation_intents_v24_validate_insert
   BEFORE INSERT ON project_boundary_agent_invocation_intents
   WHEN NEW.authority_version <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM project_ball_boundaries AS boundary
        JOIN project_agent_boundary_claims AS claim
          ON claim.boundary_id = boundary.boundary_id
         AND claim.source_revision = boundary.source_revision
        JOIN rooms AS room ON room.id = boundary.room_id
        JOIN actors AS actor ON actor.id = boundary.holder_actor_id
        JOIN room_memberships AS membership
          ON membership.room_id = boundary.room_id
         AND membership.actor_id = boundary.holder_actor_id
        JOIN agent_profiles AS profile ON profile.id = NEW.profile_id
        JOIN agent_profile_revisions AS profile_revision
          ON profile_revision.profile_id = NEW.profile_id
         AND profile_revision.revision = NEW.profile_revision
        JOIN room_agent_assignments AS assignment ON assignment.id = NEW.assignment_id
        JOIN room_agent_assignment_revisions AS assignment_revision
          ON assignment_revision.assignment_id = NEW.assignment_id
         AND assignment_revision.revision = NEW.assignment_revision
        WHERE boundary.boundary_id = NEW.boundary_id
          AND boundary.room_id = NEW.room_id
          AND boundary.project_id = NEW.project_id
          AND boundary.source_kind = NEW.source_kind
          AND boundary.source_id = NEW.source_id
          AND boundary.source_revision = NEW.source_revision
          AND boundary.lifecycle_generation = NEW.lifecycle_generation
          AND boundary.holder_kind = 'agent'
          AND boundary.holder_actor_id = NEW.target_agent_actor_id
          AND boundary.status = 'active'
          AND room.status = 'active'
          AND room.archive_generation = NEW.lifecycle_generation
          AND actor.kind = 'agent'
          AND membership.kind = 'agent'
          AND membership.participation = 'active'
          AND membership.access_revision = NEW.access_revision
          AND profile.actor_id = NEW.target_agent_actor_id
          AND profile.revision = NEW.profile_revision
          AND profile.status = 'enabled'
          AND profile_revision.actor_id = NEW.target_agent_actor_id
          AND profile_revision.status = 'enabled'
          AND assignment.room_id = NEW.room_id
          AND assignment.profile_id = NEW.profile_id
          AND assignment.agent_actor_id = NEW.target_agent_actor_id
          AND assignment.revision = NEW.assignment_revision
          AND assignment.status = 'current'
          AND assignment.participation = 'active'
          AND assignment.paused = 0
          AND assignment_revision.room_id = NEW.room_id
          AND assignment_revision.profile_id = NEW.profile_id
          AND assignment_revision.agent_actor_id = NEW.target_agent_actor_id
          AND assignment_revision.status = 'current'
          AND assignment_revision.participation = 'active'
          AND assignment_revision.paused = 0
          AND EXISTS (
            SELECT 1 FROM json_each(assignment.capability_subset_json)
            WHERE value = 'room.project.read'
          )
          AND EXISTS (
            SELECT 1 FROM json_each(assignment.capability_subset_json)
            WHERE value = 'room.respond'
          )
          AND claim.room_id = NEW.room_id
          AND claim.holder_agent_actor_id = NEW.target_agent_actor_id
          AND claim.request_sha256 = NEW.request_sha256
          AND claim.status IN ('claimed', 'consumed')
      )
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary Agent invocation authority is invalid or stale');
   END`,
  `CREATE TRIGGER project_boundary_agent_invocation_intents_v24_validate_update
   BEFORE UPDATE ON project_boundary_agent_invocation_intents
   WHEN NEW.intent_id <> OLD.intent_id
      OR NEW.room_id <> OLD.room_id
      OR NEW.project_id <> OLD.project_id
      OR NEW.boundary_id <> OLD.boundary_id
      OR NEW.boundary_kind <> OLD.boundary_kind
      OR NEW.source_kind <> OLD.source_kind
      OR NEW.source_id <> OLD.source_id
      OR NEW.source_revision <> OLD.source_revision
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation
      OR NEW.target_agent_actor_id <> OLD.target_agent_actor_id
      OR NEW.profile_id <> OLD.profile_id
      OR NEW.profile_revision <> OLD.profile_revision
      OR NEW.assignment_id <> OLD.assignment_id
      OR NEW.assignment_revision <> OLD.assignment_revision
      OR NEW.access_revision <> OLD.access_revision
      OR NEW.lineage_id <> OLD.lineage_id
      OR NEW.turn_id <> OLD.turn_id
      OR NEW.request_sha256 <> OLD.request_sha256
      OR NEW.created_at <> OLD.created_at
      OR NEW.authority_version <> OLD.authority_version + 1
      OR OLD.status = 'cancelled'
      OR (OLD.status = 'pending' AND NEW.status NOT IN ('claimed', 'cancelled'))
      OR (OLD.status = 'claimed' AND NEW.status <> 'cancelled')
      OR (OLD.status = 'pending' AND NEW.status = 'claimed'
          AND (NEW.claimed_at IS NULL OR NEW.cancelled_at IS NOT NULL
               OR NEW.cancellation_reason IS NOT NULL))
      OR (OLD.status = 'pending' AND NEW.status = 'cancelled'
          AND NEW.claimed_at IS NOT NULL)
      OR (OLD.status = 'claimed' AND NEW.claimed_at IS NOT OLD.claimed_at)
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary Agent invocation transition is invalid');
   END`,
  `CREATE TRIGGER project_boundary_agent_invocation_intents_v24_immutable_delete
   BEFORE DELETE ON project_boundary_agent_invocation_intents
   BEGIN SELECT RAISE(ABORT, 'Project boundary Agent invocation intent is immutable'); END`,
  `CREATE TABLE project_boundary_agent_executions (
    execution_id TEXT PRIMARY KEY CHECK (length(trim(execution_id)) BETWEEN 1 AND 256),
    intent_id TEXT NOT NULL REFERENCES project_boundary_agent_invocation_intents(intent_id),
    lineage_id TEXT NOT NULL CHECK (length(trim(lineage_id)) BETWEEN 1 AND 256),
    execution_ordinal INTEGER NOT NULL CHECK (execution_ordinal >= 1),
    retry_of_execution_id TEXT REFERENCES project_boundary_agent_executions(execution_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    agent_actor_id TEXT NOT NULL REFERENCES actors(id),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) BETWEEN 1 AND 128),
    model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
    public_status TEXT NOT NULL CHECK (
      public_status IN ('accepted', 'running', 'completed', 'failed', 'cancelled')
    ),
    phase TEXT NOT NULL CHECK (phase IN (
      'queued', 'retry_scheduled', 'recovery_queued', 'awaiting_capacity',
      'claiming', 'snapshot_frozen', 'model_generation', 'read_tool',
      'waiting_confirmation', 'side_effect_claimed', 'final_committing',
      'completed', 'failed', 'cancelled'
    )),
    current_attempt_seq INTEGER NOT NULL CHECK (current_attempt_seq >= 1),
    authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
    queued_at TEXT NOT NULL CHECK (length(trim(queued_at)) > 0),
    started_at TEXT,
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    completed_at TEXT,
    cancellation_reason TEXT CHECK (
      cancellation_reason IS NULL OR cancellation_reason IN (
        'room_archived', 'membership_revoked', 'assignment_revoked',
        'profile_disabled', 'capability_revoked', 'source_ineligible',
        'runtime_shutdown', 'boundary_superseded', 'boundary_resolved'
      )
    ),
    terminal_error_code TEXT CHECK (
      terminal_error_code IS NULL OR length(trim(terminal_error_code)) BETWEEN 1 AND 128
    ),
    result_message_id TEXT REFERENCES messages(id),
    UNIQUE (intent_id, execution_ordinal),
    UNIQUE (
      intent_id, execution_id, execution_ordinal, source_revision, lifecycle_generation
    ),
    FOREIGN KEY (intent_id, source_revision, lifecycle_generation)
      REFERENCES project_boundary_agent_invocation_intents(
        intent_id, source_revision, lifecycle_generation
      ),
    CHECK (
      (execution_ordinal = 1 AND retry_of_execution_id IS NULL)
      OR (execution_ordinal > 1 AND retry_of_execution_id IS NOT NULL)
    ),
    CHECK (
      (public_status = 'accepted'
       AND phase IN ('queued', 'retry_scheduled', 'recovery_queued', 'awaiting_capacity')
       AND completed_at IS NULL AND cancellation_reason IS NULL
       AND terminal_error_code IS NULL)
      OR (public_status = 'running'
          AND phase IN ('claiming', 'snapshot_frozen', 'model_generation', 'read_tool',
                        'waiting_confirmation', 'side_effect_claimed', 'final_committing')
          AND started_at IS NOT NULL AND completed_at IS NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NULL)
      OR (public_status = 'completed' AND phase = 'completed'
          AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NULL)
      OR (public_status = 'failed' AND phase = 'failed'
          AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND cancellation_reason IS NULL AND terminal_error_code IS NOT NULL)
      OR (public_status = 'cancelled' AND phase = 'cancelled'
          AND completed_at IS NOT NULL AND cancellation_reason IS NOT NULL
          AND terminal_error_code IS NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER project_boundary_agent_executions_v24_validate_insert
   BEFORE INSERT ON project_boundary_agent_executions
   WHEN NEW.authority_version <> 1
      OR NEW.current_attempt_seq <> 1
      OR NEW.public_status <> 'accepted'
      OR NOT EXISTS (
        SELECT 1 FROM project_boundary_agent_invocation_intents AS intent
        WHERE intent.intent_id = NEW.intent_id
          AND intent.status = 'claimed'
          AND intent.lineage_id = NEW.lineage_id
          AND intent.room_id = NEW.room_id
          AND intent.project_id = NEW.project_id
          AND intent.target_agent_actor_id = NEW.agent_actor_id
          AND intent.source_revision = NEW.source_revision
          AND intent.lifecycle_generation = NEW.lifecycle_generation
      )
      OR NEW.execution_ordinal <> COALESCE((
        SELECT MAX(execution_ordinal) + 1
        FROM project_boundary_agent_executions
        WHERE intent_id = NEW.intent_id
      ), 1)
      OR (NEW.retry_of_execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM project_boundary_agent_executions AS parent
        WHERE parent.intent_id = NEW.intent_id
          AND parent.execution_id = NEW.retry_of_execution_id
          AND parent.execution_ordinal < NEW.execution_ordinal
          AND parent.public_status IN ('failed', 'cancelled')
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary Agent execution authority is invalid');
   END`,
  `CREATE TRIGGER project_boundary_agent_executions_v24_validate_update
   BEFORE UPDATE ON project_boundary_agent_executions
   WHEN NEW.execution_id <> OLD.execution_id
      OR NEW.intent_id <> OLD.intent_id
      OR NEW.lineage_id <> OLD.lineage_id
      OR NEW.execution_ordinal <> OLD.execution_ordinal
      OR NEW.retry_of_execution_id IS NOT OLD.retry_of_execution_id
      OR NEW.room_id <> OLD.room_id
      OR NEW.project_id <> OLD.project_id
      OR NEW.agent_actor_id <> OLD.agent_actor_id
      OR NEW.source_revision <> OLD.source_revision
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation
      OR NEW.provider_id <> OLD.provider_id
      OR NEW.model_id <> OLD.model_id
      OR NEW.queued_at <> OLD.queued_at
      OR NEW.authority_version <> OLD.authority_version + 1
      OR OLD.public_status IN ('completed', 'failed', 'cancelled')
      OR (OLD.public_status = 'accepted'
          AND NEW.public_status NOT IN ('accepted', 'running', 'failed', 'cancelled'))
      OR (OLD.public_status = 'running'
          AND NEW.public_status NOT IN ('running', 'completed', 'failed', 'cancelled'))
      OR NEW.current_attempt_seq < OLD.current_attempt_seq
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary Agent execution transition is invalid');
   END`,
  `CREATE TRIGGER project_boundary_agent_executions_v24_immutable_delete
   BEFORE DELETE ON project_boundary_agent_executions
   BEGIN SELECT RAISE(ABORT, 'Project boundary Agent execution is immutable'); END`,
  `CREATE TABLE project_boundary_agent_execution_links (
    intent_id TEXT NOT NULL REFERENCES project_boundary_agent_invocation_intents(intent_id),
    execution_id TEXT NOT NULL UNIQUE REFERENCES project_boundary_agent_executions(execution_id),
    execution_ordinal INTEGER NOT NULL CHECK (execution_ordinal >= 1),
    retry_of_execution_id TEXT REFERENCES project_boundary_agent_executions(execution_id),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    linked_at TEXT NOT NULL CHECK (length(trim(linked_at)) > 0),
    PRIMARY KEY (intent_id, execution_ordinal),
    UNIQUE (
      intent_id, execution_id, execution_ordinal, source_revision, lifecycle_generation
    ),
    FOREIGN KEY (intent_id, source_revision, lifecycle_generation)
      REFERENCES project_boundary_agent_invocation_intents(
        intent_id, source_revision, lifecycle_generation
      ),
    CHECK (
      (execution_ordinal = 1 AND retry_of_execution_id IS NULL)
      OR (execution_ordinal > 1 AND retry_of_execution_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER project_boundary_agent_execution_links_v24_validate_insert
   BEFORE INSERT ON project_boundary_agent_execution_links
   WHEN NEW.execution_ordinal <> COALESCE((
          SELECT MAX(execution_ordinal) + 1
          FROM project_boundary_agent_execution_links
          WHERE intent_id = NEW.intent_id
        ), 1)
      OR NOT EXISTS (
        SELECT 1
        FROM project_boundary_agent_invocation_intents AS intent
        JOIN project_boundary_agent_executions AS execution
          ON execution.execution_id = NEW.execution_id
        WHERE intent.intent_id = NEW.intent_id
          AND intent.status = 'claimed'
          AND execution.intent_id = NEW.intent_id
          AND intent.room_id = execution.room_id
          AND intent.target_agent_actor_id = execution.agent_actor_id
          AND intent.lifecycle_generation = execution.lifecycle_generation
      )
      OR (NEW.retry_of_execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM project_boundary_agent_execution_links AS parent
        WHERE parent.intent_id = NEW.intent_id
          AND parent.execution_id = NEW.retry_of_execution_id
          AND parent.execution_ordinal < NEW.execution_ordinal
      ))
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary Agent execution lineage is invalid');
   END`,
  `CREATE TRIGGER project_boundary_agent_execution_links_v24_immutable_update
   BEFORE UPDATE ON project_boundary_agent_execution_links
   BEGIN SELECT RAISE(ABORT, 'Project boundary Agent execution lineage is immutable'); END`,
  `CREATE TRIGGER project_boundary_agent_execution_links_v24_immutable_delete
   BEFORE DELETE ON project_boundary_agent_execution_links
   BEGIN SELECT RAISE(ABORT, 'Project boundary Agent execution lineage is immutable'); END`,
  `CREATE UNIQUE INDEX project_fact_checkpoints_context_binding_v24
   ON project_fact_checkpoints (
     checkpoint_id, room_id, project_id, project_revision, projection_sha256
   )`,
  `CREATE TABLE project_boundary_context_sources (
    context_source_id TEXT PRIMARY KEY CHECK (
      length(trim(context_source_id)) BETWEEN 1 AND 256
    ),
    intent_id TEXT NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES project_boundary_agent_executions(execution_id),
    execution_ordinal INTEGER NOT NULL CHECK (execution_ordinal >= 1),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    checkpoint_id TEXT NOT NULL REFERENCES project_fact_checkpoints(checkpoint_id),
    checkpoint_project_revision INTEGER NOT NULL CHECK (checkpoint_project_revision >= 0),
    checkpoint_projection_sha256 TEXT NOT NULL CHECK (
      length(checkpoint_projection_sha256) = 64
      AND checkpoint_projection_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'request', 'next_action', 'blocker', 'open_question',
      'confirmation', 'transfer', 'review', 'due'
    )),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (intent_id, execution_ordinal),
    FOREIGN KEY (
      intent_id, execution_id, execution_ordinal, source_revision, lifecycle_generation
    ) REFERENCES project_boundary_agent_execution_links (
      intent_id, execution_id, execution_ordinal, source_revision, lifecycle_generation
    ),
    FOREIGN KEY (
      checkpoint_id, room_id, project_id, checkpoint_project_revision,
      checkpoint_projection_sha256
    ) REFERENCES project_fact_checkpoints (
      checkpoint_id, room_id, project_id, project_revision, projection_sha256
    )
  ) STRICT`,
  `CREATE TRIGGER project_boundary_context_sources_v24_validate_insert
   BEFORE INSERT ON project_boundary_context_sources
   WHEN NOT EXISTS (
     SELECT 1 FROM project_boundary_agent_invocation_intents AS intent
     WHERE intent.intent_id = NEW.intent_id
       AND intent.room_id = NEW.room_id
       AND intent.project_id = NEW.project_id
       AND intent.source_kind = NEW.source_kind
       AND intent.source_id = NEW.source_id
       AND intent.source_revision = NEW.source_revision
       AND intent.lifecycle_generation = NEW.lifecycle_generation
   )
   BEGIN
     SELECT RAISE(ABORT, 'Project boundary context source is not bound to its invocation');
   END`,
  `CREATE TRIGGER project_boundary_context_sources_v24_immutable_update
   BEFORE UPDATE ON project_boundary_context_sources
   BEGIN SELECT RAISE(ABORT, 'Project boundary context source is immutable'); END`,
  `CREATE TRIGGER project_boundary_context_sources_v24_immutable_delete
   BEFORE DELETE ON project_boundary_context_sources
   BEGIN SELECT RAISE(ABORT, 'Project boundary context source is immutable'); END`,
] as const;

export const AUTHORITY_V24_STATEMENT_COUNT_FOR_TEST = V24_STATEMENTS.length;
export const AUTHORITY_V24_ROLLBACK_ASSERTION_COUNT_FOR_TEST = V24_STATEMENTS.length;
export const AUTHORITY_V24_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  24,
  "project-boundary-agent-intent-lineage",
  V24_STATEMENTS,
);

const V25_STATEMENTS = [
  `DROP TRIGGER events_validate_insert`,
  `DROP TRIGGER events_prevent_update`,
  `DROP TRIGGER events_validate_delete`,
  `DROP TRIGGER project_events_immutable_update_v23`,
  `DROP TRIGGER project_events_immutable_delete_v23`,
  `DROP TRIGGER project_transition_audit_immutable_update_v23`,
  `DROP TRIGGER project_transition_audit_immutable_delete_v23`,
  `PRAGMA legacy_alter_table = ON`,
  `ALTER TABLE outbox_deliveries RENAME TO outbox_deliveries_v24`,
  `ALTER TABLE project_event_outbox RENAME TO project_event_outbox_v24`,
  `ALTER TABLE project_transition_audit RENAME TO project_transition_audit_v24`,
  `ALTER TABLE events RENAME TO events_v24`,
  `ALTER TABLE project_events RENAME TO project_events_v24`,
  `CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    stream_kind TEXT NOT NULL CHECK (stream_kind IN ('room', 'identity')),
    stream_id TEXT NOT NULL,
    stream_seq INTEGER NOT NULL CHECK (stream_seq >= 1),
    room_id TEXT REFERENCES rooms(id),
    authority_kind TEXT NOT NULL DEFAULT 'actor'
      CHECK (authority_kind IN ('actor', 'human', 'agent', 'system_timer')),
    actor_id TEXT REFERENCES actors(id),
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (stream_kind, stream_id, stream_seq),
    UNIQUE (event_id, stream_seq),
    FOREIGN KEY (stream_kind, stream_id) REFERENCES streams(stream_kind, stream_id),
    CHECK (
      (stream_kind = 'room' AND room_id IS NOT NULL AND room_id = stream_id)
      OR (stream_kind = 'identity' AND room_id IS NULL)
    ),
    CHECK (
      (authority_kind = 'system_timer' AND actor_id IS NULL AND event_type LIKE 'project.%')
      OR (authority_kind <> 'system_timer' AND actor_id IS NOT NULL)
    )
  ) STRICT`,
  `INSERT INTO events (
     event_id, stream_kind, stream_id, stream_seq, room_id, authority_kind,
     actor_id, event_type, occurred_at, payload_json
   ) SELECT legacy.event_id, legacy.stream_kind, legacy.stream_id, legacy.stream_seq,
            legacy.room_id,
            CASE WHEN legacy.event_type LIKE 'project.%' AND
                json_extract(project.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN 'system_timer'
              WHEN legacy.event_type LIKE 'project.%'
              THEN COALESCE(project.actor_kind, actor.kind)
              ELSE 'actor' END,
            CASE WHEN legacy.event_type LIKE 'project.%' AND
                json_extract(project.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE legacy.actor_id END,
            legacy.event_type, legacy.occurred_at, legacy.payload_json
     FROM events_v24 AS legacy
     LEFT JOIN project_events_v24 AS project ON project.event_id = legacy.event_id
     LEFT JOIN actors AS actor ON actor.id = legacy.actor_id`,
  `CREATE TABLE project_events (
    event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) BETWEEN 1 AND 192),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('proposal.created', 'proposal.confirmed', 'proposal.rejected', 'fact.created', 'fact.transitioned')),
    fact_kind TEXT NOT NULL CHECK (fact_kind IN ('goal', 'decision', 'request', 'next_action', 'blocker', 'open_question')),
    fact_id TEXT NOT NULL,
    fact_revision INTEGER NOT NULL CHECK (fact_revision > 0),
    authority_kind TEXT NOT NULL CHECK (authority_kind IN ('human', 'agent', 'system_timer')),
    actor_kind TEXT CHECK (actor_kind IN ('human', 'agent')),
    actor_id TEXT REFERENCES actors(id),
    causal_actor_kind TEXT CHECK (causal_actor_kind IN ('human', 'agent')),
    causal_actor_id TEXT REFERENCES actors(id),
    source_room_id TEXT NOT NULL REFERENCES rooms(id) CHECK (source_room_id = room_id),
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment', 'agent_execution', 'memory', 'project_fact', 'legacy')),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    source_visibility TEXT NOT NULL CHECK (source_visibility = 'room'),
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    UNIQUE (room_id, event_seq),
    CHECK ((authority_kind = 'system_timer' AND actor_kind IS NULL AND actor_id IS NULL
        AND causal_actor_kind IS NULL AND causal_actor_id IS NULL)
      OR (authority_kind IN ('human','agent') AND actor_kind = authority_kind
        AND actor_id IS NOT NULL AND causal_actor_kind IS NOT NULL AND causal_actor_id IS NOT NULL))
  ) STRICT`,
  `INSERT INTO project_events (
     event_id, room_id, project_id, event_seq, event_type, fact_kind, fact_id,
     fact_revision, authority_kind, actor_kind, actor_id, causal_actor_kind,
     causal_actor_id, source_room_id, source_id, source_kind, source_revision,
     source_visibility, occurred_at, payload_json
   ) SELECT event_id, room_id, project_id, event_seq, event_type, fact_kind, fact_id,
            fact_revision,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN 'system_timer' ELSE actor_kind END,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE actor_kind END,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE actor_id END,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE actor_kind END,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE actor_id END,
            source_room_id, source_id, source_kind, source_revision, source_visibility,
            occurred_at,
            CASE WHEN json_extract(payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN json_set(payload_json, '$.migratedFromV24', json('true')) ELSE payload_json END
     FROM project_events_v24`,
  `CREATE TABLE project_transition_audit (
    audit_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    project_id TEXT NOT NULL REFERENCES rooms(id) CHECK (project_id = room_id),
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    event_id TEXT NOT NULL UNIQUE REFERENCES project_events(event_id),
    operation TEXT NOT NULL,
    fact_kind TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    authority_kind TEXT NOT NULL CHECK (authority_kind IN ('human', 'agent', 'system_timer')),
    actor_kind TEXT CHECK (actor_kind IN ('human', 'agent')),
    actor_id TEXT REFERENCES actors(id),
    causal_actor_kind TEXT CHECK (causal_actor_kind IN ('human', 'agent')),
    causal_actor_id TEXT REFERENCES actors(id),
    transition_json TEXT NOT NULL CHECK (json_valid(transition_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (room_id, project_revision),
    CHECK ((authority_kind = 'system_timer' AND actor_kind IS NULL AND actor_id IS NULL
        AND causal_actor_kind IS NULL AND causal_actor_id IS NULL)
      OR (authority_kind IN ('human','agent') AND actor_kind = authority_kind
        AND actor_id IS NOT NULL AND causal_actor_kind IS NOT NULL AND causal_actor_id IS NOT NULL))
  ) STRICT`,
  `INSERT INTO project_transition_audit (
     audit_id, room_id, project_id, project_revision, event_id, operation, fact_kind,
     fact_id, authority_kind, actor_kind, actor_id, causal_actor_kind, causal_actor_id,
     transition_json, occurred_at
   ) SELECT legacy.audit_id, legacy.room_id, legacy.project_id, legacy.project_revision,
            legacy.event_id, legacy.operation, legacy.fact_kind, legacy.fact_id,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN 'system_timer' ELSE legacy.actor_kind END,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE legacy.actor_kind END,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE legacy.actor_id END,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE legacy.actor_kind END,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN NULL ELSE legacy.actor_id END,
            CASE WHEN json_extract(event.payload_json, '$.transition') IN ('review_due','transfer_expired')
              THEN json_set(legacy.transition_json, '$.migratedFromV24', json('true'))
              ELSE legacy.transition_json END,
            legacy.occurred_at
     FROM project_transition_audit_v24 AS legacy
     JOIN project_events_v24 AS event ON event.event_id = legacy.event_id`,
  `CREATE TABLE outbox_deliveries (
    id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL REFERENCES events(event_id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('room', 'principal', 'session-family')),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    stream_seq INTEGER NOT NULL CHECK (stream_seq >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT,
    PRIMARY KEY (event_id, target_kind, target_id),
    FOREIGN KEY (event_id, stream_seq) REFERENCES events(event_id, stream_seq)
  ) STRICT`,
  `INSERT INTO outbox_deliveries SELECT * FROM outbox_deliveries_v24`,
  `CREATE TABLE project_event_outbox (
    event_id TEXT PRIMARY KEY REFERENCES project_events(event_id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL, dispatched_at TEXT,
    UNIQUE (room_id, event_seq)
  ) STRICT`,
  `INSERT INTO project_event_outbox SELECT * FROM project_event_outbox_v24`,
  `DROP TABLE outbox_deliveries_v24`,
  `DROP TABLE project_event_outbox_v24`,
  `DROP TABLE project_transition_audit_v24`,
  `DROP TABLE project_events_v24`,
  `DROP TABLE events_v24`,
  `PRAGMA legacy_alter_table = OFF`,
  `CREATE UNIQUE INDEX events_event_id_stream_seq ON events(event_id, stream_seq)`,
  `CREATE INDEX project_events_stable_page_v25 ON project_events(room_id, event_seq, event_id)`,
  `CREATE TRIGGER events_validate_insert BEFORE INSERT ON events
   WHEN NOT EXISTS (
     SELECT 1 FROM streams AS stream WHERE stream.stream_kind = NEW.stream_kind
       AND stream.stream_id = NEW.stream_id AND NEW.stream_seq = stream.head_seq
       AND NEW.stream_seq >= stream.retained_from_seq AND (
         NEW.stream_seq = stream.retained_from_seq OR EXISTS (
           SELECT 1 FROM events AS previous WHERE previous.stream_kind = NEW.stream_kind
             AND previous.stream_id = NEW.stream_id AND previous.stream_seq = NEW.stream_seq - 1)))
      OR (NEW.authority_kind IN ('human','agent') AND NOT EXISTS (
        SELECT 1 FROM actors WHERE id = NEW.actor_id AND kind = NEW.authority_kind))
      OR (NEW.authority_kind = 'system_timer' AND NEW.event_type NOT IN (
        'project.goal.changed','project.decision.changed','project.request.changed',
        'project.next-action.changed','project.blocker.changed','project.open-question.changed',
        'project.proposal.changed','project.confirmation.changed',
        'project.transfer-proposal.changed','project.ball.changed'))
      OR (NEW.event_type IN (
        'project.goal.changed','project.decision.changed','project.request.changed',
        'project.next-action.changed','project.blocker.changed','project.open-question.changed',
        'project.proposal.changed','project.confirmation.changed',
        'project.transfer-proposal.changed','project.ball.changed') AND NOT EXISTS (
        SELECT 1 FROM project_events AS project
        WHERE project.event_id = NEW.event_id
          AND project.authority_kind = NEW.authority_kind
          AND project.actor_id IS NEW.actor_id
          AND (project.authority_kind <> 'system_timer'
            OR (json_extract(project.payload_json, '$.transition') = 'review_due' AND (
              (project.fact_kind = 'blocker' AND NEW.event_type = 'project.blocker.changed')
              OR (project.fact_kind = 'open_question' AND NEW.event_type = 'project.open-question.changed'))
              AND json_extract(NEW.payload_json, '$.obstacleId') = project.fact_id
              AND json_extract(NEW.payload_json, '$.revision') = project.fact_revision)
            OR (json_extract(project.payload_json, '$.transition') IN (
                  'transfer_expired','review_due_transfer_rebound')
              AND NEW.event_type = 'project.transfer-proposal.changed'
              AND json_extract(NEW.payload_json, '$.transferProposalId') =
                  json_extract(project.payload_json, '$.transferProposalId')
              AND json_extract(NEW.payload_json, '$.revision') =
                  json_extract(project.payload_json, '$.transferRevision')))))
   BEGIN SELECT RAISE(ABORT, 'event sequence is outside the current stream window'); END`,
  `CREATE TRIGGER events_prevent_update BEFORE UPDATE ON events
   BEGIN SELECT RAISE(ABORT, 'events are immutable'); END`,
  `CREATE TRIGGER events_validate_delete BEFORE DELETE ON events
   WHEN EXISTS (SELECT 1 FROM streams AS stream WHERE stream.stream_kind = OLD.stream_kind
     AND stream.stream_id = OLD.stream_id AND OLD.stream_seq >= stream.retained_from_seq
     AND OLD.stream_seq <= stream.head_seq)
   BEGIN SELECT RAISE(ABORT, 'event inside retained window cannot be deleted'); END`,
  `CREATE TRIGGER project_events_v25_validate_insert BEFORE INSERT ON project_events
   WHEN (NEW.authority_kind IN ('human','agent') AND (
        NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.causal_actor_id AND kind = NEW.causal_actor_kind)
        OR NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.actor_id AND kind = NEW.authority_kind)))
      OR (NEW.authority_kind = 'system_timer' AND (
        NEW.event_type <> 'fact.transitioned'
        OR NEW.actor_kind IS NOT NULL OR NEW.actor_id IS NOT NULL
        OR NEW.causal_actor_kind IS NOT NULL OR NEW.causal_actor_id IS NOT NULL
        OR json_type(NEW.payload_json, '$.transition') IS NOT 'text'
        OR (json_extract(NEW.payload_json, '$.transition') = 'review_due'
          AND NEW.fact_kind NOT IN ('blocker','open_question'))
        OR (json_extract(NEW.payload_json, '$.transition') IN (
              'transfer_expired','review_due_transfer_rebound') AND (
          NEW.fact_kind NOT IN ('next_action','blocker','open_question')
          OR json_type(NEW.payload_json, '$.transferProposalId') IS NOT 'text'
          OR json_type(NEW.payload_json, '$.transferRevision') IS NOT 'integer'))
        OR json_extract(NEW.payload_json, '$.transition') NOT IN (
          'review_due','transfer_expired','review_due_transfer_rebound')
        OR json_extract(NEW.payload_json, '$.migratedFromV24') IS NOT NULL))
   BEGIN SELECT RAISE(ABORT, 'Project event transition authority is invalid'); END`,
  `CREATE TRIGGER project_events_immutable_update_v25 BEFORE UPDATE ON project_events
   BEGIN SELECT RAISE(ABORT, 'Project event is immutable'); END`,
  `CREATE TRIGGER project_events_immutable_delete_v25 BEFORE DELETE ON project_events
   BEGIN SELECT RAISE(ABORT, 'Project event is immutable'); END`,
  `CREATE TRIGGER project_transition_audit_v25_validate_insert BEFORE INSERT ON project_transition_audit
   WHEN (NEW.authority_kind IN ('human','agent') AND (
        NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.causal_actor_id AND kind = NEW.causal_actor_kind)
        OR NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.actor_id AND kind = NEW.authority_kind)))
      OR (NEW.authority_kind = 'system_timer' AND (
        NEW.actor_kind IS NOT NULL OR NEW.actor_id IS NOT NULL
        OR NEW.causal_actor_kind IS NOT NULL OR NEW.causal_actor_id IS NOT NULL))
   BEGIN SELECT RAISE(ABORT, 'Project audit transition authority is invalid'); END`,
  `CREATE TRIGGER project_transition_audit_immutable_update_v25 BEFORE UPDATE ON project_transition_audit
   BEGIN SELECT RAISE(ABORT, 'Project transition audit is immutable'); END`,
  `CREATE TRIGGER project_transition_audit_immutable_delete_v25 BEFORE DELETE ON project_transition_audit
   BEGIN SELECT RAISE(ABORT, 'Project transition audit is immutable'); END`,
] as const;

export const AUTHORITY_V25_STATEMENT_COUNT_FOR_TEST = V25_STATEMENTS.length;
export const AUTHORITY_V25_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  25, "project-transition-authority", V25_STATEMENTS,
);

export const AUTHORITY_V22_STATEMENT_COUNT_FOR_TEST = V22_STATEMENTS.length;
export const AUTHORITY_V22_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  V22_STATEMENTS.filter((statement) => statement.startsWith("CREATE TRIGGER ")).length;
export const AUTHORITY_V22_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST = 7;
export const AUTHORITY_V22_INVARIANT_STATEMENT_COUNT_FOR_TEST =
  AUTHORITY_V22_TRIGGER_INVARIANT_STATEMENT_COUNT_FOR_TEST
  + AUTHORITY_V22_STARTUP_INVARIANT_STATEMENT_COUNT_FOR_TEST;
export const AUTHORITY_V22_ROLLBACK_ASSERTION_COUNT_FOR_TEST = V22_STATEMENTS.length;
export const AUTHORITY_V22_MIGRATION_CHECKSUM_FOR_TEST = migrationChecksum(
  22,
  "invocation-runtime-authority",
  V22_STATEMENTS,
);

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
    throw new Error(`Historical migration ${version} no longer matches its checksum: ${checksum}`);
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
  defineMigration(6, "agent-runtime-authority", V6_STATEMENTS, V6_MIGRATION_CHECKSUM),
  defineMigration(7, "single-route-authority", V7_STATEMENTS, V7_MIGRATION_CHECKSUM),
  defineMigration(8, "closed-open-item-authority", V8_STATEMENTS, V8_MIGRATION_CHECKSUM),
  defineMigration(9, "closed-light-task-authority", V9_STATEMENTS, V9_MIGRATION_CHECKSUM),
  defineMigration(10, "ball-in-court-boundaries", V10_STATEMENTS, V10_MIGRATION_CHECKSUM),
  defineMigration(11, "hard-human-preemption", V11_STATEMENTS, V11_MIGRATION_CHECKSUM),
  defineMigration(
    12,
    "authoritative-session-families",
    V12_STATEMENTS,
    V12_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    13,
    "room-governance-foundation",
    V13_STATEMENTS,
    V13_MIGRATION_CHECKSUM,
  ),
  defineMigration(14, "shared-authority-production-providers", V14_STATEMENTS),
  defineMigration(
    15,
    "truthful-room-lifecycle-audit-vocabulary",
    V15_STATEMENTS,
    V15_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    16,
    "message-authority-vnext",
    V16_STATEMENTS,
    V16_MIGRATION_CHECKSUM,
  ),
  defineMigration(
    17,
    "attachment-authority-pipeline",
    V17_STATEMENTS,
  ),
  defineMigration(
    18,
    "room-memory-authority-steward",
    V18_STATEMENTS,
  ),
  defineMigration(
    19,
    "context-snapshot-authority",
    V19_STATEMENTS,
  ),
  defineMigration(
    20,
    "agent-profile-routing-authority",
    V20_STATEMENTS,
  ),
  defineMigration(
    21,
    "direct-invocation-authority-binding",
    V21_STATEMENTS,
  ),
  defineMigration(
    22,
    "invocation-runtime-authority",
    V22_STATEMENTS,
  ),
  defineMigration(
    23,
    "project-loop-authority",
    V23_STATEMENTS,
  ),
  defineMigration(
    24,
    "project-boundary-agent-intent-lineage",
    V24_STATEMENTS,
  ),
  defineMigration(25, "project-transition-authority", V25_STATEMENTS),
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
    ...V4_SCHEMA_CONTRACT.agent_executions,
    "action_category",
    "tool_dispatch_phase",
    "current_attempt_seq",
    "retry_cycle",
    "retry_ordinal",
    "provider_id",
    "model_id",
    "recovery_cursor",
    "queued_at",
    "updated_at",
    "cancellation_reason",
    "terminal_error_code",
    "dead_lettered_at",
    "result_message_id",
    "next_retry_at",
    "manual_retry_of_execution_id",
    "compensates_execution_id",
  ],
  agent_execution_attempts: [
    "execution_id", "attempt_seq", "retry_cycle", "retry_ordinal", "status",
    "action_category", "started_at", "finished_at", "error_code", "next_retry_at",
    "recovery_cursor",
  ],
  agent_execution_grants: [
    "grant_id", "execution_id", "attempt_seq", "agent_id", "room_id", "tool_id",
    "parameter_sha256", "issued_at", "expires_at", "consumed_at",
  ],
  agent_execution_steps: [
    "execution_id", "attempt_seq", "step_seq", "step_kind", "tool_call_json",
    "bounded_tool_result_json", "input_sha256", "output_sha256", "completed_at",
  ],
  agent_fence_replacements: [
    "fence_message_id", "old_execution_id", "old_attempt_seq", "route_job_id", "selected_agent_id",
    "replacement_execution_id", "created_at",
  ],
  agent_human_fences: [
    "fence_message_id", "execution_id", "old_attempt_seq", "cancelled_at",
  ],
  agent_invocation_intents: [
    "id", "room_id", "source_message_id", "target_agent_id", "requester_actor_id",
    "intent_kind", "execution_id", "created_at",
  ],
  tool_confirmations: [
    "confirmation_id", "execution_id", "attempt_seq", "tool_id", "parameter_sha256",
    "room_id", "human_principal_id", "session_family_id", "expires_at", "target",
    "impact", "reversibility", "consumed_at",
  ],
  tool_dispatches: [
    "dispatch_id", "execution_id", "attempt_seq", "grant_id", "tool_id",
    "parameter_sha256", "state", "dispatched_at", "settled_at", "closed_summary_json",
    "sealed_compensation",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V7_SCHEMA_CONTRACT = {
  ...V6_SCHEMA_CONTRACT,
  message_topics: [
    "message_id", "room_id", "topic_key", "embedding_model_version", "window_size",
    "cosine_threshold", "created_at",
  ],
  route_attempts: [
    "route_job_id", "attempt_seq", "status", "started_at", "finished_at", "error_code",
    "next_retry_at",
  ],
  route_calibration_facts: [
    "fact_id", "room_id", "source_message_id", "human_actor_id", "agent_id", "topic_key",
    "weight", "kind", "created_at",
  ],
  route_calibration_scores: ["agent_id", "topic_key", "score", "updated_at"],
  route_invocation_intents: [
    "route_job_id", "source_message_id", "target_agent_id", "intent_kind", "reason_code",
    "reason_text", "priority", "created_at",
  ],
  route_job_agents: [
    "route_job_id", "agent_id", "participation", "role", "capabilities_json",
    "calibration_score", "has_ball",
  ],
  route_jobs: [
    "id", "room_id", "source_message_id", "status", "current_attempt", "topic_key",
    "embedding_model_version", "window_size", "cosine_threshold", "room_phase", "created_at",
    "updated_at", "completed_at", "terminal_error_code", "next_retry_at",
  ],
  route_judgments: [
    "id", "route_job_id", "source_message_id", "agent_id", "outcome", "reason_code",
    "reason_text", "route_attempt", "decided_at",
  ],
  route_metrics: ["route_job_id", "metric_name", "value", "recorded_at"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V8_SCHEMA_CONTRACT = {
  ...V7_SCHEMA_CONTRACT,
  open_items: [
    "id", "room_id", "source_message_id", "current_owner_actor_id", "status", "body",
    "created_at", "responded_at", "requester_actor_id", "transfer_chain_json",
    "origin_kind", "proposal_kind", "source_execution_id", "proposal_reason",
  ],
  open_item_agent_failures: [
    "id", "open_item_id", "execution_id", "attempt_seq", "reason_code", "failed_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V9_SCHEMA_CONTRACT = {
  ...V8_SCHEMA_CONTRACT,
  light_tasks: [
    "id", "room_id", "source_message_id", "title", "claimant_actor_id",
    "claimant_role_at_claim", "verifier_role", "verifier_actor_id", "criteria_json",
    "status", "created_at", "claimed_at", "delivered_at", "verified_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V10_SCHEMA_CONTRACT = {
  ...V9_SCHEMA_CONTRACT,
  ball_boundary_claims: [
    "id", "room_id", "source_kind", "source_id", "holder_actor_id", "holder_kind",
    "reason", "since_at", "deadline_at", "boundary_kind", "claimed_at", "route_consumed_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V11_SCHEMA_CONTRACT = {
  ...V10_SCHEMA_CONTRACT,
  agent_executions: [
    ...V10_SCHEMA_CONTRACT.agent_executions,
    "supersedes_execution_ids_json",
  ],
  human_preemption_fences: [
    "source_human_message_id", "room_id", "human_actor_id", "accepted_at",
    "cancelled_count", "cancel_committed_at", "route_job_id", "route_created_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V12_SCHEMA_CONTRACT = {
  ...V11_SCHEMA_CONTRACT,
  session_families: [
    "family_id", "public_id", "account_id", "actor_id", "device_id", "device_label",
    "platform", "created_at", "refresh_expires_at", "revoked_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V13_SCHEMA_CONTRACT = {
  ...V12_SCHEMA_CONTRACT,
  rooms: [
    ...V12_SCHEMA_CONTRACT.rooms,
    "owner_actor_id", "governance_revision", "archive_generation", "archived_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V14_SCHEMA_CONTRACT = {
  ...V13_SCHEMA_CONTRACT,
  agent_executions: [
    ...V13_SCHEMA_CONTRACT.agent_executions,
    "room_archive_generation",
  ],
  agent_execution_grants: [
    ...V13_SCHEMA_CONTRACT.agent_execution_grants,
    "grant_state", "grant_reason", "grant_revision", "grant_changed_at",
  ],
  tool_confirmations: [
    ...V13_SCHEMA_CONTRACT.tool_confirmations,
    "confirmation_state", "confirmation_reason", "confirmation_revision",
    "confirmation_changed_at",
  ],
  agent_profiles: [
    "id", "actor_id", "revision", "status", "capability_ceiling_json",
    "tool_ceiling_json",
  ],
  room_agent_assignments: [
    "id", "room_id", "profile_id", "agent_actor_id", "revision", "status",
    "participation", "paused", "capability_subset_json", "tool_subset_json",
  ],
  room_assignment_archive_policies: [
    "room_id", "archive_generation", "policy_version", "assignment_revision",
    "expansion_blocked", "reduced_at",
  ],
  room_business_timer_freeze_batches: [
    "room_id", "archive_generation", "suspended_at", "suspended_count",
    "resumed_at", "resumed_count", "descriptor_ids_json",
  ],
  room_business_timer_freezes: [
    "room_id", "archive_generation", "descriptor_id", "timer_key", "source_kind",
    "source_id", "original_due_at", "remaining_ms", "frozen_at", "state",
    "resumed_due_at", "resolved_at",
  ],
  project_requests: [
    "id", "room_id", "source_room_id", "source_id", "revision",
    "requester_human_actor_id", "target_human_actor_id", "status",
  ],
  project_next_actions: [
    "id", "room_id", "source_room_id", "source_id", "revision", "owner_kind",
    "owner_actor_id", "verifier_human_actor_id", "status",
  ],
  project_obstacles: [
    "id", "room_id", "source_room_id", "source_id", "revision", "kind",
    "owner_kind", "owner_actor_id", "status",
  ],
  project_transfer_proposals: [
    "id", "room_id", "source_room_id", "source_id", "revision", "subject_kind",
    "subject_id", "to_owner_kind", "to_owner_actor_id", "status",
  ],
  tool_archive_settlements: [
    "room_id", "archive_generation", "settled_at", "rejected_pending_count",
    "revoked_grant_count", "fenced_waiting_count", "preserved_dispatched_count",
  ],
  tool_archive_settlement_members: [
    "room_id", "archive_generation", "subject_kind", "subject_id", "disposition",
    "recorded_at",
  ],
  room_message_archive_gates: [
    "room_id", "gate_generation", "blocked_at",
  ],
  room_access_authority: [
    "room_id", "access_revision", "lease_generation",
  ],
  room_cache_invalidation_intents: [
    "id", "room_id", "lifecycle_generation", "access_revision", "reason",
    "status", "attempts", "available_at", "created_at", "completed_at",
    "last_error_code",
  ],
  offline_read_lease_issuances: [
    "lease_id", "room_id", "account_id", "actor_id", "session_family_id",
    "device_id", "installation_id", "server_subject", "key_id",
    "lifecycle_generation", "access_revision", "lease_generation",
    "issued_at_ms", "not_before_ms", "expires_at_ms", "revoked_at_ms",
  ],
  offline_read_lease_invalidations: [
    "id", "room_id", "lifecycle_generation", "access_revision",
    "lease_generation", "revoked_lease_count", "reason", "created_at",
  ],
  runtime_archive_fence_members: [
    "room_id", "archive_generation", "execution_id", "attempt_seq",
    "disposition", "fenced_at",
  ],
  runtime_archive_fences: [
    "room_id", "archive_generation", "fenced_at", "fenced_queued_count",
    "fenced_waiting_count", "preserved_dispatched_count",
    "preserved_outcome_review_count",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V15_SCHEMA_CONTRACT = {
  ...V14_SCHEMA_CONTRACT,
  room_cache_invalidation_intents: [
    ...V14_SCHEMA_CONTRACT.room_cache_invalidation_intents,
    "target_actor_id",
  ],
  offline_read_lease_invalidations: [
    ...V14_SCHEMA_CONTRACT.offline_read_lease_invalidations,
    "target_actor_id",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V16_SCHEMA_CONTRACT = {
  ...V15_SCHEMA_CONTRACT,
  agent_executions: [
    ...V15_SCHEMA_CONTRACT.agent_executions,
    "execution_generation",
  ],
  agent_execution_intent_links: [
    "intent_id", "execution_id", "execution_ordinal", "retry_of_execution_id",
    "source_revision", "linked_at",
  ],
  agent_invocation_intents: [
    "id", "room_id", "source_message_id", "target_agent_id",
    "requester_actor_id", "intent_kind", "execution_id", "created_at",
    "message_transaction_id", "target_id", "source_revision", "lineage_id",
    "turn_id", "origin_kind", "status", "claimed_at", "cancelled_at",
    "cancellation_reason", "supersedes_intent_id",
  ],
  agent_message_corrections: [
    "correction_message_id", "corrects_message_id", "room_id",
    "agent_actor_id", "created_at",
  ],
  agent_message_sources: [
    "message_id", "room_id", "invocation_intent_id", "execution_id",
    "attempt_seq", "execution_generation", "source_message_id",
    "source_revision", "committed_at",
  ],
  human_request_intents: [
    "id", "room_id", "source_message_id", "target_id", "source_revision",
    "requester_human_actor_id", "target_human_actor_id", "status",
    "created_at", "claimed_at", "cancelled_at", "cancellation_reason",
  ],
  message_attachment_links: [
    "message_id", "room_id", "attachment_id", "operational_state",
  ],
  message_envelopes: [
    "message_id", "room_id", "message_kind", "lifecycle", "current_revision",
    "revision_count", "created_at", "recalled_at", "recalled_by_actor_id",
  ],
  message_mentions: [
    "message_id", "room_id", "target_id", "target_kind", "target_actor_id",
    "range_start_utf16", "range_end_utf16", "target_order",
  ],
  message_recall_fences: [
    "fence_id", "room_id", "source_message_id", "source_revision",
    "scope_kind", "invocation_intent_id", "execution_id", "reason", "created_at",
  ],
  message_reply_links: ["message_id", "room_id", "reply_to_message_id"],
  message_revisions: [
    "message_id", "revision", "body", "revised_at", "revised_by_actor_id",
  ],
  message_target_outcomes: [
    "message_id", "room_id", "target_id", "target_actor_id", "target_kind",
    "status", "request_intent_id", "invocation_intent_id", "rejection_code",
    "created_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V17_SCHEMA_CONTRACT = {
  ...V16_SCHEMA_CONTRACT,
  attachment_extraction_artifacts: [
    "artifact_id", "attachment_id", "processing_generation", "method",
    "tool_name", "tool_version", "object_key", "sha256", "byte_size",
    "page_start", "page_end", "range_start", "range_end", "created_at",
  ],
  attachment_processing_attempts: [
    "attachment_id", "processing_generation", "attempt_number", "adapter_kind",
    "adapter_name", "adapter_version", "status", "failure_code", "timeout_ms",
    "stdout_limit_bytes", "stderr_limit_bytes", "started_at", "finished_at",
  ],
  attachment_upload_chunks: [
    "upload_id", "ordinal", "byte_offset", "byte_length", "chunk_sha256",
    "part_object_key", "created_at",
  ],
  attachment_uploads: [
    "upload_id", "upload_key", "canonical_input_sha256", "room_id",
    "uploader_actor_id", "session_family_id", "access_revision",
    "lifecycle_generation", "expected_bytes", "received_bytes", "expected_sha256",
    "original_filename", "declared_mime", "format_hint", "status",
    "terminal_reason_code", "created_at", "updated_at", "idle_expires_at",
    "absolute_expires_at",
  ],
  attachments: [
    "attachment_id", "source_upload_id", "room_id", "uploader_actor_id",
    "original_filename", "declared_mime", "detected_mime", "format", "byte_size",
    "sha256", "quarantine_object_key", "object_key", "processing_status",
    "processing_generation", "failure_code", "source_message_id",
    "source_operational_state", "source_bound_at", "lifecycle_generation",
    "access_revision", "created_at", "updated_at", "ready_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V18_SCHEMA_CONTRACT = {
  ...V17_SCHEMA_CONTRACT,
  room_memory_attempts: [
    "attempt_id", "job_id", "room_id", "recovery_generation", "attempt_number",
    "status", "input_sha256", "output_sha256", "error_code", "started_at",
    "finished_at", "available_at",
  ],
  room_memory_disputes: [
    "dispute_id", "room_id", "memory_record_id", "expected_version_id",
    "disputed_version_id", "expected_version_number", "operator_kind",
    "operator_actor_id", "reason", "created_at",
  ],
  room_memory_idempotency: [
    "scope", "idempotency_key", "room_id", "actor_id", "request_sha256",
    "response_json", "status_code", "created_at_ms", "expires_at_ms",
  ],
  room_memory_jobs: [
    "job_id", "room_id", "recovery_generation", "lifecycle_generation",
    "from_watermark_exclusive", "to_corpus_seq_inclusive", "source_count",
    "frozen_sources_json", "status", "current_attempt", "available_at",
    "claimed_at", "completed_at", "last_error_code", "result_sha256",
    "created_at", "updated_at",
  ],
  room_memory_project_checkpoint: [
    "room_id", "mode", "participant_id", "checkpoint_id", "checkpoint_version",
    "health", "health_reason_code", "updated_at",
  ],
  room_memory_records: [
    "memory_record_id", "room_id", "kind", "dedupe_key", "current_version_id",
    "current_version_number", "created_at", "updated_at",
  ],
  room_memory_resolutions: [
    "resolution_id", "dispute_id", "room_id", "memory_record_id",
    "expected_disputed_version_id", "resolution_version_id", "replacement_version_id",
    "operator_kind", "operator_actor_id", "resolution", "reason", "created_at",
  ],
  room_memory_source_edges: [
    "edge_id", "memory_version_id", "memory_record_id", "room_id", "source_kind",
    "source_id", "source_revision", "created_at",
  ],
  room_memory_source_transitions: [
    "transition_id", "room_id", "source_kind", "source_id", "source_revision",
    "from_eligibility", "to_eligibility", "from_availability", "to_availability",
    "reason_code", "transitioned_at",
  ],
  room_memory_sources: [
    "room_id", "corpus_seq", "source_kind", "source_id", "source_revision",
    "server_stream_seq", "eligibility", "availability", "source_actor_id",
    "safe_metadata_json", "read_reference", "occurred_at", "updated_at",
  ],
  room_memory_stewards: [
    "room_id", "steward_id", "lifecycle_generation", "memory_watermark",
    "corpus_head", "health", "health_reason_code", "recovery_generation",
    "last_attempt_at", "retryable", "recovery_required", "created_at", "updated_at",
  ],
  room_memory_versions: [
    "memory_version_id", "memory_record_id", "room_id", "version_number", "kind",
    "state", "derived_text", "proposal_id", "origin_kind", "created_by_actor_id",
    "source_job_id", "replaces_version_id", "source_count", "created_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V19_SCHEMA_CONTRACT = {
  ...V18_SCHEMA_CONTRACT,
  agent_execution_context_attempts: [
    "execution_id", "attempt_seq", "snapshot_id", "snapshot_generation",
    "reuse_kind", "bound_at",
  ],
  agent_execution_context_bindings: [
    "execution_id", "snapshot_id", "invocation_intent_id",
    "execution_generation", "bound_at",
  ],
  agent_message_citations: [
    "message_id", "ordinal", "execution_id", "snapshot_id", "receipt_id",
    "manifest_item_ordinal", "citation_label_sha256", "source_kind", "source_id",
    "source_revision", "snapshot_generation", "created_at",
  ],
  context_manifest_items: [
    "manifest_id", "snapshot_id", "ordinal", "section", "disposition",
    "canonical_sort_key", "source_label_sha256", "source_kind", "source_id",
    "source_revision", "content_sha256", "original_bytes", "included_bytes",
    "original_tokens", "included_tokens", "reason_code", "segment_json",
    "availability",
  ],
  context_manifests: [
    "manifest_id", "snapshot_id", "manifest_version", "manifest_sha256",
    "canonical_manifest_json", "item_count", "total_original_bytes",
    "total_included_bytes", "total_original_tokens", "total_included_tokens",
    "accounting_json", "created_at",
  ],
  context_manifest_range_sources: [
    "manifest_id", "snapshot_id", "range_ordinal", "range_label_sha256",
    "corpus_seq", "source_kind", "source_id", "source_revision",
    "source_index_sha256", "created_at",
  ],
  context_snapshot_bodies: [
    "snapshot_id", "envelope_schema_version", "canonical_envelope_json",
    "envelope_sha256", "byte_count", "token_count", "created_at",
  ],
  context_snapshot_lineage: [
    "child_snapshot_id", "parent_snapshot_id", "child_execution_id",
    "parent_execution_id", "relation", "created_at",
  ],
  context_snapshot_sources: [
    "snapshot_id", "room_id", "source_kind", "source_id", "source_revision",
    "source_label_sha256", "currently_required", "authorization_revision", "created_at",
  ],
  context_snapshot_transitions: [
    "transition_id", "snapshot_id", "from_state", "to_state",
    "from_generation", "to_generation", "reason_code", "transitioned_at",
  ],
  context_snapshots: [
    "snapshot_id", "room_id", "invocation_intent_id", "agent_id",
    "provider_id", "model_id", "compiler_version", "compiler_config_version",
    "estimator_version", "preparation_sha256", "trigger_message_id",
    "trigger_revision", "trigger_reason", "memory_watermark", "corpus_head",
    "raw_delta_from_exclusive", "raw_delta_to_inclusive",
    "room_lifecycle_generation", "membership_access_revision",
    "tool_capability_revision", "budget_json", "manifest_sha256",
    "envelope_sha256", "state", "snapshot_generation", "created_at",
    "invalidated_at", "invalidation_reason", "superseded_at", "retired_at",
    "retain_until", "payload_retention_state",
  ],
  context_source_read_payloads: [
    "read_id", "canonical_result_json", "result_sha256", "byte_count",
    "token_count", "created_at",
  ],
  context_source_read_grants: [
    "grant_id", "execution_id", "attempt_seq", "snapshot_id",
    "snapshot_generation", "tool_id", "parameter_sha256", "issued_at", "expires_at",
  ],
  context_source_read_dispatches: [
    "dispatch_id", "grant_id", "execution_id", "attempt_seq", "call_id",
    "tool_id", "request_sha256", "dispatched_at",
  ],
  context_source_read_receipts: [
    "receipt_id", "read_id", "snapshot_id", "execution_id", "room_id", "attempt_seq",
    "call_id", "dispatch_id", "source_label_sha256",
    "source_kind", "source_id", "source_revision", "snapshot_generation",
    "citation_label_sha256", "result_sha256", "representation", "range_text",
    "content_sha256", "content_bytes", "authorization_epoch", "issued_at",
  ],
  context_source_reads: [
    "read_id", "snapshot_id", "execution_id", "attempt_seq",
    "snapshot_generation", "call_id", "grant_id", "dispatch_id", "tool_id",
    "request_sha256", "source_label_sha256",
    "mode", "source_kind", "source_id", "source_revision",
    "authorization_epoch", "page_size", "page_offset", "cursor_sha256",
    "artifact_sha256", "artifact_range_start", "artifact_range_end", "status",
    "result_sha256", "result_bytes", "result_tokens", "accounted_bytes", "error_code",
    "created_at", "completed_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V20_SCHEMA_CONTRACT = {
  ...V19_SCHEMA_CONTRACT,
  agent_profiles: [
    ...V19_SCHEMA_CONTRACT.agent_profiles,
    "display_name", "global_responsibility", "created_at", "updated_at", "source_kind",
  ],
  room_agent_assignments: [
    ...V19_SCHEMA_CONTRACT.room_agent_assignments,
    "room_responsibility", "created_at", "updated_at", "removed_at", "source_kind",
  ],
  route_jobs: [
    ...V19_SCHEMA_CONTRACT.route_jobs, "revision", "candidate_snapshot_id",
  ],
  agent_authority_migration_provenance: [
    "source_kind", "source_object_id", "actor_id", "profile_id", "room_id",
    "assignment_id", "source_schema_version", "source_participation",
    "source_authority_json", "review_required", "migrated_at",
  ],
  agent_profile_revisions: [
    "profile_id", "revision", "actor_id", "display_name", "global_responsibility",
    "status", "capability_ceiling_json", "tool_ceiling_json",
    "changed_by_human_actor_id", "changed_at", "operation",
  ],
  room_agent_assignment_revisions: [
    "assignment_id", "revision", "room_id", "profile_id", "agent_actor_id",
    "room_responsibility", "status", "participation", "paused",
    "capability_subset_json", "tool_subset_json", "changed_by_human_actor_id",
    "changed_at", "operation",
  ],
  tenant_administrator_registry: [
    "singleton_id", "revision", "bootstrap_configuration_sha256",
    "initialized_at", "updated_at",
  ],
  tenant_administrators: [
    "human_actor_id", "revision", "status", "source_kind",
    "created_by_human_actor_id", "created_at", "updated_at", "removed_at",
  ],
  tenant_administrator_revisions: [
    "human_actor_id", "revision", "status", "operation",
    "changed_by_human_actor_id", "changed_at",
  ],
  deployment_idempotency_records: [
    "scope", "idempotency_key", "principal_actor_id", "request_sha256",
    "response_json", "status_code", "created_at_ms", "expires_at_ms",
  ],
  deployment_audit: [
    "audit_id", "event_kind", "principal_human_actor_id", "subject_kind",
    "subject_id", "subject_revision", "request_id", "occurred_at", "details_json",
  ],
  deployment_stream: ["singleton_id", "head_seq", "retained_from_seq"],
  deployment_agent_profile_events: [
    "event_id", "stream_seq", "profile_id", "profile_revision", "actor_id",
    "event_kind", "occurred_at", "payload_json", "payload_sha256",
  ],
  deployment_profile_outbox: [
    "id", "event_id", "recipient_human_actor_id", "stream_seq", "status",
    "attempts", "available_at", "delivered_at", "last_error",
  ],
  deployment_agent_profile_repair_records: [
    "profile_id", "profile_revision", "record_version", "event_id", "stream_seq",
    "projection_json", "projection_sha256", "updated_at",
  ],
  agent_profile_invalidation_facts: [
    "invalidation_id", "profile_id", "from_revision", "to_revision", "reason",
    "invalidated_context_count", "cancelled_route_intent_count",
    "affected_assignment_count", "occurred_at",
  ],
  route_candidate_snapshots: [
    "id", "route_job_id", "room_id", "room_revision", "source_message_id",
    "source_message_revision", "source_author_kind", "source_message_kind",
    "snapshot_version", "candidate_count", "snapshot_sha256", "created_at",
  ],
  route_candidate_snapshot_agents: [
    "snapshot_id", "route_job_id", "agent_actor_id", "profile_id",
    "profile_revision", "assignment_id", "assignment_revision", "access_revision",
    "participation", "availability", "room_responsibility",
    "effective_capabilities_json", "effective_tools_json", "calibration_score",
    "has_ball", "goal_fact_revision", "project_fact_revision", "ball_fact_revision",
    "candidate_order",
  ],
  route_decisions: [
    "id", "route_job_id", "expected_route_job_revision", "snapshot_id",
    "outcome", "reason_code", "decided_at",
  ],
  routed_agent_invocation_intents: [
    "id", "route_decision_id", "route_job_id", "snapshot_id", "room_id",
    "source_message_id", "source_message_revision", "target_agent_actor_id",
    "profile_id", "profile_revision", "assignment_id", "assignment_revision",
    "access_revision", "trigger_kind", "reason_text", "status", "created_at",
    "claimed_at", "cancelled_at", "cancellation_reason",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V21_SCHEMA_CONTRACT = {
  ...V20_SCHEMA_CONTRACT,
  direct_agent_invocation_authority_bindings: [
    "intent_id", "profile_id", "profile_revision", "assignment_id",
    "assignment_revision", "access_revision",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V22_SCHEMA_CONTRACT = {
  ...V21_SCHEMA_CONTRACT,
  agent_invocation_intent_runtime_states: [
    "intent_id", "public_status", "authority_version", "claimed_at",
    "cancelled_at", "cancellation_reason", "updated_at",
  ],
  agent_execution_runtime_states: [
    "execution_id", "intent_id", "lineage_id", "execution_ordinal",
    "retry_of_execution_id", "snapshot_id", "provider_id", "model_id",
    "public_status", "phase", "current_attempt_seq", "authority_version",
    "execution_generation", "queued_at", "started_at", "updated_at",
    "completed_at", "terminal_reason", "terminal_error_code", "review_state",
  ],
  agent_execution_attempt_runtime_states: [
    "execution_id", "attempt_seq", "public_status", "phase", "attempt_version",
    "reuse_kind", "started_at", "finished_at", "error_code", "next_retry_at",
  ],
  invocation_scoped_cancellation_fences: [
    "fence_id", "room_id", "scope_kind", "intent_id", "execution_id",
    "expected_authority_version", "reason", "principal_human_actor_id",
    "internal_capability", "committed_at",
  ],
  invocation_scoped_cancellation_targets: [
    "fence_id", "execution_id", "attempt_seq", "execution_version_before",
    "execution_version_after",
  ],
  invocation_cancellation_receipts: [
    "request_id", "fence_id", "principal_actor_id", "request_sha256",
    "status_code", "response_json", "committed_at",
  ],
  invocation_human_retry_receipts: [
    "request_id", "source_execution_id", "source_expected_version",
    "child_execution_id", "intent_id", "execution_ordinal", "principal_actor_id",
    "request_sha256", "response_json", "committed_at",
  ],
  invocation_recovery_queue: [
    "recovery_key", "execution_id", "execution_version", "state", "available_at",
    "lease_owner", "lease_expires_at", "failure_code", "review_required", "updated_at",
  ],
  invocation_recovery_cursors: [
    "worker_scope", "last_recovery_key", "scan_generation", "updated_at",
  ],
  project_boundary_invocation_receipts: [
    "boundary_id", "room_id", "source_revision", "status",
    "invocation_intent_id", "request_sha256", "recorded_at",
  ],
  legacy_room_wide_preemption_markers: [
    "source_kind", "source_id", "room_id", "marked_at", "production_reachable",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V23_SCHEMA_CONTRACT = {
  ...V22_SCHEMA_CONTRACT,
  project_requests: [
    "id", "room_id", "source_room_id", "source_id", "revision",
    "requester_human_actor_id", "target_human_actor_id", "status",
    "title", "description", "request_kind", "linked_fact_kind", "linked_fact_id",
    "source_kind", "created_by_actor_id", "created_at", "updated_at",
    "source_revision", "visibility_room_id", "source_request_intent_id", "source_target_id",
    "frozen_responsibility_json", "frozen_responsibility_sha256",
    "resolution_actor_kind", "resolution_actor_id", "resolved_at",
  ],
  project_next_actions: [
    "id", "room_id", "source_room_id", "source_id", "revision", "owner_kind",
    "owner_actor_id", "verifier_human_actor_id", "status", "title", "description",
    "due_at", "acceptance_criteria", "deliverable", "source_kind",
    "created_by_actor_id", "accepted_by_human_actor_id", "verified_by_human_actor_id",
    "created_at", "updated_at",
    "accepted_at", "delivery_source_kind", "delivery_source_id", "delivery_source_revision",
    "delivery_source_room_id", "delivery_summary", "completed_by_human_actor_id",
    "completed_at", "status_reason", "completion_note", "completion_criteria_json",
    "source_revision", "visibility_room_id",
  ],
  project_obstacles: [
    "id", "room_id", "source_room_id", "source_id", "revision", "kind",
    "owner_kind", "owner_actor_id", "status", "title", "description", "impact",
    "due_at", "review_at", "resolution_criteria", "question", "result_source_kind",
    "result_source_id", "result_source_revision", "result_source_room_id",
    "escalation_boundary_id", "status_reason", "escalation_emitted",
    "transfer_chain_json", "source_kind", "created_by_actor_id", "created_at", "updated_at",
    "source_revision", "visibility_room_id",
  ],
  project_transfer_proposals: [
    "id", "room_id", "source_room_id", "source_id", "revision", "subject_kind",
    "subject_id", "to_owner_kind", "to_owner_actor_id", "status", "from_owner_kind",
    "from_owner_actor_id", "principal_human_actor_id", "reason", "source_kind",
    "created_by_actor_id", "created_at", "updated_at", "subject_revision", "expires_at",
    "resolved_by_human_actor_id", "resolved_at", "resolution_reason",
  ],
  project_room_states: ["room_id", "project_id", "revision", "event_head_seq", "updated_at"],
  project_goals: [
    "id", "room_id", "project_id", "revision", "title", "description", "status",
    "supersedes_goal_id", "superseded_by_goal_id", "supersede_reason", "source_room_id", "source_id",
    "source_kind", "created_by_actor_id", "confirmed_by_human_actor_id",
    "created_at", "updated_at", "source_revision", "visibility_room_id",
  ],
  project_decisions: [
    "id", "room_id", "project_id", "revision", "title", "rationale", "status",
    "supersedes_decision_id", "superseded_by_decision_id", "source_room_id", "source_id",
    "source_kind", "created_by_actor_id", "confirmed_by_human_actor_id",
    "created_at", "updated_at", "source_revision", "visibility_room_id",
  ],
  project_fact_proposals: [
    "id", "room_id", "project_id", "revision", "fact_kind", "fact_id", "base_revision",
    "status", "payload_json", "source_room_id", "source_id", "source_kind",
    "proposed_by_kind", "proposed_by_actor_id", "principal_human_actor_id",
    "created_at", "updated_at", "expires_at", "resolved_at", "resolution_reason",
    "source_revision", "visibility_room_id",
  ],
  project_confirmations: [
    "id", "room_id", "project_id", "proposal_id", "revision",
    "principal_human_actor_id", "base_revision", "payload_digest", "state",
    "source_room_id", "source_id", "created_at", "expires_at",
    "resolved_by_human_actor_id", "resolved_at", "resolution_reason",
  ],
  project_events: [
    "event_id", "room_id", "project_id", "event_seq", "event_type", "fact_kind",
    "fact_id", "fact_revision", "actor_kind", "actor_id", "source_room_id",
    "source_id", "source_kind", "source_revision", "source_visibility",
    "occurred_at", "payload_json",
  ],
  project_command_receipts: [
    "actor_id", "idempotency_key", "room_id", "request_sha256", "response_json", "committed_at",
  ],
  project_transfer_chain: [
    "transfer_id", "room_id", "project_id", "subject_kind", "subject_id",
    "subject_revision", "from_owner_kind", "from_owner_actor_id", "to_owner_kind",
    "to_owner_actor_id", "accepted_by_human_actor_id", "reason", "transferred_at",
  ],
  project_ball_boundaries: [
    "boundary_id", "room_id", "project_id", "source_kind", "source_id",
    "source_revision", "lifecycle_generation", "holder_kind", "holder_actor_id", "reason", "since",
    "due_at", "status", "released_at",
  ],
  project_due_reminder_claims: [
    "claim_id", "room_id", "boundary_id", "source_revision", "reminder_kind",
    "reminder_ordinal", "boundary_at", "holder_kind", "holder_actor_id",
    "recipient_actor_id", "status", "claimed_at", "dispatched_at",
  ],
  project_event_outbox: [
    "event_id", "room_id", "event_seq", "status", "attempts", "available_at", "dispatched_at",
  ],
  project_transition_audit: [
    "audit_id", "room_id", "project_id", "project_revision", "event_id", "operation",
    "fact_kind", "fact_id", "actor_kind", "actor_id", "transition_json", "occurred_at",
  ],
  project_fact_checkpoints: [
    "checkpoint_id", "room_id", "project_id", "project_revision", "projection_json",
    "projection_sha256", "created_at",
  ],
  project_archive_suspensions: [
    "room_id", "project_id", "archive_generation", "suspended_project_revision",
    "suspended_at", "status", "resumed_at",
  ],
  project_agent_boundary_claims: [
    "boundary_id", "source_revision", "room_id", "holder_agent_actor_id",
    "request_sha256", "status", "attempted_at", "consumed_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V24_SCHEMA_CONTRACT = {
  ...V23_SCHEMA_CONTRACT,
  project_boundary_agent_invocation_intents: [
    "intent_id", "room_id", "project_id", "boundary_id", "boundary_kind",
    "source_kind", "source_id", "source_revision", "lifecycle_generation",
    "target_agent_actor_id", "profile_id", "profile_revision", "assignment_id",
    "assignment_revision", "access_revision", "lineage_id", "turn_id",
    "request_sha256", "status", "authority_version", "created_at", "claimed_at",
    "cancelled_at", "cancellation_reason", "updated_at",
  ],
  project_boundary_agent_executions: [
    "execution_id", "intent_id", "lineage_id", "execution_ordinal",
    "retry_of_execution_id", "room_id", "project_id", "agent_actor_id",
    "source_revision", "lifecycle_generation", "provider_id", "model_id",
    "public_status", "phase", "current_attempt_seq", "authority_version",
    "queued_at", "started_at", "updated_at", "completed_at", "cancellation_reason",
    "terminal_error_code", "result_message_id",
  ],
  project_boundary_agent_execution_links: [
    "intent_id", "execution_id", "execution_ordinal", "retry_of_execution_id",
    "source_revision", "lifecycle_generation", "linked_at",
  ],
  project_boundary_context_sources: [
    "context_source_id", "intent_id", "execution_id", "execution_ordinal",
    "room_id", "project_id", "checkpoint_id", "checkpoint_project_revision",
    "checkpoint_projection_sha256", "source_kind", "source_id", "source_revision",
    "lifecycle_generation", "created_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const V25_SCHEMA_CONTRACT = {
  ...V24_SCHEMA_CONTRACT,
  events: [
    "event_id", "stream_kind", "stream_id", "stream_seq", "room_id",
    "authority_kind", "actor_id", "event_type", "occurred_at", "payload_json",
  ],
  project_events: [
    "event_id", "room_id", "project_id", "event_seq", "event_type", "fact_kind",
    "fact_id", "fact_revision", "authority_kind", "actor_kind", "actor_id",
    "causal_actor_kind", "causal_actor_id", "source_room_id", "source_id",
    "source_kind", "source_revision", "source_visibility", "occurred_at", "payload_json",
  ],
  project_transition_audit: [
    "audit_id", "room_id", "project_id", "project_revision", "event_id", "operation",
    "fact_kind", "fact_id", "authority_kind", "actor_kind", "actor_id",
    "causal_actor_kind", "causal_actor_id", "transition_json", "occurred_at",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const SCHEMA_CONTRACTS = {
  1: V1_SCHEMA_CONTRACT,
  2: V2_SCHEMA_CONTRACT,
  3: V3_SCHEMA_CONTRACT,
  4: V4_SCHEMA_CONTRACT,
  5: V4_SCHEMA_CONTRACT,
  6: V6_SCHEMA_CONTRACT,
  7: V7_SCHEMA_CONTRACT,
  8: V8_SCHEMA_CONTRACT,
  9: V9_SCHEMA_CONTRACT,
  10: V10_SCHEMA_CONTRACT,
  11: V11_SCHEMA_CONTRACT,
  12: V12_SCHEMA_CONTRACT,
  13: V13_SCHEMA_CONTRACT,
  14: V14_SCHEMA_CONTRACT,
  15: V15_SCHEMA_CONTRACT,
  16: V16_SCHEMA_CONTRACT,
  17: V17_SCHEMA_CONTRACT,
  18: V18_SCHEMA_CONTRACT,
  19: V19_SCHEMA_CONTRACT,
  20: V20_SCHEMA_CONTRACT,
  21: V21_SCHEMA_CONTRACT,
  22: V22_SCHEMA_CONTRACT,
  23: V23_SCHEMA_CONTRACT,
  24: V24_SCHEMA_CONTRACT,
  25: V25_SCHEMA_CONTRACT,
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
        OR ${schemaVersion >= 25
          ? "(event.authority_kind <> 'system_timer' AND actor.id IS NULL)"
          : "actor.id IS NULL"}
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
  if (schemaVersion >= 8) {
    requireNoRows(
      database,
      `SELECT 1
       FROM open_items AS item
       JOIN messages AS source ON source.id = item.source_message_id
       JOIN actors AS requester ON requester.id = item.requester_actor_id
       LEFT JOIN agent_executions AS execution ON execution.id = item.source_execution_id
       WHERE source.room_id <> item.room_id
          OR (item.status IN ('awaiting', 'transferred') AND item.current_owner_actor_id IS NULL)
          OR (item.status IN ('answered', 'deferred') AND item.current_owner_actor_id IS NOT NULL)
          OR (item.status = 'transferred' AND
              COALESCE(json_extract(item.transfer_chain_json, '$[#-1].toId'), '')
                <> item.current_owner_actor_id)
          OR (item.origin_kind = 'agent_proposal' AND (
              execution.id IS NULL
              OR execution.room_id <> item.room_id
              OR execution.trigger_message_id <> item.source_message_id
              OR execution.agent_id <> item.requester_actor_id))
       LIMIT 1`,
      "closed OpenItems must keep one active owner, valid provenance, and same-room source",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM open_items AS item, json_each(item.transfer_chain_json) AS transfer
       WHERE json_type(transfer.value) <> 'object'
          OR length(trim(COALESCE(json_extract(transfer.value, '$.fromId'), ''))) = 0
          OR length(trim(COALESCE(json_extract(transfer.value, '$.toId'), ''))) = 0
          OR length(trim(COALESCE(json_extract(transfer.value, '$.reason'), ''))) = 0
          OR length(trim(COALESCE(json_extract(transfer.value, '$.transferredAt'), ''))) = 0
          OR EXISTS (
            SELECT 1
            FROM json_each(item.transfer_chain_json) AS next
            WHERE CAST(next.key AS INTEGER) = CAST(transfer.key AS INTEGER) + 1
              AND json_extract(transfer.value, '$.toId')
                <> json_extract(next.value, '$.fromId')
          )
       LIMIT 1`,
      "OpenItem transfer chains must be closed, ordered, and append-only shaped",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM open_item_agent_failures AS failure
       JOIN open_items AS item ON item.id = failure.open_item_id
       JOIN agent_executions AS execution ON execution.id = failure.execution_id
       LEFT JOIN actors AS owner ON owner.id = item.current_owner_actor_id
       WHERE item.status NOT IN ('awaiting', 'transferred')
          OR owner.kind <> 'agent'
          OR execution.room_id <> item.room_id
          OR execution.trigger_message_id <> item.source_message_id
          OR execution.agent_id <> item.current_owner_actor_id
          OR execution.status <> 'failed'
          OR execution.current_attempt_seq <> failure.attempt_seq
       LIMIT 1`,
      "OpenItem Agent failures must reference the active Agent owner and failed attempt",
    );
  }
  if (schemaVersion >= 9) {
    requireNoRows(
      database,
      `SELECT 1
       FROM light_tasks AS task
       JOIN messages AS source ON source.id = task.source_message_id
       LEFT JOIN actors AS claimant ON claimant.id = task.claimant_actor_id
       LEFT JOIN actors AS verifier ON verifier.id = task.verifier_actor_id
       WHERE source.room_id <> task.room_id
          OR (task.claimant_actor_id IS NOT NULL AND claimant.kind <> 'human')
          OR (task.verifier_actor_id IS NOT NULL AND verifier.kind <> 'human')
          OR (task.status = 'verified' AND EXISTS (
            SELECT 1 FROM json_each(task.criteria_json) AS criterion
            WHERE json_extract(criterion.value, '$.met') <> 1
          ))
       LIMIT 1`,
      "closed LightTasks must keep same-room source, human audit actors, and met verification criteria",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM light_tasks AS task, json_each(task.criteria_json) AS criterion
       WHERE json_type(criterion.value) <> 'object'
          OR (SELECT COUNT(*) FROM json_each(criterion.value)) <> 3
          OR json_type(criterion.value, '$.id') <> 'text'
          OR json_type(criterion.value, '$.text') <> 'text'
          OR json_type(criterion.value, '$.met') NOT IN ('true', 'false')
          OR length(trim(COALESCE(json_extract(criterion.value, '$.id'), ''))) = 0
          OR length(trim(COALESCE(json_extract(criterion.value, '$.text'), ''))) = 0
          OR EXISTS (
            SELECT 1 FROM json_each(task.criteria_json) AS duplicate
            WHERE duplicate.key <> criterion.key
              AND json_extract(duplicate.value, '$.id') = json_extract(criterion.value, '$.id')
          )
       LIMIT 1`,
      "LightTask criteria must be closed and uniquely identified",
    );
  }
  if (schemaVersion >= 10) {
    requireNoRows(
      database,
      `SELECT 1
       FROM ball_boundary_claims AS claim
       JOIN actors AS holder ON holder.id = claim.holder_actor_id
       LEFT JOIN room_memberships AS membership
         ON membership.room_id = claim.room_id AND membership.actor_id = claim.holder_actor_id
       WHERE holder.kind <> claim.holder_kind
          OR claim.deadline_at < claim.since_at
          OR claim.claimed_at < claim.deadline_at
          OR (claim.route_consumed_at IS NOT NULL AND claim.route_consumed_at < claim.claimed_at)
          OR (claim.boundary_kind = 'agent_trigger' AND claim.holder_kind <> 'agent')
          OR (claim.boundary_kind = 'human_reminder' AND claim.holder_kind <> 'human')
       LIMIT 1`,
      "ball boundary claims must remain closed and holder-kind matched",
    );
  }
  if (schemaVersion >= 12) {
    requireNoRows(
      database,
      `SELECT 1
       FROM sessions AS session
       LEFT JOIN session_families AS family ON family.family_id = session.family_id
       WHERE family.family_id IS NULL
          OR family.account_id <> session.account_id
          OR family.actor_id <> session.actor_id
       LIMIT 1`,
      "every session generation must match exactly one family principal",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM session_families AS family
       LEFT JOIN actors AS actor ON actor.id = family.actor_id
       WHERE actor.kind <> 'human'
          OR NOT EXISTS (
            SELECT 1 FROM sessions AS session WHERE session.family_id = family.family_id
          )
          OR family.refresh_expires_at <> (
            SELECT MAX(session.refresh_expires_at)
            FROM sessions AS session WHERE session.family_id = family.family_id
          )
          OR (family.revoked_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM sessions AS session
            WHERE session.family_id = family.family_id AND session.revoked_at IS NULL
          ))
       LIMIT 1`,
      "session families must remain human-owned, generation-backed, and terminally closed",
    );
  }
  if (schemaVersion >= 13) {
    requireNoRows(
      database,
      `SELECT 1
       FROM rooms AS room
       LEFT JOIN room_memberships AS membership
         ON membership.room_id = room.id AND membership.actor_id = room.owner_actor_id
       LEFT JOIN actors AS actor ON actor.id = membership.actor_id
       WHERE room.owner_actor_id IS NULL
          OR membership.actor_id IS NULL
          OR membership.kind <> 'human'
          OR actor.kind <> 'human'
          OR membership.role <> 'owner'
          OR room.governance_revision < 0
          OR room.archive_generation < 0
          OR (room.status = 'active' AND room.archived_at IS NOT NULL)
          OR (room.status = 'archived' AND room.archived_at IS NULL)
       LIMIT 1`,
      "every room must have exactly one canonical same-room Human owner",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM room_memberships AS membership
       WHERE (kind = 'human' AND role NOT IN ('owner', 'admin', 'member'))
          OR (kind = 'agent' AND role IS NOT NULL)
          OR (kind = 'human' AND role = 'owner' AND actor_id IS NOT (
            SELECT owner_actor_id FROM rooms WHERE id = membership.room_id
          ))
       LIMIT 1`,
      "v13 membership roles must keep Human governance separate from Agent participation",
    );
  }
  if (schemaVersion >= 14) {
    requireNoRows(
      database,
      `SELECT 1
       FROM rooms AS room
       LEFT JOIN room_message_archive_gates AS gate ON gate.room_id = room.id
       WHERE (room.status = 'archived' AND (
                gate.room_id IS NULL
                OR gate.gate_generation <> room.archive_generation
                OR gate.blocked_at <> room.archived_at
              ))
          OR (gate.room_id IS NOT NULL AND (
                gate.gate_generation <= 0
                OR gate.gate_generation > room.archive_generation
              ))
       LIMIT 1`,
      "message archive gates must match the current archived generation",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_executions AS execution
       JOIN rooms AS room ON room.id = execution.room_id
       WHERE execution.room_archive_generation < 0
          OR execution.room_archive_generation > room.archive_generation
       LIMIT 1`,
      "runtime execution generations must not outrun Room lifecycle generations",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM runtime_archive_fences AS fence
       JOIN rooms AS room ON room.id = fence.room_id
       WHERE fence.archive_generation > room.archive_generation
          OR fence.archive_generation <= 0
          OR fence.fenced_queued_count <> (
            SELECT COUNT(*) FROM runtime_archive_fence_members AS member
            WHERE member.room_id = fence.room_id
              AND member.archive_generation = fence.archive_generation
              AND member.disposition = 'cancelled_queued'
          )
          OR fence.fenced_waiting_count <> (
            SELECT COUNT(*) FROM runtime_archive_fence_members AS member
            WHERE member.room_id = fence.room_id
              AND member.archive_generation = fence.archive_generation
              AND member.disposition = 'cancelled_waiting'
          )
          OR fence.preserved_dispatched_count <> (
            SELECT COUNT(*) FROM runtime_archive_fence_members AS member
            WHERE member.room_id = fence.room_id
              AND member.archive_generation = fence.archive_generation
              AND member.disposition = 'preserved_dispatched'
          )
          OR fence.preserved_outcome_review_count <> (
            SELECT COUNT(*) FROM runtime_archive_fence_members AS member
            WHERE member.room_id = fence.room_id
              AND member.archive_generation = fence.archive_generation
              AND member.disposition = 'preserved_outcome_review'
          )
       LIMIT 1`,
      "runtime archive fence counts must match their durable member ledger",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM runtime_archive_fence_members AS member
       JOIN agent_executions AS execution ON execution.id = member.execution_id
       WHERE execution.room_id <> member.room_id
          OR execution.room_archive_generation > member.archive_generation
          OR execution.current_attempt_seq <> member.attempt_seq
       LIMIT 1`,
      "runtime archive fence members must match Room, generation, and current attempt",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM tool_confirmations
       WHERE (confirmation_state = 'pending' AND consumed_at IS NOT NULL)
          OR (confirmation_state = 'confirmed' AND consumed_at IS NULL)
          OR (confirmation_state IN ('rejected', 'expired') AND consumed_at IS NOT NULL)
          OR (confirmation_revision = 0 AND confirmation_changed_at IS NOT NULL)
          OR (confirmation_revision > 0 AND confirmation_changed_at IS NULL)
       LIMIT 1`,
      "tool confirmations must keep closed state, consumption, and revision evidence",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM agent_execution_grants
       WHERE (grant_state = 'active' AND consumed_at IS NOT NULL)
          OR (grant_state = 'claimed' AND consumed_at IS NULL)
          OR (grant_state IN ('revoked', 'expired') AND consumed_at IS NOT NULL)
          OR (grant_revision = 0 AND grant_changed_at IS NOT NULL)
          OR (grant_revision > 0 AND grant_changed_at IS NULL)
       LIMIT 1`,
      "tool grants must keep closed state, consumption, and revision evidence",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM tool_archive_settlements AS settlement
       JOIN rooms AS room ON room.id = settlement.room_id
       WHERE settlement.archive_generation > room.archive_generation
          OR settlement.rejected_pending_count <> (
            SELECT COUNT(*) FROM tool_archive_settlement_members AS member
            WHERE member.room_id = settlement.room_id
              AND member.archive_generation = settlement.archive_generation
              AND member.disposition = 'rejected_pending'
          )
          OR settlement.revoked_grant_count <> (
            SELECT COUNT(*) FROM tool_archive_settlement_members AS member
            WHERE member.room_id = settlement.room_id
              AND member.archive_generation = settlement.archive_generation
              AND member.disposition = 'revoked_unclaimed'
          )
          OR settlement.fenced_waiting_count <> (
            SELECT COUNT(*) FROM tool_archive_settlement_members AS member
            WHERE member.room_id = settlement.room_id
              AND member.archive_generation = settlement.archive_generation
              AND member.disposition = 'fenced_waiting'
          )
          OR settlement.preserved_dispatched_count <> (
            SELECT COUNT(*) FROM tool_archive_settlement_members AS member
            WHERE member.room_id = settlement.room_id
              AND member.archive_generation = settlement.archive_generation
              AND member.disposition = 'preserved_dispatched'
          )
       LIMIT 1`,
      "tool archive settlement counts must match their durable member ledger",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM tool_archive_settlement_members AS member
       LEFT JOIN tool_confirmations AS confirmation
         ON member.subject_kind = 'confirmation'
        AND confirmation.confirmation_id = member.subject_id
       LEFT JOIN agent_execution_grants AS grant
         ON member.subject_kind = 'grant' AND grant.grant_id = member.subject_id
       LEFT JOIN agent_executions AS execution
         ON member.subject_kind = 'execution' AND execution.id = member.subject_id
       LEFT JOIN tool_dispatches AS dispatch
         ON member.subject_kind = 'dispatch' AND dispatch.dispatch_id = member.subject_id
       LEFT JOIN agent_executions AS dispatch_execution
         ON dispatch_execution.id = dispatch.execution_id
       WHERE (member.subject_kind = 'confirmation' AND (
                confirmation.confirmation_id IS NULL
                OR confirmation.room_id <> member.room_id
                OR member.disposition <> 'rejected_pending'
              ))
          OR (member.subject_kind = 'grant' AND (
                grant.grant_id IS NULL OR grant.room_id <> member.room_id
                OR member.disposition <> 'revoked_unclaimed'
              ))
          OR (member.subject_kind = 'execution' AND (
                execution.id IS NULL OR execution.room_id <> member.room_id
                OR member.disposition <> 'fenced_waiting'
              ))
          OR (member.subject_kind = 'dispatch' AND (
                dispatch.dispatch_id IS NULL OR dispatch_execution.room_id <> member.room_id
                OR member.disposition <> 'preserved_dispatched'
              ))
       LIMIT 1`,
      "tool archive settlement members must match their same-Room authority facts",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_business_timer_freeze_batches AS batch
       JOIN rooms AS room ON room.id = batch.room_id
       WHERE batch.archive_generation > room.archive_generation
          OR batch.descriptor_ids_json NOT IN (
            '[]', '["dao.ball-runtime.business-boundaries.v1"]'
          )
          OR batch.suspended_count <> (
            SELECT COUNT(*) FROM room_business_timer_freezes AS timer
            WHERE timer.room_id = batch.room_id
              AND timer.archive_generation = batch.archive_generation
          )
          OR (batch.resumed_at IS NULL AND EXISTS (
            SELECT 1 FROM room_business_timer_freezes AS timer
            WHERE timer.room_id = batch.room_id
              AND timer.archive_generation = batch.archive_generation
              AND timer.state <> 'frozen'
          ))
          OR (batch.resumed_at IS NOT NULL AND (
            batch.resumed_count <> (
              SELECT COUNT(*) FROM room_business_timer_freezes AS timer
              WHERE timer.room_id = batch.room_id
                AND timer.archive_generation = batch.archive_generation
                AND timer.state = 'resumed'
            )
            OR EXISTS (
              SELECT 1 FROM room_business_timer_freezes AS timer
              WHERE timer.room_id = batch.room_id
                AND timer.archive_generation = batch.archive_generation
                AND timer.state = 'frozen'
            )
          ))
       LIMIT 1`,
      "business timer batches must match their durable freeze ledger",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM room_business_timer_freezes AS timer
       WHERE timer.descriptor_id <> 'dao.ball-runtime.business-boundaries.v1'
          OR timer.timer_key NOT LIKE 'dao.ball-runtime.business-boundaries.v1:%'
          OR NOT EXISTS (
            SELECT 1 FROM room_business_timer_freeze_batches AS batch
            WHERE batch.room_id = timer.room_id
              AND batch.archive_generation = timer.archive_generation
              AND batch.suspended_at = timer.frozen_at
          )
       LIMIT 1`,
      "business timer freezes must match the registered descriptor and archive batch",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_agent_assignments AS assignment
       JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
       JOIN actors AS actor ON actor.id = assignment.agent_actor_id
       WHERE actor.kind <> 'agent'
          OR profile.actor_id <> assignment.agent_actor_id
          OR EXISTS (
            SELECT value FROM json_each(assignment.capability_subset_json)
            EXCEPT SELECT value FROM json_each(profile.capability_ceiling_json)
          )
          OR EXISTS (
            SELECT value FROM json_each(assignment.tool_subset_json)
            EXCEPT SELECT value FROM json_each(profile.tool_ceiling_json)
          )
       LIMIT 1`,
      "Room Assignments must remain within their Agent Profile authority ceiling",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM (
         SELECT capability_ceiling_json AS authority_json FROM agent_profiles
         UNION ALL SELECT tool_ceiling_json FROM agent_profiles
         UNION ALL SELECT capability_subset_json FROM room_agent_assignments
         UNION ALL SELECT tool_subset_json FROM room_agent_assignments
       ) AS authority_set,
       json_each(authority_set.authority_json) AS entry
       WHERE typeof(entry.value) <> 'text'
          OR length(entry.value) = 0
          OR EXISTS (
            SELECT 1 FROM json_each(authority_set.authority_json) AS successor
            WHERE CAST(successor.key AS INTEGER) = CAST(entry.key AS INTEGER) + 1
              AND entry.value >= successor.value
          )
       LIMIT 1`,
      "Agent Profile and Room Assignment authority sets must be canonical",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_assignment_archive_policies AS policy
       JOIN rooms AS room ON room.id = policy.room_id
       WHERE policy.archive_generation > room.archive_generation
       LIMIT 1`,
      "Room Assignment archive policies must not outrun lifecycle generations",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_requests AS request
       JOIN actors AS requester ON requester.id = request.requester_human_actor_id
       JOIN actors AS target ON target.id = request.target_human_actor_id
       WHERE requester.kind <> 'human' OR target.kind <> 'human'
       LIMIT 1`,
      "Project Requests must remain bound to Human actors",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_next_actions AS action
       JOIN actors AS owner ON owner.id = action.owner_actor_id
       LEFT JOIN actors AS verifier ON verifier.id = action.verifier_human_actor_id
       WHERE owner.kind <> action.owner_kind
          OR (action.verifier_human_actor_id IS NOT NULL AND verifier.kind <> 'human')
       LIMIT 1`,
      "Project NextActions must remain bound to actor-kind authority",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_obstacles AS obstacle
       JOIN actors AS owner ON owner.id = obstacle.owner_actor_id
       WHERE owner.kind <> obstacle.owner_kind
       LIMIT 1`,
      "Project Obstacles must remain bound to actor-kind authority",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_transfer_proposals AS proposal
       JOIN actors AS target ON target.id = proposal.to_owner_actor_id
       WHERE target.kind <> proposal.to_owner_kind
          OR NOT (
            (proposal.subject_kind = 'next_action' AND EXISTS (
              SELECT 1 FROM project_next_actions AS action
              WHERE action.id = proposal.subject_id AND action.room_id = proposal.room_id
            ))
            OR (proposal.subject_kind IN ('blocker', 'open_question') AND EXISTS (
              SELECT 1 FROM project_obstacles AS obstacle
              WHERE obstacle.id = proposal.subject_id
                AND obstacle.room_id = proposal.room_id
                AND obstacle.kind = proposal.subject_kind
            ))
          )
       LIMIT 1`,
      "Project TransferProposals must remain same-Room and actor-kind bound",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_access_authority AS access
       JOIN rooms AS room ON room.id = access.room_id
       WHERE access.access_revision < COALESCE((
               SELECT MAX(membership.access_revision)
               FROM room_memberships AS membership
               WHERE membership.room_id = access.room_id
             ), 0)
          OR access.lease_generation < 0
       LIMIT 1`,
      "room access authority must not trail durable membership revisions",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_cache_invalidation_intents AS intent
       JOIN rooms AS room ON room.id = intent.room_id
       LEFT JOIN room_access_authority AS access ON access.room_id = intent.room_id
       WHERE intent.lifecycle_generation > room.archive_generation
          OR (intent.reason = 'room_archived' AND (
                access.room_id IS NULL OR intent.access_revision > access.access_revision
              ))
       LIMIT 1`,
      "room cache invalidations must be bounded by lifecycle and access authority",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM offline_read_lease_issuances AS issuance
       JOIN rooms AS room ON room.id = issuance.room_id
       LEFT JOIN room_access_authority AS access ON access.room_id = issuance.room_id
       WHERE issuance.lifecycle_generation > room.archive_generation
          OR access.room_id IS NULL
          OR issuance.access_revision > access.access_revision
          OR issuance.lease_generation > access.lease_generation
       LIMIT 1`,
      "offline lease issuances must be bounded by lifecycle and access authority",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM offline_read_lease_invalidations AS invalidation
       JOIN rooms AS room ON room.id = invalidation.room_id
       LEFT JOIN room_access_authority AS access ON access.room_id = invalidation.room_id
       WHERE invalidation.lifecycle_generation > room.archive_generation
          OR (invalidation.reason = 'room_archived' AND (
                access.room_id IS NULL
                OR invalidation.access_revision > access.access_revision
                OR invalidation.lease_generation > access.lease_generation
              ))
          OR (invalidation.reason <> 'room_archived' AND (
                (access.room_id IS NULL AND invalidation.lease_generation <> 0)
                OR (access.room_id IS NOT NULL
                    AND invalidation.lease_generation > access.lease_generation)
              ))
       LIMIT 1`,
      "offline lease invalidations must be bounded by lifecycle and access authority",
    );
  }
  if (schemaVersion >= 16) {
    requireNoRows(
      database,
      `SELECT 1
       FROM messages AS message
       LEFT JOIN message_envelopes AS envelope ON envelope.message_id = message.id
       LEFT JOIN message_revisions AS current_revision
         ON current_revision.message_id = envelope.message_id
        AND current_revision.revision = envelope.current_revision
       WHERE envelope.message_id IS NULL
          OR envelope.room_id <> message.room_id
          OR ((message.author_kind = 'human') <> (envelope.message_kind = 'human'))
          OR current_revision.message_id IS NULL
          OR envelope.current_revision <> envelope.revision_count
          OR envelope.revision_count <> (
            SELECT COUNT(*) FROM message_revisions AS revision
            WHERE revision.message_id = message.id
          )
          OR envelope.current_revision <> (
            SELECT MAX(revision) FROM message_revisions AS revision
            WHERE revision.message_id = message.id
          )
       LIMIT 1`,
      "every message must have one kind-matched envelope and complete revision chain",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM message_revisions AS revision
       JOIN messages AS message ON message.id = revision.message_id
       LEFT JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
       WHERE envelope.message_id IS NULL
          OR revision.revised_by_actor_id <> message.author_id
          OR (message.author_kind = 'agent' AND revision.revision <> 1)
          OR revision.revision > envelope.current_revision
       LIMIT 1`,
      "message revisions must remain append-only and author bound",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM message_mentions AS mention
       LEFT JOIN message_target_outcomes AS outcome
         ON outcome.message_id = mention.message_id AND outcome.target_id = mention.target_id
       WHERE outcome.message_id IS NULL
          OR outcome.room_id <> mention.room_id
          OR outcome.target_actor_id <> mention.target_actor_id
          OR outcome.target_kind <> mention.target_kind
          OR EXISTS (
            SELECT 1 FROM message_mentions AS other
            WHERE other.message_id = mention.message_id
              AND other.target_order < mention.target_order
              AND other.range_end_utf16 > mention.range_start_utf16
          )
       LIMIT 1`,
      "every structured mention must have exactly one matching outcome and ordered range",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM message_target_outcomes AS outcome
       LEFT JOIN human_request_intents AS request
         ON request.id = outcome.request_intent_id
       LEFT JOIN agent_invocation_intents AS invocation
         ON invocation.id = outcome.invocation_intent_id
       WHERE (outcome.status = 'request-created' AND (
                request.id IS NULL OR request.source_message_id <> outcome.message_id
                OR request.room_id <> outcome.room_id
                OR request.target_id <> outcome.target_id
                OR request.target_human_actor_id <> outcome.target_actor_id
              ))
          OR (outcome.status = 'invocation-intent-created' AND (
                invocation.id IS NULL
                OR invocation.source_message_id <> outcome.message_id
                OR invocation.room_id <> outcome.room_id
                OR invocation.target_id <> outcome.target_id
                OR invocation.target_agent_id <> outcome.target_actor_id
              ))
          OR (outcome.status = 'rejected' AND (
                request.id IS NOT NULL OR invocation.id IS NOT NULL
              ))
       LIMIT 1`,
      "message target outcomes must retain their closed intent discriminants",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM human_request_intents AS intent
       JOIN actors AS requester ON requester.id = intent.requester_human_actor_id
       JOIN actors AS target ON target.id = intent.target_human_actor_id
       JOIN messages AS source ON source.id = intent.source_message_id
       WHERE requester.kind <> 'human' OR target.kind <> 'human'
          OR source.author_kind <> 'human'
          OR source.author_id <> intent.requester_human_actor_id
          OR source.room_id <> intent.room_id
          OR NOT EXISTS (
            SELECT 1 FROM message_target_outcomes AS outcome
            WHERE outcome.message_id = intent.source_message_id
              AND outcome.room_id = intent.room_id
              AND outcome.target_id = intent.target_id
              AND outcome.target_actor_id = intent.target_human_actor_id
              AND outcome.status = 'request-created'
              AND outcome.request_intent_id = intent.id
          )
       LIMIT 1`,
      "Human Request intents must remain Human-authored and same-Room",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_invocation_intents AS intent
       JOIN actors AS requester ON requester.id = intent.requester_actor_id
       JOIN actors AS target ON target.id = intent.target_agent_id
       JOIN messages AS source ON source.id = intent.source_message_id
       WHERE target.kind <> 'agent'
          OR source.author_id <> intent.requester_actor_id
          OR source.author_kind <> requester.kind
          OR source.room_id <> intent.room_id
          OR (intent.origin_kind = 'message_target' AND (
                requester.kind <> 'human' OR source.author_kind <> 'human'
                OR intent.target_id IS NULL OR intent.message_transaction_id IS NULL
                OR intent.lineage_id IS NULL OR intent.turn_id IS NULL
                OR intent.execution_id IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1 FROM message_target_outcomes AS outcome
                  WHERE outcome.message_id = intent.source_message_id
                    AND outcome.room_id = intent.room_id
                    AND outcome.target_id = intent.target_id
                    AND outcome.target_actor_id = intent.target_agent_id
                    AND outcome.status = 'invocation-intent-created'
                    AND outcome.invocation_intent_id = intent.id
                )
              ))
       LIMIT 1`,
      "Agent invocation intents must remain execution-independent and authority bound",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM message_envelopes AS envelope
       WHERE envelope.lifecycle = 'recalled' AND (
         NOT EXISTS (
           SELECT 1 FROM message_recall_fences AS fence
           WHERE fence.source_message_id = envelope.message_id
             AND fence.source_revision = envelope.current_revision
             AND fence.scope_kind = 'message'
         )
         OR EXISTS (
           SELECT 1 FROM human_request_intents AS intent
           WHERE intent.source_message_id = envelope.message_id
             AND intent.status = 'pending'
         )
         OR EXISTS (
           SELECT 1 FROM agent_invocation_intents AS intent
           WHERE intent.source_message_id = envelope.message_id
             AND intent.status = 'pending'
         )
       )
       LIMIT 1`,
      "recalled messages must have a source fence and no pending target intents",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_message_sources AS source_lineage
       JOIN message_envelopes AS output
         ON output.message_id = source_lineage.message_id
       JOIN messages AS output_message
         ON output_message.id = output.message_id
       JOIN agent_invocation_intents AS intent
         ON intent.id = source_lineage.invocation_intent_id
       JOIN agent_execution_intent_links AS link
         ON link.intent_id = intent.id
        AND link.execution_id = source_lineage.execution_id
       JOIN agent_executions AS execution
         ON execution.id = source_lineage.execution_id
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = execution.id
        AND attempt.attempt_seq = source_lineage.attempt_seq
       JOIN message_envelopes AS source
         ON source.message_id = source_lineage.source_message_id
       WHERE output.room_id <> source_lineage.room_id
          OR output.message_kind NOT IN ('agent-final', 'agent-correction')
          OR output_message.author_kind <> 'agent'
          OR output_message.author_id <> intent.target_agent_id
          OR intent.room_id <> source_lineage.room_id
          OR intent.status <> 'claimed'
          OR intent.source_message_id <> source_lineage.source_message_id
          OR intent.source_revision <> source_lineage.source_revision
          OR execution.status <> 'completed'
          OR execution.result_message_id <> source_lineage.message_id
          OR execution.current_attempt_seq <> source_lineage.attempt_seq
          OR execution.execution_generation <> source_lineage.execution_generation
          OR attempt.status <> 'completed'
          OR EXISTS (
            SELECT 1 FROM message_recall_fences AS fence
            WHERE fence.source_message_id = source_lineage.source_message_id
              AND fence.created_at <= source_lineage.committed_at
          )
       LIMIT 1`,
      "Agent message sources must retain one completed current execution CAS",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_message_corrections AS correction
       JOIN message_envelopes AS correction_envelope
         ON correction_envelope.message_id = correction.correction_message_id
       JOIN message_envelopes AS original_envelope
         ON original_envelope.message_id = correction.corrects_message_id
       JOIN messages AS correction_message
         ON correction_message.id = correction.correction_message_id
       JOIN messages AS original_message
         ON original_message.id = correction.corrects_message_id
       WHERE correction_envelope.message_kind <> 'agent-correction'
          OR original_envelope.message_kind <> 'agent-final'
          OR correction_envelope.room_id <> correction.room_id
          OR original_envelope.room_id <> correction.room_id
          OR correction_message.author_id <> correction.agent_actor_id
          OR original_message.author_id <> correction.agent_actor_id
       LIMIT 1`,
      "Agent corrections must append for the same Agent final",
    );
  }
  if (schemaVersion >= 17) {
    requireNoRows(
      database,
      `SELECT 1
       FROM attachment_uploads AS upload
       LEFT JOIN actors AS uploader ON uploader.id = upload.uploader_actor_id
       LEFT JOIN session_families AS family
         ON family.family_id = upload.session_family_id
       LEFT JOIN rooms AS room ON room.id = upload.room_id
       WHERE uploader.kind IS NOT 'human'
          OR family.actor_id IS NOT upload.uploader_actor_id
          OR room.id IS NULL
          OR (upload.status = 'accepted' AND NOT EXISTS (
            SELECT 1 FROM attachments AS attachment
            WHERE attachment.source_upload_id = upload.upload_id
          ))
       LIMIT 1`,
      "attachment uploads must retain their Human, family, Room, and artifact identity",
    );
    requireNoRows(
      database,
      `WITH ordered AS (
         SELECT upload_id, ordinal, byte_offset, byte_length,
                ROW_NUMBER() OVER (
                  PARTITION BY upload_id ORDER BY ordinal
                ) - 1 AS expected_ordinal,
                COALESCE(SUM(byte_length) OVER (
                  PARTITION BY upload_id ORDER BY ordinal
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0) AS expected_offset
         FROM attachment_upload_chunks
       )
       SELECT 1
       FROM ordered
       WHERE ordinal <> expected_ordinal OR byte_offset <> expected_offset
       LIMIT 1`,
      "attachment upload chunks must remain contiguous and append-only",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM attachment_uploads AS upload
       WHERE upload.received_bytes <> COALESCE((
         SELECT MAX(chunk.byte_offset + chunk.byte_length)
         FROM attachment_upload_chunks AS chunk
         WHERE chunk.upload_id = upload.upload_id
       ), 0)
       LIMIT 1`,
      "attachment upload checkpoints must equal their durable chunk boundary",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM attachments AS attachment
       LEFT JOIN attachment_uploads AS upload
         ON upload.upload_id = attachment.source_upload_id
       WHERE upload.upload_id IS NULL
          OR upload.room_id <> attachment.room_id
          OR upload.uploader_actor_id <> attachment.uploader_actor_id
          OR upload.original_filename <> attachment.original_filename
          OR upload.declared_mime IS NOT attachment.declared_mime
          OR upload.format_hint <> attachment.format
          OR upload.expected_bytes <> attachment.byte_size
          OR upload.expected_sha256 <> attachment.sha256
          OR (attachment.source_operational_state = 'unbound' AND EXISTS (
            SELECT 1 FROM message_attachment_links AS link
            WHERE link.attachment_id = attachment.attachment_id
          ))
          OR (attachment.source_operational_state <> 'unbound' AND NOT EXISTS (
            SELECT 1 FROM message_attachment_links AS link
            WHERE link.attachment_id = attachment.attachment_id
              AND link.message_id = attachment.source_message_id
              AND ((attachment.source_operational_state = 'bound-active'
                    AND link.operational_state = 'active')
                OR (attachment.source_operational_state = 'excluded-recalled'
                    AND link.operational_state = 'excluded_recalled'))
          ))
       LIMIT 1`,
      "attachment artifacts and message sources must retain one canonical authority binding",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM message_attachment_links AS link
       LEFT JOIN attachments AS attachment
         ON attachment.attachment_id = link.attachment_id
       WHERE attachment.attachment_id IS NULL
          OR attachment.room_id <> link.room_id
          OR attachment.source_message_id IS NOT link.message_id
          OR (link.operational_state = 'active'
              AND attachment.source_operational_state <> 'bound-active')
          OR (link.operational_state = 'excluded_recalled'
              AND attachment.source_operational_state <> 'excluded-recalled')
       LIMIT 1`,
      "message attachment links must retain one matching Attachment Authority source",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM attachment_processing_attempts AS attempt
       LEFT JOIN attachments AS attachment
         ON attachment.attachment_id = attempt.attachment_id
       WHERE attachment.attachment_id IS NULL
          OR attempt.processing_generation > attachment.processing_generation
       LIMIT 1`,
      "attachment processing attempts cannot outrun the artifact generation",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM attachment_extraction_artifacts AS artifact
       LEFT JOIN attachments AS attachment
         ON attachment.attachment_id = artifact.attachment_id
       WHERE attachment.attachment_id IS NULL
          OR artifact.processing_generation > attachment.processing_generation
          OR NOT EXISTS (
            SELECT 1 FROM attachment_processing_attempts AS attempt
            WHERE attempt.attachment_id = artifact.attachment_id
              AND attempt.processing_generation = artifact.processing_generation
              AND attempt.status = 'succeeded'
              AND ((artifact.method = 'ocr-text' AND attempt.adapter_kind = 'ocr')
                OR (artifact.method IN ('extracted-text', 'table-text')
                    AND attempt.adapter_kind = 'extractor'))
          )
       LIMIT 1`,
      "attachment extraction metadata must retain successful processing provenance",
    );
  }
  if (schemaVersion >= 18) {
    requireNoRows(
      database,
      `SELECT 1
       FROM rooms AS room
       LEFT JOIN room_memory_stewards AS steward ON steward.room_id = room.id
       LEFT JOIN room_memory_project_checkpoint AS checkpoint
         ON checkpoint.room_id = room.id
       WHERE steward.room_id IS NULL OR checkpoint.room_id IS NULL
          OR steward.steward_id <> 'room-memory-steward:' || room.id
          OR steward.lifecycle_generation <> room.archive_generation
          OR EXISTS (SELECT 1 FROM actors WHERE id = steward.steward_id)
       LIMIT 1`,
      "every Room must have one non-actor memory steward and checkpoint mode",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_stewards AS steward
       WHERE steward.memory_watermark > steward.corpus_head
          OR steward.corpus_head <> COALESCE((
            SELECT MAX(source.corpus_seq)
            FROM room_memory_sources AS source
            WHERE source.room_id = steward.room_id
          ), 0)
          OR steward.corpus_head <> (
            SELECT COUNT(*) FROM room_memory_sources AS source
            WHERE source.room_id = steward.room_id
          )
       LIMIT 1`,
      "memory corpus sequence and watermark must remain contiguous",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_sources AS source
       WHERE NOT EXISTS (
         SELECT 1 FROM room_memory_source_transitions AS transition
         WHERE transition.room_id = source.room_id
           AND transition.source_kind = source.source_kind
           AND transition.source_id = source.source_id
           AND transition.source_revision = source.source_revision
       )
       LIMIT 1`,
      "every memory source must retain an append-only transition audit",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_jobs AS job
       LEFT JOIN room_memory_stewards AS steward ON steward.room_id = job.room_id
       WHERE steward.room_id IS NULL
          OR job.recovery_generation > steward.recovery_generation
          OR job.to_corpus_seq_inclusive > steward.corpus_head
          OR job.source_count < 1 OR job.source_count > 32
       LIMIT 1`,
      "memory jobs must remain bounded by steward generation and corpus head",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_attempts AS attempt
       LEFT JOIN room_memory_jobs AS job ON job.job_id = attempt.job_id
       WHERE job.job_id IS NULL OR attempt.room_id <> job.room_id
          OR attempt.recovery_generation <> job.recovery_generation
          OR attempt.attempt_number > job.current_attempt
       LIMIT 1`,
      "memory attempts must remain bound to one job generation",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_records AS record
       WHERE (record.current_version_number = 0 AND record.current_version_id IS NOT NULL)
          OR (record.current_version_number > 0 AND NOT EXISTS (
            SELECT 1 FROM room_memory_versions AS version
            WHERE version.memory_version_id = record.current_version_id
              AND version.memory_record_id = record.memory_record_id
              AND version.room_id = record.room_id
              AND version.kind = record.kind
              AND version.version_number = record.current_version_number
          ))
       LIMIT 1`,
      "memory records must point at one same-kind current version",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_versions AS version
       WHERE version.source_count <> (
         SELECT COUNT(*) FROM room_memory_source_edges AS edge
         WHERE edge.memory_version_id = version.memory_version_id
       )
          OR EXISTS (
            SELECT 1 FROM room_memory_source_edges AS edge
            LEFT JOIN room_memory_sources AS source
              ON source.room_id = edge.room_id
             AND source.source_kind = edge.source_kind
             AND source.source_id = edge.source_id
             AND source.source_revision = edge.source_revision
            WHERE edge.memory_version_id = version.memory_version_id
              AND (source.source_id IS NULL OR version.room_id <> edge.room_id
                OR version.memory_record_id <> edge.memory_record_id)
          )
       LIMIT 1`,
      "memory versions must retain a complete same-Room source support set",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_disputes AS dispute
       LEFT JOIN actors AS actor ON actor.id = dispute.operator_actor_id
       WHERE dispute.operator_kind <> 'human' OR actor.kind IS NOT 'human'
       LIMIT 1`,
      "memory disputes must retain a current Human operator",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_memory_resolutions AS resolution
       LEFT JOIN actors AS actor ON actor.id = resolution.operator_actor_id
       WHERE resolution.operator_kind <> 'human' OR actor.kind IS NOT 'human'
       LIMIT 1`,
      "memory resolutions must retain a current Human operator",
    );
  }
  if (schemaVersion >= 19) {
    requireNoRows(
      database,
      `SELECT 1
       FROM context_snapshots AS snapshot
       LEFT JOIN context_manifests AS manifest ON manifest.snapshot_id = snapshot.snapshot_id
       LEFT JOIN context_snapshot_bodies AS body ON body.snapshot_id = snapshot.snapshot_id
       LEFT JOIN context_snapshot_transitions AS transition
         ON transition.snapshot_id = snapshot.snapshot_id
        AND transition.to_generation = snapshot.snapshot_generation
       WHERE manifest.snapshot_id IS NULL
          OR manifest.manifest_sha256 <> snapshot.manifest_sha256
          OR (snapshot.payload_retention_state = 'required' AND body.snapshot_id IS NULL)
          OR (snapshot.payload_retention_state = 'purged' AND body.snapshot_id IS NOT NULL)
          OR transition.snapshot_id IS NULL
          OR transition.to_state <> snapshot.state
          OR (SELECT COUNT(*) FROM context_manifest_items AS item
              WHERE item.manifest_id = manifest.manifest_id) <> manifest.item_count
       LIMIT 1`,
      "context snapshots must retain one complete manifest, transition, and restricted body state",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_context_bindings AS binding
       JOIN agent_executions AS execution ON execution.id = binding.execution_id
       JOIN agent_execution_intent_links AS link ON link.execution_id = execution.id
       JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = binding.snapshot_id
       LEFT JOIN agent_execution_context_attempts AS first_attempt
         ON first_attempt.execution_id = binding.execution_id
        AND first_attempt.attempt_seq = 1
       WHERE binding.execution_generation <> execution.execution_generation
          OR binding.invocation_intent_id <> link.intent_id
          OR snapshot.invocation_intent_id <> link.intent_id
          OR snapshot.room_id <> execution.room_id
          OR snapshot.agent_id <> execution.agent_id
          OR snapshot.provider_id <> execution.provider_id
          OR snapshot.model_id <> execution.model_id
          OR first_attempt.snapshot_id IS NULL
          OR first_attempt.snapshot_id <> binding.snapshot_id
          OR first_attempt.reuse_kind <> 'first'
       LIMIT 1`,
      "every execution must retain one immutable first-attempt context binding",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_context_attempts AS attempt_binding
       JOIN agent_execution_context_bindings AS binding
         ON binding.execution_id = attempt_binding.execution_id
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = attempt_binding.execution_id
        AND attempt.attempt_seq = attempt_binding.attempt_seq
       JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = binding.snapshot_id
       WHERE attempt_binding.snapshot_id <> binding.snapshot_id
          OR attempt_binding.snapshot_generation > snapshot.snapshot_generation
          OR (attempt_binding.attempt_seq = 1 AND attempt_binding.reuse_kind <> 'first')
          OR (attempt_binding.attempt_seq > 1
              AND attempt_binding.reuse_kind NOT IN ('automatic_retry', 'crash_recovery'))
       LIMIT 1`,
      "automatic retry and crash attempts must reuse the execution snapshot",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM context_source_reads AS source_read
       JOIN context_snapshots AS snapshot ON snapshot.snapshot_id = source_read.snapshot_id
       LEFT JOIN context_source_read_payloads AS payload ON payload.read_id = source_read.read_id
       LEFT JOIN context_source_read_receipts AS receipt ON receipt.read_id = source_read.read_id
       WHERE (source_read.status = 'completed' AND (
                receipt.read_id IS NULL
                OR receipt.result_sha256 <> source_read.result_sha256
                OR (snapshot.payload_retention_state <> 'purged' AND (
                      payload.read_id IS NULL
                      OR payload.result_sha256 <> source_read.result_sha256
                    ))
                OR (snapshot.payload_retention_state = 'purged'
                    AND payload.read_id IS NOT NULL)
              ))
          OR (source_read.status = 'page_ready' AND (
                receipt.read_id IS NOT NULL
                OR (snapshot.payload_retention_state <> 'purged' AND (
                      payload.read_id IS NULL
                      OR payload.result_sha256 <> source_read.result_sha256
                    ))
                OR (snapshot.payload_retention_state = 'purged'
                    AND payload.read_id IS NOT NULL)
              ))
          OR (source_read.status NOT IN ('page_ready', 'completed') AND (
                payload.read_id IS NOT NULL OR receipt.read_id IS NOT NULL
              ))
       LIMIT 1`,
      "checkpointed context source reads must retain the exact payload and terminal receipt",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_message_citations AS citation
       JOIN agent_message_sources AS message_source
         ON message_source.message_id = citation.message_id
       JOIN agent_execution_context_bindings AS binding
         ON binding.execution_id = message_source.execution_id
       WHERE citation.execution_id <> message_source.execution_id
          OR citation.snapshot_id <> binding.snapshot_id
       LIMIT 1`,
      "final citations must remain bound to the Agent message execution snapshot",
    );
  }
  if (schemaVersion >= 20) {
    requireNoRows(
      database,
      `SELECT 1 FROM actors AS actor
       LEFT JOIN agent_profiles AS profile ON profile.actor_id = actor.id
       WHERE actor.kind = 'agent' AND profile.id IS NULL LIMIT 1`,
      "every legacy Agent actor must retain one canonical Global Profile",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_profiles AS profile
       JOIN actors AS actor ON actor.id = profile.actor_id
       LEFT JOIN agent_profile_revisions AS revision
         ON revision.profile_id = profile.id AND revision.revision = profile.revision
       WHERE actor.kind <> 'agent' OR revision.profile_id IS NULL
          OR revision.actor_id <> profile.actor_id
          OR revision.display_name <> profile.display_name
          OR revision.global_responsibility <> profile.global_responsibility
          OR revision.status <> profile.status
          OR revision.capability_ceiling_json <> profile.capability_ceiling_json
          OR revision.tool_ceiling_json <> profile.tool_ceiling_json
          OR EXISTS (
            SELECT 1 FROM json_each(profile.capability_ceiling_json)
            WHERE typeof(value) <> 'text' OR value NOT IN (
              'room.conversation.read', 'room.memory.read', 'room.project.read', 'room.respond'
            )
          ) OR EXISTS (
            SELECT 1 FROM json_each(profile.tool_ceiling_json)
            WHERE typeof(value) <> 'text' OR value NOT IN (
              'http-json.read', 'repository.git-status', 'room-memory.read', 'sandbox-file.write'
            )
          )
       LIMIT 1`,
      "Global Profiles must retain a closed current revision bound to one Agent actor",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM room_agent_assignments AS assignment
       JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
       LEFT JOIN room_agent_assignment_revisions AS revision
         ON revision.assignment_id = assignment.id AND revision.revision = assignment.revision
       WHERE revision.assignment_id IS NULL
          OR assignment.agent_actor_id <> profile.actor_id
          OR revision.room_id <> assignment.room_id
          OR revision.profile_id <> assignment.profile_id
          OR revision.agent_actor_id <> assignment.agent_actor_id
          OR revision.status <> assignment.status
          OR revision.participation <> assignment.participation
          OR revision.paused <> assignment.paused
          OR revision.capability_subset_json <> assignment.capability_subset_json
          OR revision.tool_subset_json <> assignment.tool_subset_json
          OR (assignment.status = 'removed'
              AND (assignment.paused <> 1 OR assignment.removed_at IS NULL))
          OR (assignment.status = 'current' AND assignment.removed_at IS NOT NULL)
          OR EXISTS (
            SELECT value FROM json_each(assignment.capability_subset_json)
            EXCEPT SELECT value FROM json_each(profile.capability_ceiling_json)
          )
          OR EXISTS (
            SELECT value FROM json_each(assignment.tool_subset_json)
            EXCEPT SELECT value FROM json_each(profile.tool_ceiling_json)
          )
       LIMIT 1`,
      "Room Assignments must retain a closed current revision within their Profile ceiling",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM room_memberships AS membership
       WHERE membership.kind = 'agent' AND membership.participation = 'silent'
       LIMIT 1`,
      "legacy silent membership must be migrated out of the production projection",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM tenant_administrator_registry AS registry
       WHERE (SELECT COUNT(*) FROM tenant_administrators WHERE status = 'active') < 1
       UNION ALL
       SELECT 1 FROM tenant_administrators AS administrator
       JOIN actors AS actor ON actor.id = administrator.human_actor_id
       LEFT JOIN tenant_administrator_registry AS registry ON registry.singleton_id = 1
       WHERE actor.kind <> 'human' OR registry.singleton_id IS NULL
       LIMIT 1`,
      "configured Tenant Administrator authority must retain one active Human principal",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM deployment_audit AS audit
       LEFT JOIN actors AS principal ON principal.id = audit.principal_human_actor_id
       WHERE (audit.event_kind = 'administrator.bootstrap'
              AND audit.principal_human_actor_id IS NOT NULL)
          OR (audit.event_kind <> 'administrator.bootstrap' AND principal.kind <> 'human')
          OR EXISTS (
            SELECT 1 FROM json_tree(audit.details_json)
            WHERE lower(COALESCE(key, '')) IN (
              'secret', 'secretvalue', 'credential', 'apikey', 'authorization', 'token'
            )
          )
       LIMIT 1`,
      "deployment audit must remain Human-authored and secret-free",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM deployment_stream AS stream
       WHERE stream.singleton_id <> 1 OR stream.head_seq < 0
          OR stream.retained_from_seq < 1
          OR stream.retained_from_seq > stream.head_seq + 1
       UNION ALL
       SELECT 1 FROM deployment_agent_profile_events AS event
       LEFT JOIN agent_profiles AS profile ON profile.id = event.profile_id
       WHERE profile.id IS NULL OR profile.actor_id <> event.actor_id
          OR event.profile_revision > profile.revision
          OR event.stream_seq > (
            SELECT head_seq FROM deployment_stream WHERE singleton_id = 1
          )
       UNION ALL
       SELECT 1 FROM deployment_agent_profile_repair_records AS repair
       LEFT JOIN deployment_agent_profile_events AS event ON event.event_id = repair.event_id
       LEFT JOIN agent_profiles AS profile ON profile.id = repair.profile_id
       WHERE event.event_id IS NULL OR profile.id IS NULL
          OR event.profile_id <> repair.profile_id
          OR event.profile_revision <> repair.profile_revision
          OR event.stream_seq <> repair.stream_seq
          OR profile.revision <> repair.profile_revision
       UNION ALL
       SELECT 1 FROM deployment_profile_outbox AS outbox
       LEFT JOIN deployment_agent_profile_events AS event ON event.event_id = outbox.event_id
       LEFT JOIN tenant_administrators AS administrator
         ON administrator.human_actor_id = outbox.recipient_human_actor_id
       WHERE event.event_id IS NULL OR event.stream_seq <> outbox.stream_seq
          OR administrator.human_actor_id IS NULL
       LIMIT 1`,
      "deployment Profile stream, outbox, and repair must retain exact authority bindings",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM route_candidate_snapshots AS snapshot
       JOIN route_jobs AS job ON job.id = snapshot.route_job_id
       WHERE job.candidate_snapshot_id <> snapshot.id
          OR snapshot.candidate_count <> (
         SELECT COUNT(*) FROM route_candidate_snapshot_agents AS candidate
         WHERE candidate.snapshot_id = snapshot.id
       ) OR EXISTS (
         SELECT 1 FROM route_candidate_snapshot_agents AS candidate
         WHERE candidate.snapshot_id = snapshot.id
           AND (candidate.participation <> 'active' OR candidate.availability <> 'ready')
       )
       LIMIT 1`,
      "route candidate snapshots must contain only their exact ready active candidate set",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM routed_agent_invocation_intents AS intent
       JOIN route_decisions AS decision ON decision.id = intent.route_decision_id
       LEFT JOIN route_candidate_snapshot_agents AS candidate
         ON candidate.snapshot_id = intent.snapshot_id
        AND candidate.route_job_id = intent.route_job_id
        AND candidate.agent_actor_id = intent.target_agent_actor_id
       WHERE decision.route_job_id <> intent.route_job_id
          OR decision.snapshot_id <> intent.snapshot_id
          OR decision.outcome <> 'selected'
          OR candidate.agent_actor_id IS NULL
          OR candidate.profile_id <> intent.profile_id
          OR candidate.profile_revision <> intent.profile_revision
          OR candidate.assignment_id <> intent.assignment_id
          OR candidate.assignment_revision <> intent.assignment_revision
          OR candidate.access_revision <> intent.access_revision
       LIMIT 1`,
      "routed invocation intents must retain exact route decision provenance",
    );
  }
  if (schemaVersion >= 21) {
    requireNoRows(
      database,
      `SELECT 1
       FROM direct_agent_invocation_authority_bindings AS binding
       LEFT JOIN agent_invocation_intents AS intent ON intent.id = binding.intent_id
       LEFT JOIN agent_profile_revisions AS profile_revision
         ON profile_revision.profile_id = binding.profile_id
        AND profile_revision.revision = binding.profile_revision
       LEFT JOIN room_agent_assignment_revisions AS assignment_revision
         ON assignment_revision.assignment_id = binding.assignment_id
        AND assignment_revision.revision = binding.assignment_revision
       WHERE intent.id IS NULL OR intent.origin_kind <> 'message_target'
          OR intent.intent_kind <> 'direct_mention'
          OR intent.message_transaction_id <> intent.source_message_id
          OR profile_revision.profile_id IS NULL
          OR profile_revision.actor_id <> intent.target_agent_id
          OR assignment_revision.assignment_id IS NULL
          OR assignment_revision.room_id <> intent.room_id
          OR assignment_revision.profile_id <> binding.profile_id
          OR assignment_revision.agent_actor_id <> intent.target_agent_id
       LIMIT 1`,
      "direct invocation bindings must retain exact immutable authority revisions",
    );
  }
  if (schemaVersion >= 22) {
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_invocation_intents AS intent
       LEFT JOIN agent_invocation_intent_runtime_states AS runtime
         ON runtime.intent_id = intent.id
       WHERE runtime.intent_id IS NULL
          OR (runtime.public_status = 'pending' AND (
            runtime.claimed_at IS NOT NULL OR runtime.cancelled_at IS NOT NULL
            OR runtime.cancellation_reason IS NOT NULL
          ))
          OR (runtime.public_status = 'claimed' AND (
            runtime.claimed_at IS NULL OR runtime.cancelled_at IS NOT NULL
            OR runtime.cancellation_reason IS NOT NULL
          ))
          OR (runtime.public_status = 'cancelled' AND (
            runtime.cancelled_at IS NULL OR runtime.cancellation_reason IS NULL
          ))
       LIMIT 1`,
      "invocation intent runtime projection must retain one valid canonical state",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_runtime_states AS runtime
       JOIN agent_executions AS execution ON execution.id = runtime.execution_id
       LEFT JOIN agent_execution_intent_links AS link
         ON link.execution_id = runtime.execution_id
       LEFT JOIN agent_execution_context_bindings AS context
         ON context.execution_id = runtime.execution_id
       WHERE runtime.current_attempt_seq <> execution.current_attempt_seq
          OR runtime.execution_generation <> execution.execution_generation
          OR (runtime.review_state <> 'legacy_review_required' AND (
            runtime.intent_id <> link.intent_id
            OR runtime.lineage_id <> (
              SELECT lineage_id FROM agent_invocation_intents WHERE id = runtime.intent_id
            )
            OR runtime.execution_ordinal <> link.execution_ordinal
            OR runtime.retry_of_execution_id IS NOT link.retry_of_execution_id
            OR runtime.snapshot_id <> context.snapshot_id
            OR runtime.provider_id IS NOT execution.provider_id
            OR runtime.model_id IS NOT execution.model_id
          ))
       LIMIT 1`,
      "invocation execution projection must retain exact lineage and frozen authority",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM agent_execution_attempt_runtime_states AS runtime
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = runtime.execution_id
        AND attempt.attempt_seq = runtime.attempt_seq
       WHERE (attempt.status = 'queued' AND runtime.public_status <> 'accepted')
          OR (attempt.status <> 'queued' AND runtime.public_status <> attempt.status)
       LIMIT 1`,
      "invocation attempt projection must map queued only to accepted",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM invocation_scoped_cancellation_targets AS target
       JOIN invocation_scoped_cancellation_fences AS fence
         ON fence.fence_id = target.fence_id
       JOIN agent_execution_runtime_states AS execution
         ON execution.execution_id = target.execution_id
       WHERE fence.execution_id IS NOT NULL
             AND fence.execution_id <> target.execution_id
          OR execution.intent_id <> fence.intent_id
          OR target.execution_version_after <> target.execution_version_before + 1
       LIMIT 1`,
      "scoped cancellation targets must remain inside their exact intent/execution scope",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_boundary_invocation_receipts
       WHERE (status = 'consumed') <> (invocation_intent_id IS NOT NULL)
       LIMIT 1`,
      "project boundary dependency receipts must fail closed without a durable intent",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM invocation_human_retry_receipts AS receipt
       LEFT JOIN agent_execution_intent_links AS link
         ON link.execution_id = receipt.child_execution_id
       LEFT JOIN agent_execution_runtime_states AS runtime
         ON runtime.execution_id = receipt.child_execution_id
       LEFT JOIN agent_execution_runtime_states AS source_runtime
         ON source_runtime.execution_id = receipt.source_execution_id
       LEFT JOIN agent_executions AS execution
         ON execution.id = receipt.child_execution_id
       LEFT JOIN agent_invocation_intents AS intent ON intent.id = receipt.intent_id
       LEFT JOIN actors AS principal ON principal.id = receipt.principal_actor_id
       WHERE link.intent_id IS NULL OR link.intent_id <> receipt.intent_id
          OR link.execution_ordinal <> receipt.execution_ordinal
          OR link.retry_of_execution_id <> receipt.source_execution_id
          OR principal.kind IS NOT 'human'
          OR runtime.snapshot_id IS NULL
          OR json_extract(receipt.response_json, '$.kind') IS NOT 'invocation'
          OR json_extract(receipt.response_json, '$.replayed') IS NOT 0
          OR json_extract(receipt.response_json, '$.execution.id')
             IS NOT receipt.child_execution_id
          OR json_extract(receipt.response_json, '$.execution.manualRetryOfExecutionId')
             IS NOT receipt.source_execution_id
          OR json_extract(receipt.response_json, '$.execution.roomId') IS NOT execution.room_id
          OR json_extract(receipt.response_json, '$.execution.queuedAt') IS NOT execution.queued_at
          OR json_extract(receipt.response_json, '$.intent.kind') IS NOT intent.intent_kind
          OR json_extract(receipt.response_json, '$.intent.roomId') IS NOT intent.room_id
          OR json_extract(receipt.response_json, '$.intent.sourceMessageId')
             IS NOT intent.source_message_id
          OR json_extract(receipt.response_json, '$.intent.targetAgentId')
             IS NOT intent.target_agent_id
          OR json_extract(receipt.response_json, '$.retryReceipt.requestId')
             IS NOT receipt.request_id
          OR json_extract(receipt.response_json, '$.retryReceipt.sourceExecutionId')
             IS NOT receipt.source_execution_id
          OR json_extract(receipt.response_json, '$.retryReceipt.executionId')
             IS NOT receipt.child_execution_id
          OR json_extract(receipt.response_json, '$.retryReceipt.intentId')
             IS NOT receipt.intent_id
          OR json_extract(receipt.response_json, '$.retryReceipt.lineageId')
             IS NOT source_runtime.lineage_id
          OR json_extract(receipt.response_json, '$.retryReceipt.roomId')
             IS NOT execution.room_id
          OR json_extract(receipt.response_json, '$.retryReceipt.executionOrdinal')
             IS NOT receipt.execution_ordinal
          OR json_extract(receipt.response_json, '$.retryReceipt.snapshotId')
             IS NOT runtime.snapshot_id
          OR json_extract(receipt.response_json, '$.retryReceipt.status') IS NOT 'accepted'
          OR json_extract(receipt.response_json, '$.retryReceipt.createdAt')
             IS NOT execution.queued_at
       LIMIT 1`,
      "Human retry receipts must retain exact principal, child lineage, and snapshot binding",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM legacy_room_wide_preemption_markers
       WHERE production_reachable <> 0
          OR source_kind NOT IN ('human_preemption_fence', 'agent_human_fence')
       LIMIT 1`,
      "legacy room-wide preemption history must remain read-only and production-unreachable",
    );
  }
  if (schemaVersion >= 23) {
    requireNoRows(
      database,
      `SELECT 1 FROM project_room_states
       WHERE room_id <> project_id OR revision <> event_head_seq
          OR event_head_seq <> COALESCE((
            SELECT MAX(event_seq) FROM project_events
            WHERE project_events.room_id = project_room_states.room_id
          ), 0)
       LIMIT 1`,
      "Project room revisions must match their immutable event head",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM (
         SELECT room_id, project_id, source_room_id FROM project_goals
         UNION ALL SELECT room_id, project_id, source_room_id FROM project_decisions
         UNION ALL SELECT room_id, project_id, source_room_id FROM project_fact_proposals
         UNION ALL SELECT room_id, project_id, source_room_id FROM project_confirmations
         UNION ALL SELECT room_id, project_id, source_room_id FROM project_events
       ) AS scoped
       WHERE scoped.room_id <> scoped.project_id OR scoped.room_id <> scoped.source_room_id
       LIMIT 1`,
      "Project Loop authority must remain inside the Room-equals-Project boundary",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_fact_proposals AS proposal
       JOIN actors AS proposer ON proposer.id = proposal.proposed_by_actor_id
       LEFT JOIN actors AS principal ON principal.id = proposal.principal_human_actor_id
       WHERE proposer.kind <> proposal.proposed_by_kind
          OR (proposal.principal_human_actor_id IS NOT NULL AND principal.kind <> 'human')
       LIMIT 1`,
      "Project proposals must retain proposer and Human principal authority",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_confirmations AS confirmation
       JOIN actors AS principal ON principal.id = confirmation.principal_human_actor_id
       LEFT JOIN actors AS resolver ON resolver.id = confirmation.resolved_by_human_actor_id
       JOIN project_fact_proposals AS proposal ON proposal.id = confirmation.proposal_id
       WHERE principal.kind <> 'human' OR confirmation.room_id <> proposal.room_id
          OR confirmation.revision <> proposal.revision
          OR confirmation.base_revision <> proposal.base_revision
          OR confirmation.state <> proposal.status
          OR (confirmation.resolved_by_human_actor_id IS NOT NULL AND resolver.kind <> 'human')
       LIMIT 1`,
      "Project confirmations must bind pending and terminal Human authority to the proposal revision",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM (
         SELECT room_id, source_kind, source_revision, visibility_room_id FROM project_requests
         UNION ALL SELECT room_id, source_kind, source_revision, visibility_room_id FROM project_next_actions
         UNION ALL SELECT room_id, source_kind, source_revision, visibility_room_id FROM project_obstacles
       ) AS fact
       WHERE (fact.source_kind = 'legacy_v14' AND
              (fact.source_revision IS NOT NULL OR fact.visibility_room_id IS NOT NULL))
          OR (fact.source_kind <> 'legacy_v14' AND
              (fact.source_revision IS NULL OR fact.visibility_room_id <> fact.room_id))
       LIMIT 1`,
      "legacy Project skeleton rows must remain compatibility-only without invented provenance",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_requests
       WHERE (source_kind = 'legacy_v14' AND
              (frozen_responsibility_json IS NOT NULL OR frozen_responsibility_sha256 IS NOT NULL))
          OR (source_kind <> 'legacy_v14' AND
              (frozen_responsibility_json IS NULL OR frozen_responsibility_sha256 IS NULL))
       LIMIT 1`,
      "canonical Project Requests must retain an explicit frozen responsibility factory",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_requests AS request
       LEFT JOIN actors AS resolver ON resolver.id = request.resolution_actor_id
       WHERE (request.status = 'pending_acceptance' AND
              (request.resolution_actor_kind IS NOT NULL OR request.resolution_actor_id IS NOT NULL
               OR request.resolved_at IS NOT NULL))
          OR (request.status <> 'pending_acceptance' AND request.source_kind <> 'legacy_v14' AND
              (request.resolution_actor_kind IS NULL OR request.resolution_actor_id IS NULL
               OR request.resolved_at IS NULL OR resolver.kind <> request.resolution_actor_kind))
       LIMIT 1`,
      "canonical Project Request resolution authority must be explicit",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_requests AS request
       LEFT JOIN human_request_intents AS intent
         ON intent.id = request.source_request_intent_id
       WHERE (request.source_request_intent_id IS NULL) <> (request.source_target_id IS NULL)
          OR (request.source_request_intent_id IS NOT NULL AND (
            intent.id IS NULL OR intent.room_id <> request.room_id
            OR intent.source_message_id <> request.source_id
            OR intent.target_id <> request.source_target_id
            OR intent.source_revision <> request.source_revision
            OR intent.requester_human_actor_id <> request.requester_human_actor_id
          ))
       LIMIT 1`,
      "Project Requests must retain their exact structured Human Request intent source",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_ball_boundaries AS boundary
       JOIN actors AS holder ON holder.id = boundary.holder_actor_id
       WHERE holder.kind <> boundary.holder_kind
          OR boundary.room_id <> boundary.project_id
       LIMIT 1`,
      "Project Ball boundaries must retain one same-Room actor-kind holder",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_due_reminder_claims AS claim
       JOIN project_ball_boundaries AS boundary ON boundary.boundary_id = claim.boundary_id
       WHERE claim.room_id <> boundary.room_id
          OR claim.source_revision <> boundary.source_revision
          OR claim.holder_kind <> boundary.holder_kind
          OR claim.holder_actor_id <> boundary.holder_actor_id
          OR claim.recipient_actor_id <> claim.holder_actor_id
          OR (claim.reminder_ordinal = 0 AND claim.reminder_kind <> 'initial_due')
          OR (claim.reminder_ordinal > 0 AND claim.reminder_kind <> 'repeat_24h')
       LIMIT 1`,
      "Project reminder claims must retain exact boundary bucket and recipient authority",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_event_outbox AS delivery
       JOIN project_events AS event ON event.event_id = delivery.event_id
       WHERE delivery.room_id <> event.room_id OR delivery.event_seq <> event.event_seq
       LIMIT 1`,
      "Project outbox records must retain immutable event identity",
    );
  }
  if (schemaVersion >= 24) {
    requireNoRows(
      database,
      `SELECT 1
       FROM project_boundary_agent_invocation_intents AS intent
       JOIN project_ball_boundaries AS boundary ON boundary.boundary_id = intent.boundary_id
       JOIN project_agent_boundary_claims AS claim
         ON claim.boundary_id = intent.boundary_id
        AND claim.source_revision = intent.source_revision
       JOIN agent_profile_revisions AS profile_revision
         ON profile_revision.profile_id = intent.profile_id
        AND profile_revision.revision = intent.profile_revision
       JOIN room_agent_assignment_revisions AS assignment_revision
         ON assignment_revision.assignment_id = intent.assignment_id
        AND assignment_revision.revision = intent.assignment_revision
       WHERE intent.room_id <> intent.project_id
          OR boundary.room_id <> intent.room_id
          OR boundary.project_id <> intent.project_id
          OR boundary.source_kind <> intent.source_kind
          OR boundary.source_id <> intent.source_id
          OR boundary.source_revision <> intent.source_revision
          OR boundary.lifecycle_generation <> intent.lifecycle_generation
          OR boundary.holder_kind <> 'agent'
          OR boundary.holder_actor_id <> intent.target_agent_actor_id
          OR claim.room_id <> intent.room_id
          OR claim.holder_agent_actor_id <> intent.target_agent_actor_id
          OR claim.request_sha256 <> intent.request_sha256
          OR profile_revision.actor_id <> intent.target_agent_actor_id
          OR assignment_revision.room_id <> intent.room_id
          OR assignment_revision.profile_id <> intent.profile_id
          OR assignment_revision.agent_actor_id <> intent.target_agent_actor_id
       LIMIT 1`,
      "Project boundary Agent intents must retain exact frozen authority and source lineage",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM project_boundary_agent_execution_links AS link
       JOIN project_boundary_agent_invocation_intents AS intent
         ON intent.intent_id = link.intent_id
       JOIN project_boundary_agent_executions AS execution
         ON execution.execution_id = link.execution_id
       WHERE link.source_revision <> intent.source_revision
          OR link.lifecycle_generation <> intent.lifecycle_generation
          OR execution.room_id <> intent.room_id
          OR execution.project_id <> intent.project_id
          OR execution.agent_actor_id <> intent.target_agent_actor_id
          OR execution.lifecycle_generation <> intent.lifecycle_generation
       LIMIT 1`,
      "Project boundary executions must retain message-independent frozen lineage",
    );
    requireNoRows(
      database,
      `SELECT 1
       FROM project_boundary_context_sources AS source
       JOIN project_boundary_agent_invocation_intents AS intent
         ON intent.intent_id = source.intent_id
       JOIN project_boundary_agent_execution_links AS link
         ON link.intent_id = source.intent_id
        AND link.execution_id = source.execution_id
        AND link.execution_ordinal = source.execution_ordinal
       JOIN project_fact_checkpoints AS checkpoint
         ON checkpoint.checkpoint_id = source.checkpoint_id
       WHERE source.room_id <> intent.room_id
          OR source.project_id <> intent.project_id
          OR source.source_kind <> intent.source_kind
          OR source.source_id <> intent.source_id
          OR source.source_revision <> intent.source_revision
          OR source.lifecycle_generation <> intent.lifecycle_generation
          OR checkpoint.room_id <> source.room_id
          OR checkpoint.project_id <> source.project_id
          OR checkpoint.project_revision <> source.checkpoint_project_revision
          OR checkpoint.projection_sha256 <> source.checkpoint_projection_sha256
       LIMIT 1`,
      "Project boundary context sources must retain exact checkpoint and execution lineage",
    );
  }
  if (schemaVersion >= 25) {
    requireNoRows(
      database,
      `SELECT 1 FROM project_events AS event
       LEFT JOIN actors AS authority ON authority.id = event.actor_id
       LEFT JOIN actors AS causal ON causal.id = event.causal_actor_id
       LEFT JOIN events AS public ON public.event_id = event.event_id
       LEFT JOIN project_transition_audit AS audit ON audit.event_id = event.event_id
       LEFT JOIN project_event_outbox AS delivery ON delivery.event_id = event.event_id
       WHERE audit.event_id IS NULL OR delivery.event_id IS NULL
          OR delivery.room_id <> event.room_id OR delivery.event_seq <> event.event_seq
          OR (event.authority_kind = 'system_timer' AND (
            event.actor_kind IS NOT NULL OR event.actor_id IS NOT NULL
            OR event.causal_actor_kind IS NOT NULL OR event.causal_actor_id IS NOT NULL
            OR event.event_type <> 'fact.transitioned'
            OR json_type(event.payload_json, '$.transition') IS NOT 'text'
            OR (json_extract(event.payload_json, '$.transition') = 'review_due' AND (
              event.fact_kind NOT IN ('blocker','open_question')
              OR public.event_type <> CASE event.fact_kind WHEN 'blocker'
                THEN 'project.blocker.changed' ELSE 'project.open-question.changed' END
              OR json_extract(public.payload_json, '$.obstacleId') IS NOT event.fact_id
              OR json_extract(public.payload_json, '$.revision') IS NOT event.fact_revision))
            OR (json_extract(event.payload_json, '$.transition') IN (
                  'transfer_expired','review_due_transfer_rebound') AND (
              event.fact_kind NOT IN ('next_action','blocker','open_question')
              OR json_type(event.payload_json, '$.transferProposalId') IS NOT 'text'
              OR (json_extract(event.payload_json, '$.migratedFromV24') IS TRUE AND (
                json_extract(event.payload_json, '$.transition') <> 'transfer_expired'
                OR public.event_type <> CASE event.fact_kind
                  WHEN 'next_action' THEN 'project.next-action.changed'
                  WHEN 'blocker' THEN 'project.blocker.changed'
                  ELSE 'project.open-question.changed' END
                OR json_extract(public.payload_json,
                     CASE event.fact_kind WHEN 'next_action' THEN '$.nextActionId'
                       ELSE '$.obstacleId' END) IS NOT event.fact_id
                OR json_extract(public.payload_json, '$.revision') IS NOT event.fact_revision))
              OR (json_extract(event.payload_json, '$.migratedFromV24') IS NOT TRUE AND (
                json_type(event.payload_json, '$.transferRevision') IS NOT 'integer'
                OR public.event_type <> 'project.transfer-proposal.changed'
                OR json_extract(public.payload_json, '$.transferProposalId') IS NOT
                    json_extract(event.payload_json, '$.transferProposalId')
                OR json_extract(public.payload_json, '$.revision') IS NOT
                    json_extract(event.payload_json, '$.transferRevision')))))
            OR json_extract(event.payload_json, '$.transition') NOT IN (
              'review_due','transfer_expired','review_due_transfer_rebound')
            OR public.event_id IS NULL OR public.authority_kind <> 'system_timer'
            OR public.actor_id IS NOT NULL))
          OR (event.authority_kind IN ('human','agent') AND (
            public.event_id IS NULL OR causal.kind <> event.causal_actor_kind
            OR event.actor_kind <> event.authority_kind OR authority.kind <> event.authority_kind
            OR public.authority_kind <> event.authority_kind OR public.actor_id <> event.actor_id))
       LIMIT 1`,
      "Project events must retain closed Human, Agent, or system timer authority",
    );
    requireNoRows(
      database,
      `SELECT 1 FROM project_transition_audit AS audit
       JOIN project_events AS event ON event.event_id = audit.event_id
       WHERE audit.authority_kind <> event.authority_kind
          OR audit.actor_kind IS NOT event.actor_kind OR audit.actor_id IS NOT event.actor_id
          OR audit.causal_actor_kind IS NOT event.causal_actor_kind
          OR audit.causal_actor_id IS NOT event.causal_actor_id
       LIMIT 1`,
      "Project audit authority must match its immutable stored event",
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

function assertV12SessionCapacity(database: DatabaseSync, now: number): void {
  const overCapacity = database.prepare(
    `WITH active_families AS (
       SELECT family_id, account_id, actor_id
       FROM sessions
       GROUP BY family_id, account_id, actor_id
       HAVING SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) > 0
          AND MAX(refresh_expires_at) > ?
     )
     SELECT account_id AS accountId, actor_id AS actorId, COUNT(*) AS count
     FROM active_families
     GROUP BY account_id, actor_id
     HAVING COUNT(*) > ?
     LIMIT 1`,
  ).get(now, MAX_ACTIVE_SESSION_FAMILIES);
  if (overCapacity !== undefined) {
    throw new Error(
      `Refusing v12 migration: active session family capacity exceeds ` +
        MAX_ACTIVE_SESSION_FAMILIES,
    );
  }
}

function assertV13LegacyOwnership(database: DatabaseSync): void {
  requireNoRows(
    database,
    `SELECT 1
     FROM rooms AS room
     WHERE (SELECT COUNT(*) FROM room_memberships AS membership
            JOIN actors AS actor ON actor.id = membership.actor_id
            WHERE membership.room_id = room.id
              AND membership.kind = 'human'
              AND actor.kind = 'human'
              AND membership.role = 'owner') <> 1
        OR EXISTS (
          SELECT 1 FROM room_memberships AS membership
          LEFT JOIN actors AS actor ON actor.id = membership.actor_id
          WHERE membership.room_id = room.id
            AND membership.role = 'owner'
            AND (membership.kind <> 'human' OR actor.kind <> 'human')
        )
     LIMIT 1`,
    "v13 migration requires exactly one same-room Human owner per room",
  );
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
      if (migration.version === 12) {
        assertV12SessionCapacity(database, Date.now());
      }
      if (migration.version === 13) {
        assertV13LegacyOwnership(database);
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
    database.exec("PRAGMA legacy_alter_table = OFF");
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

export function migrateAuthorityDatabaseToHistoricalVersionForTest(
  database: DatabaseSync,
  version: number,
): void {
  if (version >= AUTHORITY_SCHEMA_VERSION) {
    throw new TypeError("historical authority schema version must precede current");
  }
  migrateAuthorityDatabaseToVersion(database, version);
}

export function migrateAuthorityDatabaseToVersion13ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 13);
}

export function migrateAuthorityDatabaseToVersion16ForTest(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void {
  migrateAuthorityDatabaseToVersion(database, 16, fault);
}

export function migrateAuthorityDatabaseToVersion20ForTest(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void {
  migrateAuthorityDatabaseToVersion(database, 20, fault);
}

export function migrateAuthorityDatabaseToVersion15ForTest(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void {
  migrateAuthorityDatabaseToVersion(database, 15, fault);
}

export function migrateAuthorityDatabaseToVersion14ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 14);
}

export function migrateAuthorityDatabaseToVersion12ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 12);
}

export function migrateAuthorityDatabaseToVersion11ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 11);
}

export function migrateAuthorityDatabaseToVersion10ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 10);
}

export function migrateAuthorityDatabaseToVersion9ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 9);
}

export function migrateAuthorityDatabaseToVersion8ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 8);
}

export function migrateAuthorityDatabaseToVersion7ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 7);
}

export function migrateAuthorityDatabaseToVersion6ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 6);
}

export function migrateAuthorityDatabaseToVersion5ForTest(
  database: DatabaseSync,
): void {
  migrateAuthorityDatabaseToVersion(database, 5);
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

export const SNAPSHOT_CACHE_SCHEMA_VERSION = 2 as const;
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
