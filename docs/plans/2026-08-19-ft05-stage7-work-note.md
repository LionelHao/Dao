# FT-05 Room Memory Authority & Steward：Stage 7 工作记录

> 日期：2026-08-19
> owner：本 Stage integration owner
> 状态：已达到交付条件；本记录随最终 documentation-only PR 合入远端 `main` 后构成完整交付，等待 owner 验收；不代表 Blueprint 状态变化或 owner 已验收。

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

| Wave | Agent/owner | worktree/branch | scope/result |
| --- | --- | --- | --- |
| 0 | adversarial audit | `/Users/leo/code/Dao-stage7-ft05-adversarial` / `codex/ft05-stage7-adversarial` | 只读审查五类memory、FT-06/09、recall/watermark/degraded |
| 0 | code seams | `/Users/leo/code/Dao-stage7-ft05-code-seams` / `codex/ft05-stage7-code-seams` | 只读定位64、source/repair/runtime接入 |
| 0 | provider/security | `/Users/leo/code/Dao-stage7-ft05-provider-security` / `codex/ft05-stage7-provider-security` | 只读Provider/Secret/structured output/dependency/sentinel |
| 1 | Core contracts | `/Users/leo/code/Dao-stage7-ft05-adversarial` | RED：module/exports/type shape missing；GREEN：五类memory、source/version/health、dispute/resolve、private raw-delta、public frames/events/repair closed guards及negative type tests |
| 1 | schema v18 | `/Users/leo/code/Dao-stage7-ft05-provider-security` | RED：v17、v18表族缺失；GREEN：fresh与v1～v17升级/restart、12表、61/61逐statement rollback、tamper/future拒绝 |
| 1 | Provider | `/Users/leo/code/Dao-stage7-ft05-code-seams` | RED：provider/parser/contracts module missing；GREEN：duplicate-key aware bounded JSON、strict Responses schema、noauth零fetch、closed errors与live opt-in |
| 2 | DB authority/corpus/steward | `/Users/leo/code/Dao-stage7-ft05-db-authority`及integration worktree | RED：corpus/source/job/dispute/runtime seam缺失；GREEN：唯一AuthorityWorker事务、FIFO steward、32-source batch、3 attempts、revision/recall/attachment fence |
| 2 | sync/repair | `/Users/leo/code/Dao-stage7-ft05-core-sync`、`Dao-stage7-ft05-repair-descriptor` | RED：Core union与中央registry exhaustiveness失败；GREEN：唯一memory descriptor/order 17、fixed-watermark/checksum、event dedupe/repair closed projection |
| 2 | Desktop | `/Users/leo/code/Dao-stage7-ft05-desktop-controller`及integration worktree | RED：client/cache/controller/bridge module missing；GREEN：production IPC/preload/controller/cache/surface、全状态、source deep-link与a11y合同 |
| 3 | degraded route/runtime | `/Users/leo/code/Dao-stage7-ft05-route-gate`及integration worktree | RED：noauth/degraded仍调用semantic Provider；GREEN：semantic/risk proactive gate，direct mention/help/健康Ball deterministic保留，explicit invocation使用memory snapshot+delta |
| 4 | adversarial hardening | `/Users/leo/code/Dao-stage7-ft05-hardening` | 真实CI先后暴露随机event ID前缀、Authority操作瞬态不可用、heavy project竞争和重复noauth造成repair checksum漂移；逐项以生产修复与确定性回归闭合 |

所有子Agent先报告独立worktree、branch、base、文件所有权与真实RED，再报告GREEN/commit/risk。共享 `schema.ts`、Worker protocol/handler、`sync.ts`、snapshot registry、WebSocket、production composition与Desktop root由integration owner按依赖串行接线；没有复制整棵目录覆盖。

## 6. 实施与PR事实

冻结设计与计划：

- `docs/plans/2026-08-19-ft05-room-memory-authority-design.md`
- `docs/plans/2026-08-19-ft05-room-memory-implementation-plan.md`

代码按五个受保护PR顺序squash进入远端 `main`：

| PR | 范围 | ready head | 双Node CI run | squash merge |
| --- | --- | --- | --- | --- |
| [#54](https://github.com/LionelHao/Dao/pull/54) | Core/schema/provider/design foundation | `dae7ea9fd7c4272ed4b04617cf7e7388b82eb9fa` | [32371872606](https://github.com/LionelHao/Dao/actions/runs/32371872606) | `a820a65493bdf283d8cad7760b01dc6f541395ba` |
| [#55](https://github.com/LionelHao/Dao/pull/55) | corpus/DB authority/steward/protocol/repair/runtime | `06fbc6085c910703985623969c680b19b1cb1c5b` | [32377138394](https://github.com/LionelHao/Dao/actions/runs/32377138394) | `c7879d0de8728fe859d7a0b4e7d8ea724a333175` |
| [#57](https://github.com/LionelHao/Dao/pull/57) | transient Authority operation recovery | `cd8e975a85d9132edf46383aaf0b0e8de7258aaf` | [32388081790](https://github.com/LionelHao/Dao/actions/runs/32388081790) | `1ae46ab66421681266184648d9d4d859b2d5ae7f` |
| [#56](https://github.com/LionelHao/Dao/pull/56) | Desktop Memory panel与三端E2E | `d462b82977d49ed472721e3b68adf487ba5adbf3` | [32389497440](https://github.com/LionelHao/Dao/actions/runs/32389497440) | `db1d3af96c158e0443a97568e651121da2989df0` |
| [#58](https://github.com/LionelHao/Dao/pull/58) | invocation/degraded/sentinel/archive/runtime hardening | `ca891898917b6ceafc4089bf03d9324b619efb62` | [32399055191](https://github.com/LionelHao/Dao/actions/runs/32399055191) | `c2f38a432a008ecbec93aac706ac19164e4289f8` |

每个最终run的Node `22.13.1`与Node `22.x` jobs均为success。没有绕过required check、直接推送或force push `main`。

关键review闭环：

- 随机503最终定位为`room.memory.health.changed`裸base64url digest偶尔以`-`/`_`起始，不满足Core stable identifier；生产ID统一加`room-memory:`命名空间，并用可确定产生标点首字符的timestamp回归验证event/outbox解析。
- `authority_operation_unavailable`按内部、非terminal、一次性503处理；真实`storage_unavailable`与rollback poison仍terminal fail closed，SQLite BUSY/LOCKED只做有界分类。
- 重复`mark-noauth`原本无条件改`updated_at`并制造新health event/checksum；最终改成状态/原因/retry标志未变时零写、零event。该修复有独立RED、13/13 focused GREEN和真实Authority E2E连续5轮120/120证据。
- heavy Authority/snapshot/sync E2E拆成三个single-fork project，不删除断言、测试或扩大业务权限。

## 7. 最终门禁与交付

最终可执行代码基线 `origin/main@c2f38a432a008ecbec93aac706ac19164e4289f8` 上，同一完整HEAD门禁结果：

- `corepack pnpm typecheck`、`lint`、`test`、`build`、`verify:core-boundary`、`verify:desktop-boundary`、`git diff --check`全部退出0；lint 0 warnings。
- 全仓 Test Files `158 passed / 3 skipped / 0 failed (161)`；Tests `1796 passed / 3 skipped / 0 failed (1799)`。
- Core `6 files / 77 tests`；Desktop `57 files / 433 tests`；Server `95 passed / 3 skipped files`、`1286 passed / 3 skipped tests`。
- schema v18 `8/8`，61 meaningful statements / 61 rollback；真实AuthorityWorker/WebSocket/restart E2E `24/24`，修复后另连续5轮`120/120`。
- 三个skip均为显式环境门控的OpenAI live smoke；未设置`DAO_OPENAI_LIVE_SMOKE=1`与真实secret，因此如实记为未运行，不伪报通过。

最终交付说明为 `docs/deliveries/FT-05-Room-Memory-Stage7-交付说明.md`。documentation-only PR合入后再从远端 `main` 建全新clean worktree重复最终门禁并回读最终SHA。

Blueprint HTML/JSON与任务状态不在本阶段修改范围；在owner验收前不使用 `verified` 或声称owner已验收。
