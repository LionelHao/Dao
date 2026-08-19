# Shared Authority Production Providers · 第三阶段交付说明

> 日期：2026-08-19  
> 状态：交付条件已满足，等待 owner 验收；本文不宣布任何 FT 或 Blueprint 任务 verified。

## 1. 一句话结果

Shared Authority Participant Spine 的 10 个 feature 已全部接入真实 production provider，并以 AuthorityWorker 单 writer、immutable v14 migration、transaction-local CAS、restart recovery、durable cache/lease invalidation 和 secret sentinel 完成闭合证据。

## 2. Requirement 与 UI / 设计边界

- 范围对应 `REQ-ROOM-003/004`、`REQ-MSG-001/002/006/008`、`REQ-PRJ-004/005/009/010/011/012`、`REQ-AGT-003/004/008/010/012/013`、`REQ-ID-004/005`、`REQ-NFR-001/002/004/005/007/008/009/010/011/014`，涉及 FT-02B/02C/03/07/08/09/10/13/14 的 server-private provider seam。
- UI 设计旅程：本切片无新增可见状态；未修改 renderer 或 Desktop 交互，因此不新增 J-01～J-07 组件、loading/empty/error、keyboard/focus、`aria-live`、zoom 或 reduced-motion 行为。
- 权威状态来源：AuthorityWorker `BEGIN IMMEDIATE` transaction 内的 durable facts，以及 commit 后消费的 projection/invalidation intent。
- 设计偏离：**无**。

## 3. 10 个 production provider 证据

| Feature | 生产代码 | 真实测试证据 | 闭合语义 |
| --- | --- | --- | --- |
| `departure-responsibility` | `packages/server/src/project-loop/departure-responsibility-port.ts` | 同目录 `.test.ts`；真实 Request、NextAction、Blocker/OpenQuestion、verification、transfer 非空 fixture | 同 transaction 聚合；contributor missing/duplicate/version/throw/malformed/cross-room 整体闭合 |
| `pending-confirmation-departure` | `packages/server/src/tool-safety/pending-confirmation-departure-contributor.ts` | 同目录 `.test.ts`；真实 pending confirmation/execution/attempt/grant 绑定 | 只读 conflict；closed/expired/claimed/terminal 不再阻断，不 accept/reject/dispatch |
| `archived-message-gate` | `packages/server/src/message-authority/archived-message-gate.ts` | 同目录 `.test.ts`；真实 SQLite 非空 message/gate、rollback/restart/race | message/intent 写入前同 writer 重验 generation；blocked path 事实/event/outbox/idempotency 零写 |
| `business-timer-suspension` | `packages/server/src/business-timers/business-timer-suspension-participant.ts` | 同目录 `.test.ts`；真实 Ball boundary timer、空 batch、rollback/restart/replay/race | 只暂停 business deadline；absolute security/session/grant/confirmation expiry 不延长，terminal/claimed 不复活 |
| `archive-settlement` | `packages/server/src/tool-safety/archive-tool-safety-participant.ts` | 同目录 `.test.ts`；pending/active/waiting/dispatched/outcome-review 真实状态 | pending confirmation reject，unclaimed grant revoke；claimed/dispatched/outcome_unknown 保留，不伪装回滚 |
| `runtime-archive-fence` | `packages/server/src/agent-runtime/runtime-archive-fence-participant.ts` | 同目录 `.test.ts`；queued/waiting/model/tool/dispatched/outcome_unknown、late generation、restart | durable generation fence；dispatch 后保留真实 outcome review；late result CAS 拒绝 |
| `assignment-security-reduction` | `packages/server/src/room-assignment/assignment-security-reduction-participant.ts` | 同目录 `.test.ts`；真实 Global Profile/Room Assignment/policy revision | archive 后 expansion/wake-up 禁止，security subset reduction 仍可审计，`businessWakeUpCount=0` |
| `lifecycle-repair` | `packages/server/src/room-governance/lifecycle-repair-descriptor.ts` | 同目录 `.test.ts` + `repair-projection-registry.test.ts` | FT-02C-owned stable/sort key、mapper、visibility；materialized/streaming 共用唯一 registry mapper |
| `room-cache-invalidation` | `packages/server/src/access/room-cache-invalidation-port.ts` | 同目录 `.test.ts` + `snapshot-worker-client.test.ts` | transaction 内只写 durable intent；commit 后 64-item bounded dispatcher purge；失败可恢复重试 |
| `offline-lease-invalidation` | `packages/server/src/access/offline-lease-invalidation-port.ts` | 同目录 `.test.ts`；Ed25519 issue/verify、expiry/binding/generation/revoke/race、DB/WAL/SHM sentinel | principal/session family/device/installation/server/room/revision/generation 绑定；有限 TTL；旧 generation 立即 fail closed |

所有 production provider 都有真实非空 SQLite 状态证据；没有 production fake、no-op、fixture、固定成功结果或第二 registry/writer/event bus。

## 4. Registration 与 production composition

10 个 registration 全部为 version `1`、manifest `enabled: true`，并由 `packages/server/src/authoritative-server.ts` 的 `createProductionSharedAuthorityParticipantComposition` 按以下 exact ID 注册：

| Feature | Exact registration ID | Enabled |
| --- | --- | --- |
| departure responsibility | `dao.project-loop.departure-responsibility.v1` | true |
| pending confirmation departure | `dao.tool-safety.pending-confirmation-departure.v1` | true |
| archived message gate | `dao.message-authority.archived-message-gate.v1` | true |
| business timer suspension | `dao.business-timers.suspension.v1` | true |
| archive settlement | `dao.tool-safety.archive-settlement.v1` | true |
| runtime archive fence | `dao.agent-runtime.archive-fence.v1` | true |
| assignment security reduction | `dao.room-assignment.security-reduction.v1` | true |
| lifecycle repair | `dao.room-governance.lifecycle-repair.v1` | true |
| room cache invalidation | `dao.access.room-cache-invalidation.v1` | true |
| offline lease invalidation | `dao.access.offline-lease-invalidation.v1` | true |

`packages/server/src/authoritative-server.test.ts` 断言 manifest 10/10 true、registration 顺序和 ID exact match；departure composition 必须显式传入 FT-10 contributor，offline lease 必须显式传入有限正值 `maxOfflineReadLeaseMs`。仓库没有批准的 FT-14 唯一默认值，因此生产不内建默认；缺失或非法配置 fail closed。

## 5. Schema predecessor、v14 与兼容证据

- 任务起始 predecessor：`d012d7f79ff366f6583a0d7366288b8db9c71136` (PR #32)。实现分支基于后续最新 `f1e2812492914f286c6ee143427739255ee0324e` (PR #33)，该 prerequisite 未改变 schema v13。
- predecessor schema：v13；checksum `0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e`；fingerprint `037df6a2818f2a90b7394240a4cf71d77949faf31df6534c5546c9ed6b7e7191`。
- 新 schema：v14；migration checksum `a0236646cdbc9d018e120caf8ccde012433e0d32fb7a011c2b4a2be34404085d`；fingerprint `b4f1034ce034203fd14f5bc32391cb8855f7d6eed64c0b01f75d41e331a8b5c5`。
- v14 集中追加 message gate、runtime fence/member、project-loop facts、tool confirmation/grant state 与 settlement ledger、agent profile/assignment policy、business timer freeze batch/member、cache invalidation intent、offline lease issuance/invalidation authority 所需 DDL/index/trigger；不改写 v1～v13 statement、checksum 或 fingerprint。
- `schema.test.ts` 覆盖 fresh v1→v14、历史 v1/v2/…/v13→v14、future/unknown refusal、v14 逐 statement fault rollback、checksum/fingerprint tamper refusal、历史 confirmation/grant backfill。
- historical v13 archived room 经真实 AuthorityWorker 启动两次，每个 participant generation ledger 仍恰好一行，access/lease revision 只前进一次。

## 6. Transaction、CAS、restart 与 race

- AuthorityWorker 继续是唯一 SQLite writer；participant 只接收 Shared Spine mint 出的 branded `AuthorityTransactionView`，database binding 只能在 deep server module 内解析。
- message gate、timer claim/suspend、confirmation/grant claim/settle、runtime create/claim/model/tool/final、assignment expansion/reduction、cache intent 和 lease issue/invalidate 均在同一 `BEGIN IMMEDIATE` 内做 generation/revision/state CAS。
- crash-before-commit 保持零写；commit-before-ACK 通过既有 idempotency/outbox 回放相同 fact/event ID。
- AuthorityWorker startup 对 archived room 作 keyset 扫描，每个 room 在一个 transaction 内补齐 message/timer/tool/runtime/assignment/cache/lease ledger，重启可重算、可幂等。
- 竞态证据包含 message-vs-archive、runtime-vs-archive、grant/confirmation-vs-archive、timer-vs-archive 与 lease-vs-revoke；均以单 writer 串行化和 stale generation/CAS 拒绝收敛。
- cache purge 不在 authority transaction 内执行；commit 后 dispatcher 每批最多 64 条、无重叠 poll，失败保留 durable intent 供 restart/retry。

## 7. 安全边界

- Departure：conflict ID/revision/source/safe summary/allowed resolutions 闭合，不泄漏责任正文或 tool params；任一 enabled contributor 异常都不被解释为“无责任”。
- Message：archive gate 后新 business message/intent 不可跨越；历史 committed fact 保持可读。
- Timer：只暂停真实 business timer，不延长 security/session/confirmation/grant/lease absolute expiry。
- Tool/runtime：undispatched 工作可 reject/revoke/fence；dispatched/outcome_unknown/review 保留真实历史，不合成 success 或 rollback，blocked path adapter 调用为 0。
- Assignment：archive 禁止 expansion 与 business wake-up，但不阻断必需 security reduction。
- Repair：fixed-watermark materialized/streaming 共用 mapper，新 lifecycle transition 只通过连续 delta 进入，无第二 registry。
- Cache/lease：cache 不是事实源；access reduction 提交后旧 lease generation 立即无效，client 不能延长、改写或自续期。
- 公开 FT-02B leave/remove 和 FT-02C archive/reopen coordinator 仍保持 `503 dependency_unavailable` fail closed；本阶段没有越权开启。
- participant、registry、transaction minting 和 test seam 均不从 package root 导出；boundary tests 持续防止泄漏。

## 8. Secret / sensitive-data sentinel

- `offline-lease-invalidation-port.test.ts` 生成真实 Ed25519 keypair，签发完整 bearer lease，再逐字节扫描 SQLite 主库、WAL 与 SHM；PKCS#8 private DER 和完整 bearer token 均不存在。
- `agent-runtime/secret-sentinel.test.ts` 继续覆盖 runtime secret 不进入数据库、event/outbox/message、WebSocket、log/stdout/stderr 和 diagnostic 的闭合哨兵。
- cache invalidation intent 只含 stable ID、room/revision/generation 和 safe status/error code，不含 cache key、encryption key、token、secret 或原始业务正文。

## 9. 验证命令与精确计数

以仓库声明的 pnpm `10.14.0` 运行：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
git diff --check
```

结果：

- 总测试文件：72；70 passed，2 skipped，0 failed。
- 总测试：1084；1082 passed，2 skipped，0 failed。
- 两个 skipped 为已有 opt-in live OpenAI smoke tests，不是本阶段回避项。
- provider/registry/schema focused matrix：14 文件 / 123 测试通过。
- historical v13 archived-room restart recovery：1 测试通过，同文件 49 项因 focused filter skipped。
- secret sentinel：2 文件 / 7 测试通过。
- typecheck、lint（0 warnings）、build、core boundary、desktop boundary 和 diff-check 均通过。

## 10. PR、head、merge 与 CI

| PR | Ready head | Squash merge | 最终 quality checks |
| --- | --- | --- | --- |
| [#34 · Wave 1 providers](https://github.com/LionelHao/Dao/pull/34) | `aa7c6ecd382c065f67dd8b89f225ccad2612bb4d` | `328fd81890800783cc96a17e801d39b39f73d93b` | [run 32208689535](https://github.com/LionelHao/Dao/actions/runs/32208689535)；Node 22.13.1 success，Node 22.x success |
| [#35 · Wave 2 providers](https://github.com/LionelHao/Dao/pull/35) | `2a130ff7cdda92078ce3fb9b935d5fae112c0be1` | `afa46413e9197d73de41d7d9eb9c001833e2efd4` | [run 32209464043](https://github.com/LionelHao/Dao/actions/runs/32209464043)；Node 22.13.1 success，Node 22.x success |
| [#36 · central assembly](https://github.com/LionelHao/Dao/pull/36) | `43db0b0c56112ffef59ab201aac62198ec982f0b` | `e6bf0b43d0ed3efe0f6fb20f4115869584c630d5` | [run 32209807610](https://github.com/LionelHao/Dao/actions/runs/32209807610)；Node 22.13.1 success，Node 22.x success |

PR #35 首轮 CI 暴露 schema/legacy 真实 SQLite Worker 测试在增大后的并行集合上竞争默认 5 秒预算。最终修复将这两个完整文件放入 single-fork persistence project，没有修改任何测试、没有减少数量、没有扩大 5 秒 timeout；两个 Node 矩阵最终均成功。

## 11. 已知风险与建议 reviewer

- Node 22 `node:sqlite` 仍会打印 ExperimentalWarning；本阶段不改变其平台属性。建议 persistence reviewer 重点审查 v14 immutable migration、trigger/FK、startup keyset recovery 和 per-statement rollback。
- 仓库未冻结唯一 `maxOfflineReadLeaseMs` 产品默认；部署必须显式传入有限正值，否则启动 fail closed。建议 access/security reviewer 审查 Ed25519 binding、generation CAS 与 secret sentinel。
- 真实 tool 已 dispatch 后的 `outcome_unknown` 仍需按 FT-10 后续 review/reconciliation 流程处理；本阶段刻意不自动 replay 或伪装 revoke。建议 tool/runtime reviewer 审查 claim-vs-archive 和 late-result CAS。
- cache purge 是 bounded eventual convergence；外部 cache 故障会延迟 purge，但不回滚已提交 authority fact。建议 sync/repair reviewer 审查 intent replay、same-room revision 过滤和 shutdown 有界性。
- Public leave/remove/archive/reopen 仍返回闭合 503；下一阶段 coordinator 必须在同 transaction 中按已批准顺序调用这些 provider，不得恢复旧 permissive path。

## 12. 远端、PR 与工作区审计

- 生产代码 PR 全部合入后，`origin/main` 为 `e6bf0b43d0ed3efe0f6fb20f4115869584c630d5`；开放 PR 为 0。
- 任务开始前的 `/Users/leo/code/Dao` 仍在 `codex/ft02a-delivery-trace-fix@979863e7936962626b54a130d0260a4689a9bfb0`，四个未跟踪 FT-09/FT-10 design/implementation-plan 文档原样保留，未 clean/stash/reset/移动/覆盖/纳入提交。
- 第三阶段 FT-03、FT-07、FT-08、FT-09、FT-10、FT-13、integration 与 PR worktree 在交付审计时均无未提交修改。
- 未修改 Blueprint HTML/JSON，未自行更改任何 FT/Blueprint 状态。

**第三阶段已达到交付条件，等待 owner 验收。**
