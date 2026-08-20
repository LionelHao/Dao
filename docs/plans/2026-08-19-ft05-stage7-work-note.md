# FT-05 Room Memory Authority & Steward：Stage 7 工作记录

> 日期：2026-08-19
> owner：本 Stage integration owner
> 状态：实施中；不代表 Blueprint 状态变化或 owner 验收。

## 1. 基线与隔离

- 原工作树 `/Users/leo/code/Dao` 保持 `codex/ft02a-delivery-trace-fix`；四份 FT-09/10 用户未跟踪文档未被 clean、stash、reset、移动、覆盖、暂存或提交。
- `git fetch origin --prune` 后实际基线：`origin/main@65d92f56f6b7426d2c65c4a6f0e3def5b07b60fe`；open PR 0。
- integration worktree：`/Users/leo/code/Dao-stage7-ft05-memory`；branch `codex/ft05-stage7-integration`；从上述SHA创建且初始clean。
- 子Agent使用独立worktree/branch；Wave 0均只读、文件所有权为空。

## 2. 基线证据

- pnpm：repository-declared `10.14.0`，使用 `corepack pnpm` 与 frozen lockfile。
- authority schema：v17。
- 全量 Vitest：Test Files `133 passed / 2 skipped / 0 failed (135)`；Tests `1607 passed / 2 skipped / 0 failed (1609)`；两个skip是既有opt-in OpenAI provider/router live suites。
- `verify:core-boundary`、`verify:desktop-boundary`：通过。
- 依赖安装后tracked status未改变。

## 3. 权威文档审计

已按顺序完整阅读根 `AGENTS.md`、重建PRD、approved implementation map、design README/coverage/current self-contained review、FT-03/04/13/09设计与计划、Stage 5/6工作记录、FT-03/04交付、相关protocols以及当前Core/Server/Desktop/SQLite/Message/Attachment/Runtime/sync/repair代码。

直接Requirement为 `REQ-MEM-001/002/005/006/007/010`、`REQ-MSG-005/006/010`、`REQ-PRIM-008/014`；横切 `REQ-NFR-001`～`005`、`007`～`012`、`014`、`REQ-UX-004/007/009`。UI映射正式右栏“重要记忆 · 5类”及 `J-04/J-06/J-07`，设计偏离：**无**。

未发现需要owner另行产品裁决的实质冲突。旧 lifecycle protocol中的 silent/archive措辞低于approved PRD/FT-02，不重新引入silent，不放宽archive业务冻结。正式审阅稿未逐屏画出本 Stage 指令列出的全部 Memory health/source/error 状态；本次 owner 指令已经逐项批准这些状态、事实源、恢复与 a11y，设计文档将其记录为补充设计决策并要求 DESIGN_CONTRACT/DOM/Electron 证据，视觉与语义偏离为无。

## 4. 已确认代码 gap 与边界

- `packages/server/src/persistence/authority-database-handler.ts` 的生产 `runtime.read-context` 对active message envelope执行 `ORDER BY ... DESC LIMIT 64`；这正是第65条以后不再进入当前invocation conversation的精确路径。
- FT-05不靠把64调大解决；新增全量source index、按source ID授权读取、单调watermark与完整raw-delta seam。现有64窗口的最终替换属于FT-06/08 context/invocation编排。
- FT-04已经提供ready+bound+active extraction的server-private授权reader，FT-05只保存source/provenance，不复制object/extraction正文。
- FT-13拥有唯一repair descriptor registry/assembly/fixed-watermark/checksum；FT-05只实现memory record/guard/mapper/sort key/descriptor并注册。
- production Provider复用现有OpenAI Responses与Environment SecretProvider，`store:false`；不新增dependency、第二配置或fake/no-op fallback。
- FT-09 checkpoint port生产初始明确disabled；未来enabled但缺adapter为readiness degraded/503。

## 5. Wave 组织与 RED/GREEN 证据

| Wave | Agent/owner | worktree/branch | scope/status |
| --- | --- | --- | --- |
| 0 | adversarial audit | `/Users/leo/code/Dao-stage7-ft05-adversarial` / `codex/ft05-stage7-adversarial` | 只读审查五类memory、FT-06/09、recall/watermark/degraded |
| 0 | code seams | `/Users/leo/code/Dao-stage7-ft05-code-seams` / `codex/ft05-stage7-code-seams` | 只读定位64、source/repair/runtime接入 |
| 0 | provider/security | `/Users/leo/code/Dao-stage7-ft05-provider-security` / `codex/ft05-stage7-provider-security` | 只读Provider/Secret/structured output/dependency/sentinel |

后续每个Agent的base SHA、所有权、RED、GREEN、commit、files/tests/risks将在本节逐波追加。共享文件只由integration owner按依赖串行接线。

## 6. 实施与PR事实

尚未开始生产编码。设计冻结见：

- `docs/plans/2026-08-19-ft05-room-memory-authority-design.md`
- `docs/plans/2026-08-19-ft05-room-memory-implementation-plan.md`

本节只在真实提交、测试、ready PR、CI与squash merge发生后记录，不预填成功或SHA。

## 7. 最终门禁与交付

尚未执行Stage 7最终门禁。最终交付文档将是 `docs/deliveries/FT-05-Room-Memory-Stage7-交付说明.md`，并记录精确测试计数、schema statement rollback、live smoke、CI/PR/squash SHA、最终origin/main与两个worktree状态。

Blueprint HTML/JSON与任务状态不在本阶段修改范围；在owner验收前不使用 `verified` 或声称owner已验收。
