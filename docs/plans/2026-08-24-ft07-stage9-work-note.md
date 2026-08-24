# FT-07 Stage 9 工作笔记

> 日期：2026-08-24（Asia/Shanghai）
> 状态：进行中；只记录可复核事实，不把计划写成完成证据

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
| 集成 | `codex/ft07-stage9-integration` | `/Users/leo/code/Dao-stage9-ft07-profile-routing` | `5234b9a` | active |
| Core/schema | `codex/ft07-core-schema` | `/Users/leo/code/Dao-stage9-ft07-core-schema` | `5234b9a` | active |
| Administrator/Profile | `codex/ft07-admin-profile` | `/Users/leo/code/Dao-stage9-ft07-admin-profile` | `5234b9a` | active |
| Assignment/Router | `codex/ft07-assignment-router` | `/Users/leo/code/Dao-stage9-ft07-assignment-router` | `5234b9a` | active |

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

## 7. PR、CI、review与清理日志（持续更新）

当前尚未push、创建或合入Stage 9 PR。后续仅记录真实GitHub URL、ready head、CI job和merge SHA；不得预填或伪造。
