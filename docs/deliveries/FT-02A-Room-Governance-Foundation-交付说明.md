# FT-02A Room Governance Foundation 交付说明

日期：2026-08-18

## 交付结论

FT-02A 基础切片实现了唯一 Human owner、owner/admin/member 角色矩阵、ownership transfer、治理 revision CAS、幂等审计事件 outbox 原子性、v13 schema、WebSocket/repair projection，以及不安全旧路径失败闭合。

本交付只说明 FT-02A 基础切片达到交付条件；不宣称完整 FT-02 完成，也不宣称 M2 verified。

## 生产实现

- Core：新增闭合 `RoomGovernanceView`、departure conflict/list 类型和严格 runtime guards/type tests；`projectId` 必须与 `roomId` 相同。
- Authority：`rooms.owner_actor_id` 是 canonical owner，membership owner role 是数据库受控镜像；不存在第二 Project aggregate/state store/event bus。
- 命令：`room.ownership.transfer` 与 `room.member.role.set` 使用 CAS；普通 role-set 只接受 admin/member。
- 原子性：transfer 的 canonical state、revision、audit、room event、identity events、outbox、idempotency record 位于一个 AuthorityWorker `BEGIN IMMEDIATE` transaction。
- 协议：新增 closed worker request/response、WebSocket governance get/mutation frames、ACK 与 403/409/503 errors。
- repair：room snapshot 增加 `governance` record；catalog/membership owner 投影读取 canonical owner。
- Desktop：只增加最小只读 governance/权限矩阵显示，含文本状态和可访问通告；未接完整 archive/冲突/责任 UI。

## schema v13 证据

- predecessor：v12；当前 version：v13。
- migration name：`room-governance-foundation`。
- immutable checksum：`0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e`。
- physical fingerprint：`037df6a2818f2a90b7394240a4cf71d77949faf31df6534c5546c9ed6b7e7191`。
- v1-v12 statement/checksum/fingerprint 未修改。
- 覆盖 fresh v1→…→v13、historical v1-v12→v13、future/unknown refusal、20 个 v13 statement fault rollback 点。
- legacy zero owner、two owners、Agent owner 在 v12→v13 前置验证中拒绝且零写；v13 canonical owner 的 null、Agent、cross-room 与第二 owner role 由 trigger/index/validation 拒绝。

## 旧公开治理入口审计

| 入口 | FT-02A 行为 | 副作用 |
| --- | --- | --- |
| admin 操作 peer admin | 403 `role_forbidden` | 0 |
| owner leave 未 transfer | 409 `ownership_transfer_required` | 0 |
| member leave / Human 或 Agent remove | 503 `dependency_unavailable`（FT-09 port 缺失） | 0 |
| archive / reopen | 503 `dependency_unavailable`（FT-10/FT-13 port 缺失） | 0 |
| legacy `human.role.change` | 503 `dependency_unavailable` | 0 |

因此没有把旧 permissive 路径宣称为新合同，也没有假装责任清理、settlement 或 archive repair 已完成。

## 测试断言收紧记录

- worker 当前 schema 断言 12→13；历史 v11 session migration 仍使用专用 v11 fixture。
- 旧 accepted legacy role/remove/archive cases 改为新 CAS role/transfer 或失败闭合断言。
- repair preemption tests 对 unsupported remove/archive 改为 503、零写、lease/cache 不变。
- direct owner deletion 与 audit mutation 改为 SQLite trigger 拒绝。
- owner role 解析统一从 canonical owner 投影，保留 LightTask/runtime 等已批准的既有语义。

## 未交付

FT-09 responsibility objects/cleanup、FT-10 settlement/timer、FT-13 encrypted cache/archive repair、完整 archive/reopen/conflict/project responsibility UI 均未实现。

## 验证

- `corepack pnpm typecheck`：通过。
- `corepack pnpm lint`：通过（0 warnings）。
- `corepack pnpm test`：通过；Test Files `54 passed | 2 skipped (56)`，Tests `995 passed | 2 skipped (997)`。
- `corepack pnpm build`：通过（core/server/desktop）。
- `corepack pnpm verify:core-boundary`：通过。
- `node scripts/verify-desktop-boundary.mjs`：通过（5 个 production renderer sources）。
- `git diff --check`：通过。

## Git / PR 交付溯源

- 工作分支：`codex/ft-02a-room-governance`；独立 worktree：`/Users/leo/code/Dao-ft02a-room-governance`。
- 原始创建基线：main commit `097a41e`；发布前该分支变基到当时的 `origin/main` `ca159f6`。
- feature commit：`003b36c9f3bb9db30a64ff13e8702fae2fd38148`。
- GitHub PR：`#26`；仓库按 squash merge 策略合入 main。
- main squash-merge commit：`fb37f7aca58665b5aad0aeda80fa3a685d45e74b`；截至本次溯源核对，它也是本地 main 与 `origin/main` 的当前提交。
- 本次交付未修改 Blueprint 或任务状态；交付范围仍仅为 FT-02A 基础切片，不代表完整 FT-02、M2 或任务 verified。
