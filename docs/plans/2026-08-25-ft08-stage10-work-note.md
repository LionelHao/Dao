# FT-08 Stage 10 工作笔记

> 日期：2026-08-25（Asia/Shanghai）  
> 状态：实现、本地验证与独立审查完成，待 PR/CI；仅记录可复核事实

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
- v22最终候选本地全量：205 passed / 3 skipped / 0 failed test files（208）；2281 passed / 3 skipped / 0 failed tests（2284），295.33s。分包为Core 9 files / 99 passed，Desktop 66 files / 507 passed，Server 130 files / 1675 passed / 3 skipped。三个skip仍为显式opt-in Agent/Router/Memory OpenAI live suites，本机无`OPENAI_API_KEY`，未伪造live通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、Core boundary、Desktop renderer boundary全部通过。
- Desktop Electron smoke通过：app bridge、native selection、secure preview均加载。
- WebSocket 135项、真实进程preview sentinel路径连续3轮通过；Worker runtime authority 4项连续3轮通过，未观察到flake。
- 两名独立只读reviewer复核最终候选`8414513`，覆盖scoped cancellation、preview/reset与subscription generation、队列/在途字节边界、manual retry frozen context及ACK前durable receipt重读，结论均为无剩余P0/P1。

## 实现收口事实

- Core公开模型已冻结为`accepted/running/completed/failed/cancelled`五态，`queued/retrying/waiting_confirmation/finalizing`仅作为phase/action；canonical intent/execution/attempt、lineage、Human retry receipt、scoped cancellation receipt与project boundary result均有closed guard/type-test。
- schema v22以reader-first方式追加runtime state/attempt state、scoped fence/target/receipt、recovery cursor、Human retry receipt、project boundary receipt与legacy marker；fresh、v1…v21 upgrade、rollback、tamper、future-version拒绝、WAL reopen和startup invariants已纳入测试。
- scheduler现为Room+Agent lane：同turn不同Agent可并发、单Agent保持有序；global active=8、Room durable admission=32；自动retry固定1s/4s且最多3 attempts，timeout/shutdown均先持久化再abort；recovery用稳定keyset和poison isolation证明257/513/1025尾部收敛。
- public `invocation.cancel`/`invocation.retry`均要求`expectedVersion`并由Authority transaction线性化；取消只影响指定execution lineage，原子reject pending confirmation、revoke unclaimed grant、保留claimed dispatch证据，receipt replay返回同一事实，commit后才清理本地队列/preview并abort。
- production不再装配legacy room-wide HumanPreemptionRuntime，也不再从任意Human message触发room-wide cancel/replacement。FT-07路由从该旧路径拆为独立的`runtime.create-route-for-human-message`原子入队，保留消息路由且不产生broad cancellation。
- Provider `open-item.propose`旧工具和production回调已退出；project boundary producer保持server-private、exactly-once receipt、FT-09 dependency unavailable时fail-closed且Provider零调用。
- sync/repair已注册canonical intent/execution/attempt/retry/cancel/project records，并把历史execution显式隔离为`legacy-agent-execution`；真实进程cache closed registry同步覆盖所有kind，fixed-watermark checksum恢复通过。
- Desktop execution card只呈现权威五态和phase，取消/重试只提交命令；preview sentinel/reset不进入SQLite、event/outbox/snapshot/cache或最终消息。

## 设计与权威状态映射

- Requirement与J-03/J-05/J-07映射沿用本阶段rebaseline第6节；本次实现未偏离批准设计，偏离：**无**。
- local transient：preview、focus、command submitting；server ACK：intent/cancel/retry commit；stable event：execution/attempt terminal与confirmation/grant/dispatch；projection/repair：availability、source revision/recall、canonical runtime与receipt。
- loading/empty/401/403/409/410/429/503/offline/repair/retry以及keyboard/focus/non-color/aria-live/200% zoom/reduced-motion继续由正式设计和既有Desktop合同覆盖；本阶段触及的execution card与control path测试均按该映射验证。
