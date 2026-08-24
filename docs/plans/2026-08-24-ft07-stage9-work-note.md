# FT-07 Stage 9 工作笔记

> 日期：2026-08-24（Asia/Shanghai）
> 状态：最终集成与门禁中；只记录可复核事实，不把计划写成完成证据

## 1. 起始基线

- `git fetch origin --prune` 后 `origin/main=5234b9a9a043ef03cb5ecf37f00a4671800612b8`。
- 最新交付：`47293d3`（FT-06实现，PR #60）、`5234b9a`（Stage 8 evidence，PR #61）。
- Authority schema v19；v19为89条append-only migration statements。
- Stage 8已记录基线：172 passed / 3 skipped / 0 failed test files（175）；1927 passed / 3 skipped / 0 failed tests（1930）。三个skip为opt-in Agent/Router/Memory OpenAI live suites。
- 开始时GitHub无open PR；唯一注册worktree为用户主工作区。
- 工具链：Node v22.22.2、pnpm 10.14.0。

## 2. 受保护的用户主工作区

主工作区 `/Users/leo/code/Dao` 位于 `codex/ft02a-delivery-trace-fix`。下列文件始终保持untracked，不得clean/stash/reset/move/stage/commit/format：

| 文件 | 起始 SHA-256 |
| --- | --- |
| `docs/plans/2026-08-18-ft09-project-loop-design.md` | `88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122` |
| `docs/plans/2026-08-18-ft09-project-loop-implementation-plan.md` | `8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c` |
| `docs/plans/2026-08-18-ft10-tool-safety-design.md` | `8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578` |
| `docs/plans/2026-08-18-ft10-tool-safety-implementation-plan.md` | `8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd` |

## 3. Stage 9 worktree 台账

| 用途 | branch | path | 基线 | 当前状态 |
| --- | --- | --- | --- | --- |
| 首轮集成、Core/schema、Administrator/Profile、Assignment/Router | 对应 `codex/ft07-*` 分支 | 对应 Stage 9 临时 worktree | `5234b9a` 起 | 已通过 PR #62～#68 交付并清理 |
| Protocol/sync | `codex/ft07-sync-protocol`、`codex/ft07-sync-integration` | `/Users/leo/code/Dao-stage9-ft07-sync-protocol`、`/Users/leo/code/Dao-stage9-ft07-sync-integration` | `ae3149e` 前后 | 已集成，待最终 PR 后清理 |
| direct binding/schema v21 | `codex/ft07-direct-binding` | `/Users/leo/code/Dao-stage9-ft07-direct-binding` | `ae3149e` | 已集成，待最终 PR 后清理 |
| Context | `codex/ft07-context-integration` | `/Users/leo/code/Dao-stage9-ft07-context-integration` | `ae3149e` | 已集成，待最终 PR 后清理 |
| Desktop | `codex/ft07-desktop-sync` | `/Users/leo/code/Dao-stage9-ft07-desktop-sync` | 集成候选 | 已集成，待最终 PR 后清理 |
| Runtime gates | `codex/ft07-runtime-gates` | `/Users/leo/code/Dao-stage9-ft07-runtime-gates` | `73a4e21` | 已集成，待最终 PR 后清理 |
| 最终集成 | `codex/ft07-stage9-final` | `/Users/leo/code/Dao-stage9-ft07-final-integration` | `ae3149e` | active |

每个写入Agent只在自己的worktree工作。`schema.ts`、AuthorityWorker/handler、authoritative-server、protocol/WebSocket、sync/snapshot、Desktop root由主集成串行处理。最终PR合入远端main并核实后逐个检查、remove、prune。

## 4. 已读权威输入与设计映射

主Agent已读根`AGENTS.md`，未发现更深层规则；已读PRD/evidence map、design README/103项coverage、正式审阅稿的J-01/J-03/J-05/J-07与Settings/a11y状态、批准实施映射、identity/message/sync协议、FT-07设计/计划/work note、FT-01/02/03/05/06/08/10/13正式计划和交付边界、FT-06 Stage 8 evidence，以及当前core/server/desktop生产实现。未查阅Buzz，因此没有引入Buzz语义或代码。

UI映射与正式设计偏离记录见rebaseline第1、6、7节；偏离为“无”。

## 5. 首轮生产代码审计

- v14 Profile/Assignment物理表和archive safety participant存在，但无CRUD/事件/repair/Desktop producer。
- `AgentActor`仍写readiness/toolPermissions；`silent`仍在Core、sync、room lifecycle、Router/DB旧生产路径。
- FT-03 structured mention已存在，但direct eligibility只允许active，错误拒绝on-mention。
- public `agent.invoke` decoder/WebSocket仍允许Human提交kind/target并立即调用runtime。
- Router provider input仍含displayName-derived role/static permissions；Agent final继续notify Router。
- route terminal后逐intent调用best-effort runtime callback，存在crash gap。
- FT-06 compiled envelope已有persona block位置，但真实Profile/Assignment/revision/availability尚未接入。
- provider保持单一server secret、单模型、`store:false`；缺secret路径可用于noauth，但无正式披露projection。

## 6. 验证日志（持续更新）

- integration worktree初次执行`pnpm test`因尚未安装`node_modules`在Vitest启动前失败；boundary脚本本身通过。此环境准备失败不计产品测试结果。
- 随后执行`corepack pnpm install --frozen-lockfile`：锁文件无变化，212 packages全部从本地store复用，pnpm 10.14.0。
- Stage 8独占全量基线复跑完成：172 passed / 3 skipped / 0 failed test files（175）；1927 passed / 3 skipped / 0 failed tests（1930），耗时211.74s。计数与Stage 8交付证据一致；SQLite experimental warning不是失败。三个skip仍为opt-in Agent/Router/Memory OpenAI live suites。
- schema v20 全量证据：177 files（174 passed / 3 skipped），1946 tests（1943 passed / 3 skipped）；v20 97条statements、51条trigger invariants、9条startup invariants、97条statement rollback assertions、11项migration tests。v1-v19 checksum/fingerprint保持不变。
- schema v21 direct authority binding：6条statements、5条trigger invariants、1条startup invariant、6条rollback assertions；focused schema/runtime 99、54、18、4、1项分组均通过。
- Context Authority：compiler/database/property 4 files / 40 tests；三组permutation seed各256次、large-delta各32次保持不变。
- Protocol/sync production composition：closed protocol、real Worker SQLite/WAL restart、real multi-client WebSocket共4 files / 38 tests。
- Desktop：60 files / 469 tests；build后Electron smoke通过；Desktop renderer boundary确认23个production sources不暴露Node/Electron authority。
- 同进程Desktop Agent Settings E2E已通过真实WebSocket、AuthorityWorker和SQLite完成Profile create、Assignment create、ACK、stable event及权威回读；并补证Assignment event可通过persisted-event/outbox closed parser。
- 最终 routed authority 收口把terminal RouteJob decision、v20 candidate snapshot与`routed_agent_invocation_intents`放入同一个Authority transaction；生产Worker adapter支持pending handoff的有界恢复与claim，重启测试经真实SQLite/WAL关闭重开后恢复同一intent。FT-08仍负责从accepted handoff创建完整execution lifecycle，本阶段没有best-effort callback或伪造terminal execution。
- routed候选只读取Profile/Assignment/membership与服务端Provider readiness形成的冻结快照；旧`route_job_agents`静态角色/权限不再进入Provider candidate，direct target及正文`@displayName`/regex不进入Router重选。runtime handoff在Provider调用前复核Profile/Assignment/access/Room/participation与Profile∩Assignment∩membership tool交集。
- 私有Route Authority协议新增closed `route.handoff.claim`/`route.handoff.recover`操作；focused protocol/route/SQLite/human-preemption/runtime authority矩阵为6 files / 122 tests全通过。真实进程authority E2E为1 file / 26 tests全通过，并以terminal `route_decisions`等待恢复收敛。
- 首次最终全量候选暴露3项测试fixture不再符合新权威边界（两个E2E仍等待legacy judgment计数、一个runtime fixture缺真实Profile/Assignment/direct binding）；均已改为生产事实fixture。该次非最终结果为193 files passed / 3 skipped / 2 failed，2153 tests passed / 3 skipped / 3 failed；不作为交付计数。
- 最终候选独占全量门禁：199 files（196 passed / 3 skipped / 0 failed），2161 tests（2158 passed / 3 skipped / 0 failed），249.58s；同一命令先通过Core I/O boundary与Desktop renderer boundary（23 production sources）。三个skip仍是opt-in OpenAI Agent、Router、Memory live suites；未读取或披露secret。
- CI链接与merge SHA待GitHub事实产生后写入交付说明。

## 7. PR、CI、review与清理日志（持续更新）

- PR #62：rebaseline文档，merge SHA `74e46260093b61bda5543eab3b4cb979bd346c9b`。
- PR #63：Core closed contracts，merge SHA `1bb810e286cc019e6af6e3c2388af324fc51cb5c`。
- PR #64：no-silent/public surface hardening，merge SHA `87e5602769c17a943a1780e97ea1346bd44d3afc`。
- PR #65：schema v20，merge SHA `aac6164e3bf5997dea7e6c8ceceedbf9b4952d17`；quality run 32731031217双Node矩阵通过。
- PR #66：runtime/public no-cascade，merge SHA `19153709cec2dc946276ba10767189b7d9ada530`。
- PR #67：Tenant Administrator/Profile authority，merge SHA `35fd3a10d470ac73140718268806f7cb650c9a21`。
- PR #68：Profile fan-out、Assignment authority、trusted routing，merge SHA `ae3149e0a0b3e3dc421b06e47c06f87038a85385`；quality run 32735120300双Node矩阵通过。
- 最终implementation/evidence PR只能在独占门禁、独立对抗审阅、CI和真实merge完成后补录。
