# FT-10 Shared Authority Production Providers 工作记录

> 日期：2026-08-19
>
> 状态：production provider 实现；不是 FT-10、FT-02C、Blueprint 或阶段 verified 声明
>
> 分支：`codex/stage3-ft10-tool-safety`
>
> worktree：`/Users/leo/code/Dao-stage3-ft10-tool-safety`

## 1. 权威映射与范围

本切片落实 `REQ-ROOM-003/004`、`REQ-AGT-010/012/013`、`REQ-NFR-011/014` 的两个
server-private provider：

- `PendingConfirmationDepartureContributor` 只读同一 AuthorityWorker transaction 中目标
  Human principal 的当前 pending confirmation，并输出闭合、脱敏、稳定的 departure conflict；
- `ArchiveToolSafetyParticipant.settleUndispatched` 在同一 writer transaction 中拒绝 pending
  confirmation、撤销 active/unclaimed grant、fence 尚未 dispatch 的 waiting execution，并为所有
  已 claim/dispatch/known/outcome-review 事实只写“preserved” ledger，绝不改写 dispatch 结果。

生产 registration 固定为：

| export | registration ID | feature |
| --- | --- | --- |
| `pendingConfirmationDepartureContributorRegistration` | `dao.tool-safety.pending-confirmation-departure.v1` | `pending-confirmation-departure` |
| `archiveToolSafetyParticipantRegistration` | `dao.tool-safety.archive-settlement.v1` | `archive-settlement` |

本切片不修改 schema、AuthorityWorker、handler、shared registry、package root、public protocol、
WebSocket、Desktop 或 Blueprint，也不启用 public leave/remove/archive/reopen coordinator。

UI / 交互映射：本次没有新增可见状态，不修改 J-01～J-07、loading/empty、401/403/409/410/
429/503、offline/repair、键盘、焦点、非颜色、`aria-live`、缩放或 reduced motion。未来 departure
conflict 由 J-04 消费 closed projection，archive settlement 由 J-05/J-07 消费 stable event/repair
projection；本切片不制造这些可见状态。设计偏离：**无**。

## 2. Pending confirmation 只读合同

只有同时满足以下事实的 confirmation 才贡献 conflict：

1. `confirmation_state = pending` 且 `consumed_at IS NULL`，`expiresAt > server now`；
2. confirmation 的 execution/attempt/tool/room/principal/session family/parameter SHA-256 完整；
3. execution 当前 attempt 与 confirmation attempt 相同，execution/attempt 均为 `running` 且
   `waiting_upstream`；
4. matching grant 的 execution/attempt/tool/room/parameter SHA-256 完全相同，状态为
   `active`、未 consumed；
5. session family 仍绑定同一 Human、未 revoke、refresh authority 未过期，Human 仍为同 Room
   current membership。

rejected、expired、revoked、claimed、terminal 或其他 principal/Room 的事实不阻塞。绑定缺失、
重复 grant、hash mismatch、非法状态或 cross-Room persistence 不能解释为空责任，而是 closed 503。
输出只含 fixed title/state、stable source/subject ID、hash-derived conflict ID、revision 与 closed
allowed resolutions；不含 target、impact、params、params hash、session family、grant、正文或 secret。

## 3. Archive settlement 状态分流

固定 CAS 顺序为：

1. 验证 Room 已在同一 transaction 进入目标 `archive_generation`；
2. 验证 confirmation/grant/execution/attempt/dispatch 物理绑定；
3. `pending + unconsumed confirmation → rejected(room_archived)`；
4. `active + unconsumed grant → revoked(room_archived)`；
5. `queued/running + waiting_upstream` 或 `tool_call/not_started` 且 execution 没有任何 dispatch
   → execution/attempt `cancelled(room_archived)`；
6. grant claimed 或任何 claimed/dispatched/succeeded/failed/outcome_unknown/review dispatch 只写
   `preserved_dispatched` ledger，不更新原 dispatch；
7. 按 `(room_id, archive_generation, subject_kind, subject_id)` 写 durable member ledger并回算四个
   count；重复调用读取同一 ledger，restart 后结果不漂移。

provider 没有 adapter 参数、handle 或 callback；未 dispatch 拒绝路径物理 adapter call count 为 0。
claim 与 archive 由 AuthorityWorker `BEGIN IMMEDIATE` 决定 winner：archive 先提交则后续 active/pending
CAS 为 0；claim 先提交则 archive 保留 claimed grant/dispatch，绝不写 revoked/cancelled/rollback。

## 4. 中央 v14 migration 精确要求

本分支不拥有 schema。中央 migration owner 应追加等价的 immutable statements；不得修改 v1～v13：

```sql
ALTER TABLE tool_confirmations
  ADD COLUMN confirmation_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (confirmation_state IN ('pending', 'confirmed', 'rejected', 'expired'));
ALTER TABLE tool_confirmations ADD COLUMN confirmation_reason TEXT;
ALTER TABLE tool_confirmations
  ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (confirmation_revision >= 0);
ALTER TABLE tool_confirmations ADD COLUMN confirmation_changed_at TEXT;

ALTER TABLE agent_execution_grants
  ADD COLUMN grant_state TEXT NOT NULL DEFAULT 'active'
  CHECK (grant_state IN ('active', 'claimed', 'revoked', 'expired'));
ALTER TABLE agent_execution_grants ADD COLUMN grant_reason TEXT;
ALTER TABLE agent_execution_grants
  ADD COLUMN grant_revision INTEGER NOT NULL DEFAULT 0
  CHECK (grant_revision >= 0);
ALTER TABLE agent_execution_grants ADD COLUMN grant_changed_at TEXT;

-- Historical rows are not silently made resumable.
UPDATE tool_confirmations
SET confirmation_state = CASE
      WHEN consumed_at IS NULL THEN 'rejected' ELSE 'confirmed' END,
    confirmation_reason = CASE
      WHEN consumed_at IS NULL THEN 'legacy_unbound' ELSE NULL END;
UPDATE agent_execution_grants
SET grant_state = CASE
      WHEN consumed_at IS NULL THEN 'revoked' ELSE 'claimed' END,
    grant_reason = CASE
      WHEN consumed_at IS NULL THEN 'legacy_unbound' ELSE NULL END;

CREATE TABLE tool_archive_settlements (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
  settled_at TEXT NOT NULL,
  rejected_pending_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_pending_count >= 0),
  revoked_grant_count INTEGER NOT NULL DEFAULT 0 CHECK (revoked_grant_count >= 0),
  fenced_waiting_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_waiting_count >= 0),
  preserved_dispatched_count INTEGER NOT NULL DEFAULT 0 CHECK (preserved_dispatched_count >= 0),
  PRIMARY KEY (room_id, archive_generation)
) STRICT;

CREATE TABLE tool_archive_settlement_members (
  room_id TEXT NOT NULL,
  archive_generation INTEGER NOT NULL,
  subject_kind TEXT NOT NULL
    CHECK (subject_kind IN ('confirmation', 'grant', 'execution', 'dispatch')),
  subject_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN (
    'rejected_pending', 'revoked_unclaimed', 'fenced_waiting', 'preserved_dispatched'
  )),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (room_id, archive_generation, subject_kind, subject_id),
  FOREIGN KEY (room_id, archive_generation)
    REFERENCES tool_archive_settlements(room_id, archive_generation)
) STRICT;

CREATE INDEX tool_confirmations_departure_v14
  ON tool_confirmations(
    room_id, human_principal_id, confirmation_state, expires_at, confirmation_id
  );
CREATE INDEX agent_execution_grants_archive_v14
  ON agent_execution_grants(room_id, grant_state, grant_id);
CREATE INDEX tool_dispatches_execution_attempt_v14
  ON tool_dispatches(execution_id, attempt_seq, state);
CREATE INDEX tool_archive_settlement_members_disposition_v14
  ON tool_archive_settlement_members(room_id, archive_generation, disposition, subject_id);

CREATE TRIGGER tool_confirmations_binding_immutable_v14
BEFORE UPDATE OF execution_id, attempt_seq, tool_id, parameter_sha256, room_id,
  human_principal_id, session_family_id, expires_at ON tool_confirmations
BEGIN
  SELECT RAISE(ABORT, 'tool confirmation binding is immutable');
END;

CREATE TRIGGER tool_confirmations_state_insert_v14
BEFORE INSERT ON tool_confirmations
WHEN (NEW.confirmation_state = 'pending' AND NEW.consumed_at IS NOT NULL)
  OR (NEW.confirmation_state = 'confirmed' AND NEW.consumed_at IS NULL)
  OR (NEW.confirmation_state IN ('rejected', 'expired') AND NEW.consumed_at IS NOT NULL)
  OR (NEW.confirmation_revision > 0 AND NEW.confirmation_changed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'tool confirmation state is invalid');
END;

CREATE TRIGGER tool_confirmations_state_update_v14
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
END;

CREATE TRIGGER agent_execution_grants_binding_immutable_v14
BEFORE UPDATE OF execution_id, attempt_seq, agent_id, room_id, tool_id,
  parameter_sha256, issued_at, expires_at ON agent_execution_grants
BEGIN
  SELECT RAISE(ABORT, 'tool grant binding is immutable');
END;

CREATE TRIGGER agent_execution_grants_state_insert_v14
BEFORE INSERT ON agent_execution_grants
WHEN (NEW.grant_state = 'active' AND NEW.consumed_at IS NOT NULL)
  OR (NEW.grant_state = 'claimed' AND NEW.consumed_at IS NULL)
  OR (NEW.grant_state IN ('revoked', 'expired') AND NEW.consumed_at IS NOT NULL)
  OR (NEW.grant_revision > 0 AND NEW.grant_changed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'tool grant state is invalid');
END;

CREATE TRIGGER agent_execution_grants_state_update_v14
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
END;
```

这些 trigger 规定 confirmation 只允许 `pending→confirmed/rejected/expired`，grant 只允许
`active→claimed/revoked/expired`，且 state 改变时 revision 恰好 `+1`。schema physical validation
还必须复核 settlement header counts 与 member ledger完全相等、member subject 绑定同 Room，并拒绝
future generation、cross-Room、重复或敏感字段。

## 5. AuthorityWorker / handler / composition 接线要求

1. `runtime.prepare-tool` 的新 production INSERT 必须显式写 confirmation `pending` 与 grant
   `active`（legacy backfill不能依赖 column default）；reject/expiry/revoke生产路径同步迁移状态/revision。
2. `runtime.claim-tool` 在同一 transaction 的完整权限/binding重验后，以 CAS 把 confirmation
   `pending→confirmed + consumed_at`、grant `active→claimed + consumed_at`，再插 dispatch；任一
   `changes !== 1` 时 dispatch/event/outbox/adapter permit全部零写。
3. FT-09 `DepartureResponsibilityPort` 在 manifest 启用 FT-10 时必须装配
   `pendingConfirmationDepartureContributorRegistration`，并在 departure preflight 与 membership
   mutation 前 final recheck 都用同一 branded transaction调用；缺失/throw/malformed/cross-Room均503。
4. FT-02C archive transaction 在 lifecycle CAS、message gate、business timer suspension后调用
   `archiveToolSafetyParticipantRegistration`，随后才调用 runtime archive fence；任一 provider失败由
   外层 AuthorityWorker transaction整体 rollback。不得用 post-commit settlement。
5. restart scanner 对已 archived Room、缺失该 generation tool settlement ledger的记录，在新的
   bounded room transaction调用同一 participant；已有 ledger只校验/重放，不调用adapter、不恢复
   rejected/revoked/expired事实。
6. production composition manifest 精确启用两个 feature并注册上表两个 registration；package root、
   Core、protocol、preload、renderer不导出 participant或 transaction capability。
7. public FT-02B leave/remove与 FT-02C archive/reopen在下一阶段 coordinator完成前继续
   `dependency_unavailable` fail closed。

## 6. TDD 证据

本切片从缺失 production module 的 2 个 failing suites 开始，再补最小实现。focused tests使用真实、
非空、`foreign_keys=ON` SQLite（含文件数据库与独立 observer），覆盖：

- 同 writer 未提交事实可见、其他 connection提交前不可见；
- exact binding与 rejected/revoked/expired/claimed/terminal exclusion；
- restart、rollback、idempotent durable ledger；
- pending reject、unclaimed revoke、waiting fence、claimed/dispatched/succeeded/outcome_unknown/review
  preserve；
- archive-before-claim / claim-before-archive双顺序和未 dispatch adapter 0 call；
- invalid capability、stale/cross-Room generation、malformed/hash mismatch与敏感 canary零 DTO泄漏。

最终命令与提交 SHA 由该分支交付报告记录。
