# FT-08 Stage 10 工作笔记

> 日期：2026-08-25（Asia/Shanghai）  
> 状态：实施中；仅记录可复核事实

## 起始基线

- `origin/main=82ef2231c86559ed8ad7941f8abe32d6cd32a68a`；schema v21；无 open PR。
- Stage 9记录基线：197 passed / 3 skipped test files（200）；2170 passed / 3 skipped tests（2173）。三个skip为opt-in Agent、Router、Memory OpenAI live suites。
- v20：97 statements、51 trigger + 9 startup invariants、97 rollback assertions、11 migration tests；v21：6 statements、5 trigger + 1 startup invariant、6 rollback assertions、5 migration tests。
- 集成分支/worktree：`codex/ft08-stage10-integration` / `/Users/leo/code/Dao-stage10-ft08-runtime`。

## 保护文件

主工作区 `/Users/leo/code/Dao` 位于 `codex/ft02a-delivery-trace-fix`。四个用户untracked文件不属于本阶段；开始哈希已复核匹配：

| 文件 | SHA-256 |
| --- | --- |
| `2026-08-18-ft09-project-loop-design.md` | `88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122` |
| `2026-08-18-ft09-project-loop-implementation-plan.md` | `8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c` |
| `2026-08-18-ft10-tool-safety-design.md` | `8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578` |
| `2026-08-18-ft10-tool-safety-implementation-plan.md` | `8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd` |

## Stage 10 worktree 台账

| 用途 | branch | path | owner |
| --- | --- | --- | --- |
| 集成/共享文件 | `codex/ft08-stage10-integration` | `/Users/leo/code/Dao-stage10-ft08-runtime` | main integration |
| Core closed contracts | `codex/ft08-core-contracts` | `/Users/leo/code/Dao-stage10-ft08-core` | core agent |
| scoped cancellation module | `codex/ft08-scoped-cancellation` | `/Users/leo/code/Dao-stage10-ft08-cancel` | cancellation agent |
| scheduler/retry/recovery | `codex/ft08-runtime-recovery` | `/Users/leo/code/Dao-stage10-ft08-recovery` | runtime agent |

所有写入Agent使用独立worktree。schema、AuthorityWorker/handler、composition、protocol/WS、sync/snapshot与Desktop root由集成owner串行修改。PR合入并核实远端main后逐worktree检查、remove、prune；最终只保留开始前的主工作区。

## 已读输入与当前审计

主Agent已读取根`AGENTS.md`、批准PRD/evidence map、Design README/103项coverage、正式J-03/J-05/J-07/execution/confirmation/a11y、批准实施映射、identity/message/sync协议、FT-08设计/计划、FT-07 Stage 9与FT-06 Stage 8 rebaseline/work note/delivery、FT-01/02/03/05/13边界以及保护的FT-09/10计划；未查阅Buzz实现，因此未引入Buzz语义。

首轮代码确认：Core和sync仍公开queued；runtime按Room单active；timeout catch在signal aborted时直接return；recover一次读取；public interrupt有自由reason、retry无expectedVersion；production仍装配HumanPreemptionRuntime；Desktop将queued显示为已排队；Provider envelope仍允许legacy `open-item.propose`。v16/v19/v21已提前交付intent一对多、snapshot binding和direct/routed revision gates，Stage 10将复用而非重建。

## 验证日志

- `corepack pnpm install --frozen-lockfile`：lockfile无变化，212 packages全部本地复用，pnpm 10.14.0。
- Stage 9独占基线复跑：197 passed / 3 skipped / 0 failed test files（200）；2170 passed / 3 skipped / 0 failed tests（2173），266.94s。计数与Stage 9交付证据完全一致；三个skip仍是opt-in Agent/Router/Memory OpenAI live suites。
