# T-0041 Real Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production Agent runtime that streams a real external model, persists a recoverable execution lifecycle, enforces room/tool grants and one-shot confirmations, supports interruption/retry/compensation, and renders Agent work without human typing semantics.

**Architecture:** A bounded in-process `AgentRuntime` orchestrates external Provider and Tool adapters while the existing single `AuthorityWorker` remains the only SQLite writer. Every observable state transition is a closed v6 authority fact/event/outbox write; in-memory state contains only queue handles, abort controllers, and bounded partial previews. Production composition always constructs the OpenAI Responses adapter plus three closed tool adapters; deterministic fakes are available only through deep test constructors.

**Tech Stack:** TypeScript 5.9, Node 22 `fetch`/Web Streams/`child_process`, SQLite `DatabaseSync` in the existing Worker, Vitest, WebSocket v2 sync, Electron renderer DOM.

---

## Frozen requirements and evidence map

| Blueprint criterion | Implementation tasks | Proof |
|---|---|---|
| 1. Real ProviderAdapter + secret-safe live smoke | 4, 7, 8 | fake provider tests, production-root boundary test, opt-in OpenAI smoke |
| 2. Two physically different tools + denial matrix | 6, 8 | HTTPS adapter + fixed Git binary + sandbox writer; zero-call matrix |
| 3. Durable lifecycle/action category/restart/UI | 1, 2, 3, 5, 7 | v6 facts, worker restart, sync reconstruction, renderer assertions |
| 4. Interrupt/Abort/no partial message/idempotence | 5, 7, 8 | paused stream/tool tests and real worker restart |
| 5. Secret provider + sentinel zero leak | 4, 7, 8 | DB/WAL/cache/frame/log/error/diagnostic byte scan |
| 6. Attempts/retry/dead-letter/recovery | 2, 3, 5, 8 | injected clock 1s/4s, attempt3 dead-letter, stale CAS, crash recovery |
| 7. Side-effect confirmation/once/compensation | 2, 3, 6, 7, 8 | atomic dispatch tests, denial matrix, compensation chain |

## Planned file boundaries

### Core closed facts

- Modify `packages/core/src/collaboration.ts`: canonical Agent execution/attempt/action types and exact guards.
- Modify `packages/core/src/collaboration.test.ts`: runtime guard matrix.
- Modify `packages/core/src/collaboration.type-test.ts`: human request and Agent execution non-assignability.
- Modify `packages/core/src/sync.ts` and `packages/core/src/sync.test.ts`: v6 execution room event validation.
- Modify `packages/core/src/index.ts`: safe public type/guard exports only.
- Modify `packages/server/src/primitives.ts` and `primitives.test.ts`: mechanically adapt the verified T-0013 in-memory compatibility primitive to the new `cancelled/tool_call` fact without restoring legacy aliases.
- Modify `packages/server/src/persistence/snapshot-worker.ts` and `snapshot-worker-client.test.ts`: conservatively project the pre-v6 execution row into the new closed repair fact until Task 2 installs v6 physical columns.

### Server runtime deep module

- Create `packages/server/src/agent-runtime/contracts.ts`: runtime/provider/tool closed interfaces and guards; no I/O.
- Create `packages/server/src/agent-runtime/provider-openai.ts`: production Responses SSE adapter and environment secret provider.
- Create `packages/server/src/agent-runtime/provider-openai.test.ts`: fake fetch/SSE/error/abort/sentinel tests.
- Create `packages/server/src/agent-runtime/tool-adapters.ts`: HTTPS JSON, fixed Git binary, sandbox write/compensation adapters.
- Create `packages/server/src/agent-runtime/tool-adapters.test.ts`: physical target and sandbox security tests.
- Create `packages/server/src/agent-runtime/agent-runtime.ts`: bounded queue, attempts, streaming loop, interruption and recovery.
- Create `packages/server/src/agent-runtime/agent-runtime.test.ts`: deterministic fake runtime tests.
- Create `packages/server/src/agent-runtime/live-smoke.test.ts`: explicitly enabled secret-safe live checks.

### Authority persistence

- Modify `packages/server/src/persistence/schema.ts` and `schema.test.ts`: immutable v6 migration/fingerprint/invariants.
- Modify `packages/server/src/persistence/contracts.ts` and its runtime/type tests: deep runtime authority port and opaque runtime context.
- Modify `packages/server/src/persistence/worker-protocol.ts`: closed deep runtime RPC requests/responses/errors.
- Modify `packages/server/src/persistence/worker-database-client.ts` and tests: request correlation and root-surface denial.
- Modify `packages/server/src/persistence/authority-database-handler.ts`: v6 transactions and authorization.
- Modify `packages/server/src/persistence/authority-worker.ts`: route runtime requests while retaining sole `DatabaseSync` ownership.
- Modify `packages/server/src/persistence/sqlite-authoritative-store.ts` and tests: typed runtime authority facade.

### Transport/composition/client

- Modify `packages/server/src/protocol.ts` and tests: closed invoke/interrupt/retry/confirmation/compensation and ephemeral preview frames.
- Modify `packages/server/src/websocket.ts` and tests: session-bound runtime calls, bounded preview send, stable errors.
- Modify `packages/server/src/authoritative-server.ts` and `authority.e2e.test.ts`: production composition, shutdown, restart and sentinel proof.
- Modify `packages/server/src/index.ts`: export only safe `AgentRuntime` configuration/API; hide fake/raw authority/secret seams.
- Modify `packages/desktop/src/renderer/app.ts` and tests: queued/running/waiting/terminal execution card and action-category labels without typing animation.
- Modify `docs/protocols/authoritative-sync.md`: v6 runtime frames/facts and recovery contract.
- Create `docs/deliveries/T-0041-真实-Agent-运行时-模型供应商与工具权限-交付说明.md`: four required delivery sections.

---

### Task 1: Expand the core Agent execution fact without merging human semantics

**Files:**
- Modify: `packages/core/src/collaboration.ts`
- Modify: `packages/core/src/collaboration.test.ts`
- Modify: `packages/core/src/collaboration.type-test.ts`
- Modify: `packages/core/src/sync.ts`
- Modify: `packages/core/src/sync.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/primitives.ts`
- Modify: `packages/server/src/primitives.test.ts`
- Modify: `packages/server/src/persistence/snapshot-worker.ts`
- Modify: `packages/server/src/persistence/snapshot-worker-client.test.ts`
- Modify: `packages/server/src/persistence/contracts.test.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/contracts.type-test.ts`
- Modify: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.test.ts`
- Modify: `packages/desktop/src/renderer/app.ts`
- Modify: `packages/desktop/src/renderer/app.test.ts`

The server and desktop files above are compatibility consumers of the public core fact. They are migrated mechanically in this task so a clean checkout remains type- and runtime-green; Task 3 and Task 7 still own the new authority port and final runtime UI behavior.

- [x] **Step 1: Write the failing exact-guard and type tests**

Add tests that accept this complete fact and reject every unknown key, illegal optional relation, `interrupted`, `retryOrdinal=4`, tool phase on model generation, terminal fact without `finishedAt`, and a human request assigned to an execution variable:

```ts
const queued: AgentExecution = {
  id: "execution-1",
  roomId: "room-1",
  sourceMessageId: "message-1",
  requesterId: "human-1",
  agentId: "agent-1",
  status: "queued",
  actionCategory: "model_generation",
  currentAttemptSeq: 1,
  retryCycle: 1,
  retryOrdinal: 1,
  providerId: "openai-responses",
  modelId: "configured-model",
  recoveryCursor: 0,
  queuedAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};
expect(isAgentExecution(queued)).toBe(true);
expect(isAgentExecution({ ...queued, status: "interrupted" })).toBe(false);
expect(isAgentExecution({ ...queued, retryOrdinal: 4 })).toBe(false);
```

- [x] **Step 2: Run RED**

Run:

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/core/src/collaboration.test.ts packages/core/src/sync.test.ts
```

Expected: typecheck fails because queued/cancelled/action/attempt fields do not exist; runtime test rejects the new fact.

- [x] **Step 3: Implement the closed core model**

Use these discriminants and relations:

```ts
export type AgentExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentExecutionActionCategory = "model_generation" | "tool_call" | "waiting_upstream";
export type AgentToolDispatchPhase = "not_started" | "dispatched" | "finished";

export interface AgentExecution {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly requesterId: string;
  readonly agentId: string;
  readonly status: AgentExecutionStatus;
  readonly actionCategory: AgentExecutionActionCategory;
  readonly toolDispatchPhase?: AgentToolDispatchPhase;
  readonly currentToolId?: string;
  readonly currentAttemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly providerId: string;
  readonly modelId: string;
  readonly recoveryCursor: number;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly cancellationReason?: string;
  readonly terminalErrorCode?: string;
  readonly deadLetteredAt?: string;
  readonly resultMessageId?: string;
  readonly manualRetryOfExecutionId?: string;
  readonly compensatesExecutionId?: string;
  readonly supersedesExecutionIds?: readonly string[];
}
```

The guard must be exact-key, require positive safe `currentAttemptSeq/retryCycle`, `retryOrdinal` 1–3, non-negative safe cursor, tool phase/tool ID only for `tool_call`, and terminal timestamps/reasons consistent with status. `resultMessageId`, when present, is allowed only on completed; legacy completed facts without a message ID remain representable until the real runtime replaces the compatibility primitive. Update sync event guard to require payload room/agent equality.

Mechanically update the two existing consumers rather than restoring aliases:

- T-0013 in-memory primitive: `interrupted→cancelled`, `toolName→currentToolId`, action `tool_call`, phase `dispatched/finished`, attempt fields all 1, provider/model `legacy-direct-tool/no-model`, cancellation/error closed reason.
- pre-v6 snapshot row: map `running/completed/interrupted/failed` to `running/completed/cancelled/failed`, set action `tool_call`, use tool name as `currentToolId`, attempt fields 1, provider/model `legacy-v5/no-model`, timestamps from start/completion. Do not expose old `result_json` as a normal execution body.

- [x] **Step 4: Run GREEN**

Run the Step 2 command. Expected: all core/type tests pass.

- [ ] **Step 5: Proposed checkpoint commit (owner authorization required before execution)**

```bash
git add packages/core/src/collaboration.ts packages/core/src/collaboration.test.ts packages/core/src/collaboration.type-test.ts packages/core/src/sync.ts packages/core/src/sync.test.ts packages/core/src/index.ts packages/server/src/primitives.ts packages/server/src/primitives.test.ts packages/server/src/persistence/snapshot-worker.ts packages/server/src/persistence/snapshot-worker-client.test.ts
git commit -m "feat(core): close Agent execution lifecycle [T-0041]"
```

### Task 2: Add immutable authority schema v6 and corruption validation

**Files:**
- Modify: `packages/server/src/persistence/schema.ts`
- Modify: `packages/server/src/persistence/schema.test.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/persistence/legacy-importer.test.ts`
- Modify: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/snapshot-worker.ts`
- Modify: `packages/server/src/persistence/snapshot-worker-client.test.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.test.ts`
- Modify: `packages/server/src/fixtures/authority-child.ts`
- Modify: `packages/server/src/authority.e2e.test.ts`
- Modify: `packages/server/src/sync-service.test.ts`

The worker and consumer files are a mechanical schema-version compatibility update: the closed ready/inspect response, legacy transition adapter, snapshot reader, and existing fixtures move from the v5 layout to v6 without changing Task 3's runtime authority behavior.

- [x] **Step 1: Write migration RED tests**

Tests must cover fresh v1→v6, every historical v1/v2/v3/v4/v5→v6, stable v1–v5 checksum/fingerprint constants, fault rollback at every v6 statement, legitimate legacy completed/failed/interrupted/running rows, and startup refusal for corrupt status/attempt/dispatch/foreign-key relations.

The legacy running expectation is:

```ts
expect(readExecution(db, "legacy-running")).toMatchObject({
  status: "failed",
  currentAttemptSeq: 1,
  retryCycle: 1,
  retryOrdinal: 1,
  actionCategory: "tool_call",
  toolDispatchPhase: "finished",
  terminalErrorCode: "side_effect_outcome_unknown",
});
```

- [x] **Step 2: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/persistence/schema.test.ts
```

Expected: schema version is 5 and v6 tables/columns are absent.

- [x] **Step 3: Implement v6**

Set `AUTHORITY_SCHEMA_VERSION = 6` and append only v6 statements. Rebuild `agent_executions` with the Task 1 fields while preserving old IDs, room/agent/source/requester/tool/result/timestamps. Add strict tables:

```sql
CREATE TABLE agent_execution_attempts (
  execution_id TEXT NOT NULL REFERENCES agent_executions(id),
  attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
  retry_cycle INTEGER NOT NULL CHECK (retry_cycle >= 1),
  retry_ordinal INTEGER NOT NULL CHECK (retry_ordinal BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  action_category TEXT NOT NULL CHECK (action_category IN ('model_generation','tool_call','waiting_upstream')),
  tool_dispatch_phase TEXT CHECK (tool_dispatch_phase IN ('not_started','dispatched','finished')),
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  next_retry_at INTEGER,
  recovery_cursor INTEGER NOT NULL CHECK (recovery_cursor >= 0),
  PRIMARY KEY (execution_id, attempt_seq)
) STRICT;
```

Also add `agent_invocation_intents`, `agent_execution_steps`, `agent_tool_grants`, `agent_tool_confirmations`, `agent_tool_dispatches`, and `agent_fence_replacements` with the unique keys frozen in the design. Add indexes for room queue/recovery, grant/confirmation expiry, dispatch state, and fence replay. Compute and pin only the v6 checksum/fingerprint; never rewrite v1–v5 constants.

- [x] **Step 4: Run GREEN and physical probes**

Run Step 2 plus a real temporary SQLite probe that drops one v6 index and verifies startup refuses it. Expected: all schema tests pass and version remains 5 after injected migration failure.

- [ ] **Step 5: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src/persistence/schema.ts packages/server/src/persistence/schema.test.ts
git commit -m "feat(persistence): add immutable Agent runtime schema v6 [T-0041]"
```

### Task 3: Build the deep runtime authority port and atomic transactions

**Files:**
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/contracts.test.ts`
- Modify: `packages/server/src/persistence/contracts.type-test.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write closed-port RED tests**

Define tests for invoke idempotency, claim FIFO, checkpoint CAS, automatic retry transaction, attempt3 dead-letter, interrupt replay, manual retry, recovery scan, grant denial matrix, confirmation+dispatch atomicity, late dispatch settlement after cancellation, and root API non-export. Protocol tests must reject extra/missing/wrong correlated fields before any worker post.

- [ ] **Step 2: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/persistence/contracts.test.ts packages/server/src/persistence/worker-database-client.test.ts packages/server/src/persistence/sqlite-authoritative-store.test.ts -t "Agent runtime authority"
```

Expected: new authority methods and request kinds are absent.

- [ ] **Step 3: Add the deep port**

Add an opaque WeakSet-backed `InternalAgentRuntimeContext` and a plain worker projection. The package root must not export either mint function or raw authority store. Define:

```ts
interface AgentRuntimeAuthorityStore {
  invoke(context: AuthenticatedCommandContext | InternalAgentCommandContext, input: AgentInvocationInput): Promise<AgentExecution>;
  claimNext(runtime: InternalAgentRuntimeContext, roomId: string, now: number): Promise<AgentExecution | undefined>;
  commitStep(runtime: InternalAgentRuntimeContext, input: CommitExecutionStepInput): Promise<AgentExecution>;
  scheduleRetry(runtime: InternalAgentRuntimeContext, input: ScheduleRetryInput): Promise<AgentExecution>;
  interrupt(context: AuthenticatedCommandContext, input: InterruptExecutionInput): Promise<AgentExecution>;
  manualRetry(context: AuthenticatedCommandContext, executionId: string): Promise<AgentExecution>;
  prepareTool(runtime: InternalAgentRuntimeContext, input: PrepareToolInput): Promise<ToolGrant>;
  confirmTool(context: AuthenticatedCommandContext, input: ToolConfirmationInput): Promise<ToolConfirmation>;
  dispatchTool(runtime: InternalAgentRuntimeContext, input: DispatchToolInput): Promise<ToolDispatch>;
  settleTool(runtime: InternalAgentRuntimeContext, input: SettleToolInput): Promise<ToolDispatch>;
  recover(runtime: InternalAgentRuntimeContext, now: number): Promise<readonly AgentExecution[]>;
  readExecution(context: AuthenticatedSessionContext, executionId: string): Promise<AgentExecution>;
}
```

- [ ] **Step 4: Implement worker requests and transactions**

Add exact request/response variants and client correlation for each method. In `authority-database-handler.ts`, reuse `runAuthorityImmediateTransaction`, `appendRoomEvent`, room outbox, canonical JSON and stable ID helpers. Required transaction boundaries:

- invoke: authority check + intent unique key + execution/attempt/event/outbox.
- retry: old attempt terminal + new queued attempt + execution pointer + event/outbox.
- dispatch: actor/membership/permission/attempt/hash/expiry + consume grant/confirmation + phase CAS + unique dispatch row.
- settle: append-only dispatch CAS; cancelled execution remains cancelled.
- interrupt: current authority recheck before idempotency replay, execution CAS + event/outbox.

Map business errors to closed 400/401/403/404/409/410/429/503 codes; unknown worker error is terminal sanitized 503. Keep AuthorityWorker the only `DatabaseSync` owner.

- [ ] **Step 5: Run GREEN plus restart/matrix**

Run Step 2 without the filter plus focused real-worker restart tests. Expected: all calls have sequential replay, concurrent replay, changed payload conflict and restart-stable ACK; table count snapshots prove zero-write denials.

- [ ] **Step 6: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src/persistence packages/server/src/index.ts
git commit -m "feat(server): add atomic Agent runtime authority port [T-0041]"
```

### Task 4: Implement the production OpenAI Responses Provider and secret boundary

**Files:**
- Create: `packages/server/src/agent-runtime/contracts.ts`
- Create: `packages/server/src/agent-runtime/provider-openai.ts`
- Create: `packages/server/src/agent-runtime/provider-openai.test.ts`
- Create: `packages/server/src/agent-runtime/live-smoke.test.ts`

- [x] **Step 1: Write Provider RED tests**

Use a fake `fetch` returning chunk-split SSE. Test exactly one `response_started`, monotonic deltas/tool calls, usage, exactly one completed, malformed JSON/event order/duplicate completion/HTTP errors, byte limits and AbortSignal. Scan captured request/error/log values for a high-entropy sentinel secret.

- [x] **Step 2: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/agent-runtime/provider-openai.test.ts
```

Expected: module cannot be resolved.

- [x] **Step 3: Implement closed contracts and adapter**

Define non-assignable `AgentRuntimeProviderInput` and closed events:

```ts
type ProviderEvent =
  | { readonly type: "response_started" }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "tool_call_delta"; readonly callId: string; readonly toolId: string; readonly argumentsDelta: string }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "completed"; readonly finishReason: "stop" | "tool_calls" };
```

`createOpenAiResponsesProvider` uses configured HTTPS endpoint/model, `stream:true`, `store:false`, Authorization built only inside the adapter, a bounded incremental SSE parser and sanitized closed errors. `createEnvironmentSecretProvider` reads the configured environment key on demand and returns no serializable object containing it.

- [x] **Step 4: Add opt-in live smoke**

Skip unless `NATIVE_IM_OPENAI_LIVE_SMOKE=1` and `OPENAI_API_KEY` exist. Assert one started, at least one delta, one completed, non-fixture output hash/length, and sentinel zero leak; never print/store response text.

- [x] **Step 5: Run GREEN**

Run Step 2. Expected: fake suite passes; live smoke is skipped by default with a named reason.

- [ ] **Step 6: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src/agent-runtime/contracts.ts packages/server/src/agent-runtime/provider-openai.ts packages/server/src/agent-runtime/provider-openai.test.ts packages/server/src/agent-runtime/live-smoke.test.ts
git commit -m "feat(server): add production Responses provider [T-0041]"
```

### Task 5: Implement bounded runtime scheduling, streaming, retry and interruption

**Files:**
- Create: `packages/server/src/agent-runtime/agent-runtime.ts`
- Create: `packages/server/src/agent-runtime/agent-runtime.test.ts`
- Modify: `packages/server/src/agent-runtime/contracts.ts`

- [x] **Step 1: Write deterministic scheduler RED tests**

Cover room FIFO, eight cross-room active, room queue 32/429, partial preview byte/backpressure limit, ordered provider/tool steps, checkpoint-before-next-step, transient 1s/4s and attempt3 dead-letter, stale completion CAS, queued/running/waiting recovery, interrupt before/during provider/read tool/side-effect dispatch, duplicate interrupt, close all-settled and readiness projection.

- [x] **Step 2: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/agent-runtime/agent-runtime.test.ts
```

Expected: runtime module cannot be resolved.

- [x] **Step 3: Implement the queue and attempt loop**

Use a room-keyed FIFO plus a global semaphore. `invoke` persists before enqueue. Each active attempt owns one AbortController and bounded preview sequence. The loop is:

```ts
claim queued -> provider stream -> parse closed plan
  -> no tool: authority complete with Agent message
  -> tool: authority prepare/dispatch -> adapter -> authority settle/checkpoint -> provider continuation
```

Only `rate_limited`, `upstream_timeout`, `upstream_unavailable`, and `target_busy` schedule retry. Backoff comes from injected clock/timer, never `sleep` in tests. Provider/read-only late outputs are discarded after CAS failure; dispatched side effects may only settle their dispatch fact.

- [x] **Step 4: Implement recovery and close**

At startup call `recover`: requeue due queued, terminalize/retry incomplete provider/read-only attempts within budget, mark dispatched side effect outcome unknown, preserve unexpired confirmation wait. `close` stops claims, aborts active adapters, waits bounded all-settled and leaves authority close to composition root.

- [x] **Step 5: Run GREEN**

Run Step 2. Expected: all deterministic scheduler tests pass with no real timers or network.

- [ ] **Step 6: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src/agent-runtime/agent-runtime.ts packages/server/src/agent-runtime/agent-runtime.test.ts packages/server/src/agent-runtime/contracts.ts
git commit -m "feat(server): add bounded recoverable Agent runtime [T-0041]"
```

### Task 6: Implement physical tool adapters, grants, confirmation and compensation

**Files:**
- Create: `packages/server/src/agent-runtime/tool-adapters.ts`
- Create: `packages/server/src/agent-runtime/tool-adapters.test.ts`
- Modify: `packages/server/src/agent-runtime/agent-runtime.ts`
- Modify: `packages/server/src/agent-runtime/agent-runtime.test.ts`

- [x] **Step 1: Write physical adapter RED tests**

Test HTTPS origin/path allowlist, redirect/private-IP/content-type/decompressed-size refusal and abortable DNS/body reads; fixed Git plumbing (`ls-files --stage` + `ls-tree`) with no shell/filter/hook execution and streaming blob hashing; sandbox root-direct path normalization, a persistent `O_NOFOLLOW` lock inode held by macOS `lockf` for the full irreversible effect (process crash releases the kernel lock without stale-record reclamation), bounded descriptor reads, expected SHA-256, crash-recoverable atomic version capture plus no-clobber hard-link publication so non-cooperating writes are preserved, and ordered directory-fsynced capture/write journals that retain a bounded old/new fallback when the first target-name sync is unconfirmed. An uncommitted write-only journal must block for reconciliation rather than silently publish on restart. Also test sealed compensation, post-effect durability-unknown and post-write hash conflict.

- [x] **Step 2: Write grant/confirmation denial matrix RED**

For actor, membership, permission, execution, attempt, tool, parameter hash, expiry, principal, session family, room, replay and cancellation mismatch, assert the adapter invocation spy is exactly zero. Test confirmation+dispatch crash yields one `outcome_unknown` dispatch and never replays. Test cancellation after rename keeps execution cancelled and creates a compensatable dispatch outcome.

- [x] **Step 3: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/agent-runtime/tool-adapters.test.ts packages/server/src/agent-runtime/agent-runtime.test.ts -t "tool|confirmation|compensation"
```

Expected: adapters are absent.

- [x] **Step 4: Implement adapters**

Expose only descriptors and `execute(parameters, signal)`. Return closed bounded `ToolOutcome` with summary/modelInput and optional sealed compensation; raw HTTP/stdout/stderr never cross the adapter seam. Git status is reconstructed from fixed plumbing instead of porcelain so repository-defined filters cannot execute. The first sandbox version accepts only root-direct files because Node does not expose a portable `openat`/`renameat` chain that can safely retain nested parents across a symlink-swap race. Sandbox compensation runs as a new execution and restores/deletes only when expected post-write hash still matches; a post-effect fsync/response gap is persisted as `outcome_unknown`, never falsely as failed.

- [x] **Step 5: Run GREEN and opt-in target smoke**

Run Step 3. Add opt-in HTTP controlled endpoint and temporary Git repository smoke; record only status/schema/hash/line count, never response body or environment.

- [ ] **Step 6: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src/agent-runtime
git commit -m "feat(server): enforce physical Agent tool grants [T-0041]"
```

### Task 7: Wire production composition, closed WebSocket frames and renderer

**Files:**
- Modify: `packages/server/src/authoritative-server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/src/protocol.test.ts`
- Modify: `packages/server/src/websocket.ts`
- Modify: `packages/server/src/websocket.test.ts`
- Modify: `packages/desktop/src/renderer/app.ts`
- Modify: `packages/desktop/src/renderer/app.test.ts`
- Modify: `packages/server/src/authority.e2e.test.ts`

- [x] **Step 1: Write protocol/composition RED tests**

Add exact client frames `agent.invoke`, `agent.interrupt`, `agent.retry`, `agent.tool.confirm`, `agent.compensate`; result frames use stable requestId correlation and closed errors. Add ephemeral `agent.execution.preview` with executionId/attemptSeq/streamSeq/text and byte limit. Assert package root has production config/start API but no fake Provider, raw secret, runtime authority mint or test constructor.

- [x] **Step 2: Run RED**

```bash
npx --yes pnpm@10.14.0 typecheck && npx --yes pnpm@10.14.0 exec vitest run packages/server/src/protocol.test.ts packages/server/src/websocket.test.ts packages/server/src/authority.e2e.test.ts packages/desktop/src/renderer/app.test.ts -t "Agent runtime|execution preview|action category"
```

Expected: new frames/config/runtime are absent.

- [x] **Step 3: Wire production root and transport**

Extend `StartAuthoritativeServerOptions` with closed Agent runtime config: provider endpoint/model/secret environment key, tool descriptors/roots, queue limits. Production always constructs the real Provider and three real Tool adapters; missing secret starts with Agent readiness `noauth` and invoke fails closed. Deep test options may inject deterministic adapters but root type/runtime must omit them. Shutdown order is transport → runtime → snapshots → authority, all-settled.

WebSocket handlers derive human context from the authenticated session; Agent capability is never accepted from JSON. Preview send failure/backpressure removes only the preview subscriber and never changes execution state.

- [x] **Step 4: Render distinct execution semantics**

Render exact labels `排队中 / 正在生成 / 正在调用 <tool> / 等待上游 / 已完成 / 已失败 / 已取消`; expose attempt and closed reason. Do not create `.typing`, typing dots or human read/request actions. Interrupt/retry/confirmation buttons derive from authoritative status and send closed commands; hidden buttons are not authority.

- [x] **Step 5: Run GREEN**

Run Step 2 without the filter. Expected: all protocol/WebSocket/renderer tests pass; existing legacy/v2 sync tests remain green.

- [ ] **Step 6: Proposed checkpoint commit (authorization required)**

```bash
git add packages/server/src packages/desktop/src/renderer
git commit -m "feat(runtime): expose real Agent execution lifecycle [T-0041]"
```

### Task 8: Prove real restart, zero secret leakage and delivery

**Files:**
- Modify: `packages/server/src/authority.e2e.test.ts`
- Modify: `packages/server/src/fixtures/authority-child.ts`
- Modify: `packages/server/src/agent-runtime/live-smoke.test.ts`
- Modify: `docs/protocols/authoritative-sync.md`
- Create: `docs/deliveries/T-0041-真实-Agent-运行时-模型供应商与工具权限-交付说明.md`
- Modify: `docs/plans/2026-08-13-t0041-agent-runtime-implementation.md`

- [ ] **Step 1: Add real-process RED scenarios**

Use the compiled child, real Worker/SQLite and real WebSocket clients. Cover queued/running/waiting restart, provider partial crash, interrupt-commit crash, retry/dead-letter restart, read-only tool success, side-effect dispatch crash/outcome unknown, confirmation replay and compensation. A restarted replica must reconstruct the same execution and readiness facts.

- [ ] **Step 2: Add sentinel scan**

Seed a high-entropy fake API key and assert it is absent from authority DB/WAL/SHM, snapshot cache, messages/events/outbox/idempotency, WebSocket frames, structured errors, captured stdout/stderr and diagnostic export. Assert production root has no fixed response/mock branch.

- [ ] **Step 3: Run focused GREEN**

```bash
npx --yes pnpm@10.14.0 typecheck
npx --yes pnpm@10.14.0 exec vitest run \
  packages/server/src/agent-runtime/agent-runtime.test.ts \
  packages/server/src/agent-runtime/provider-openai.test.ts \
  packages/server/src/agent-runtime/tool-adapters.test.ts \
  packages/server/src/persistence/schema.test.ts \
  packages/server/src/persistence/worker-database-client.test.ts \
  packages/server/src/persistence/sqlite-authoritative-store.test.ts \
  packages/server/src/protocol.test.ts \
  packages/server/src/websocket.test.ts \
  packages/server/src/authority.e2e.test.ts \
  packages/desktop/src/renderer/app.test.ts
```

Expected: all T-0041 and inherited T-0040/T-0013 scenarios pass; live smoke remains explicit opt-in.

- [ ] **Step 4: Run mandatory full gates**

```bash
npx --yes pnpm@10.14.0 install --frozen-lockfile
npx --yes pnpm@10.14.0 typecheck
npx --yes pnpm@10.14.0 lint
npx --yes pnpm@10.14.0 test
npx --yes pnpm@10.14.0 build
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links
git diff --check
```

Expected: zero errors; any Node SQLite experimental warning is documented as platform output and not suppressed globally. Blueprint check must show zero violations/dead links.

- [ ] **Step 5: Write the four-part delivery note**

Include: one-sentence result; each of the seven criteria with direct evidence; Buzz EventQueue/PoolLifecycle/PromptContext translation and deviations; newly claimable downstream tasks. List opt-in live smoke as passed only if actually run with a real secret; otherwise criterion 1/2 remains unmet and T-0041 cannot be delivered.

- [ ] **Step 6: Deliver only after every criterion is proven**

First verify the artifact exists:

```bash
ls docs/deliveries/T-0041-真实-Agent-运行时-模型供应商与工具权限-交付说明.md
```

Then, and only then:

```bash
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py set \
  /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html \
  T-0041 --state delivered --awaiting @lionel \
  --artifact "T-0041 交付说明|../../../agent-im/docs/deliveries/T-0041-真实-Agent-运行时-模型供应商与工具权限-交付说明.md" \
  --by @claude --note "真实 Agent 运行时、Provider 与工具权限已交付；解锁 T-0016、T-0017 及其下游。"
```

Never set `verified`. Stop after reporting the delivery.

---

## Plan self-review

- Spec coverage: all seven Blueprint criteria map to executable tasks and direct evidence.
- Primitive coverage: data/interface/rendering are explicit for #3, #4, #6/#13; human request and Agent execution remain non-assignable.
- Authority boundary: no second database or public raw worker/secret seam; all facts/events/outbox writes stay in AuthorityWorker.
- Failure coverage: explicit crash points, stale CAS, outcome unknown, retry budget, denial zero-call, sentinel scan and all-settled shutdown.
- Downstream compatibility: T-0016 gets a distinct Router input; T-0020 gets cancellation-only fence followed by terminal RouteJob-selected replacement.
- Placeholder scan: no `TBD`, `TODO`, “similar to”, or undefined implementation step remains.
- Git boundary: proposed commits are documentation only until the owner separately authorizes Git writes.
