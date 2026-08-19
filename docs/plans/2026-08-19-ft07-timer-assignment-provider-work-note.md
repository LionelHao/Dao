# FT-07 Assignment 安全收缩与业务 timer suspension production provider 工作说明

> 日期：2026-08-19
> 分支：`codex/stage3-ft07-timers-assignment`
> 实施基线：`origin/main@f1e2812492914f286c6ee143427739255ee0324e`
> 状态：feature-local production provider 已实现；等待 migration/composition owner 串行接线，public archive/reopen 仍关闭

## 1. 权威映射与范围

| 落点 | Requirement / FT | 本次权威事实与行为 |
| --- | --- | --- |
| Assignment 安全收缩 | `REQ-ID-004`、`REQ-AGT-004`、`REQ-ROOM-004`、`REQ-NFR-014`；FT-07、FT-02C | 只读取 canonical Global Profile / Room Assignment / actor / Room lifecycle；归档 generation 写 durable expansion fence；只向安全收缩命令提供 transaction-local gate；结果返回持久化的 `policyVersion`、真实 current Assignment revision 与固定 `businessWakeUpCount: 0`。 |
| 业务 timer suspension | `REQ-ROOM-004`、`REQ-PRJ-012`～`REQ-PRJ-013`、`REQ-NFR-014`；FT-02C | 聚合 exact enabled descriptor 集合；保存真实 source、原 due 与剩余时长；重开只恢复仍由 descriptor 报告为合法的 timer；expired/terminal/claimed work 不复活。 |
| race 与安全 expiry | `REQ-AGT-012`～`REQ-AGT-013`、`REQ-NFR-002`、`REQ-NFR-011`、`REQ-NFR-014`；FT-08、FT-10、FT-13 | claim/fire gate、archive CAS 与 freeze 必须在同一 AuthorityWorker `BEGIN IMMEDIATE` writer 上线性化；session、confirmation、grant、offline lease 等绝对安全 expiry 不进入 descriptor，也不被改写或按 archive 时长延长。 |

本切片没有 Core/public protocol、WebSocket、preload、renderer、Desktop 或 UI 可见状态；J-01～J-07 的 loading/empty/401/403/409/410/429/503/offline/repair、键盘、焦点、非颜色识别、可访问通告、缩放与 reduced motion 均不适用。所有结果都是 server-private transaction participant output，不是用户可见 ACK/projection。设计偏离：无。

明确未做：不修改 schema/version/checksum/fingerprint、AuthorityWorker、handler、shared participant contract/registry、package root export、Blueprint、UI；不开放 public archive/reopen；不复制旧 actor/membership 静态 seed、route reducer 或 runtime reducer。

## 2. Production exports 与 closed registration

Assignment production module：

- `assignmentSecurityReductionParticipantRegistration`
  - registration ID：`dao.room-assignment.security-reduction.v1`
  - feature：`assignment-security-reduction`
  - version：`1`
- `createAssignmentSecurityReductionParticipant`
- `requireAssignmentExpansionAllowedInTransaction`
- `requireAssignmentSecurityReductionAllowedInTransaction`

Timer production module：

- `businessTimerSuspensionParticipantRegistration`
  - registration ID：`dao.business-timers.suspension.v1`
  - feature：`business-timer-suspension`
  - version：`1`
- `createBusinessTimerSuspensionParticipantRegistration`
- `createBusinessTimerSuspensionProductionRegistration`
- `businessTimerFeatureManifest`
- `businessTimerDescriptorRegistrations`
- `createBallBoundaryBusinessTimerDescriptorRegistration`
- `isBusinessTimerClaimAllowedInTransaction`

当前仓库实际 enabled business timer descriptor 集合是严格单元素闭集：

| descriptor / registration ID | version | enabled | 真实来源 |
| --- | --- | --- | --- |
| `dao.ball-runtime.business-boundaries.v1` | `1` | `true` | v13 `open_items` 的 `awaiting/transferred` 与 `light_tasks` 的 `claimed/delivered`，结合 current holder actor kind、Ball deadline policy 与既有 `ball_boundary_claims`。 |

默认 production export 使用 AuthoritativeServer 当前同值默认 policy（OpenItem/LightTask 都是 24h）。若 server options 配置了非默认 Ball deadline，composition 必须调用 `createBusinessTimerSuspensionProductionRegistration(ballPolicy)`，把与 `createBallRuntimeService` 完全相同的两个 deadline 值注入，不能让 runtime 与 freeze descriptor 使用不同 policy。

Descriptor 的 `timerKey` 必须以 descriptor ID 命名空间开头；Ball key 还绑定 source kind/id、holder actor/kind、`sinceAt` 与 boundary kind。聚合器拒绝 enabled-but-missing、未知/额外 manifest key、version mismatch、重复 registration ID/feature、manifest mismatch、throw、malformed、跨 Room 与非命名空间 key，统一返回 Shared Spine 的安全 503 envelope，不泄漏异常或业务内容。

## 3. Assignment 生产语义

`reduceForArchive` 通过 branded transaction capability 取得同一 SQLite connection，并在同一事务中：

1. 验证 Room 已是相同 archive generation/time；
2. join `room_agent_assignments`、`agent_profiles` 与 `actors`，拒绝 cross-actor Profile、非 Agent actor、无效状态/participation/paused、非 canonical subset 与任何超过 Profile ceiling 的 capability/tool；
3. 计算 current Assignment 真实 revision 的最大值（空集合为 `0`）；
4. 为 `(room_id, archive_generation)` 写一次 immutable archive policy，按 Room 单调增加 `policy_version`；
5. replay 返回持久化原结果；不创建 route job、execution、event/outbox 或任何业务 wake-up。

Assignment create/resume/participation expansion/subset expansion 必须先调用 `requireAssignmentExpansionAllowedInTransaction`。归档时它固定拒绝；active 且 generation 匹配时才允许继续进入 owning FT-07 command 的 ACL/CAS/subset validator。pause/remove/capability 或 tool subset reduction 可调用 `requireAssignmentSecurityReductionAllowedInTransaction`，但 owning handler 仍必须执行 FT-02 owner/admin ACL、expected revision、immutable audit/event/cache invalidation；该 gate 不替代这些权威检查，也绝不唤醒 route/runtime/timer。

Global Profile disable/ceiling reduction、session revoke、member/Agent remove、grant reduction由各 owning FT 的命令和 audit 负责；本 provider 不越权复制其 reducer。它提供的 archive policy 与 transaction gate只保证 Assignment expansion 不能从 FT-07 路径绕过。

## 4. Timer 生产语义

Suspend 在 Room lifecycle CAS 之后、同一事务时钟内调用 enabled descriptors。每个未来 timer 保存 source kind/id、原 due、严格非负 remaining duration 与 frozen timestamp；在 archive 时已到期的 timer不创建 freeze。即使实际 timer 集合为空，batch 也持久化 `suspended_count = 0` 与 exact descriptor ID 集合，因此 rollback/restart/replay不会把“已经完成的空聚合”误当尚未执行。

Resume 在 Room 已 CAS 回 active、相同 generation 的事务中重新调用同一 descriptor 集合。只有同一个 namespaced timer key仍存在于真实 current facts 才更新为 `resumed`，新 due 为 `reopenedAt + remainingMs`；已经 answered/rejected/revoked/verified/done、Ball boundary 已 claim 或不再由 current holder拥有的 key变为 `discarded`。batch 固定首次 resume count/time，重复/restart resume返回持久化原结果。

Ball claim/fire path 必须在插入 `ball_boundary_claims` 前、同一 `BEGIN IMMEDIATE` transaction view 中调用 `isBusinessTimerClaimAllowedInTransaction`，并使用返回的 authoritative `dueAt`：

- archived/frozen：`room_archived`；
- discarded：`timer_discarded`；
- 未到恢复后的 due：`not_due`；
- 既有 claim：`already_claimed`；
- 仅 active、未 claim且到期才返回 timer key/due permit。

因此 archive CAS、freeze、claim 与 claim insert由同一 writer排序；不能先调外部 adapter再补 gate。重开提交后只允许 bounded rescan，不能直接 fire；scan/claim仍重验 Room、freeze 与既有 claim。

## 5. Migration / DDL owner 接线要求

本切片按约束没有修改 `schema.ts`。FT-13 migration owner必须从合入时真实 predecessor分配唯一 migration version，并同步 checksum/fingerprint/历史升级/rollback/fault tests。Provider依赖以下 canonical Profile/Assignment列与 durable表。

Profile / Assignment 必需列：

```sql
-- 可增加 owning FT 已批准的 provenance/audit timestamp 等列；下列是 provider 精确读取面。
agent_profiles(
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  capability_ceiling_json TEXT NOT NULL,
  tool_ceiling_json TEXT NOT NULL
);

room_agent_assignments(
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  agent_actor_id TEXT NOT NULL REFERENCES actors(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('current', 'removed')),
  participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  capability_subset_json TEXT NOT NULL,
  tool_subset_json TEXT NOT NULL
);

CREATE UNIQUE INDEX room_agent_assignments_one_current_agent
ON room_agent_assignments(room_id, agent_actor_id)
WHERE status = 'current';

CREATE TABLE room_assignment_archive_policies(
  room_id TEXT NOT NULL REFERENCES rooms(id),
  archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 0),
  expansion_blocked INTEGER NOT NULL CHECK (expansion_blocked = 1),
  reduced_at TEXT NOT NULL,
  PRIMARY KEY(room_id, archive_generation),
  UNIQUE(room_id, policy_version)
) STRICT;
```

Migration validator/trigger还必须证明：Profile actor与Assignment agent actor一致且为 Agent；JSON是已知 closed registry的 sorted/unique canonical string array；Assignment subsets不超过Profile ceilings；一个Room/Agent最多一个current Assignment；removed历史不删除；正常重启不允许static options覆写这些表。

Timer 表沿用 FT-02 design 已批准名称 `room_business_timer_freezes`：

```sql
CREATE TABLE room_business_timer_freeze_batches(
  room_id TEXT NOT NULL REFERENCES rooms(id),
  archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
  suspended_at TEXT NOT NULL,
  suspended_count INTEGER NOT NULL CHECK (suspended_count >= 0),
  resumed_at TEXT,
  resumed_count INTEGER CHECK (resumed_count >= 0),
  descriptor_ids_json TEXT NOT NULL
    CHECK (json_valid(descriptor_ids_json) AND json_type(descriptor_ids_json) = 'array'),
  PRIMARY KEY(room_id, archive_generation),
  CHECK ((resumed_at IS NULL) = (resumed_count IS NULL))
) STRICT;

CREATE TABLE room_business_timer_freezes(
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
  PRIMARY KEY(room_id, archive_generation, timer_key),
  CHECK (
    (state = 'frozen' AND resumed_due_at IS NULL AND resolved_at IS NULL)
    OR (state = 'resumed' AND resumed_due_at IS NOT NULL AND resolved_at IS NOT NULL)
    OR (state = 'discarded' AND resumed_due_at IS NULL AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX room_business_timer_freezes_latest
ON room_business_timer_freezes(room_id, descriptor_id, timer_key, archive_generation DESC);

CREATE INDEX room_business_timer_freezes_generation_state
ON room_business_timer_freezes(room_id, archive_generation, state);
```

`descriptor_ids_json`必须是 sorted/unique closed descriptor IDs；batch count必须与该 generation的 freeze rows相等；未 resume batch只能全是 `frozen`，已 resume batch不能残留 `frozen`，`resumed_count`必须等于 `resumed` rows。Migration/startup validator应复用相同不变量。

## 6. Coordinator / handler / composition 接线顺序

1. `authoritative-server.ts` 的 private composition注册 `assignmentSecurityReductionParticipantRegistration`。Timer在默认 Ball policy时可注册 `businessTimerSuspensionParticipantRegistration`；存在 server配置时必须改用 `createBusinessTimerSuspensionProductionRegistration`并传同一个effective Ball policy。
2. FT-02 archive transaction严格按 sliced note §5.2 C1：Room lifecycle CAS → message gate → `BusinessTimerSuspensionParticipant.suspendForArchive` → FT-10 undispatched settlement → runtime fence → `AssignmentSecurityReductionParticipant.reduceForArchive` → lifecycle repair descriptor → cache/lease invalidation intent → audit/event/outbox/idempotency → commit。任一 envelope失败全部 rollback。
3. reopen transaction：Room CAS为active → `resumeAfterReopen` → audit/event/outbox/idempotency → commit；after-commit仅安排 bounded Ball rescan。不得提前重新调度或调用 adapter。
4. `executeBallAuthorityOperation`/对应 claim handler在其现有 `BEGIN IMMEDIATE` 内mint/release database-backed transaction view，先调用 `isBusinessTimerClaimAllowedInTransaction`，再用permit due写唯一 `ball_boundary_claims`。不要另开第二 transaction/writer。
5. FT-07 Assignment create/resume/participation/subset expansion接 expansion gate；pause/remove/subset reduction接 security-reduction gate并继续写 owning FT immutable audit/event/cache invalidation。归档安全收缩的业务 wake-up/route/runtime/outbox escalation计数必须为零。
6. participant registration、transaction capability、descriptor与claim gate保持 `packages/server` private；不从package root/public protocol/renderer导出。当前阶段public archive/reopen继续由既有fail-closed composition gate返回503。

## 7. TDD 与验证证据

RED先行：新增两个 focused test后，Vitest因两个 production module不存在而失败；随后才加入实现。

GREEN覆盖：

- exact production registration/export与单一enabled Ball descriptor；
- 真实非空v13 SQLite fixture、真实Profile/Assignment ceiling/subset/revision、durable policy；
- future/expired/terminal/claimed timer筛选，真实remaining duration，restart reopen与idempotent replay；
- empty timer batch持久化与restart replay；
- rollback无残留、second archive、claim不重复；
- 两个真实SQLite connection证明archive `BEGIN IMMEDIATE`与claim contender串行；
- session family/session、confirmation、grant的绝对expiry在archive/reopen前后逐值不变；
- forged/unbound transaction capability、cross-Room、损坏Profile subset、缺表；
- enabled missing/version/duplicate/manifest mismatch/throw/malformed/cross-Room descriptor均安全关闭，异常内容不泄漏。

交付前执行：focused Vitest、server TypeScript build/typecheck、workspace typecheck、focused/full lint、`git diff --check`、禁止路径与package boundary diff检查；最终结果与commit SHA在交付消息报告。
