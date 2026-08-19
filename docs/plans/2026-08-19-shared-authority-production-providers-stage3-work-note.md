# Shared Authority Production Providers · 第三阶段工作记录

> 日期：2026-08-19  
> 状态：生产代码、CI 与依赖合入已完成；等待 owner 验收；不是 FT、Blueprint 或阶段 verified 声明
> 原集成分支：`codex/shared-authority-providers-stage3`
> 原集成 worktree：`/Users/leo/code/Dao-stage3-integrator`

## 1. 开工基线与工作区保护

- 开工前执行 `git fetch origin --prune`；任务起始 predecessor 为 `origin/main@d012d7f79ff366f6583a0d7366288b8db9c71136`，与 Shared Contract Spine PR #32 的 squash merge commit 一致。实现分支落地前，transaction database capability prerequisite PR #33 合入，后续生产切片全部基于当时最新 `origin/main@f1e2812492914f286c6ee143427739255ee0324e`；该 prerequisite 未改变 predecessor schema v13。
- predecessor schema 为 v13；v13 checksum 为 `0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e`，fingerprint 为 `037df6a2818f2a90b7394240a4cf71d77949faf31df6534c5546c9ed6b7e7191`。
- 开工时开放 PR 为 0。基线测试口径为 59 文件 / 1010 测试；57 文件 / 1008 测试通过，2 文件 / 2 个 opt-in live smoke 跳过。
- 原 `/Users/leo/code/Dao` 工作区仍在 `codex/ft02a-delivery-trace-fix@979863e`，含四个未跟踪 FT-09/FT-10 文档。本阶段不 clean、stash、reset、移动、覆盖或提交它们。
- 本阶段不修改 Blueprint HTML/JSON，不自行把任何 FT 或任务标为 verified。

## 2. Requirement、设计与权威状态映射

| Provider / seam | Requirement / FT | 权威状态来源 | 设计映射 |
| --- | --- | --- | --- |
| departure aggregate + pending confirmation | `REQ-ROOM-003`、`REQ-PRJ-004/005/009/011`、`REQ-AGT-012`；FT-02B/09/10 | 同一 AuthorityWorker transaction 中的 project/tool facts | 本切片无新增可见状态；未来 J-04 governance conflict 只消费 closed projection |
| message gate | `REQ-ROOM-004`、`REQ-MSG-001/006/008`、`REQ-NFR-002/011/014`；FT-02C/03/13 | durable lifecycle/message-gate generation + 单 writer serialisation | 本切片无新增可见状态；未来 J-02/J-07 由 ACK/event/projection 呈现 |
| business timer suspension | `REQ-ROOM-004`、`REQ-PRJ-010/012`、`REQ-NFR-014`；FT-02C/09/13 | durable timer freeze row + archive generation | 本切片无新增可见状态；未来 J-07 projection |
| tool settlement | `REQ-AGT-010/012/013`、`REQ-ROOM-004`、`REQ-NFR-011/014`；FT-02C/10 | confirmation/grant/dispatch CAS in Authority transaction | 本切片无新增可见状态；未来 J-05/J-07 projection |
| runtime fence | `REQ-AGT-004/008/010`、`REQ-MSG-008`、`REQ-NFR-005/011/014`；FT-02C/08 | durable execution/attempt/fence generation | 本切片无新增可见状态；未来 J-03/J-07 projection |
| assignment reduction | `REQ-ID-004`、`REQ-AGT-003/004`、`REQ-NFR-011/014`；FT-02C/07 | current Room assignment/membership revisions | 本切片无新增可见状态；未来 J-03/settings projection |
| lifecycle repair | `REQ-MSG-002`、`REQ-NFR-001/004/010/014`；FT-02C/13 | closed descriptor + fixed-watermark registry mapper | 本切片无新增可见状态；未来 J-07 repair projection |
| cache invalidation | `REQ-ID-005`、`REQ-NFR-007/008/009/011/014`；FT-02C/13 | durable invalidation intent; purge only after commit | 本切片无新增可见状态；未来 J-01/J-07 projection |
| offline lease invalidation | `REQ-ID-005`、`REQ-NFR-007/008/011/014`；FT-02C/13/14 | signed finite lease generation + access revision | 本切片无新增可见状态；未来 J-01/J-07 projection |

所有状态均为 server-private transaction/projection；本阶段不修改 renderer、Desktop 可见状态、loading/empty/error UI、键盘、焦点、非颜色、`aria-live`、缩放或 reduced-motion 行为。设计偏离：**无**。

## 3. Provider、文件、registration 与 migration owner

| Feature | production registration ID | feature-local owner / 文件 | durable 需求 |
| --- | --- | --- | --- |
| `departure-responsibility` | `dao.project-loop.departure-responsibility.v1` | FT-09 owner；`project-loop/departure-responsibility-port.ts` | project responsibility facts；中央 migration owner分配 |
| `pending-confirmation-departure` | `dao.tool-safety.pending-confirmation-departure.v1` | FT-10 owner；`tool-safety/pending-confirmation-departure-contributor.ts` | 复用/扩展 confirmation facts |
| `archived-message-gate` | `dao.message-authority.archived-message-gate.v1` | FT-03 owner；`message-authority/archived-message-gate.ts` | durable gate generation；中央 migration owner分配 |
| `business-timer-suspension` | `dao.business-timers.suspension.v1` | timer integration owner；`business-timers/business-timer-suspension-participant.ts` | timer descriptor/freeze rows；中央 migration owner分配 |
| `archive-settlement` | `dao.tool-safety.archive-settlement.v1` | FT-10 owner；`tool-safety/archive-tool-safety-participant.ts` | confirmation/grant/execution CAS |
| `runtime-archive-fence` | `dao.agent-runtime.archive-fence.v1` | FT-08 owner；`agent-runtime/runtime-archive-fence-participant.ts` | durable fence/generation |
| `assignment-security-reduction` | `dao.room-assignment.security-reduction.v1` | FT-07 owner；`room-assignment/assignment-security-reduction-participant.ts` | assignment policy/revision |
| `lifecycle-repair` | `dao.room-governance.lifecycle-repair.v1` | integration owner；`room-governance/lifecycle-repair-descriptor.ts` | descriptor本身无第二 registry；中央 assembly |
| `room-cache-invalidation` | `dao.access.room-cache-invalidation.v1` | FT-13 owner；`access/room-cache-invalidation-port.ts` | durable replayable intent |
| `offline-lease-invalidation` | `dao.access.offline-lease-invalidation.v1` | FT-13/14 owner；`access/offline-lease-invalidation-port.ts` | generation-bound lease/invalidation facts |

本阶段唯一 schema/migration owner 为总集成 Agent。真实 v13 predecessor 后只追加单个 **v14** batch；v1-v13 statement/checksum/fingerprint 不变。v14 migration checksum 为 `a0236646cdbc9d018e120caf8ccde012433e0d32fb7a011c2b4a2be34404085d`，完整 schema fingerprint 为 `b4f1034ce034203fd14f5bc32391cb8855f7d6eed64c0b01f75d41e331a8b5c5`。AuthorityWorker、handler/protocol、worker client、`authoritative-server.ts`、repair中央 assembly由总集成 Agent串行修改。

## 4. 并行 ownership 与 shared-file 窗口

- 第一波 A：FT-03 message gate；只拥有 `message-authority/**` 与同目录 tests。
- 第一波 B：FT-08 runtime archive fence；只拥有 `agent-runtime/runtime-archive-fence-participant*`。
- 第一波 C：FT-13/14 repair registry prerequisite、cache invalidation、offline lease；只拥有 `access/**`、repair registry新文件及同目录 tests，不修改 schema/handler/snapshot/composition。
- 第二波 D：FT-09 departure aggregate；只拥有 `project-loop/**`。
- 第二波 E：FT-10 pending confirmation + archive settlement；只拥有 `tool-safety/**`。
- 第二波 F：FT-07 assignment reduction + business timer aggregation；只拥有 `room-assignment/**`、`business-timers/**`。
- 总集成 Agent：transaction database capability、v14 migration、AuthorityWorker/handler/worker protocol/client、production composition、lifecycle descriptor、中央 repair assembly、integration/race/restart/sentinel tests与交付说明。

子 Agent 不修改共享文件；需要接线时在报告中列出精确 API/SQL/migration 需求。每个分支从已提交的中央 prerequisite 创建，完成后报告 commit SHA、文件、focused tests、依赖和共享接线需求。

## 5. RED → GREEN 顺序与 PR 依赖图

1. 中央 prerequisite：transaction-local DB capability、production registration assembly contract、工作记录。
2. 第一波 RED/GREEN：message gate；runtime fence；repair/cache/lease ports。
3. 中央 v14 migration与AuthorityWorker transaction host，集成第一波并跑 fresh/history/future/rollback。
4. 第二波 RED/GREEN：departure aggregate；pending confirmation + settlement；assignment + timers。
5. lifecycle descriptor、central repair assembly、production composition exact registration。
6. integration/race/restart/idempotency/zero-call/sentinel；全仓门禁。
7. 按可审计依赖拆 PR：`central-prerequisite` → `message/runtime/access providers` → `departure/tool/assignment/timer providers` → `final composition + delivery`。每个后继 PR 基于最新 main；CI 两组 quality checks通过后按序 squash merge。

Public leave/remove/archive/reopen 在本阶段全部继续 fail closed；Provider注册不能自动开启旧 permissive command。

## 6. 实际合入与验证记录

| PR | 范围 | head | squash merge | 最终 CI |
| --- | --- | --- | --- | --- |
| [#34](https://github.com/LionelHao/Dao/pull/34) | transaction host；FT-03、FT-08、FT-13/14、lifecycle repair/access Wave 1 | `aa7c6ecd382c065f67dd8b89f225ccad2612bb4d` | `328fd81890800783cc96a17e801d39b39f73d93b` | Node 22.13.1 与 Node 22.x 两组 `quality` success |
| [#35](https://github.com/LionelHao/Dao/pull/35) | FT-09、FT-10、FT-07 assignment/timer Wave 2；严格 persistence test scheduling | `2a130ff7cdda92078ce3fb9b935d5fae112c0be1` | `afa46413e9197d73de41d7d9eb9c001833e2efd4` | Node 22.13.1 与 Node 22.x 两组 `quality` success |
| [#36](https://github.com/LionelHao/Dao/pull/36) | v14 central schema、10/10 composition、startup recovery、真实 cache purge、lease secret sentinel | `43db0b0c56112ffef59ab201aac62198ec982f0b` | `e6bf0b43d0ed3efe0f6fb20f4115869584c630d5` | Node 22.13.1 与 Node 22.x 两组 `quality` success |

最终本地生产树运行结果：

- `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm build`、两项 boundary verification、`git diff --check` 全部通过。
- 全量：72 个测试文件；70 passed、2 skipped、0 failed。1084 个测试；1082 passed、2 skipped、0 failed。
- provider/registry/schema focused matrix：14 文件 / 123 测试通过。
- historical v13 archived-room AuthorityWorker restart recovery：1 测试通过（同文件其余 49 项按过滤条件 skipped）。
- runtime + offline lease secret sentinel：2 文件 / 7 测试通过。
- PR #35 首轮暴露既有 schema/legacy SQLite Worker 测试在并行 runner 上触发 5 秒墙钟竞争；修复只把两个完整测试文件移入 single-fork persistence project，未修改测试、未减少覆盖、未扩大 5 秒 timeout。最终两个 Node 矩阵均通过。

原 `/Users/leo/code/Dao` 的四个未跟踪 FT-09/FT-10 文档保持原样；本阶段全部 feature、integration 与 PR worktree 均无未提交修改。Blueprint、renderer 和 Desktop 可见状态均未修改；设计偏离：**无**。
