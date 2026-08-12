# T-0040 Authoritative Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace T-0039's three file stores with one server-authoritative SQLite system that durably persists collaboration facts, provides idempotent writes and outbox delivery, and restores three clients without gaps or permission leaks.

**Architecture:** A single `AuthorityWorker` owns the read-write `node:sqlite` connection and exposes asynchronous `CommandStore` / `SyncQueryStore` operations through `WorkerDatabaseClient`. A separate `SnapshotWorker` creates bounded materialized snapshots and falls back to AuthorityWorker-owned room/catalog barriers for unbounded O(page) streaming repair. WebSocket v2 and `ClientSyncReplica` consume closed cursor/snapshot contracts while the T-0039 legacy history/subscribe frames remain compatible.

**Tech Stack:** TypeScript 5.9, Node.js 22.13+ built-in `node:sqlite` and `worker_threads`, `ws`, Electron, Vitest, JSDOM, pnpm workspace, GitHub Actions.

---

## Work note: acceptance criteria copied before implementation

The implementer must not edit or weaken these six Blueprint criteria:

1. 身份、群、成员、消息、已读、已判定、待答项、agent 执行和校准信号写入持久存储；服务进程重启后逐类读回一致
2. 写入使用稳定事件 ID 或幂等键；客户端重试同一写入不会产生重复消息或重复承诺，有自动化测试覆盖
3. 客户端以服务端游标断线重连；游标仍在保留范围内时增量恢复不漏不重，游标过期时服务端返回明确状态并触发全量历史修复，修复完成后的水位与服务端一致；至少三客户端并发测试通过
4. ACK 只表示 durable acceptance。自动化故障注入在持久提交后、实时分发前终止服务；恢复后，未收到事件的客户端通过游标或可重放记录补齐且只出现一次。实现使用事务 outbox 或等价机制，不依赖进程内 best-effort 任务
5. 持久化结构有版本化迁移；从上一版 schema 升级到当前版后历史可读，失败时不会留下部分迁移状态
6. 历史查询与实时订阅遵守群权限；客户端本地缓存不是权威源，清空缓存后可从服务端完整恢复

## Execution invariants

- Work only on Blueprint task T-0040. Do not claim or implement another Blueprint task.
- Before every implementation task, use `superpowers:test-driven-development`; capture an expected RED before production edits.
- Before every commit, use `superpowers:commit-rebase-pr`, show the Chinese preview, and wait for the user's commit authorization. Stage only the task's listed files.
- After each task, dispatch a fresh spec reviewer and then a fresh quality reviewer through `superpowers:subagent-driven-development`; fix Important/Critical findings before moving on.
- Never edit Blueprint JSON directly. Only `gbp.py` may change task state, and final delivery stops at `delivered` awaiting `@lionel`.
- T-0012, T-0013, and T-0014 remain an external delivery gate. Tasks 1-3 can proceed without them; before Task 4, verify all three are `verified` and merged into `origin/main`. If they are not, stop T-0040 at `blocked` naming `@lionel`; do not copy their types into this branch.

## File structure

### Server persistence foundation

- Create `packages/server/src/persistence/schema.ts` — schema versions, safe pragmas, migration transaction, schema inspection.
- Create `packages/server/src/persistence/schema.test.ts` — fresh database, v1→v2, rollback, Node lower-bound behavior.
- Create `packages/server/src/persistence/worker-protocol.ts` — closed request/result/error unions shared by main thread and workers.
- Create `packages/server/src/persistence/authority-worker.ts` — worker entrypoint and operation dispatcher; the only read-write `DatabaseSync` owner.
- Create `packages/server/src/persistence/worker-database-client.ts` — asynchronous request correlation, crash propagation, graceful close.
- Create `packages/server/src/persistence/worker-database-client.test.ts` — real-worker concurrency, crash, restart, and main-loop responsiveness.
- Create `packages/server/src/persistence/legacy-importer.ts` — validated JSON/JSONL import into a temporary authority DB and atomic activation.
- Create `packages/server/src/persistence/legacy-importer.test.ts` — success, corrupt input, duplicate startup, activation crash.

### Domain authority and reliable delivery

- Create `packages/core/src/collaboration.ts` and tests — verified primitive record declarations moved without shape changes and re-exported compatibly by server.
- Create `packages/core/src/sync.ts` and tests — pure closed event/cursor/snapshot/wire value types shared by server and desktop without I/O.
- Create `packages/server/src/persistence/contracts.ts` — authenticated/internal contexts, closed commands/events, cursor, outbox, snapshot records and guards.
- Create `packages/server/src/persistence/contracts.test.ts` — closed-schema, cross-primitive, human/agent authority rejection.
- Create `packages/server/src/persistence/sqlite-authoritative-store.ts` — business-side asynchronous authority facade; all calls route through the single AuthorityWorker, which owns command transactions, idempotency, facts, events, outbox, and permission-aware queries. Before Task 6 grows the command surface, extract worker-only SQL handlers from the worker entrypoint without introducing another connection owner.
- Create `packages/server/src/persistence/sqlite-authoritative-store.test.ts` — all durable facts, concurrency, restart, authorization, idempotency.
- Create `packages/server/src/invitation-secret-protector.ts` and test — AES-GCM protection for replayable invitation responses without plaintext at rest.
- Create `packages/server/src/subscription-registry.ts` — target-kind indexed subscriptions and revocation.
- Create `packages/server/src/subscription-registry.test.ts` — room/principal/session-family authorization and cleanup.
- Create `packages/server/src/outbox-dispatcher.ts` — pending delivery replay and durable dispatch marking.
- Create `packages/server/src/outbox-dispatcher.test.ts` — duplicate send tolerance, retry, restart, terminal family notification.

### Cursor, snapshot, transport, and client replica

- Create `packages/server/src/sync-service.ts` and `sync-service.test.ts` — room delta, retained cursors, catalog and repair orchestration.
- Create `packages/server/src/persistence/snapshot-worker.ts` — read-only WAL snapshot materialization into derived cache.
- Create `packages/server/src/persistence/snapshot-worker-client.ts` and test — snapshot worker lifecycle and page API.
- Create `packages/server/src/fallback-repair-coordinator.ts` and test — scoped barriers, refresh bypass, preemption, tombstones.
- Modify `packages/server/src/{auth,room-lifecycle,service,protocol,websocket,index}.ts` and their tests — authoritative adapters, v2 closed frames, legacy compatibility.
- Create `packages/desktop/src/sync/client-sync-replica.ts` and test — staging pages, atomic swap, cursor application, cache clear restore.
- Create `packages/server/src/authority.e2e.test.ts` — real child-process restart/fault tests and three real WebSocket clients.
- Create `packages/server/src/fixtures/authority-child.ts` — test child process controlled through JSON lines, excluded from package exports.
- Modify `.nvmrc`, `package.json`, `.github/workflows/quality.yml`, protocol/delivery docs, and renderer tests for lower-bound/runtime and final acceptance evidence.

## External gate before Task 4

- [ ] Run Blueprint check and verify the three primitive tasks are owner-verified:

```bash
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links
```

Expected: T-0012, T-0013, and T-0014 show `已验收` / `verified`; T-0040 remains claimed by `@claude`.

- [ ] Fetch and prove their files exist on `origin/main` before rebasing:

```bash
git fetch origin
git show origin/main:packages/server/src/primitives.ts >/dev/null
git show origin/main:packages/server/src/primitives.test.ts >/dev/null
```

Expected: both `git show` commands exit 0. If either fails, run the following exact command and stop:

```bash
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py set /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html T-0040 --state blocked --blocked-reason "T-0012/T-0013/T-0014 尚未由 @lionel 验收并合入 main，T-0040 无法复用 canonical 原语类型" --by @claude --note "等待 @lionel 验收并合入三项原语任务"
```

- [ ] Rebase only after inspecting remote overlap:

```bash
git log HEAD..origin/main --oneline
git diff HEAD...origin/main -- packages/server/src/index.ts packages/desktop/src/renderer/app.ts
git rebase origin/main
```

Expected: the rebase preserves the approved T-0040 design commits and brings in the canonical primitive implementation without hand-copying files.

### Task 1: Pin Node 22.13 and build transactional schema migration

**Files:**

- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `.github/workflows/quality.yml`
- Create: `packages/server/src/persistence/schema.ts`
- Create: `packages/server/src/persistence/schema.test.ts`

- [ ] **Step 1: Write failing schema tests.**

Cover these exact cases in `schema.test.ts`:

```ts
it("creates a fresh database through v1 then v2", () => {
  const database = new DatabaseSync(databasePath);
  migrateAuthorityDatabase(database);
  expect(readSchemaVersion(database)).toBe(2);
  expect(listAuthorityTables(database)).toEqual(expect.arrayContaining([
    "actors", "sessions", "rooms", "room_memberships", "messages",
    "human_read_receipts", "agent_judgments", "open_items",
    "agent_executions", "calibration_signals", "streams", "events",
    "idempotency_records", "outbox_deliveries",
  ]));
});

it("rolls the entire migration chain back on an injected v2 failure", () => {
  const database = createV1Fixture(databasePath);
  expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 3 }))
    .toThrow("migration_fault_injected");
  expect(readSchemaVersion(database)).toBe(1);
  expect(database.prepare("SELECT body FROM messages WHERE id = ?").get("message-1"))
    .toMatchObject({ body: "升级前消息" });
  expect(listAuthorityTables(database)).not.toContain("outbox_deliveries");
});
```

Also assert all v1 actors receive `catalog_revision = 0`, memberships receive `access_revision = 0`, and room/identity streams start at `head_seq = 0`, `retained_from_seq = 1`.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/schema.test.ts`

Expected: FAIL because `schema.ts` and its exports do not exist.

- [ ] **Step 3: Implement the migration boundary.**

Use this public surface; keep every `DatabaseSync` parameter internal to the persistence folder:

```ts
export const AUTHORITY_SCHEMA_VERSION = 2 as const;

export interface MigrationFaultOptions {
  readonly failAfterStatement?: number;
}

export function configureAuthorityConnection(database: DatabaseSync): void;
export function migrateAuthorityDatabase(
  database: DatabaseSync,
  fault?: MigrationFaultOptions,
): void;
export function readSchemaVersion(database: DatabaseSync): number;
export function listAuthorityTables(database: DatabaseSync): readonly string[];
```

`configureAuthorityConnection` must set and verify `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, and a bounded `busy_timeout`. `migrateAuthorityDatabase` must open one outer `BEGIN IMMEDIATE`, apply missing numbered migrations in order, write `(version,name,checksum,applied_at)` to `schema_migrations`, set `user_version`, run integrity checks, and either COMMIT the whole chain or ROLLBACK it.

The v1 DDL contains actors, sessions, rooms, memberships, invitations, audit, and messages. The v2 DDL adds the five collaboration-fact tables plus streams/events/idempotency/outbox and deterministically initializes both revision columns and both stream kinds.
Task 5 treats the v2 migration already merged to `main` as immutable and advances the current schema to v3, rebuilding only the outbox target envelope.

- [ ] **Step 4: Pin and verify the supported runtime.**

Set `.nvmrc` to `22.13.1`, add `"engines": { "node": ">=22.13" }` to the root package, and make CI run the existing quality job on `22.13.1` plus the current Node 22 line. Do not silently rely on the local Node 25 runtime.

```yaml
strategy:
  fail-fast: false
  matrix:
    node-version: ["22.13.1", "22.x"]
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node-version }}
      cache: pnpm
```

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/schema.test.ts && pnpm lint`

Expected: schema tests pass on the local runtime; typecheck and lint exit 0. CI later proves the lower bound.

- [x] **Step 5: Preview and commit.**

Use `superpowers:commit-rebase-pr`, stage only the five listed files, and propose `feat(server): add versioned authority schema`. The Chinese preview must call out the experimental `node:sqlite` risk and the fact that CI, not the local Node 25 runtime, is the Node 22.13 proof.

### Task 2: Isolate SQLite behind a real AuthorityWorker

**Files:**

- Create: `packages/server/src/persistence/worker-protocol.ts`
- Create: `packages/server/src/persistence/authority-worker.ts`
- Create: `packages/server/src/persistence/worker-database-client.ts`
- Create: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write worker lifecycle RED tests.**

```ts
it("runs database work off the main event loop", async () => {
  const client = await createWorkerDatabaseClient({ databasePath });
  const heartbeat = new Promise<void>((resolve) => setImmediate(resolve));
  const migration = client.inspectSchema();
  await expect(heartbeat).resolves.toBeUndefined();
  await expect(migration).resolves.toMatchObject({ version: 2 });
  await client.close();
});

it("rejects every pending request when the worker exits", async () => {
  const client = await createWorkerDatabaseClient({ databasePath });
  const pending = client.testOnlyBlockUntilExit();
  await client.testOnlyTerminateWorker();
  await expect(pending).rejects.toMatchObject({ code: "authority_worker_exited" });
  await expect(client.inspectSchema()).rejects.toMatchObject({
    code: "authority_worker_exited",
  });
});
```

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/worker-database-client.test.ts`

Expected: FAIL on missing worker client exports.

- [ ] **Step 3: Define a closed worker protocol.**

```ts
export type AuthorityWorkerRequest =
  | { readonly type: "authority.initialize"; readonly requestId: string }
  | { readonly type: "authority.inspect-schema"; readonly requestId: string }
  | { readonly type: "authority.close"; readonly requestId: string };

export type AuthorityWorkerResponse =
  | { readonly type: "authority.ready"; readonly requestId: string; readonly schemaVersion: 2 }
  | { readonly type: "authority.schema"; readonly requestId: string; readonly schemaVersion: 2 }
  | { readonly type: "authority.closed"; readonly requestId: string }
  | { readonly type: "authority.error"; readonly requestId: string; readonly code: string; readonly message: string };
```

Extend this union in later tasks; never add an `operation: string` plus arbitrary JSON escape hatch. Runtime guards must reject unknown type and extra fields on both sides.

- [ ] **Step 4: Implement request correlation and shutdown.**

`authority-worker.ts` opens/configures/migrates one read-write connection, dispatches one request at a time, serializes stable errors, and closes the DB before acknowledging close. `WorkerDatabaseClient` owns a monotonically increasing request ID, a pending Promise map, and one terminal failure shared by all later calls. It must not import `node:sqlite`.

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/worker-database-client.test.ts && pnpm verify:core-boundary`

Expected: worker tests and zero-I/O core boundary pass; an `rg 'node:sqlite' packages/server/src -g '!persistence/**'` review finds no main-thread imports.

- [ ] **Step 5: Preview and commit.**

Stage only the five listed files and propose `feat(server): isolate authority database worker`. The AI review summary must cover crash propagation, double-close behavior, and the risk of accidentally exporting worker-only `DatabaseSync` APIs.

### Task 3: Import T-0039 files once without partial activation

**Files:**

- Create: `packages/server/src/persistence/legacy-importer.ts`
- Create: `packages/server/src/persistence/legacy-importer.test.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`

- [ ] **Step 1: Write importer RED tests.**

Create real T-0039 session JSON, room JSON, and message JSONL files. Assert:

```ts
const result = await client.importLegacyState({
  sessionFilePath,
  roomFilePath,
  messageFilePath,
});
expect(result).toEqual({ imported: true, actors: 3, rooms: 1, messages: 2 });

const restarted = await createWorkerDatabaseClient({ databasePath });
await expect(restarted.inspectLegacyImport()).resolves.toMatchObject({
  markerVersion: 1,
  messages: 2,
  roomHeadSeq: 0,
  identityHeadSeq: 0,
});
```

Add corrupt reference, corrupt JSONL, repeated startup, and fault-before-rename cases. In every failure case the final authority path must remain absent or byte-identical to its prior valid database.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/legacy-importer.test.ts`

Expected: FAIL because the import operation is absent.

- [ ] **Step 3: Implement strict read-validate-stage-activate.**

`legacy-importer.ts` must:

1. Read all three inputs without writing the final authority path.
2. Validate with `isSessionState`, `isRoomLifecycleState`, and the existing strict message reader; reject cross-file references and duplicate IDs.
3. Create a same-directory temporary SQLite file, run v1→v2 migrations, and import all rows in one transaction.
4. Set actor `catalog_revision=0`, membership `access_revision=0`, and room/identity streams to `(head_seq=0, retained_from_seq=1)` without inventing historical events.
5. Write one unique import marker, fsync/close, then atomically rename into place only if the final DB does not exist.
6. Leave legacy inputs untouched.

Use closed request fields for the three explicit paths; never accept a directory and guess filenames.

- [ ] **Step 4: Verify GREEN and restart.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/schema.test.ts packages/server/src/persistence/legacy-importer.test.ts packages/server/src/persistence/worker-database-client.test.ts && pnpm lint`

Expected: all focused tests pass; restart reads only SQLite after a successful marker.

- [ ] **Step 5: Preview and commit.**

Stage only the five listed files and propose `feat(server): import legacy authority state`. The risk section must explicitly say legacy files are retained and corrupt input never activates a new authority DB.

### Task 4: Freeze closed command/event contracts after primitive verification

**Precondition:** Complete the external gate above. Do not start this task from the current unverified `m2-primitives` worktree.

**Files:**

- Create: `packages/core/src/collaboration.ts`
- Create: `packages/core/src/collaboration.test.ts`
- Create: `packages/core/src/sync.ts`
- Create: `packages/core/src/sync.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/primitives.ts`
- Create: `packages/server/src/persistence/contracts.ts`
- Create: `packages/server/src/persistence/contracts.test.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/primitives.test.ts`

- [ ] **Step 1: Write closed-schema RED tests.**

Start from the owner-verified `HumanReadReceipt`, `AgentJudgement`, `OpenItem`, `AgentExecution`, `SocialReaction`, and `CalibrationSignal` declarations in `primitives.ts`. Move only those pure declarations and their status/transfer aliases, unchanged, into `packages/core/src/collaboration.ts`; import and re-export them from `primitives.ts` so existing `@native-im/server` consumers keep the same names. Test every accepted command and these rejections:

```ts
expect(parsePersistentCommand({
  type: "agent.judgment.record",
  payload: { messageId: "m-1", outcome: "suppressed", reason: "冷却期" },
})).toMatchObject({ ok: true });

expect(parsePersistentCommand({
  type: "agent.judgment.record",
  payload: { messageId: "m-1", outcome: "will_respond", reason: "" },
})).toMatchObject({ ok: false, code: "invalid_command" });

expect(parsePersistentCommand({
  type: "human.read.record",
  payload: { messageId: "m-1", agentId: "agent-search" },
})).toMatchObject({ ok: false, code: "invalid_command" });

expect(parsePersistentCommand({
  type: "calibration.record",
  payload: { sourceMessageId: "m-agent", emoji: "🎉" },
})).toMatchObject({ ok: false, code: "invalid_command" });
```

Type tests must prove public JSON cannot construct `InternalAgentCommandContext` and authenticated human commands cannot carry `actorId`, `agentId`, or `authorKind` in their payload.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/contracts.test.ts packages/server/src/primitives.test.ts`

Expected: contract tests fail because `contracts.ts` is missing. During the type relocation, the verified primitive tests must remain green without changing expected literals or fields.

- [ ] **Step 3: Add exact contexts and command unions.**

```ts
export interface AuthenticatedSessionContext {
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly principal: AuthenticatedPrincipal;
}

export interface AuthenticatedCommandContext extends AuthenticatedSessionContext {
  readonly kind: "human";
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AgentPrincipal {
  readonly actorId: string;
  readonly kind: "agent";
}

declare const internalCommandAuthority: unique symbol;
export interface InternalAgentCommandContext {
  readonly kind: "agent";
  readonly [internalCommandAuthority]: true;
  readonly agent: AgentPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export type CollaborationCommand =
  | { readonly type: "message.send"; readonly roomId: string; readonly payload: MessageDraft }
  | { readonly type: "human.read.record"; readonly roomId: string; readonly payload: { readonly messageId: string } }
  | { readonly type: "agent.judgment.record"; readonly roomId: string; readonly payload: { readonly messageId: string; readonly outcome: AgentJudgementOutcome; readonly reason: string } }
  | { readonly type: "open-item.create"; readonly roomId: string; readonly payload: { readonly sourceMessageId: string; readonly ownerId: string; readonly content: string } }
  | { readonly type: "open-item.transition"; readonly roomId: string; readonly payload: { readonly itemId: string; readonly action: "respond" | "defer" | "transfer"; readonly targetId?: string; readonly reason?: string } }
  | { readonly type: "agent.execution.transition"; readonly roomId: string; readonly payload: { readonly executionId: string; readonly sourceMessageId: string; readonly toolName: string; readonly status: AgentExecutionStatus; readonly result?: string } }
  | { readonly type: "calibration.record"; readonly roomId: string; readonly payload: { readonly sourceMessageId: string; readonly emoji: "👍" | "👎" } };

export type HumanCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "human.read.record" | "open-item.create" | "open-item.transition" | "calibration.record" }
>;

export type AgentCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "agent.judgment.record" | "open-item.create" | "open-item.transition" | "agent.execution.transition" }
>;

export type RoomGovernanceCommand =
  | { readonly type: "room.create"; readonly payload: { readonly name: string } }
  | { readonly type: "room.rename"; readonly roomId: string; readonly payload: { readonly name: string } }
  | { readonly type: "room.archive"; readonly roomId: string; readonly payload: Record<string, never> }
  | { readonly type: "human.invitation.issue"; readonly roomId: string; readonly payload: { readonly inviteeActorId: string } }
  | { readonly type: "human.invitation.decide"; readonly payload: { readonly token: string; readonly decision: "accept" | "reject" } }
  | { readonly type: "agent.configure"; readonly roomId: string; readonly payload: { readonly agentId: string; readonly participation: AgentParticipation; readonly toolPermissions: readonly string[] } }
  | { readonly type: "human.role.change"; readonly roomId: string; readonly payload: { readonly targetActorId: string; readonly role: "admin" | "member" } }
  | { readonly type: "member.remove"; readonly roomId: string; readonly payload: { readonly targetActorId: string } };
```

The pure core sync surface must include these exact discriminants; each imported primitive record retains its verified field names:

```ts
export interface RoomSummary {
  readonly roomId: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly role: HumanRoomRole;
}

export type SnapshotDeliveryMode =
  | { readonly mode: "materialized"; readonly expiresAt: string; readonly idleExpiresAt?: never }
  | { readonly mode: "streaming"; readonly idleExpiresAt: string; readonly expiresAt?: never };

export type RoomRepairRecord =
  | { readonly kind: "room"; readonly value: Omit<ManagedRoom, "members"> }
  | { readonly kind: "membership"; readonly value: HumanRoomMembership | AgentRoomMembership }
  | { readonly kind: "message"; readonly value: Message }
  | { readonly kind: "human-read"; readonly value: HumanReadReceipt }
  | { readonly kind: "agent-judgement"; readonly value: AgentJudgement }
  | { readonly kind: "open-item"; readonly value: OpenItem }
  | { readonly kind: "agent-execution"; readonly value: AgentExecution }
  | { readonly kind: "calibration"; readonly value: CalibrationSignal };

export type SnapshotVersion =
  | { readonly kind: "room"; readonly roomId: string; readonly watermark: number }
  | { readonly kind: "catalog"; readonly catalogRevision: number };

export type WorkspaceBootstrapPage = {
  readonly type: "workspace.bootstrap.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly page: number;
  readonly rooms: readonly RoomSummary[];
  readonly catalogRevision: number;
  readonly snapshotChecksum: string;
  readonly hasMore: boolean;
} & SnapshotDeliveryMode;

export type RoomRepairPage = {
  readonly type: "room.repair.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly roomId: string;
  readonly page: number;
  readonly records: readonly RoomRepairRecord[];
  readonly watermark: number;
  readonly snapshotChecksum: string;
  readonly hasMore: boolean;
} & SnapshotDeliveryMode;

export interface SnapshotCompleted {
  readonly type: "snapshot.completed";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly version: SnapshotVersion;
}
```

Define `PersistedRoomEvent` as an envelope union correlating each literal event type with its exact payload: room metadata for create/rename/archive, invitation IDs and target actors for issuance/decision, canonical membership for accepted/configured/role-change, target actor for removal, and the corresponding canonical record for message/read/judgement/open-item/execution/calibration. An event parser must reject mismatched type/payload pairs.

Add a separate closed `RoomGovernanceCommand` union for create/rename/archive/invite/decision/configure-agent/change-role/remove-member. Put pure `PersistedRoomEvent`, `PersistedIdentityEvent`, `RoomCursor`, `RoomSyncResult`, snapshot page/version, and bootstrap page value types in `packages/core/src/sync.ts`, export them through core `index.ts`, and keep untrusted-wire runtime parsers in the server. The event unions must import the relocated canonical primitive records and use literal event types from the design; do not reuse core's broad `Event.type: string`.

- [ ] **Step 4: Define the two narrow ports.**

```ts
export interface CommandStore {
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
  ): Promise<CommandAcknowledgement>;
  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
  ): Promise<CommandAcknowledgement>;
}

export interface SyncQueryStore {
  syncRoom(context: AuthenticatedSessionContext, request: RoomSyncRequest): Promise<RoomSyncResult>;
  readHistory(context: AuthenticatedSessionContext, roomId: string): Promise<readonly Message[]>;
  // Server-internal point lookups; not exported through the package root.
  readActor(actorId: string): Promise<Actor | undefined>;
  readRoom(roomId: string): Promise<ManagedRoom | undefined>;
  canAccessRoom(context: AuthenticatedSessionContext, roomId: string): Promise<boolean>;
  readRoomAudit(context: AuthenticatedSessionContext, roomId: string): Promise<readonly RoomAuditRecord[]>;
  listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]>;
  markOutboxDispatched(deliveryId: string): Promise<void>;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandAcknowledgement {
  readonly aggregateId: string;
  readonly eventIds: readonly string[];
  readonly acceptedAt: string;
  readonly result: JsonValue;
}

export interface OutboxDelivery {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly targetKind: "room" | "principal" | "session-family";
  readonly targetId: string;
  readonly streamSeq: number;
  readonly attempts: number;
}
```

The acknowledgement stores stable business fields and event IDs but excludes the transport `requestId`; the WebSocket adapter rebinds the current request ID on every replay.

- [ ] **Step 5: Verify contracts and commit.**

Run: `pnpm typecheck && pnpm exec vitest run packages/core/src/collaboration.test.ts packages/core/src/sync.test.ts packages/server/src/persistence/contracts.test.ts packages/server/src/primitives.test.ts && pnpm verify:core-boundary && pnpm lint`

Expected: all focused tests pass and core remains zero I/O.

Use the commit workflow and propose `feat(server): define authoritative command contracts`. Reviewer focus: canonical primitive reuse, no client-selected identity, and no arbitrary-JSON worker escape hatch.

### Task 5: Persist authentication and re-check sessions inside transactions

**Files:**

- Modify: `packages/server/src/auth.ts`
- Modify: `packages/server/src/auth.test.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/persistence/schema.ts`
- Modify: `packages/server/src/persistence/schema.test.ts`
- Modify: `packages/server/src/persistence/legacy-importer.ts`
- Modify: `packages/server/src/persistence/legacy-importer.test.ts`
- Create: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Create: `packages/server/src/persistence/sqlite-authoritative-store.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `docs/plans/2026-08-10-t0040-authoritative-persistence-design.md`
- Modify: `docs/plans/2026-08-10-t0040-authoritative-persistence-implementation.md`

- [ ] **Step 1: Write auth authority RED tests.**

```ts
const first = await createAuthorityFixture(databasePath);
await first.authority.registerActors(actors);
const session = await first.auth.login({ accountId: "account-li", secret: "correct" });
const authenticated = await first.auth.authenticateSession(session.accessToken);
expect(authenticated).toMatchObject({
  principal: { actorId: "human-li" },
  sessionFamilyId: expect.any(String),
  sessionId: expect.any(String),
});
await first.close();

const restarted = await createAuthorityFixture(databasePath);
await expect(restarted.auth.authenticateSession(session.accessToken)).resolves.toMatchObject({
  sessionId: authenticated.sessionId,
});
```

Add deterministic interleavings for: refresh with expected principal, old refresh replay revoking the whole family, explicit revoke, access expiry, and a human command paused after socket authentication but before it is enqueued to the single AuthorityWorker while another connection revokes the family. The queued command must return `session_revoked` with zero facts/events/outbox rows.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/auth.test.ts packages/server/src/persistence/sqlite-authoritative-store.test.ts`

Expected: new tests fail because auth still depends on JSON `StateStore` and exposes no session context.

- [ ] **Step 3: Add the session authority port and atomic SQLite operations.**

```ts
export interface SessionAuthority {
  issue(input: HashedSessionIssue): Promise<IssuedSessionRecord>;
  authenticate(accessTokenHash: string, now: number): Promise<AuthenticatedSessionContext>;
  rotate(input: HashedSessionRotation): Promise<IssuedSessionRecord>;
  revoke(accessTokenHash: string, now: number): Promise<void>;
}

export interface HashedSessionIssue {
  readonly accountId: string;
  readonly actorId: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface HashedSessionRotation extends HashedSessionIssue {
  readonly currentRefreshTokenHash: string;
  readonly expectedPrincipal?: AuthenticatedPrincipal;
  readonly now: number;
}

export interface IssuedSessionRecord {
  readonly sessionId: string;
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface AuthenticationService {
  login(credentials: LoginCredentials): Promise<IssuedSession>;
  authenticate(accessToken: string): Promise<AuthenticatedPrincipal>;
  authenticateSession(accessToken: string): Promise<AuthenticatedSessionContext>;
  refresh(refreshToken: string, expectedPrincipal?: AuthenticatedPrincipal): Promise<IssuedSession>;
  revoke(accessToken: string): Promise<void>;
}
```

Keep plaintext tokens in `auth.ts`; send only canonical SHA-256 base64url hashes to the worker. Add an explicit startup `registerActors(actors)` operation: it inserts missing human/Agent actors with `catalog_revision=0` and stable `identity.actor.registered` events, treats a byte-equivalent repeat as idempotent, and rejects a changed kind/display/capability payload for an existing ID. Rotation must run under `BEGIN IMMEDIATE`, validate expected principal before token generation is persisted, revoke only the prior record on normal refresh, append a new record in the same family, and revoke the whole family on refresh replay. Revoke/rotate writes identity events; only family revoke creates terminal session-family outbox. Because v2 was already merged, add immutable migration v3 that rebuilds `outbox_deliveries` from `destination` into closed `target_kind / target_id / stream_seq` columns and proves v2 rows survive the upgrade.

- [ ] **Step 4: Make human command session validation transactional.**

At the start of every `executeHuman`, re-read `sessions.access_token_hash = context.sessionId` inside the same transaction as the command and require family/account/actor match, unexpired access, and no family revoke. Because one AuthorityWorker serializes all writes, a revoke cannot overtake a command after that command has begun its transaction. Add the test-only pause after socket authentication but before command enqueue, then commit revoke first; this deterministically proves the other legal serial order without holding a transaction open across test I/O.

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/auth.test.ts packages/server/src/persistence/sqlite-authoritative-store.test.ts packages/server/src/websocket.test.ts && pnpm lint`

Expected: SQLite auth tests pass and existing login/resume/refresh/revoke WebSocket behavior remains green.

- [ ] **Step 5: Preview and commit.**

Stage only listed files and propose `feat(server): persist authoritative sessions`. The preview must mention the public `authenticateSession` addition, JSON session import compatibility, and refresh/revoke family semantics.

### Task 6: Persist room governance, messages, and every collaboration fact atomically

**Files:**

- Modify: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.test.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Create: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/schema.ts`
- Modify: `packages/server/src/persistence/schema.test.ts`
- Modify: `packages/server/src/persistence/legacy-importer.test.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/contracts.test.ts`
- Modify: `packages/server/src/persistence/contracts.type-test.ts`
- Modify: `packages/server/src/room-lifecycle.ts`
- Modify: `packages/server/src/room-lifecycle.test.ts`
- Modify: `packages/server/src/service.ts`
- Modify: `packages/server/src/service.test.ts`
- Modify: `packages/server/src/primitives.ts`
- Modify: `packages/server/src/primitives.test.ts`
- Create: `packages/server/src/invitation-secret-protector.ts`
- Create: `packages/server/src/invitation-secret-protector.test.ts`
- Modify: `packages/server/src/index.ts`

Task 6 advances the immutable authority schema from v3 to v4. The migration adds the missing canonical OpenItem, AgentExecution, and CalibrationSignal columns without changing v1-v3 checksums/fingerprints. Legacy calibration rows keep both actor and source fields `NULL`; migration must not infer only source from the old judgment and create a half-known row. V4 triggers require every new authoritative calibration write to carry a valid human actor and same-room source Agent message; the v4 triggers are included in the physical fingerprint/startup validation.

- [ ] **Step 1: Write parameterized RED tests for all accepted facts.**

Use a table containing `room.create`, all governance commands, `message.send`, `human.read.record`, `agent.judgment.record`, `open-item.create/transition`, `agent.execution.transition`, and `calibration.record`. For each command assert:

```ts
const first = await fixture.execute(context, command);
const replay = await fixture.execute(
  { ...context, requestId: "transport-retry" },
  command,
);
expect(replay.eventIds).toEqual(first.eventIds);
expect(await fixture.countFacts(command)).toBe(1);
expect(await fixture.countEvents(first.eventIds)).toBe(first.eventIds.length);
```

Run each case sequentially, concurrently with the same key, after worker restart, and with the same key plus changed canonical payload. The conflict case must be 409 and leave row counts unchanged. Add separate tests proving human/agent cross-authority calls fail and all three Agent judgement outcomes persist a non-empty reason.

Changed-payload 409 applies only when a command has two or more legal canonical business payloads within the same idempotency scope. `room.archive` has a closed empty payload, so it instead proves sequential, concurrent, and cross-restart exact replay; an unknown or extra payload field is rejected as closed-schema 400 with zero writes, while a changed `roomId` is a different aggregate scope. Do not change the archive scope and do not add a synthetic reason field.

For `human.invitation.issue`, drop the first ACK after COMMIT, restart, and replay the same key. The service must return the byte-identical invitation token without inserting another invitation. Scan SQLite text/blob values and prove the plaintext token is absent.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/sqlite-authoritative-store.test.ts packages/server/src/room-lifecycle.test.ts packages/server/src/service.test.ts packages/server/src/primitives.test.ts`

Expected: tests fail on missing command implementations; existing in-memory behavior remains visible as the compatibility baseline.

- [ ] **Step 3: Implement the shared transaction and idempotency skeleton.**

```text
BEGIN IMMEDIATE
→ re-check human session or server-private Agent capability
→ re-check room membership and command-specific owner/admin authority
→ parse closed command payload
→ look up idempotency scope and canonical business hash
→ on exact replay, return stored business acknowledgement
→ on changed payload, throw idempotency_conflict
→ update the one authoritative fact table
→ advance room and/or identity stream head
→ append stable closed event rows
→ append all required outbox delivery rows
→ store idempotency result with every event ID
→ COMMIT
```

Hash canonical business payload only; exclude `requestId` and `idempotencyKey`. Use scope `(actorId, commandType, aggregateKind, aggregateId, idempotencyKey)`. First make only `message.send` pass sequential, concurrent, conflict, and restart cases; every later command must call the same helper rather than duplicate idempotency logic.

- [ ] **Step 4: Implement room governance and catalog/access revisions.**

Add create/rename/archive/invite/decision/configure-agent/change-role/remove-member handlers one at a time. After each handler, run its parameterized test case before adding the next. Preserve authored messages after removal. Increment all affected human catalog revisions for room create/rename/join/role/remove/archive and the target membership access revision for permission changes. Agent configure appends `identity.room-access.changed` with `joined` or `updated`, and Agent removal appends `removed`; include those identity event IDs in the acknowledgement, advance the Agent identity stream, and intentionally create no principal outbox delivery because Agents have no principal observer.

Create an explicit secret port and AES-256-GCM adapter:

```ts
export interface InvitationSecretProtector {
  seal(token: string): string;
  open(ciphertext: string): string;
}

export function createAesGcmInvitationSecretProtector(
  key: Uint8Array,
): InvitationSecretProtector;
```

The key must be exactly 32 bytes and is injected at server composition; it is never written to SQLite or logs. Store only the token hash in `room_invitations` and sealed token in the idempotency result. An exact cross-restart replay decrypts the original response; a wrong key fails closed with `invitation_secret_unavailable`. Legacy imported invitations have no replayable issuance response and remain valid only through their existing token hash.

Run: `pnpm exec vitest run packages/server/src/invitation-secret-protector.test.ts packages/server/src/persistence/sqlite-authoritative-store.test.ts -t "room governance|invitation secret"`

Expected: owner/admin cases persist facts/events/outbox, ordinary member calls return 403, and replay row counts remain one.

- [ ] **Step 5: Implement the five primitive fact families.**

Add human read, Agent judgement, open-item create/transition, Agent execution transition, and calibration in that order. Human commands use the authenticated actor from context; Agent judgement/execution use only the server-private capability context. Calibration derives the target Agent from the source Agent message and rejects unsupported emoji. After each handler, run its named test case and inspect the stored canonical record.

Run: `pnpm exec vitest run packages/server/src/persistence/sqlite-authoritative-store.test.ts -t "collaboration facts"`

Expected: all canonical records and closed events persist exactly once; human/Agent cross-authority payloads are rejected.

- [ ] **Step 6: Convert services to authority facades.**

`RoomLifecycleService` methods call `CommandStore` and async query methods instead of saving whole JSON documents. `MessageService.send/history` use authenticated/internal contexts; `send` no longer invokes listeners directly. Keep the synchronous T-0039 primitive as a pure compatibility decision model. Add a separate asynchronous authoritative primitive facade that maps human/Agent contexts to `CommandStore`, awaits the committed acknowledgement, strictly parses the canonical result, and only then publishes the accepted fact; a failed commit must publish nothing. T-0041 remains responsible for real Agent runtime invocation.

Owner-approved transition: implement a separate authoritative RoomLifecycle facade whose mutations use `CommandStore` and whose `readActor/readRoom/canAccessRoom/readRoomAudit` calls use the corresponding asynchronous `SyncQueryStore` methods. `readActor` and `readRoom` are explicitly server-internal point lookups for composition/lifecycle, not public permission queries: do not export raw `SyncQueryStore`, the SQLite authority factory, an authoritative lifecycle factory whose options expose them, or worker-client point-query methods from the package root. `canAccessRoom` and `readRoomAudit` retain session, membership, active-room, and authorization checks in the worker. Keep the T-0039 synchronous JSON implementation only as an explicitly named compatibility adapter; it must not participate in authoritative MessageService, authoritative mutations, or security decisions. Do not change WebSocket composition in Task 6 and do not pull Task 7 outbox dispatch forward.

Keep the package-root worker client physically narrowed as well as type-narrowed: it must omit `executeHuman`, `executeAgent`, `readActor`, and `readRoom`, and it must not expose rollback/transport test seams. The deep client accepts `InternalAgentCommandContext`, validates its runtime capability internally, and only then constructs `AgentWorkerCommandContext`; never accept plain worker wire context at a public command boundary. Invitation secret material is prepared only by the internal SQLite authority facade.

Use one closed `AuthorityWorkerErrorCode` union across database handlers, worker serialization, and response parsing. Map every member exhaustively to `400 | 401 | 403 | 404 | 409 | 503`; an unknown worker code must become one sanitized terminal `storage_unavailable` error shared by pending and later calls. If `ROLLBACK` fails after a transaction error, throw an internal `AggregateError` preserving both causes, close/poison the worker-owned `DatabaseSync`, reject all client work with that same sanitized terminal error, and release the coordinator only after `terminate()` resolves or an explicit `exit` arrives; terminate rejection without exit must retain the reservation. Fault seams remain internal test-only exports. Registration, session, and governance identity events must share one deep canonical identity stream/event writer whose input is derived from the closed `PersistedIdentityEvent` union; when an event ID depends on payload, derive it from the exact canonical bytes that the same writer persists. A synchronous `publishAccepted` observer runs after commit and its exception cannot change the durable ACK into a failure.

- [ ] **Step 7: Run the complete authority regression.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/sqlite-authoritative-store.test.ts packages/server/src/auth.test.ts packages/server/src/room-lifecycle.test.ts packages/server/src/service.test.ts packages/server/src/primitives.test.ts && pnpm verify:core-boundary && pnpm lint`

Expected: all focused tests pass, every fact restarts from SQLite, and no file store is used after successful import.

- [ ] **Step 8: Preview and commit.**

Propose `feat(server): persist collaboration authority`. Reviewer focus: transaction completeness, idempotency hash scope, role/catalog revisions, canonical primitive shapes, and removal preserving history.

### Task 7: Replace direct listeners with transactional outbox delivery

**Files:**

- Create: `packages/server/src/subscription-registry.ts`
- Create: `packages/server/src/subscription-registry.test.ts`
- Create: `packages/server/src/outbox-dispatcher.ts`
- Create: `packages/server/src/outbox-dispatcher.test.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Modify: `packages/server/src/websocket.ts`
- Modify: `packages/server/src/websocket.test.ts`
- Modify: `packages/server/src/index.ts`

Implementation-required hard expansion: the dispatcher needs durable pending reads, per-candidate
authorization against the worker-owned current SQLite view, and idempotent dispatch/failure
marks. Task 7 may therefore also modify `worker-protocol.ts`,
`worker-database-client.ts` and its tests, `authority-worker.ts`,
`authority-database-handler.ts`, the SQLite authoritative store/tests, and contract/type
tests. `OutboxDelivery` remains a target-kind discriminated union reconstructed from an
`events` JOIN; authorization requests carry only delivery ID, candidate credential snapshot,
credential generation, and current time, while the worker re-reads the pending delivery and
applies the target-specific rule. Failure reasons remain the closed
`closed | backpressure | send_rejected` union, attempts advance once per dispatcher round,
marks are idempotent, and the package-root worker wrapper exposes none of these management
operations. Owner-approved public wire contract: keep `room.message.accepted` delivery
byte-compatible with the existing `{ type: "message.created", message }` frame; wrap every
other room event as `{ type: "room.event", event }`; deliver the complete closed
`identity.room-access.changed` event as its frame; and deliver session-family revocation as
the unsolicited `{ type: "auth.session-revoked", eventId }` terminal frame without a fake
`requestId`. Do not expose arbitrary persisted events as new top-level frame types.

- [x] **Step 1: Write target-kind and replay RED tests.**

```ts
registry.addRoom({ roomId: "room-1", connection: memberConnection });
registry.addPrincipal({ principalId: "human-removed", connection: removedConnection });
registry.addSessionFamily({ familyId: "family-revoked", connection: revokedConnection });

await dispatcher.flushOnce();
expect(memberConnection.frames).toContainEqual(expect.objectContaining({ eventId }));
expect(removedConnection.frames).toContainEqual(expect.objectContaining({
  type: "identity.room-access.changed",
}));
expect(revokedConnection.frames).toContainEqual(expect.objectContaining({
  type: "auth.session-revoked",
}));
```

Remove the first actor from the room before dispatch: room delivery must skip it, principal delivery must still reach it, and revoked-family terminal delivery must not require a currently valid session. Simulate send failure and restart; pending delivery remains. Simulate send success before mark-dispatched crash; replay may send twice but the event ID stays identical.

- [x] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/subscription-registry.test.ts packages/server/src/outbox-dispatcher.test.ts packages/server/src/websocket.test.ts`

Expected: missing registry/dispatcher tests fail; existing direct listener tests identify behavior that must move.

- [x] **Step 3: Implement indexed subscriptions and durable dispatch.**

```ts
export interface SubscriptionRegistry {
  addRoom(subscription: RoomSubscription): () => void;
  addPrincipal(subscription: PrincipalSubscription): () => void;
  addSessionFamily(subscription: SessionFamilySubscription): () => void;
  candidates(delivery: OutboxDelivery): readonly RegisteredConnection[];
  revokeConnection(connectionId: string): void;
}

export interface OutboxDispatcher {
  flushOnce(): Promise<number>;
  start(): void;
  close(): Promise<void>;
}
```

Before each send, `OutboxDispatcher` asks the authority store to authorize the candidate using target-specific rules. Change the internal bounded `sendFrame` seam to report accepted/rejected delivery: if any eligible connection is closed, over backpressure limit, or rejects the frame, keep the row pending and increment attempts; already-sent peers may receive the same event ID again. Mark dispatched only after every eligible local connection accepted the frame, or when no eligible connection exists and durable cursor replay is the only remaining path. A process crash leaves pending rows; event/outbox unique keys make replay stable.

- [x] **Step 4: Remove direct post-append fanout and verify.**

`MessageService.send` returns immediately after durable COMMIT/ACK. WebSocket composition starts the dispatcher and registers connection principal/family/rooms. Close, error, unsubscribe, and family revoke remove registry entries exactly once.

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/subscription-registry.test.ts packages/server/src/outbox-dispatcher.test.ts packages/server/src/service.test.ts packages/server/src/websocket.test.ts && pnpm lint`

Expected: no test relies on `MessageService`'s old listener Map; outbox tests pass.

- [ ] **Step 5: Preview and commit.**

Propose `feat(server): dispatch transactional outbox`. The risk summary must distinguish at-least-once network delivery from exactly-once visible application and call out terminal revoked-family authorization.

### Task 8: Add retained room cursors and permission-aware delta sync

**Files:**

- Create: `packages/server/src/sync-service.ts`
- Create: `packages/server/src/sync-service.test.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts` (real RPC client)
- Modify: `packages/server/src/persistence/authority-database-handler.ts` (worker-owned SQLite sync query and compaction transaction)
- Modify: `packages/server/src/index.ts`
- Modify: `packages/core/src/sync.ts` (mechanical cursor/result contract repair)
- Modify: `packages/core/src/sync.test.ts` (closed guard regression coverage)

This mechanical expansion keeps the Task 8 acceptance contract unchanged: the
facade must reach the real worker RPC client, while all SQLite reads and
compaction SQL remain owned by the authority worker.
The core sync files are additionally in scope only to carry the fixed page
watermark and close impossible result envelopes; acceptance semantics remain
unchanged.
Compaction blocked by a non-dispatched outbox delivery uses the closed,
request-level `room_compaction_blocked` error (HTTP 409), leaves stream/event/
outbox state unchanged, and does not poison the worker client.

- [ ] **Step 1: Write three-cursor RED tests against the authority store.**

```ts
const first = await sync.syncRoom(contextA, {
  roomId: "room-1",
  cursor: { version: 1, roomId: "room-1", afterSeq: 0 },
  limit: 2,
});
expect(first).toMatchObject({ mode: "delta", hasMore: true, watermark: 5 });
expect(first.events.map((event) => event.streamSeq)).toEqual([1, 2]);

const second = await sync.syncRoom(contextA, {
  roomId: "room-1",
  cursor: first.nextCursor,
  limit: 10,
});
expect(second.events.map((event) => event.streamSeq)).toEqual([3, 4, 5]);

await store.compactRoomStream("room-1", 4);
await expect(sync.syncRoom(contextB, {
  roomId: "room-1",
  cursor: { version: 1, roomId: "room-1", afterSeq: 2 },
})).resolves.toMatchObject({ mode: "repair_required", reason: "cursor_expired" });
```

Also test absent cursor, future cursor, wrong room/version, byte-bounded pages, concurrent new event after fixed watermark, removed member, archived room, and independent cursors for three clients.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/sync-service.test.ts`

Expected: FAIL because `SyncService` is missing.

- [ ] **Step 3: Implement the closed cursor result.**

```ts
export type RoomCursor = {
  readonly version: 1;
  readonly roomId: string;
  readonly afterSeq: number;
};

export type RoomSyncResult =
  | { readonly mode: "delta"; readonly events: readonly PersistedRoomEvent[]; readonly nextCursor: RoomCursor; readonly watermark: number; readonly hasMore: boolean }
  | { readonly mode: "repair_required"; readonly reason: "cursor_absent" | "cursor_expired"; readonly retainedFromSeq: number; readonly watermark: number };
```

In one worker read transaction: validate the session, validate current room membership, read `retained_from_seq` and `head_seq` as the page watermark, then read `afterSeq < stream_seq <= watermark` in ascending order with both record-count and UTF-8 byte limits. Never treat the cursor as authorization.

- [ ] **Step 4: Verify delta invariants.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/sync-service.test.ts packages/server/src/persistence/sqlite-authoritative-store.test.ts && pnpm lint`

Expected: retained cursors have no gaps/duplicates, expired/absent cursors explicitly require repair, and permission failures return 401/403.

- [ ] **Step 5: Preview and commit.**

Propose `feat(server): add authoritative room cursors`. Reviewer focus: watermark transaction boundary, byte limits, compaction off-by-one behavior, and cursor-not-auth semantics.

### Task 9: Materialize durable catalog and room repair snapshots off the main thread

**Files:**

- Create: `packages/server/src/persistence/snapshot-worker.ts`
- Create: `packages/server/src/persistence/snapshot-worker-client.ts`
- Create: `packages/server/src/persistence/snapshot-worker-client.test.ts`
- Modify: `packages/server/src/persistence/schema.ts`
- Modify: `packages/server/src/persistence/contracts.ts`
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/sqlite-authoritative-store.ts`
- Modify: `packages/server/src/sync-service.ts`
- Modify: `packages/server/src/sync-service.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/sync.ts`
- Modify: `packages/core/src/sync.test.ts`

- [ ] **Step 1: Write materialized snapshot RED tests.**

Test room and empty/non-empty catalog page 0, 0-based `afterPage`, byte/count limits, checksum stability, same-family single-flight, different-family rejection, two consumers, TTL expiry, restart continuation, and final authorization recheck. Use a deterministic pause after the read-only authority view is fixed:

```ts
const begin = sync.beginRoomRepair(context, "room-1");
await fixture.snapshotHooks.waitForFixedView();
await fixture.removeMember(ownerContext, "room-1", context.principal.actorId);
fixture.snapshotHooks.continueBuild();
await expect(begin).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
expect(await fixture.snapshotCacheCount()).toBe(0);
```

Prove heartbeat and an unrelated AuthorityWorker message commit while a 10,000-record snapshot build is paused.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/snapshot-worker-client.test.ts packages/server/src/sync-service.test.ts`

Expected: FAIL because snapshot worker/client are absent.

- [ ] **Step 3: Implement the snapshot worker and derived schema.**

The snapshot worker opens authority read-only, verifies WAL, and owns a separate `snapshot-cache.sqlite` with schema version 1. A durable manifest contains:

```ts
export type MaterializedSnapshotManifest = {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly sessionFamilyId: string;
  readonly checksum: string;
  readonly pageCount: number;
  readonly expiresAt: string;
} & (
  | { readonly kind: "room"; readonly roomId: string; readonly accessRevision: number; readonly watermark: number }
  | { readonly kind: "catalog"; readonly catalogRevision: number }
);
```

Room single-flight key is `(principalId,sessionFamilyId,roomId,headSeq,accessRevision)`; catalog key is `(principalId,sessionFamilyId,catalogRevision)`. Only committed completed snapshots with at least 60 seconds remaining TTL are reused. Materialized page reads are idempotent and do not delete pages; cleanup removes only expired manifests/pages.

Validate fixed production defaults at construction: one global build, queue length 16, 200 records per scan batch, five-minute TTL, 512 MiB cache quota, 60-second build deadline, and 128 MiB authority WAL-growth threshold. Zero, negative, non-finite, or disabled safety limits are rejected. A full queue returns retryable `429 snapshot_busy`; quota/deadline/WAL exits are internal fallback signals, not terminal client errors.

- [ ] **Step 4: Implement begin/page authorization linearization.**

After cache COMMIT and before page 0, ask AuthorityWorker to revalidate the live session family, membership/catalog revision, and access revision. Recheck every later page and WebSocket credential generation immediately before send. A different family cannot take over even if the principal matches.

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/persistence/snapshot-worker-client.test.ts packages/server/src/sync-service.test.ts && pnpm lint`

Expected: materialized snapshots survive process restart within TTL, never block main-thread heartbeat, and never return a page after revocation wins the ordering.

- [ ] **Step 5: Preview and commit.**

Propose `feat(server): materialize repair snapshots`. Risks: experimental read-only `node:sqlite`, WAL growth, derived cache capacity, and multi-consumer TTL semantics.

### Task 10: Guarantee finite-state repair with scoped streaming barriers

**Files:**

- Create: `packages/server/src/fallback-repair-coordinator.ts`
- Create: `packages/server/src/fallback-repair-coordinator.test.ts`
- Modify: `packages/server/src/index.ts` (keep Task 10 server-internal APIs off the package root)
- Modify: `packages/server/src/persistence/contracts.ts` (closed internal repair scope/lease contract)
- Modify: `packages/server/src/persistence/worker-protocol.ts`
- Modify: `packages/server/src/persistence/worker-database-client.ts`
- Modify: `packages/server/src/persistence/worker-database-client.test.ts`
- Modify: `packages/server/src/persistence/authority-database-handler.ts`
- Modify: `packages/server/src/persistence/authority-worker.ts`
- Modify: `packages/server/src/persistence/schema.ts` (immutable v5 scoped keyset indexes only)
- Modify: `packages/server/src/persistence/schema.test.ts`
- Modify: `packages/server/src/persistence/snapshot-worker.ts`
- Modify: `packages/server/src/persistence/snapshot-worker-client.ts`
- Modify: `packages/server/src/persistence/snapshot-worker-client.test.ts`
- Modify: `packages/server/src/sync-service.ts`
- Modify: `packages/server/src/sync-service.test.ts`

- [ ] **Step 1: Write deterministic fallback RED tests.**

Inject materialized cache quota, 60-second deadline, and 128 MiB WAL threshold failures separately. Each must return streaming page 0 rather than a terminal storage error. Add these interleavings:

```ts
const page0 = await sync.beginRoomRepair(context, "room-large");
expect(page0.mode).toBe("streaming");
await expect(sendMessage(context, "room-large")).rejects.toMatchObject({
  status: 503,
  code: "repair_barrier_active",
});
await expect(sendMessage(otherContext, "room-unrelated")).resolves.toMatchObject({
  type: "message.accepted",
});
```

Also test same-family `auth.refresh` during a repair longer than access TTL, continuation from a new socket, other-family rejection, session revoke/member removal/role downgrade/archive preemption, 30-second idle release, process exit release, complete ACK loss, and catalog completion by `catalogRevision` rather than room watermark.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/fallback-repair-coordinator.test.ts packages/server/src/sync-service.test.ts`

Expected: RED on missing streaming coordinator and barrier operations.

- [ ] **Step 3: Implement AuthorityWorker-owned scoped leases.**

```ts
export type RepairScope =
  | { readonly kind: "room"; readonly roomId: string }
  | { readonly kind: "catalog"; readonly principalId: string };

export type SnapshotVersion =
  | { readonly kind: "room"; readonly roomId: string; readonly watermark: number }
  | { readonly kind: "catalog"; readonly catalogRevision: number };
```

AuthorityWorker serializes acquire/normal-command/preempt/complete. A normal mutation affecting the lease scope returns retryable 503 before persistence. `auth.refresh` bypasses every lease. Session-family revoke, target member removal, permission downgrade, and archive commit first, invalidate affected leases, and make later page/complete return 401/403/stale. Never create a global barrier.

- [ ] **Step 4: Implement O(page) streaming and completion tombstones.**

SnapshotWorker does one stable checksum pass and then reads pages in primary-key order while the scope is frozen. It keeps only one page in memory and has no total record/byte/time limit; only 30 seconds between page/complete requests. The client keeps staging until `snapshot.completed`. A 30-second tombstone replays completed only after current same-family/permission/version validation; revoke or revision change rejects the old completion.

Authority schema v5 adds only the composite indexes required by those closed
keyset scans: `(room_id, id)` on the five streamed fact tables and
`(actor_id, kind, room_id)` for catalog membership. V1-v4 statements,
checksums, and fingerprints stay immutable. `EXPLAIN QUERY PLAN` plus sparse,
interleaved room/catalog fixtures prove that later pages seek within the target
scope instead of skipping unrelated rows from the beginning.

Immediately after acquire, the client tracks the lease with a process-local operation epoch, before the checksum pass starts. Checksum registration and page authorization use that epoch as an ownership CAS, so close, terminal failure, or explicit release cannot be followed by a late barrier resurrection. Once the checksum is attached, an expired access token leaves that lease available for a same-family refreshed session to authorize and replay page zero without another materialized or checksum scan.

Buzz translation is explicit at this boundary: Buzz's stored-event query becomes
primary-key/keyset-ordered room and catalog segments; its per-event visibility
recheck becomes AuthorityWorker lease authorization before every page; and its
EOSE completion boundary becomes `snapshot.completed` only after the final page
is continuously authorized. We deliberately deviate from Buzz's Nostr
filter/subscription model: repair uses closed room/catalog scopes, a frozen
authority version, and client staging followed by one atomic replacement because
human/Agent IM repair must never expose a partially rebuilt cache.

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/fallback-repair-coordinator.test.ts packages/server/src/persistence/snapshot-worker-client.test.ts packages/server/src/sync-service.test.ts && pnpm lint`

Expected: all bounded-path failures fall back; any finite fixture completes; unrelated writes and refresh continue; preemptive governance cannot be frozen.

- [ ] **Step 5: Preview and commit.**

Propose `feat(server): guarantee scoped streaming repair`. Reviewer focus: no global denial of service, completion-before-cache-swap, tombstone reauthorization, and no accepted authority-size ceiling.

### Task 11: Add closed v2 frames and preserve T-0039 legacy transport

**Files:**

- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/src/protocol.test.ts`
- Modify: `packages/server/src/websocket.ts`
- Modify: `packages/server/src/websocket.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/outbox-dispatcher.ts`
- Modify: `packages/server/src/outbox-dispatcher.test.ts`

- [x] **Step 1: Write protocol RED tests for every new request/result.**

Cover `workspace.bootstrap.begin/page`, `room.sync`, `room.repair.begin/page`, `snapshot.complete`, and `room.subscribe.v2`. Each parser test must reject extra fields, wrong cursor version/room, negative/future page, room/catalog version interchange, missing `requestId`, and over-limit IDs.

```ts
expect(parseClientFrame(JSON.stringify({
  type: "snapshot.complete",
  requestId: "req-1",
  snapshotId: "snapshot-1",
  version: { kind: "catalog", catalogRevision: 7 },
  snapshotChecksum: "sha256-value",
}))).toMatchObject({ ok: true });

expect(parseClientFrame(JSON.stringify({
  type: "snapshot.complete",
  requestId: "req-2",
  snapshotId: "snapshot-1",
  watermark: 7,
  snapshotChecksum: "sha256-value",
}))).toMatchObject({ ok: false });
```

- [x] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/protocol.test.ts packages/server/src/websocket.test.ts`

Expected: new protocol cases fail; legacy auth/message/history/subscribe tests stay green.

- [x] **Step 3: Extend closed ClientFrame/ServerFrame unions.**

Use the exact types from the approved design: every successful server frame has a literal `type` and current request's `requestId`; bootstrap pages include `mode`, `catalogRevision`, checksum, and mode-specific expiry; repair pages include room watermark; complete uses `SnapshotVersion`. Extend protocol status to 410, 429, and 503 with stable codes.

- [x] **Step 4: Wire v2 sync and bounded subscription gate.**

`requirePrincipal` returns `AuthenticatedSessionContext`. v2 operations call `SyncService`, recheck connection credential generation immediately before send, and use the existing inbound/outbound byte limits. `room.subscribe.v2` registers an inactive gate, reads delta to a watermark, drains higher events by event ID, then activates. Gate limits are 256 events or 256 KiB; overflow removes the temporary subscription and returns `room.subscribe.v2.retry` with `restartFrom`.

Keep legacy `room.history` and cursorless `room.subscribe` behavior byte-for-byte compatible: register first, return history, then continue live delivery. Do not make a missing cursor a legacy 400.

Buzz 的 `register_scoped → stored ordered query → EVENT/EOSE` 在这里翻译为 inactive bounded room gate、authoritative cursor delta/watermark、按 durable `eventId` 去重后 drain/activate。为保留 `room.message.accepted` 的 `eventId + streamSeq`，OutboxDispatcher 的内部 send callback 同时传递完整 delivery envelope；它不进入 `ServerFrame` 或 package-root wire，legacy 客户端仍收到原有 `message.created`。这是 closed room cursor/requestId 合同对 Buzz Nostr filter/kind/community 模型的明确偏离。

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/protocol.test.ts packages/server/src/websocket.test.ts packages/server/src/sync-service.test.ts && pnpm lint`

Expected: legacy and v2 suites pass; close/backpressure/refresh concurrency regressions remain green.

- [ ] **Step 5: Preview and commit.**

Propose `feat(server): expose cursor recovery protocol`. Risks: expanded wire union, legacy/v2 coexistence, subscription gate overflow, and large-frame bounds.

### Task 12: Build ClientSyncReplica with staging and atomic cache swap

**Files:**

- Create: `packages/desktop/src/sync/client-sync-replica.ts`
- Create: `packages/desktop/src/sync/client-sync-replica.test.ts`

- [ ] **Step 1: Write replica state-machine RED tests.**

```ts
const replica = createClientSyncReplica({ transport, cache });
await replica.restoreWorkspace();
expect(cache.liveCatalog()).toEqual([{ roomId: "room-1", name: "Alpha" }]);
expect(cache.liveRoom("room-1")?.watermark).toBe(9);

transport.pauseBeforeLastRepairPage();
const restoring = replica.repairRoom("room-1");
expect(cache.liveRoom("room-1")).toEqual(previousCompleteRoom);
transport.releaseLastRepairPage();
await restoring;
expect(cache.liveRoom("room-1")?.watermark).toBe(9);
```

Test out-of-order page, duplicate page, wrong snapshot ID/version, checksum mismatch, 401/403/409/410, streaming complete ACK loss, delta overlap by event ID, cache clear, and subscription retry. Every failure must discard staging and retain either no cache or the previous complete cache.

- [ ] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/desktop/src/sync/client-sync-replica.test.ts`

Expected: FAIL because the replica is absent.

- [ ] **Step 3: Implement transport and cache ports.**

```ts
export interface SyncTransport {
  bootstrapBegin(): Promise<WorkspaceBootstrapPage>;
  bootstrapPage(snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage>;
  syncRoom(request: RoomSyncRequest): Promise<RoomSyncResult>;
  repairRoomBegin(roomId: string): Promise<RoomRepairPage>;
  repairRoomPage(snapshotId: string, afterPage: number): Promise<RoomRepairPage>;
  completeSnapshot(snapshotId: string, version: SnapshotVersion, checksum: string): Promise<SnapshotCompleted>;
  subscribeRoom(roomId: string, cursor: RoomCursor): Promise<RoomSubscription>;
}

export interface RoomSubscription {
  readonly cursor: RoomCursor;
  close(): void;
}

export interface ClientAuthorityCache {
  roomCursor(roomId: string): RoomCursor | undefined;
  beginCatalog(snapshotId: string): void;
  stageCatalogPage(page: WorkspaceBootstrapPage): void;
  commitCatalog(version: number, checksum: string): void;
  beginRoom(roomId: string, snapshotId: string): void;
  stageRoomPage(page: RoomRepairPage): void;
  commitRoom(roomId: string, watermark: number, checksum: string): void;
  applyRoomEvents(roomId: string, events: readonly PersistedRoomEvent[], cursor: RoomCursor): void;
  discardSnapshot(snapshotId: string): void;
  clear(): void;
}
```

Import all cursor/page/version types from `@native-im/core`; do not add a desktop dependency on `@native-im/server` and do not duplicate the protocol shapes.

Materialized mode commits after the verified last page. Streaming mode leaves staging untouched until `snapshot.completed`. Then run `room.sync` from snapshot watermark before v2 subscribe. Apply delta/live events idempotently by `eventId` and monotonically advance the room cursor.

- [ ] **Step 4: Verify clear-cache recovery.**

Run: `pnpm typecheck && pnpm exec vitest run packages/desktop/src/sync/client-sync-replica.test.ts packages/desktop/src/renderer/app.test.ts && pnpm lint`

Expected: replica tests pass; no renderer markup or styling changes are needed.

- [ ] **Step 5: Preview and commit.**

Propose `feat(desktop): restore authoritative client replica`. Risks: staging cleanup, stream completion ordering, duplicate events, and accidentally exposing incomplete room state to renderer code.

### Task 13: Prove restart, crash-window, three-client recovery, and renderer separation

**Files:**

- Create: `packages/server/src/authoritative-server.ts`
- Create: `packages/server/src/authority.e2e.test.ts`
- Create: `packages/server/src/fixtures/authority-child.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/desktop/src/renderer/app.test.ts`
- Create: `docs/protocols/authoritative-sync.md`
- Create: `docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md`

- [ ] **Step 1: Build a real-process test harness.**

`authoritative-server.ts` composes AuthorityWorker, SnapshotWorker, authentication, lifecycle/message/fact facades, SyncService, registry, outbox dispatcher, and WebSocket server. It exposes only:

```ts
export interface AuthoritativeServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartAuthoritativeServerOptions {
  readonly databasePath: string;
  readonly snapshotCachePath: string;
  readonly actors: readonly Actor[];
  readonly identities: IdentityAdapter;
  readonly invitationSecretKey: Uint8Array;
  readonly faultPoint?: "after-domain-write" | "before-commit" | "after-commit-before-outbox" | "after-send-before-dispatch-mark";
}
```

`authority-child.ts` reads one closed JSON-line startup command from stdin, emits `{ "type": "ready", "url": string }`, and exits with documented test-only codes at fault points. Tests must spawn compiled `packages/server/dist/fixtures/authority-child.js`; run `pnpm build` before the focused e2e test.

- [ ] **Step 2: Write RED child-process durability tests.**

The first child writes identity, room, human/agent membership, message, human read, Agent judgement, open item, Agent execution, and calibration; then exits normally. A completely new child with no shared module cache reads every field back from the same DB.

For ACK/outbox fault injection:

1. Connect client B and record its cursor.
2. Send a message through client A with fault `after-commit-before-outbox`.
3. Confirm the child exited with the dedicated code and no ACK was fabricated after death.
4. Start a fresh child on the same DB.
5. Reconnect B with its old cursor and assert the same stable event ID appears once in the replica.
6. Retry A's same idempotency key and assert one message/fact/event/outbox identity.

Run the other three fault points too: `after-domain-write` and `before-commit` must leave no fact/event/outbox/idempotency row after restart; `after-send-before-dispatch-mark` may replay the same frame but the replica must apply its stable event ID only once.

- [ ] **Step 3: Write the required three-real-client scenario.**

Use three actual `ws` connections and three independent `ClientSyncReplica` instances:

- A remains online and receives live v2 events.
- B disconnects, misses several events, then resumes from a retained cursor without gaps or duplicates.
- C deletes catalog, room cache, and cursors; bootstrap rediscovers rooms, an expired cursor produces `repair_required`, paginated repair restores all facts, delta reaches the current watermark, then v2 subscribe becomes active.
- Force materialized fallback with 10,000 mixed closed records; verify C's live cache remains its prior complete version until `snapshot.completed`.
- Clear all three caches and restore them again; their fact sets and final room watermarks must equal the authority DB.

Run: `pnpm build && pnpm exec vitest run packages/server/src/authority.e2e.test.ts`

Expected before the harness is implemented: FAIL because `authoritative-server.ts` and child fixture do not exist. Expected after implementation: all child exits, restarts, and three-client assertions pass.

- [ ] **Step 4: Add renderer and protocol evidence.**

Feed restored `HumanReadReceipt`, `AgentJudgement`, `OpenItem`, `AgentExecution`, and `CalibrationSignal` records into the verified renderer fixture. Assert distinct DOM classes and visible labels for human read versus Agent judgement, pending human request versus Agent execution, and social reaction versus calibration; never assert only raw JSON equality.

Write `docs/protocols/authoritative-sync.md` with closed frames, error codes, cursor retention, materialized/streaming ordering, permission rechecks, session-family refresh, outbox ACK semantics, migration/import, and the exact Buzz reference/translation/deviation from the design.

- [ ] **Step 5: Run focused and full gates before the delivery commit.**

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links
git diff --check
```

Expected: every command exits 0; `gbp.py` prints `✓ 无违规`. Any warning must be explained in the delivery document before commit.

- [ ] **Step 6: Write the four-part delivery document and commit.**

The delivery document must contain:

1. **做了什么** — one-sentence outcome.
2. **逐条对照验收标准** — all six criteria, each with exact source/test links and satisfied/not-satisfied status.
3. **参照与偏离** — Buzz module/symbol, TypeScript translation, and reason for every deviation.
4. **解锁了什么** — exact downstream tasks made claimable after verification.

Include the checked self-test list and AI review summary required by the repository. Use the commit workflow for two explicit commits: first propose `test(server): prove authoritative recovery` for the composition/e2e/renderer evidence, then propose `docs: deliver T-0040 authoritative persistence` for the protocol and delivery document.

- [ ] **Step 7: Rebase, push, create the Chinese PR, and wait for CI.**

Use `superpowers:commit-rebase-pr`: fetch `origin/main`, inspect overlap and deletion regressions, rebase, rerun focused tests if the base changed, push with `--force-with-lease`, and create a non-draft Chinese PR. Do not infer success from local gates; wait until GitHub quality checks pass on the pushed head SHA.

- [ ] **Step 8: Deliver through GBP and stop.**

First prove the artifact exists:

```bash
test -f /Users/lionel/.config/superpowers/worktrees/agent-im/t0040-authoritative-persistence/docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md
```

Then set only `delivered`:

```bash
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py set /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html T-0040 --state delivered --awaiting @lionel --artifact "T-0040 服务端权威持久化、多客户端同步与故障恢复交付说明|../../../../.config/superpowers/worktrees/agent-im/t0040-authoritative-persistence/docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md" --by @claude --note "权威持久化、游标恢复、事务 outbox 与三客户端清缓存恢复已交付；等待 @lionel 验收后解锁 T-0041"
```

Run `gbp.py check --links` once more. Report the six criteria, current claimable list, recommended next task, and any criteria-tighten suggestion. Do not mark T-0040 verified, merge the PR, clean the worktree, or claim another task until `@lionel` explicitly approves. After owner verification and merge, update the artifact path through `gbp.py` to `../../../agent-im/docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md` before deleting this worktree, so the permanent link stays live.

## Plan self-review checklist

| Criterion | Production tasks | Acceptance evidence |
| --- | --- | --- |
| 1. All authority facts survive restart | 3, 5, 6, 13 | Legacy import tests, store restart tests, real child-process readback |
| 2. Stable event/idempotency | 4, 6 | Sequential/concurrent/cross-restart replay and conflict table |
| 3. Three-client cursor recovery | 8-13 | Retained/expired cursor suites and three real WebSocket replicas |
| 4. Durable ACK/outbox crash window | 6, 7, 13 | Four fault points, especially child exit after COMMIT before outbox |
| 5. Versioned migration | 1, 3, 5 | fresh/v1→v2→v3, existing v2→v3, unknown-target/injected rollback, import activation crash |
| 6. Permissions and cache-clear restore | 8-13 | Current-state authorization races and all-client cache deletion/rebuild |

- [x] Every one of the six T-0040 criteria maps to at least one production task and one automated test.
- [x] T-0012/T-0013/T-0014 are reused only after owner verification and merge; no canonical types are copied from the dirty worktree.
- [x] Every SQLite call is worker-owned; core and desktop remain zero/native-I/O-free at their domain boundaries.
- [x] Authentication refresh, family revoke, room removal, role downgrade, and archive have deterministic race tests.
- [x] Catalog and room snapshots each have materialized and streaming paths, closed version unions, and atomic client swap.
- [x] No design limit turns finite accepted authority state into an unrecoverable terminal error.
- [x] Legacy T-0039 history/subscribe remains covered while v2 carries cursor correctness.
- [x] Commit, PR, CI, Blueprint delivery, and user verification remain distinct states.
