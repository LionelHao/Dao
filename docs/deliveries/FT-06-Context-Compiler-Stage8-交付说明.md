# FT-06 Context Compiler Stage 8 交付说明

状态：实现已通过 squash merge 交付远端 `main`；等待 owner 验收。本说明不把 Agent 自测或 CI 写成 owner 验收结论。

## 1. 远端交付事实

- 起始基线：`c0dc4421b3b5d5c00c4676e86bd205c482aa332c`（FT-05 Stage 7，schema v18）。
- Stage 8 集成分支最终 head：`88dab7406b307725274f88dda19cd917ebf028d5`。
- 实现 PR：[PR #60 — FT-06: deliver authoritative context compiler](https://github.com/LionelHao/Dao/pull/60)。
- squash merge 时间：2026-08-21 23:26:43 +08:00。
- FT-06 实现 squash SHA：`47293d3a791a71472ae8ef987ac80ca4caebcaa4`。
- 实现 tree SHA：`3261baf0492ad5eed186cdcee4d57ad27245848e`。
- 范围：89 files changed，15,939 insertions，326 deletions。
- CI workflow：[quality run 32496971258](https://github.com/LionelHao/Dao/actions/runs/32496971258)。
  - [Node 22.x job](https://github.com/LionelHao/Dao/actions/runs/32496971258/job/96817579220)：success，6m11s。
  - [Node 22.13.1 job](https://github.com/LionelHao/Dao/actions/runs/32496971258/job/96817579405)：success，6m49s。
- 本交付记录 PR：[PR #61 — docs(ft06): record Stage 8 delivery evidence](https://github.com/LionelHao/Dao/pull/61)。

## 2. Requirement、设计旅程与权威状态

直接覆盖 `REQ-MEM-003/004/007/008/009/011/012`、`REQ-PRIM-014`、`REQ-PRJ-013`；对应 J-03 invocation/execution/final、J-06 source inspection、J-07 offline/repair，以及 Memory panel 的 PRIM-014 边界。

- local transient：仅 Provider preview、打开中的 source 请求与本地焦点状态。
- server ACK：source-read claim/page/receipt、工具确认与 closed error。
- stable event/projection：execution terminal、Agent final、citation metadata、source unavailable/tombstone。
- 401/403/409/410/429/503、offline、repair、retry、invalidation、`content_too_large` 均走闭合分支，不把本地状态当成权限或持久化成功。
- 既有键盘、焦点、非颜色识别、ARIA通告、200%缩放与 reduced-motion 合同保持不变；本阶段未增加未经正式设计覆盖的长期 Desktop 信息架构。
- 设计偏离：无。owner 在本阶段明确批准“人工 retry 创建新 execution/new snapshot”，已记录为 Stage 8 设计基线；自动 retry/crash recovery 仍复用 immutable snapshot。

## 3. 生产交付范围

- server-private pure compiler：closed input/output、canonical JSON/hash、确定性 UTF-8 token accounting、固定 section reserve 与 degradation ladder。
- compiled-only Provider：删除 legacy 64-message production path；trusted 与 untrusted group content 分层，工具 continuation 也受冻结 input budget 约束，OpenAI request 保持 `store:false`。
- schema v19 Context Snapshot Authority：snapshot/body/manifest/source/binding/lineage/read receipt/citation；v1-v18 statement/checksum/fingerprint 未修改，v19 保持89条append-only migration statements。
- retry/recovery：automatic retry与crash复用同一body；manual/supersede建立新lineage；pending confirmation恢复原始immutable intent；未链接的legacy execution不被FT-06 runtime抢占。
- `room-memory.read`：只接收manifest label与opaque cursor；每页前后重新授权，执行级call/byte budget，AES-256-GCM 5分钟cursor，closed 401/403/409/410/429/503映射。
- source identity/lifecycle：FT-05 message/message-revision/tombstone prefix归一为逻辑message id；`currently_required=false`只保留不可寻址的历史审计来源，并由v19物理约束双向封闭；historical attachment由immutable extraction artifact证明。
- citation：manifest/read receipt namespace分离；`delta_range`只能在成功读取后引用；final message、citation与execution terminal在AuthorityWorker同一事务提交；Desktop只呈现server-confirmed projection。
- startup/privacy：attachment reader capability在所有runtime recovery前收敛；source grant在成功/失败/malformed路径均清理；restricted body不进入event/outbox/repair/WebSocket/普通日志。
- FT-09/FT-07未交付能力保持明确`disabled/unavailable`，没有用消息、fixture、fake Provider或mock填充生产事实。

## 4. 本地门禁证据

- `corepack pnpm test`：172 passed / 3 skipped files；1927 passed / 3 skipped tests；202.87s。命令内core boundary和Desktop renderer boundary同时通过。
- `corepack pnpm typecheck`：通过，包括core/server negative type tests。
- `corepack pnpm lint`：通过，0 warnings。
- `corepack pnpm build`：core、server、desktop三个workspace通过；Desktop preload/renderer copy完成。
- `corepack pnpm verify:core-boundary`：通过。
- `corepack pnpm verify:desktop-boundary`：通过，20个renderer production source无Node/Electron authority。
- `git diff --check`：通过。
- v19 migration matrix：4/4；覆盖fresh、每个v1-v18升级/restart、89条statement逐条rollback、future/history/physical tamper。
- 聚焦回归：受影响套件52/52；Context Snapshot Authority单独19/19。
- property：seeds `1129601030,1296387335,3737844653`，每seed 256次permutation，加每seed 32次large-delta；运行规模与断言未降低。
- real path：AuthorityWorker/SQLite restart、real-process server 24项、WebSocket/history/repair、Electron smoke、attachment extraction、source read/cursor/citation、privacy sentinel与既有FT-01～05/07～08回归均包含在全量门禁。

三个skip仅为Agent、route、memory OpenAI live suites。显式live flag与server-side secret没有同时存在，因此按批准合同安全跳过；没有读取、打印或派生secret。两次受共享worktree并发`tsc -b --force`影响的早期运行不作为交付证据；终止干扰后，失败项顺序复跑通过，并以最终独占全量结果作为本说明证据。

## 5. 独立审阅与受保护内容

最终独立对抗审阅代码对象为`12a3ba6e424f6bd92cebdb6147502810da366934`，结论`APPROVE`，blocker=0、non-blocker=0。审阅逐项核对pending intent恢复、attachment readiness、FT-05 prefix归一、`currently_required=false`不变量与source grant清理，并确认v1-v18 fingerprint未改、v19仍为89条statement。

原工作区四个用户untracked文件在实现合入后仍未被stage、commit、移动或格式化，SHA-256如下：

- FT-09 design：`88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122`
- FT-09 implementation：`8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c`
- FT-10 design：`8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578`
- FT-10 implementation：`8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd`

Blueprint文件未修改。临时worktree仅在本交付记录合入并再次核对远端merge状态、各worktree无未交付内容后清理。
