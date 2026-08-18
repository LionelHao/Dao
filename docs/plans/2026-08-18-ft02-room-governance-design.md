# FT-02 Room Governance · 生产工程设计与 TDD 矩阵

> 日期：2026-08-18
> 状态：**实施准备设计；没有实现、没有验证 FT-02，也不改变任何任务状态**
> 产品权威：[批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)；UI 映射基线：[Design README](../design/README.md)
> 对应实施顺序：[FT-02 implementation plan](./2026-08-18-ft02-room-governance-implementation-plan.md)

## 1. 结论、范围和审计基线

FT-02 把 **Room 作为唯一 Project 边界**，为后续 FT-09 项目事实、FT-10 工具确认、FT-13 同步可靠性提供三个不会含混的权威能力：

1. 一个当前 Human owner 和受限的 `owner/admin/member` 治理；
2. 离开/移除前的可计算责任清理门；
3. 可逆、可审计、业务冻结而不冻结安全时钟的 archive/reopen 生命周期。

本设计覆盖 `REQ-ROOM-001`～`REQ-ROOM-004`、`REQ-PRIM-003`～`REQ-PRIM-005`、`REQ-ID-003`、`REQ-ID-005`、`REQ-NFR-002`～`REQ-NFR-004`、`REQ-NFR-007`～`REQ-NFR-008`、`REQ-NFR-011`～`REQ-NFR-014`，并为 `REQ-PRJ-004`～`REQ-PRJ-012` 和 `REQ-AGT-004`、`REQ-AGT-012` 建立 FT 边界；这些 Requirement ID 均存在于上述 PRD。

开始本设计时的只读 Git 基线为：分支 `codex/t0026-expand-m4`；已修改 `CONTEXT.md`、`packages/desktop/src/window.test.ts`；已有未跟踪 `docs/design/`、`docs/reconstruction/`、`docs/plans/2026-08-18-ft01-identity-session-acceptance-matrix.md` 与 `docs/plans/2026-08-18-ft01-identity-session-implementation-plan.md`。它们均视为其他会话所有，本设计不依赖其未提交实现，亦不覆盖、暂存或修改它们。

不在 FT-02 实现：旧跨 Room inbox、Mobile/Web、OS push、global search、完整 Blueprint、永久删除、多租户/组织模型，或任何通用 shell/未经 Human 确认的外部副作用。

## 2. 不变量和术语

### 2.1 Room 即 Project

- `roomId` 是消息、附件、memory、Agent assignment、Request、NextAction、Blocker/OpenQuestion、Ball、confirmation、grant、audit、event、outbox、cursor、snapshot 的唯一业务边界。所有 command 输入和每个持久对象均须带同一 `roomId`；跨 Room 引用在 guard、handler、SQL trigger 和 query 复核四层失败关闭。
- 不建立独立且可脱离 Room 的 `Project` aggregate/table。需要项目投影时使用 `{ roomId, projectId: roomId }` 的纯投影，不得产生第二个可写 ID。
- 一个 Room 最多一个 active primary Goal 是 FT-09 的项目事实不变量；FT-02 仅保证 Goal 的 `roomId` 作用域和 archive gate，不猜测 Goal 的状态机。

### 2.2 治理不变量

1. 当前 Human membership **恰有一位 owner**。Agent 永远不能成为 owner/admin/member，也不能登录或发起治理 command。
2. owner 可管理治理和 admin；admin 只可管理 member 与普通 Agent assignment；member 仅可读取其仍获授权的 Room 历史、请求自身离开和执行其另有授权的业务动作。
3. admin 不得提升、降级、移除 owner 或任一 admin（包括 peer）；owner 可管理 admin。任何角色变更都从当前 transaction 的 membership 重新计算，不能相信 UI 的旧角色。
4. owner 离开或被移除前必须先将 ownership 原子转移给另一位**当前 Human member**。转移后旧 owner 成为 `member`；所有时刻不出现零或两名 owner。
5. Human/Agent 离开、被移除或被停用前，所有仍活动的 Request、NextAction、Blocker/OpenQuestion、pending confirmation、以及待验收责任必须以各自 owning FT 的合法命令完成、转交或显式升级。FT-02 从不通过删除责任对象来“清理”。
6. archive 是 `active → archived → active` 生命周期，不是删除。归档用户仍可按当前 membership 审计读取历史、附件清单和项目事实；被移除者不能借 archive 继续读。

### 2.3 两类时间

| 类别 | 示例 | archive 行为 |
| --- | --- | --- |
| 业务 timer | Request/NextAction due、Blocker reviewAt、Ball boundary、业务通知升级、steward/route 调度 | 在 archive transaction 记录剩余时长；不触发、不升级；reopen 按保存的剩余时长顺延。 |
| 安全有效期 | access/refresh session、offline read lease、confirmation、execution grant | 继续使用绝对 server clock；绝不因 archive 延长。未 dispatch confirmation/grant 在 archive transaction 直接拒绝/撤销。 |

已 dispatch 的 side effect 不能被改写成“已撤销”。它保留 dispatch 记录；如无法得知最终结果，沿 FT-10 的 `outcome_unknown`/review 路径处理。

## 3. 依赖 seam 和实施前置条件

FT-02 不假定另一个会话尚未提交的 FT-01 API 已存在。以下是合并前必须由实施者确认的可替换 seam；现有 `AuthenticatedSessionContext`、`AuthenticatedCommandContext`、`CommandStore`、`SyncQueryStore`、`AuthorityWorker` 和 room identity events 是可复用的当前形状，而不是对 FT-01 最终形状的锁定。

| 依赖 | FT-02 只要求的稳定 seam / 前置条件 | FT-02 不拥有 |
| --- | --- | --- |
| FT-01 Identity & Session | `AuthenticatedSessionContext` 能在 AuthorityWorker transaction 内重新认证并给出 Human principal；针对 Room access reduction 的 identity delivery/cache-invalidation hook；`revokeSession` 可在 archived Room 外独立工作。 | session-family schema 版本、public session DTO、credential vault、邀请绑定建号、offline lease 参数。 |
| FT-09 Project Loop | `DepartureResponsibilityPort.collect(roomId, targetActorId, snapshot)` 返回严格的活动责任引用；FT-09 的完成/转交/升级命令在自己的 transaction 内产生终态或可移交状态。 | Request/NextAction/Blocker/Goal/Decision 的表、状态机、Human 接受与验收语义。 |
| FT-10 Tool Safety | `ArchiveSafetyPort.settleUndispatched(roomId, archivedAt)` 在同一 authority transaction 拒绝 pending confirmation、撤销未 dispatch grant 并收敛 waiting execution；`dispatch` 在 claim 前重验 Room lifecycle。 | tool adapter、confirmation UI、补偿和 outcome review 的细节。 |
| FT-13 Sync & Reliability | event/outbox/cursor/repair 的 room-scoped原子性，cache purge/lease policy 的端口，以及 archive 状态在 snapshot 中恢复。 | cache 加密、offline lease 默认值、transport retry policy。 |
| FT-14 Privacy & Operations | archive 后 audit/history/attachment/fact 读取授权及导出策略；日志和诊断的最小化。 | retention policy、export 实现、发布用 threat model/lease 数值。 |
| FT-07 Agent Profile & Routing / FT-08 Invocation | assignment/reduction、claim/route/runtime 的 lifecycle recheck。 | Global Profile、participation/readiness 的完整模型或 runtime scheduler。 |

若上述任一 port 未实现，FT-02 可先实现纯治理和 archive state，但**不得**伪造项目责任、confirmation 或 cache 已处理；相应 command 应在部署组装时 fail closed 为 `dependency_unavailable`/503，不能降级为“允许离开”。这是一项集成前置条件，不是 FT-02 已完成的声称。

## 4. Core closed types、guards 与 type tests

实现时在现有 [`packages/core/src/index.ts`](../../packages/core/src/index.ts)、[`packages/core/src/collaboration.ts`](../../packages/core/src/collaboration.ts) 和 [`packages/core/src/sync.ts`](../../packages/core/src/sync.ts) 扩展 closed union；core 保持零 I/O。以下为目标合同，字段均为 required，除明确的判别联合外拒绝额外键。

```ts
export type RoomLifecycleState = "active" | "archived";
export type HumanRoomRole = "owner" | "admin" | "member";

export interface RoomGovernanceView {
  readonly roomId: string;
  readonly projectId: string;          // required: exactly equal to roomId
  readonly lifecycle: RoomLifecycleState;
  readonly governanceRevision: number; // monotonic CAS revision
  readonly ownerActorId: string;
  readonly archivedAt?: string;
  readonly archiveGeneration: number;
}

export type DepartureResponsibilityKind =
  | "request"
  | "next_action"
  | "blocker_or_open_question"
  | "confirmation"
  | "acceptance";

export type DepartureResolution =
  | "complete"
  | "transfer"
  | "escalate"
  | "reject_or_revoke";

export interface DepartureConflict {
  readonly conflictId: string;
  readonly roomId: string;
  readonly subjectId: string;
  readonly kind: DepartureResponsibilityKind;
  readonly title: string;
  readonly state: string; // owning FT provides a closed per-kind state projection
  readonly allowedResolutions: readonly DepartureResolution[];
  readonly sourceId: string;
  readonly revision: number;
}

export interface DepartureConflictList {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly governanceRevision: number;
  readonly conflicts: readonly DepartureConflict[];
}

export type RoomGovernanceAudit =
  | { readonly type: "room.ownership.transferred"; /* room/actor/target/time/revisions */ }
  | { readonly type: "room.member.left" | "room.member.removed"; /* target/reason */ }
  | { readonly type: "room.archived"; /* archiveGeneration/frozenTimerCount */ }
  | { readonly type: "room.reopened"; /* archiveGeneration/resumedTimerCount */ }
  | { readonly type: "room.security.reduced"; /* no secret/grant value */ };
```

`RoomGovernanceView.projectId === roomId` is a guard invariant, not a client convenience. `DepartureConflict` must verify non-empty identifiers, stable kind, unique `conflictId`, room equality, non-empty title/state/source, positive safe revision, and a non-empty duplicate-free resolution subset valid for its kind. It may expose no raw confirmation parameter, grant token, attachment content, secret, target filesystem path, or provider diagnostics.

Required type tests in existing [`packages/core/src/collaboration.type-test.ts`](../../packages/core/src/collaboration.type-test.ts) and [`packages/core/src/actor.type-test.ts`](../../packages/core/src/actor.type-test.ts):

- Agent membership cannot carry `owner`/`admin`/`member`; a Human member cannot carry Agent participation/tool grant fields.
- A `RoomGovernanceView` cannot omit `projectId`, use a project ID different from its `roomId`, or carry an unknown lifecycle state.
- A conflict cannot use an arbitrary kind/resolution, omit `roomId`, include cross-Room source data, or add raw confirmation/grant fields.
- an archive event cannot be used where a reopen event is expected; `@ts-expect-error` assertions explain the intended compile failure.

Runtime guard tests in existing [`packages/core/src/collaboration.test.ts`](../../packages/core/src/collaboration.test.ts) and [`packages/core/src/sync.test.ts`](../../packages/core/src/sync.test.ts) must prove the matching malformed JSON and unknown event variants fail before persistence/replica application.

## 5. Server contract: commands, queries, ACKs, events and errors

### 5.1 Closed command set

All commands carry a server-derived Human `AuthenticatedCommandContext`, `requestId`, idempotency key, and `expectedGovernanceRevision`, except initial Room create. The public WebSocket frame never carries caller actor ID, role, session-family identity, grant, or authority capability.

| Command | Actor / lifecycle | Success ACK result | Notes |
| --- | --- | --- | --- |
| `room.ownership.transfer` | owner; active, or archived only to an existing Human member for a required owner exit | governance view, `previousOwnerActorId`, `eventIds`, `replayed` | CAS and current membership required; no new access is granted. |
| `room.member.role.set` | owner; active | governance view, target membership, `eventIds` | target role only admin/member; owner role is never set here. |
| `room.member.leave` | target is caller; active or archived subject to the allowlist below | governance view or `departure_blocked` | owner requires prior transfer; no implicit reassignment. |
| `room.member.remove` | owner; admin only for a member/ordinary Agent; active or archived safety allowlist | governance view or `departure_blocked` | no hard delete of history/audit. |
| `room.agent.assignment.reduce` | owner/admin; active or archived | updated assignment, `eventIds` | only removes capability/grant or pauses/removes; cannot expand access while archived. FT-07 owns normal assignment details. |
| `room.archive` | owner/admin; active | archived governance view, archive generation, settlement summary, `eventIds`, `replayed` | exactly one authority transaction. |
| `room.reopen` | owner/admin; archived | active governance view, resumed timer summary, `eventIds`, `replayed` | creates exactly one audit/event for the transition. |

Fresh-key retries against the already-achieved lifecycle state return a stable `already_archived` / `already_active` result with no new event/audit/outbox. Same scope/key/payload returns the original ACK under the existing idempotency window; same key with another payload is `idempotency_conflict`.

### 5.2 Queries

`room.governance.get`, `room.departure.conflicts`, and `room.audit.list` are authorized, read-only queries. A current Human member may query the archived view and audit/history; an active, assigned Agent only gets the minimum runtime view while active; a removed member, non-member, Tenant Administrator without ordinary membership, or unauthenticated party gets no Room content. `room.departure.conflicts` is re-evaluated in the final remove/leave transaction; a UI preflight is informative, never an authorization grant.

### 5.3 Events and replica application

Extend `PersistedRoomEvent` and `RoomRepairRecord` in [`packages/core/src/sync.ts`](../../packages/core/src/sync.ts) with discriminated governance events/records, rather than overloading `room.archived` with a stringly payload. Minimal event families are:

- `room.governance.changed` for ownership/role/membership/allowed Agent security reductions, with a closed governance snapshot;
- `room.archived` with archive generation and no secret settlement details;
- `room.reopened` with the same generation and resumed-timer count;
- `room.security.reduced` when an archived-safe reduction changes assignment/grant visibility.

The full repair snapshot must contain current Room lifecycle/governance, current memberships, the owning FT's project facts, execution/confirmation lifecycle projections, and frozen-timer state sufficient to render read-only facts. It does not duplicate immutable audit history as mutable current state. Delta and repair produce the same projection; `eventId` remains the replica de-duplication key.

### 5.4 Errors

Extend the closed code unions in [`packages/server/src/protocol.ts`](../../packages/server/src/protocol.ts) and [`packages/server/src/persistence/worker-protocol.ts`](../../packages/server/src/persistence/worker-protocol.ts), then map them in [`packages/server/src/websocket.ts`](../../packages/server/src/websocket.ts). The generic error remains safe; only `departure_blocked` has the closed actionable detail below.

```ts
{
  type: "error";
  status: 409;
  code: "departure_blocked";
  requestId: string;
  details: DepartureConflictList;
}
```

Other required codes: `room_revision_conflict` (409), `ownership_transfer_required` (409), `room_archived` (409 for prohibited business mutation), `role_forbidden` (403), `member_not_found` (404), `dependency_unavailable` (503), `confirmation_rejected` (409), `grant_revoked` (409), plus existing authentication/room/idempotency/snapshot codes. Error text is not parsed by Desktop and contains no raw security data.

### 5.5 Permission denial matrix

| Operation | owner | admin | member | Agent / non-member | archived rule |
| --- | --- | --- | --- | --- | --- |
| Read historical Room, attachment metadata, project facts, audit | allow | allow | allow | only current authorized scope; otherwise 403 | current Human members remain allowed and auditable. |
| Transfer ownership | allow to current Human member | 403 | 403 | 403 | allow only the existing-member handoff needed before owner exit; no runtime wake-up. |
| Promote/demote admin | allow | 403 | 403 | 403 | reject: privilege expansion/change is not a reduction. |
| Invite/accept new Human or expand Agent assignment | allow active only | allow active only for ordinary Agent assignment | 403 | 403 | 409 `room_archived`. |
| Remove/demote member; remove/reduce ordinary Agent | allow after conflict gate | allow only member/Agent, never owner/admin peer | self leave only after conflict gate | 403 | allow as safety reduction, never wake business runtime. |
| Archive/reopen | allow | allow | 403 | 403 | archive/reopen only their valid transition; repeat is idempotent. |
| Message/project/memory mutation; new invocation; business timer/notification escalation | allow active only when owning FT permits | same | same | server internal only with recheck | 409 `room_archived`; no enqueue/ACK/event/outbox for rejected business mutation. |
| Session revoke / confirmation-grant reduction | FT-01 authorized session principal | FT-01 policy | FT-01 policy | no client Agent authority | allowed independently; security expiry/revoke is never paused. |

## 6. AuthorityWorker transaction boundaries

`AuthorityWorker` remains the only writer. No renderer, WebSocket handler, timer, runtime, snapshot worker, outbox dispatcher, or Desktop cache edits an authority fact. Each accepted FT-02 command performs within one `BEGIN IMMEDIATE … COMMIT` boundary:

1. reauthenticate session and derive Human principal in the worker;
2. read Room, lifecycle/governance revision, current membership and archive state;
3. authorize role and archive allowlist; compare expected revision; resolve final responsibility conflicts where applicable;
4. update domain rows and immutable audit rows; for archive/reopen call registered transaction-local participants in a deterministic order;
5. append stable Room and necessary identity events; create all room/principal/session-family outbox rows; persist idempotency receipt and ACK result;
6. commit, then only the dispatcher may deliver. A committed ACK never means all recipients, timers, runtime or external effects have completed.

**Archive participant order** is fixed: (a) CAS Room to archived plus generation/time; (b) freeze registered business timers; (c) FT-10 settles undispatched confirmation/grant/execution; (d) fence queued business route/runtime/steward work; (e) append governance event/audit/outbox. Any error rolls back all five parts. Participant output is a closed summary, not a second writer.

**Reopen participant order** is fixed: (a) CAS archived to active; (b) calculate new due/review timestamps from frozen remaining duration using the reopen transaction clock; (c) clear only successfully resumed freezes; (d) append audit/event/outbox; (e) after commit, schedulers may rescan. Security expiry/grant state is never recomputed from archive duration.

`room.member.remove`/leave finalizes only after `DepartureResponsibilityPort` returns no conflict in the same transaction. If its preflight was stale, the command produces `departure_blocked`, leaves membership untouched, and supplies a new list. This closes the query-to-remove race.

## 7. SQLite migration and invariant design

### 7.1 Version coordination

At audit time [`packages/server/src/persistence/schema.ts`](../../packages/server/src/persistence/schema.ts) declares schema v11, while the untracked FT-01 plan proposes a v12 session-family migration. FT-02 must **not** reserve `v12`, hard-code any next version, or change a historical migration. At integration, the owner of the merged migration queue assigns the next serial immutable version after FT-01's actually merged schema, recomputes only that new migration checksum/fingerprint/contract, and runs FT-01 + FT-02 historical-upgrade compatibility tests together.

### 7.2 Target physical model

The implementation may rebuild current membership representation in its new migration, but must preserve source data and existing historical migration fingerprints.

| Structure | Required fields / constraint | Purpose |
| --- | --- | --- |
| `rooms` extension | `owner_actor_id`, `governance_revision`, `archive_generation`, `archived_at` | canonical exactly-one owner, CAS, lifecycle generation. |
| current Human membership | Human role is only `admin`/`member`; owner is derived from `rooms.owner_actor_id`; Agent rows retain Agent-specific fields | avoids two independently writable owner representations. |
| composite deferred FK | `(rooms.id, rooms.owner_actor_id)` references current Human membership of that Room; trigger verifies target Actor kind is Human | a Room cannot commit with missing/non-Human owner. |
| unique/current membership | `(room_id, actor_id)` unique; each member has one kind-compatible shape | no duplicate/dual Human-Agent membership. |
| governance audit | immutable type/actor/target/time/revision/result/details JSON under closed parser | explains transfer, archive/reopen and reductions without deleting history. |
| `room_business_timer_freezes` | `(room_id, archive_generation, timer_key)` unique, source kind/id, original due, non-negative remaining duration, frozen timestamp | makes due/review/boundary pause durable and restart-safe. |
| FT-10 archive settlement fields | closed rejected/revoked reason/time on confirmations/grants and an immutable relation to dispatch state | distinguishes rejected-before-dispatch from dispatched/unknown; exact table ownership coordinates with FT-10. |

Because SQLite checks unique constraints statement-by-statement, do **not** implement exactly-one owner using two role updates plus a partial unique index. The canonical `rooms.owner_actor_id` plus deferred composite FK lets ownership change in one row update, while the API projection still returns `HumanRoomRole: "owner"`. Triggers reject direct membership deletion/demotion of the recorded owner unless the same transaction has changed `owner_actor_id` to an existing Human member. Handler authorization remains the primary policy; database constraints make malformed imports/direct SQL fail closed.

Additional migration-time validators must prove:

- every Room has exactly one current Human owner membership; no Agent and no foreign-room membership can satisfy it;
- all current business records and immutable references have matching Room IDs and valid source/owner membership at the point demanded by their owning state machine;
- active frozen timers have exactly one active archive generation and no negative remaining duration;
- no `tool_dispatches` row is called revoked; unconsumed confirmation/grant settlement is distinguishable from a consumed/dispatch row;
- rooms are never permanently deleted by FT-02 migration or command;
- schema history/checksum/fingerprint, future-version refusal, unknown-schema refusal and all migration failure rollback retain the existing strict behavior.

## 8. Archive/reopen runtime, sync, repair and outbox

### 8.1 State entrance and gates

Every command/query/worker resume/dispatch/context build/download performs an authoritative Room lifecycle recheck. `archived` permits only history/audit/attachment/project fact reads for current authorization and the closed safety-reduction allowlist. It blocks message/project/memory writes, new invocation/intents, normal Agent assignment expansion, steward, routing, business timers and business notification escalation before these paths allocate work or emit a durable business event.

On startup, recoverers first read Room lifecycle. They must not requeue archived route/execution/steward/timer work. A durable queued task created before archive is cancelled/fenced only where it has no dispatched external effect; an already-dispatched operation retains its record and follows FT-10 outcome handling. Reopen schedules a bounded rescan after commit; it never replays a frozen pre-archive timer as though its original absolute due timestamp remained valid.

### 8.2 Outbox

The archive transaction creates one durable lifecycle event/outbox sequence after all freeze/settlement writes commit. Pending pre-archive business outbox delivery is authorization-checked at send time; it can be delivered at-least-once only if it represents a committed historical fact, but it must not cause a post-archive worker mutation. `OutboxDispatcher` treats archive/remove/revoke as current-access changes before sending and continues to use stable `eventId` de-duplication. A lost lifecycle ACK retries from idempotency; a crash after commit repeats delivery, not the transition/audit.

### 8.3 Sync and repair

Reuse [`packages/server/src/sync-service.ts`](../../packages/server/src/sync-service.ts), [`packages/server/src/persistence/snapshot-worker.ts`](../../packages/server/src/persistence/snapshot-worker.ts), [`packages/desktop/src/sync/client-sync-replica.ts`](../../packages/desktop/src/sync/client-sync-replica.ts), and their cursor/barrier protocol:

1. lifecycle/revision is part of Room summary, delta and full repair projection;
2. archive and access-reduction mutations preempt a streaming repair barrier just as current access-reducing mutations do; a subsequent page/complete is forbidden/stale, never leaks a fixed view;
3. an authorized archived member may repair into a complete **read-only** snapshot; a removed member discards staging and invokes the FT-01/13 cache invalidation seam;
4. `ClientSyncReplica` commits a snapshot atomically only after checksum and completion rules; it applies governance events by `eventId` and never uses local archive state as authority;
5. reopening is another Room event. The replica starts business controls only after the matched ACK/event projection says active, not from an optimistic button click.

## 9. Desktop UI mapping

The implementation extends existing [`packages/desktop/src/renderer/app.ts`](../../packages/desktop/src/renderer/app.ts), [`packages/desktop/src/renderer/styles.css`](../../packages/desktop/src/renderer/styles.css), [`packages/desktop/src/sync/client-sync-replica.ts`](../../packages/desktop/src/sync/client-sync-replica.ts) and tests. It follows J-07 and the settings drawer requirements in `REQ-UX-003`～`REQ-UX-007`; the current review-only join controls are not proof of live governance.

| UI surface | Source of truth | Required states/actions |
| --- | --- | --- |
| Room list | catalog ACK/event/projection | active vs archived entry, selected state, archive badge; revoked Room disappears only after authority access event/cache purge. No cross-Room inbox. |
| Settings → Governance | current governance projection | owner/admin/member labels; controls disabled with text explanation but server still enforces; owner transfer picker restricted to current Human members; admin peer controls absent/disabled. |
| Leave/remove sheet | `room.departure.conflicts` query and final command error | grouped, actionable closed conflict list with source link and only allowed transfer/complete/escalate/revoke actions; a stale final 409 replaces the list without claiming success. |
| Archive confirmation | archive ACK/event | purpose/read-only warning, remaining business timer count, pending confirmation/grant settlement summary; submitting/accepted/retryable/nonretryable states keyed by `requestId`. No raw grant/parameter exposure. |
| Archived Room | server projection | persistent read-only banner with archive time/audit link; composer/project mutations/Agent controls disabled; history, attachment read and fact/audit navigation stay available. |
| Reopen control | owner/admin projection + ACK/event | auditable submit and `already_active` idempotent state; after event, controls re-enable and timer display recomputes from resumed due times. |

Accessibility is part of TDD: native buttons/labels, keyboard-operable drawer/sheet, focus moves to conflict summary or success banner, `aria-live` only for finite mutation result, and non-colour role/archived/denied indicators. UI may show local `submitting` but must not report archive, transfer, removal or reopen success until matching ACK plus stable event/projection arrives.

## 10. Existing implementation: reuse versus PRD conflict

| Reuse as foundation | Current behavior that conflicts with the approved PRD and must change in FT-02 integration |
| --- | --- |
| `AuthorityWorker`, `CommandStore`, transaction outbox, idempotency records, events/cursors, snapshot repair, `ClientSyncReplica` staging and `eventId` de-duplication. | [`room-lifecycle.ts`](../../packages/server/src/room-lifecycle.ts) has no ownership-transfer/self-leave/reopen command, and legacy archive treats archived as terminal. |
| Existing closed Human/Agent membership unions, room-scoped facts, audit persistence, auth-derived principals and per-action revalidation. | Current manager check lets admin remove peer admin; current owner guard only prevents removal of the last owner, not transfer-before-leave and exactly-one canonical ownership. |
| Existing tool confirmation/grant/dispatch tables and CAS/outcome safeguards from runtime. | Current archive blocks all member/Agent removal and archive does not atomically reject undispatched confirmations/revoke grants/freeze timer domains; it cannot claim FT-10 archive semantics. |
| Existing `room_archived` error, room event/outbox and streaming repair preemption concepts. | Current access/read checks treat archived as inaccessible, contradicting authorized historical/attachment/project-fact audit reads and J-07. |
| Existing OpenItem/LightTask/Ball facts can inform migration discovery. | They are historical M3 contracts, not FT-09 Request/NextAction/Blocker/OpenQuestion semantics; they cannot be silently relabelled as the required departure responsibilities. |
| Existing Desktop message/Agent render primitives and room join review controls. | They are static/review surfaces, lack governance conflict, archived read-only, recovery and authority ACK/event wiring; the old `silent` Agent participation is superseded by `REQ-PRIM-013` and belongs to FT-07 reconciliation. |

## 11. TDD test matrix

All rows are future evidence targets, initially **PENDING**. Tests start RED, then minimum GREEN, then focused regression. They do not mark FT-02 verified.

| ID | Contract / failure example | Evidence targets (all existing paths) |
| --- | --- | --- |
| FT02-CORE-01 | guards accept only closed governance/conflict/archive records; reject unknown fields, cross-room IDs, unknown status/resolution and secret-like extras | `packages/core/src/collaboration.test.ts`, `packages/core/src/sync.test.ts` |
| FT02-CORE-02 | compile-time Human/Agent/owner/project/conflict unions cannot be intermixed | `packages/core/src/actor.type-test.ts`, `packages/core/src/collaboration.type-test.ts` |
| FT02-GOV-01 | create/import/transfer/restart always has exactly one Human owner; transfer target must be current Human member | `packages/server/src/room-lifecycle.test.ts`, `packages/server/src/persistence/sqlite-authoritative-store.test.ts` |
| FT02-GOV-02 | exhaustive role matrix: owner admin management; admin member/ordinary-Agent only; peer-admin action and member governance are 403 | `packages/server/src/room-lifecycle.test.ts`, `packages/server/src/persistence/contracts.test.ts`, `packages/server/src/websocket.test.ts` |
| FT02-GOV-03 | owner leave/remove without transfer is 409; after exactly one transfer old owner can leave; transfer/remove races linearize with one valid owner | `packages/server/src/persistence/sqlite-authoritative-store.test.ts`, `packages/server/src/persistence/worker-database-client.test.ts` |
| FT02-EXIT-01 | each active Request/NextAction/Blocker/OpenQuestion/confirmation/acceptance produces a closed actionable conflict; no conflict list leaks another Room | `packages/server/src/primitives.test.ts`, `packages/server/src/persistence/contracts.test.ts`, `packages/server/src/persistence/sqlite-authoritative-store.test.ts` |
| FT02-EXIT-02 | final leave/remove rechecks in the same transaction; complete/transfer/escalate/reject/revoke permit only their owning legal paths; stale UI preflight cannot bypass a newly created responsibility | `packages/server/src/persistence/sqlite-authoritative-store.test.ts`, `packages/server/src/authority.e2e.test.ts` |
| FT02-ARCH-01 | archive is idempotent; active business writes/new invocation/route/steward/timer notification create zero fact/event/outbox after archive; active read remains role-scoped | `packages/server/src/websocket.test.ts`, `packages/server/src/agent-runtime/worker-runtime-authority.test.ts`, `packages/server/src/route-runtime/route-runtime-service.test.ts` |
| FT02-ARCH-02 | undispatched confirmation is `rejected(room_archived)`, grant is revoked, waiting execution is terminally fenced; dispatched effect is not called revoked and may be outcome_unknown | `packages/server/src/agent-runtime/worker-runtime-authority.test.ts`, `packages/server/src/agent-runtime/tool-gateway.test.ts`, `packages/server/src/persistence/sqlite-authoritative-store.test.ts` |
| FT02-ARCH-03 | security expiry still passes while archived; session revoke, member/Agent remove and capability/grant reduction work immediately yet do not wake Agent/steward/timer | `packages/server/src/auth.test.ts`, `packages/server/src/websocket.test.ts`, `packages/server/src/agent-runtime/agent-runtime-service.test.ts` |
| FT02-ARCH-04 | freeze exact remaining business duration, restart while archived, reopen once, and execute only after resumed boundary; expired confirmation/grant does not revive | `packages/server/src/persistence/sqlite-authoritative-store.test.ts`, `packages/server/src/ball-runtime/ball-runtime-service.test.ts`, `packages/server/src/authority.e2e.test.ts` |
| FT02-SYNC-01 | delta and materialized/streaming repair reproduce archived governance, current memberships, conflict-related projections and timer freeze; removed member repair aborts/clears | `packages/server/src/sync-service.test.ts`, `packages/server/src/persistence/snapshot-worker-client.test.ts`, `packages/desktop/src/sync/client-sync-replica.test.ts` |
| FT02-SYNC-02 | archive/remove preempts repair barrier; duplicate outbox lifecycle frame is one replica apply; crash before commit rolls back fact/event/outbox/idempotency, crash after commit replays same event ID | `packages/server/src/outbox-dispatcher.test.ts`, `packages/server/src/authority.e2e.test.ts`, `packages/server/src/persistence/worker-database-client.test.ts` |
| FT02-CAS-01 | same scope/key/payload replay is identical before/after restart; same key/different payload conflicts; parallel archive/reopen/transfer/remove gets one linearized result and no duplicate audit/outbox | `packages/server/src/persistence/sqlite-authoritative-store.test.ts`, `packages/server/src/persistence/worker-database-client.test.ts` |
| FT02-MIG-01 | fresh migration contains exact new schema contract/invariants; every historical version including FT-01's actually merged predecessor upgrades without data loss | `packages/server/src/persistence/schema.test.ts`, `packages/server/src/persistence/legacy-importer.test.ts` |
| FT02-MIG-02 | future/unknown/checksum/fingerprint tampering refuses; injected mid-migration failure rolls schema/data/user_version/history back as one transaction | `packages/server/src/persistence/schema.test.ts` |
| FT02-UI-01 | settings role controls, ownership handoff, conflict grouping and request-correlated loading/failure do not optimistically claim success | `packages/desktop/src/renderer/app.test.ts` |
| FT02-UI-02 | archive banner/read-only controls/history/audit/reopen/revocation/repair states are keyboard accessible, non-colour and event-driven | `packages/desktop/src/renderer/app.test.ts`, `packages/desktop/src/sync/client-sync-replica.test.ts` |

## 12. Definition of implementation readiness

FT-02 is ready to start only when the integrator has reconciled the actual FT-01 merge with §3/§7.1, chosen the serial migration version, and obtained concrete FT-09/FT-10 archive/departure port contracts. It is ready to claim delivery only after every relevant matrix row has reproducible evidence, all compatibility/migration/crash/restart gates pass, and a delivery note truthfully states unresolved cross-FT boundaries. Neither this design nor the implementation plan is verification evidence.
