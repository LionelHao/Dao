import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const AUTHORITY_SCHEMA_VERSION = 11 as const;

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
