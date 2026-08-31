export type ReceiptRetention = "30-day-command" | "mixed-command-and-permanent" | "permanent";

export interface IdempotencyReceiptFamilyDescriptor {
  readonly id: string;
  readonly tables: readonly string[];
  readonly retention: ReceiptRetention;
  readonly scopeKey: string;
  readonly fingerprint: string | null;
  readonly resultDecoder: string;
  readonly expiryColumn: string | null;
  readonly expiryIndex: string | null;
  readonly cleanupAdapter: string;
  readonly requiresV27: boolean;
  readonly stableBoundary: string;
}

export const IDEMPOTENCY_RECEIPT_FAMILIES = Object.freeze([
  { id: "generic-command", tables: ["idempotency_records"], retention: "30-day-command",
    scopeKey: "scope,key", fingerprint: "request_hash", resultDecoder: "stored-command-ack",
    expiryColumn: "expires_at", expiryIndex: "idempotency_records_expiry_v27",
    cleanupAdapter: "generic-command", requiresV27: false,
    stableBoundary: "aggregate id / revision / domain uniqueness" },
  { id: "deployment-command", tables: ["deployment_idempotency_records"],
    retention: "30-day-command", scopeKey: "scope,idempotency_key",
    fingerprint: "request_sha256", resultDecoder: "deployment-result",
    expiryColumn: "expires_at_ms", expiryIndex: "deployment_idempotency_records_expiry_v27",
    cleanupAdapter: "deployment-command", requiresV27: false,
    stableBoundary: "profile id / revision" },
  { id: "room-memory-command", tables: ["room_memory_idempotency"],
    retention: "30-day-command", scopeKey: "scope,idempotency_key",
    fingerprint: "request_sha256", resultDecoder: "room-memory-result",
    expiryColumn: "expires_at_ms", expiryIndex: "room_memory_idempotency_expiry_v27",
    cleanupAdapter: "room-memory-command", requiresV27: false,
    stableBoundary: "memory record/version and CAS" },
  { id: "tool-safety-command", tables: ["tool_safety_command_receipts_v2"],
    retention: "30-day-command", scopeKey: "principal_actor_id,command_kind,idempotency_key",
    fingerprint: "request_sha256", resultDecoder: "tool-safety-result",
    expiryColumn: "expires_at", expiryIndex: "tool_safety_command_receipts_expiry_v27",
    cleanupAdapter: "tool-safety-command", requiresV27: false,
    stableBoundary: "toolCall/confirmation/grant/dispatch id and version" },
  { id: "project-command", tables: ["project_command_receipts"],
    retention: "30-day-command", scopeKey: "actor_id,idempotency_key",
    fingerprint: "request_sha256", resultDecoder: "project-loop-result",
    expiryColumn: "expires_at", expiryIndex: "project_command_receipts_expiry_v27",
    cleanupAdapter: "project-command-v27",
    requiresV27: true,
    stableBoundary: "project fact/proposal id and revision" },
  { id: "human-cancellation-command", tables: ["invocation_cancellation_receipts"],
    retention: "mixed-command-and-permanent", scopeKey: "request_id",
    fingerprint: "request_sha256", resultDecoder: "scoped-cancellation-result",
    expiryColumn: "expires_at", expiryIndex: "invocation_cancellation_receipts_expiry_v27",
    cleanupAdapter: "human-cancellation-only-v27",
    requiresV27: true,
    stableBoundary: "cancellation fence and execution/intent version" },
  { id: "human-retry-command", tables: ["invocation_human_retry_receipts"],
    retention: "30-day-command", scopeKey: "request_id", fingerprint: "request_sha256",
    resultDecoder: "human-retry-result", expiryColumn: "expires_at",
    expiryIndex: "invocation_human_retry_receipts_expiry_v27",
    cleanupAdapter: "human-retry-v27", requiresV27: true,
    stableBoundary: "execution lineage and ordinal" },
  { id: "project-boundary-domain-receipt", tables: ["project_boundary_invocation_receipts"],
    retention: "permanent", scopeKey: "boundary_id", fingerprint: null,
    resultDecoder: "project-boundary-domain-fact", expiryColumn: null, expiryIndex: null,
    cleanupAdapter: "none-permanent", requiresV27: false,
    stableBoundary: "project source boundary" },
  { id: "read-and-source-facts", tables: ["human_read_receipts", "context_source_read_receipts"],
    retention: "permanent", scopeKey: "domain-primary-key", fingerprint: null,
    resultDecoder: "read-and-source-domain-facts", expiryColumn: null, expiryIndex: null,
    cleanupAdapter: "none-permanent", requiresV27: false,
    stableBoundary: "read/source provenance fact" },
] as const satisfies readonly IdempotencyReceiptFamilyDescriptor[]);

export type OutboxClassification =
  | "central-transport"
  | "dedicated-authoritative-stream"
  | "terminal-mirror-reserved"
  | "security-post-commit-intent";

export interface AuthoritativeOutboxFamilyDescriptor {
  readonly id: string;
  readonly table: string;
  readonly classification: OutboxClassification;
  readonly consumer: string;
  readonly requiresV27: boolean;
  readonly batchSize: 100;
  readonly maxAttempts: 8;
  readonly backlogWarningMs: 60000;
  readonly backlogCriticalMs: 300000;
  readonly terminalState: "dead_letter";
}

export const AUTHORITATIVE_OUTBOX_FAMILIES = Object.freeze([
  { id: "central", table: "outbox_deliveries", classification: "central-transport",
    consumer: "central-dispatcher", requiresV27: true, batchSize: 100, maxAttempts: 8,
    backlogWarningMs: 60000, backlogCriticalMs: 300000, terminalState: "dead_letter" },
  { id: "deployment-profile", table: "deployment_profile_outbox",
    classification: "dedicated-authoritative-stream", consumer: "deployment-profile-dispatcher",
    requiresV27: true, batchSize: 100, maxAttempts: 8,
    backlogWarningMs: 60000, backlogCriticalMs: 300000, terminalState: "dead_letter" },
  { id: "project-shadow", table: "project_event_outbox",
    classification: "terminal-mirror-reserved", consumer: "central-mirror", requiresV27: true,
    batchSize: 100, maxAttempts: 8, backlogWarningMs: 60000, backlogCriticalMs: 300000,
    terminalState: "dead_letter" },
  { id: "room-cache-invalidation", table: "room_cache_invalidation_intents",
    classification: "security-post-commit-intent", consumer: "cache-invalidation-dispatcher",
    requiresV27: false, batchSize: 100, maxAttempts: 8,
    backlogWarningMs: 60000, backlogCriticalMs: 300000, terminalState: "dead_letter" },
] as const satisfies readonly AuthoritativeOutboxFamilyDescriptor[]);
