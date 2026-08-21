# FT-06 Stage 8 工作笔记

状态：本地实现、门禁与独立审阅完成，等待远端 PR/CI/merge。此文件记录可复核事实，不把计划写成完成证据。

## 1. 基线

- 日期/时区：2026-08-21 / Asia-Shanghai。
- `git fetch origin --prune` 后 `origin/main=c0dc4421b3b5d5c00c4676e86bd205c482aa332c`。
- schema v18；Stage 7基线为158 passed/3 skipped files、1796 passed/3 skipped tests。
- GitHub无open PR；Stage 7最新merge为#59。
- 原工作区`/Users/leo/code/Dao`位于`codex/ft02a-delivery-trace-fix`，四个用户未跟踪FT-09/FT-10计划文件已列入保护清单。

## 2. Worktree台账

| 用途 | branch | path | 基线 | 状态 |
| --- | --- | --- | --- | --- |
| 集成 | `codex/ft06-stage8-integration` | `/Users/leo/code/Dao-stage8-ft06-context` | c0dc442 | active |
| contract/compiler | `codex/ft06-contract-compiler` | `/Users/leo/code/Dao-stage8-ft06-contract` | c0dc442 | active |
| persistence/recovery | `codex/ft06-persistence-recovery` | `/Users/leo/code/Dao-stage8-ft06-persistence` | c0dc442 | active |
| provider/source tool | `codex/ft06-provider-source-tool` | `/Users/leo/code/Dao-stage8-ft06-provider` | c0dc442 | active |

## 3. 已读权威资料与现状证据

已读根`AGENTS.md`；未发现更深层`AGENTS.md`。已读PRD、design README与Requirement coverage、批准FT implementation map、authoritative sync/identity/message ACK协议、FT-01～05正式spec/计划/交付材料、T-0041 runtime材料，以及当前core/server/runtime/persistence/room-memory/provider实现。未查阅Buzz，因此无需引入其模式或许可证内容。

确认现状缺口：`AgentRuntimeProviderInput.visibleConversation`仅messageId/authorId/body；OpenAI把其全部映为`user`；`runtime.read-context` SQL为按时间倒序`LIMIT 64`后重排；`runAttempt`每次递归/自动retry再次调用`buildProviderInput`；无snapshot/manifest/budget/read receipt/final citation authority。

FT-09尚未正式交付；production project adapter必须disabled/unavailable。FT-07 persona未交付；只使用真实Agent id/kind/membership/tool permission，responsibility明确unavailable。

## 4. 设计裁决

- pure compiler与runtime metadata分离，时钟/随机snapshot id不进入canonical manifest hash。
- deterministic estimator使用保守UTF-8 byte accounting +固定结构overhead，不在线猜模型窗口。
- snapshot restricted body可持久化canonical envelope以确保crash byte identity，但绝不投影到event/outbox/repair/WebSocket/log。
- Provider dispatch前重验snapshot及当前授权；recall/dispute/revoke不允许旧snapshot继续发送，也不静默换context。
- `room-memory.read`只能接受当前manifest label与opaque cursor；无任意source id、SQL、URL/path/regex。
- citation自然语言不解析；只验证closed declaration是manifest/read receipt子集，并与final transaction原子提交。
- 不扩大Desktop shell。J-03/J-06/J-07既有状态作为交互边界；服务端citation projection是唯一显示前提。
- owner本阶段明确要求manual retry新snapshot，取代旧J-03审阅稿“复用同一snapshot”的一行描述；自动retry/crash仍复用。

## 5. 验证日志

最终本地候选在无并发构建进程的独占状态下执行：

- `corepack pnpm test`：172 passed / 3 skipped files，1927 passed / 3 skipped tests，202.87s；命令内 core boundary 与 Desktop renderer boundary 同时通过。三个 skip 恰为 Agent、route、memory OpenAI live suite；未同时提供显式 live flag 与 server-side secret，因此按批准合同安全跳过，未读取、输出或派生 secret。
- `corepack pnpm typecheck`：通过，包括 workspace build graph、core/server negative type tests 与 Vitest config strict check。
- `corepack pnpm lint`：通过，0 warnings。
- `corepack pnpm build`：core、server、desktop 三个 workspace build 通过；Desktop preload/renderer copy 同时完成。
- `corepack pnpm verify:core-boundary`：通过；core 无 I/O dependency/import。
- `corepack pnpm verify:desktop-boundary`：通过；20个renderer production source无Node/Electron authority。
- `git diff --check`：通过。
- 最终聚焦回归：7个受影响测试文件52/52通过；`context-snapshot-database-authority.test.ts` 19/19单独复跑通过；property seeds `1129601030,1296387335,3737844653` 每seed 256次、large-delta每seed 32次顺序复跑2/2通过。固定768次permutation property的测试时限从30秒调整为60秒，运行规模和断言没有降低。
- v19 migration：fresh及每个v1-v18升级/restart、89条statement逐条rollback、future/history/physical tamper均在`schema-v19.test.ts` 4/4通过；v1-v18 fingerprint未改，v19 fingerprint为`e458dedc7c0d85c04bca92dc2f6289b02367fb97fc7edbe1c7dba011470812b7`。
- 真实路径覆盖包含AuthorityWorker/SQLite restart、real-process server 24项、WebSocket/history/repair、Electron smoke、attachment extraction、source read/cursor/citation、privacy sentinel与既有FT-01～05/07～08回归。

两次更早的全量运行受到独立审阅Agent在共享worktree并发执行`tsc -b --force`、改写`dist/tsbuildinfo`的干扰，触发artifact hash与Worker瞬时失败；其进程组停止后，三条失败定向复跑全绿，并以上述独占全量复跑作为唯一最终证据。

## 6. Review与PR日志

独立对抗审阅先后发现并关闭：range receipt namespace/`delta_range`投影、Provider compiled-only closure、source pagination evidence、retry/recovery漂移、legacy execution抢占、pending confirmation intent丢失、attachment readiness启动竞态、FT-05 prefixed identity、`currently_required=false`生命周期/授权/物理约束以及dispatch失败后grant泄漏。

最终审阅对象`12a3ba6e424f6bd92cebdb6147502810da366934`，结论`APPROVE`，blocker=0、non-blocker=0。审阅确认v19保持89条statement、v1-v18 fingerprint不变，并逐项核对上述五个最后blocker的production代码与回归。

原工作区四个用户文件在本地交付候选完成后仍为untracked且SHA-256未变：

- FT-09 design：`88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122`
- FT-09 implementation：`8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c`
- FT-10 design：`8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578`
- FT-10 implementation：`8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd`

Blueprint未修改。PR、CI、squash merge SHA与worktree清理将在真实远端操作完成后写入最终交付记录。任何“通过”均绑定上述命令或后续GitHub状态；本文不使用`verified`作为项目状态。
