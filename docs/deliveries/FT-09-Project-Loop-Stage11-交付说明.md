# FT-09 Project Loop · Stage 11 交付说明

状态：FT-09 Stage 11 生产实现已经受保护分支合入远端 `main`，等待 owner 验收。本说明只记录可复核的实现、测试、审阅和远端事实；不把 Agent 自测、CI 或审阅写成 owner 验收，不标记 verified。

## 1. 一句话结果与远端事实

- 一句话结果：Goal、Decision、Request、NextAction、Blocker/OpenQuestion、TransferProposal、Ball/NeedsAction 与 due/review reminder 已形成 Core closed union → AuthorityWorker/SQLite transaction → stable event/outbox → fixed-watermark repair → Desktop Project Panel 的生产权威闭环。
- predecessor：`55aba117d8bcef5b89390a62e2a57a050fb571e1`（FT-08 Stage 10 evidence；开始时 schema v22）。
- 实现合入后的远端 `main`：`11a73baea42707a7efb12bb9eda01fdd695ea5ef`（Authority schema v25）。
- 实现 PR：[PR #73 — FT-09: deliver authoritative Project Loop](https://github.com/LionelHao/Dao/pull/73)，squash merge SHA `11a73baea42707a7efb12bb9eda01fdd695ea5ef`。
- 实现 CI：[quality 32891609467](https://github.com/LionelHao/Dao/actions/runs/32891609467)：[Node 22.13.1](https://github.com/LionelHao/Dao/actions/runs/32891609467/job/97944591202) 与 [Node 22.x](https://github.com/LionelHao/Dao/actions/runs/32891609467/job/97944590913) 均 success。
- 证据 PR：[PR #74 — docs(ft09): record evidence and stabilize real-Worker CI](https://github.com/LionelHao/Dao/pull/74)；PR 页面保留最终双 Node required checks，最终 squash merge SHA 由 GitHub 在本 PR 合入时记录。

实现 PR 共变更 124 个文件，新增 21,981 行、删除 241 行；没有 Blueprint HTML/JSON、Grand Blueprint 数据或 renderer 变更。仓库禁止 merge commit，因此实现 PR 按 branch protection 允许的 squash 方式合入；没有 force push 或绕过 required checks。

## 2. 24 条 Requirement 逐条证据

统一代码入口：Core `packages/core/src/project-loop.ts`；Authority `packages/server/src/project-loop/database-authority.ts`、`boundary-authority.ts`；协议 `packages/server/src/project-loop-protocol.ts`；Desktop `packages/desktop/src/project-loop/production-runtime.ts`、`packages/desktop/src/renderer/project-loop/surface.ts`。逐条完整性由 `packages/core/src/project-loop-requirements.test.ts` 证明 24/24、无重复、每条均有 Core/Authority/UI bucket。

| Requirement | 产品/代码证据 | Authority/SQLite 与测试证据 | UI/边界 |
| --- | --- | --- | --- |
| `REQ-AGT-005` | Agent 只能提交 Goal/Decision proposal 或更新自己合法责任；`ProjectProposal` 保留 proposer 与 Human principal | `database-authority.test` 的 eligible Assignment、spoof/outsider/cross-Room 拒绝 | J-06 proposal 明确不是 confirmed fact |
| `REQ-AGT-006` | `ProjectBallFact`、stable boundary ID 与 exact subject revision | `project-boundary-authority.adversarial.test` 的 current/revoke/archive/transfer/final recheck 与 zero Provider | J-07 NeedsAction/boundary 只显示当前责任 |
| `REQ-MEM-005` | `ProjectSnapshot` 与 confirmed fact checkpoint closed port | `confirmed-project-fact-checkpoint-port.test`、canonical snapshot/restart | J-06 source deep link；memory proposal 不创建 Project fact |
| `REQ-PRIM-003` | 独立 Project fact closed union，不复用 OpenItem/LightTask | Core exact-key/unknown-enum/type tests与 DB closed dispatcher | Project Panel 使用正式 Project 对象 |
| `REQ-PRIM-010` | Ball 是 boundary projection、每 source 单一 holder、Room 可多 source | boundary/DB single-holder、transfer supersede、reopen generation tests | NeedsAction 与 unread/read 分离 |
| `REQ-PRIM-015` | Goal/Decision proposal 是独立非权威候选态 | proposal transaction、replay、source revision CAS tests | J-06 pending proposal 标签与确认动作 |
| `REQ-PRIM-016` | 只有具名当前 Human 可 confirm/reject | Human principal/owner-admin/target-only tests；Agent direct confirm 为零写入 | J-06 confirm/reject，非颜色状态 |
| `REQ-PRIM-017` | `ProjectEvent` + outbox + audit 与 ACK 分层 | event/outbox/idempotency 同事务、startup reverse invariant、WS ACK/event ordering | local transient → submitting → ACK → stable event/repair |
| `REQ-PRJ-001` | 一个 Room 同时最多一个 active primary Goal | concurrent confirm、atomic replacement、双向 immutable edge | J-06 active Goal/proposed/superseded |
| `REQ-PRJ-002` | Decision proposed/confirmed/rejected/superseded | named confirmer、source revision、immutable confirmed history | J-06 Decision 列表与来源 |
| `REQ-PRJ-003` | 新结论 supersede 旧 Decision，不原位改写 | replacement reason/双向链/CAS/event/checkpoint tests | superseded 明文状态与受影响提示 |
| `REQ-PRJ-004` | structured Human target 形成 pending Request handshake | message + target outcome + Request 同事务；accept/cancel/transfer/replay/rollback | J-04 Request card、recipient action、requester coordination |
| `REQ-PRJ-005` | NextAction 七态、单一 owner、criteria/deliverable/due/revision | Human accept、Agent start/deliver、verifier done、reopen/transfer race | Project Panel action、owner/verifier、交付/验收状态 |
| `REQ-PRJ-006` | Human/Agent 身份与 assignment 分治 | membership/Profile/Assignment/availability/capability final recheck | owner kind 与具名 Human principal 可见 |
| `REQ-PRJ-007` | Agent 永远不能写 done；Agent-owned action 固定 Human verifier | Agent direct done 零写入；deliver → designated verifier accept/reject | verification state 与 named verifier |
| `REQ-PRJ-008` | Human-owned 无 verifier 唯一直接 `in_progress → done` 例外 | verifier-aware completion 与 illegal transition matrix | completion state 不伪装为本地成功 |
| `REQ-PRJ-009` | Blocker/OpenQuestion 是两个独立 kind、单一 owner、只经 accepted transfer 改 owner | obstacle reducer、current transfer subject CAS、stale proposal refusal | 两类对象与状态分别展示 |
| `REQ-PRJ-010` | deferred 与 cannot_answer 永远分离；review_due 与 escalation boundary | defer/reviewAt、system timer reopen、cannot_answer 单次 escalation tests | due/review 与 escalation 非颜色标签 |
| `REQ-PRJ-011` | transfer pending 不改 owner/Ball；accepted 原子迁移责任 | single-active proposal、current/stale revision、old Ball supersede、新 Ball、departure tests | transfer card 使用 subject revision；stale 为只读 |
| `REQ-PRJ-012` | due ordinal 0、每 24h 新 bucket、长停机只 claim 当前 bucket | duplicate scan、4096 stale bounded progress、restart/competition/archive/reopen | due/review time 与 reminder recovery 状态 |
| `REQ-PRJ-013` | future tool dispatcher 复用同一 reducer/principal/CAS/audit | Worker adapter 与 shared database authority dispatcher tests | 只提供 FT-10 closed seam，不开放任意 tool authority |
| `REQ-ROOM-001` | `projectId === roomId`，不建第二 aggregate | schema scope checks、cross-Room refusal、Room lifecycle composition | Room 内 Project segment |
| `REQ-ROOM-003` | membership/access/lifecycle 是每次读写与运行时的权威 gate | archive/reopen freeze-resume、departure final recheck、403/410、repair revoke | archived read-only、403/410 恢复动作 |
| `REQ-UX-004` | Project repair record、closed UI state model | fixed-watermark/three-client/reconnect/clear-cache/corrupt-record fail-closed | J-04/J-06/J-07、keyboard/focus/ARIA/zoom/reduced motion |

本阶段闭合上述 FT-09 直接语义；FT-10 tool confirmation、FT-12 flat notification center、FT-13 通用可靠性终局和 FT-14 retention/credential policy 仍是共享后续边界，没有被本表冒充完成。

## 3. 状态机与 principal 边界

- Goal：`proposed → active/rejected/superseded`；Human 或 Agent 可 propose，只有当前 Room Human 可确认。替换 active Goal 在一个事务中 supersede 旧 Goal、激活新 Goal并写双向 replacement edge。
- Decision：`proposed → confirmed/rejected/superseded`；confirmed 记录 Human confirmer、source/revision/time/version，之后不可原位改写。
- Request：`pending_acceptance → accepted/rejected/cancelled`；接受前 target 只有 recipient-scoped action，请求人持有 coordination Ball；target Human 可 accept/reject/transfer，请求人可在接受前 cancel；accept 原子链接且只链接一个 NextAction/Blocker/OpenQuestion。
- NextAction：`proposed → accepted → in_progress → delivered → done`，以及 `rejected/cancelled` 终态；Human owner 本人接受，Agent assignment 由具名 Human principal 确认；Agent 只能 start/deliver，不能 done；reopen 生成新 revision/boundary，终态不复活。
- Blocker/OpenQuestion：`open/resolved/deferred/cannot_answer`；deferred 必须 reason+reviewAt，到时由 `system_timer` 原子回 open 并生成新 boundary；cannot_answer 只产生一次 escalation；resolve/answer 必须带 result source。
- TransferProposal：`pending → accepted/rejected/cancelled/expired`；只绑定既存责任的 kind/id/revision。pending 不迁移 owner/Ball；accepted 原子更新 proposal、subject、transfer chain、旧/新 boundary、event/outbox/receipt；stale proposal保留审计但无 Ball/reminder/departure blocker且 UI 只读。
- Ball/reminder：Ball 只由 current nonterminal boundary 派生，不是第二 writer。stable reminder key 为 `(roomId,boundaryId,kind,ordinal,recipient)`；Human holder 得 durable recipient outbox，Agent holder经 FT-08 seam exactly-once invocation；完成、转移、defer、archive或 generation 变化停止旧 reminder。
- authority：public frame不能提交 actor/principal/role/Agent/provider/internal capability；principal来自 session、membership、Profile/Assignment与 Room governance。`system_timer` authority 必须无 actor/causal actor；Human/Agent authority 必须与存储 actor kind 精确一致。

## 4. Schema v25 与 v1-v24 兼容

- v23 在 v22 后 reader-first 扩展 v14 skeleton，提供 Project current/detail、proposal/confirmation、transfer/audit/event/outbox/idempotency、boundary/Ball/reminder、checkpoint、repair 与 lifecycle suspension；历史 v1-v22 migration 未修改。
- v24 增加 FT-08 project-boundary intent/execution/checkpoint durable lineage；v25 机械解决 timer authority 与历史 v24 event/audit/public projection 一致性。最终 schema 为 v25，而不是旧计划中的 v23；原因与每次增量已写入 rebaseline/addendum。
- v25：40 条 immutable migration statements、6 条 v25 write/immutability triggers、2 条专属 startup reverse/authority invariants、40 个逐 statement 故障注入 rollback 位置；fresh 与 v24-upgrade physical schema 等价。
- 13 个 schema 文件 / 129 tests 覆盖 `schema.test` 与 v15…v25、v23 分区 rollback、fresh、每个历史版本升级、重复 migrate、future/history/fingerprint/physical tamper、WAL reopen、legacy fixture、不伪造 confirmer/verifier/source、v24 timer backfill。
- v25 将历史 `review_due`/`transfer_expired` 的 stored/public/audit authority 迁成 `system_timer` + null actor/causal actor；新事件要求 event→public/audit/outbox 双向存在与 room/event sequence 一致。

## 5. 相邻阶段生产 seam

- FT-02B：server-private departure contributor 在 membership mutation 同一 AuthorityWorker transaction 做 final recheck，覆盖 Request requester/target、NextAction owner/verifier、Obstacle owner、current transfer acceptance与pending confirmation；冲突只含 safe summary。
- FT-02C：archive 冻结非终态 responsibility/timer/runtime，不伪装 terminal；reopen恢复剩余业务时长，使用认证 Human actor并生成新 lifecycle generation/boundary；terminal 不复活。
- FT-03：只消费 structured Human target/intention；message、target outcome、pending Request、event/outbox/receipt 同事务，message ACK 不表示 target 接责。
- FT-05：提供 confirmed project fact checkpoint；memory proposal/confirmed/disputed 与 Project fact 是独立状态机，raw body 不进入 checkpoint/repair。
- FT-07：Agent owner和project invocation在创建、claim、Provider前与 final 前复核 membership、Profile/Assignment revision、participation、availability、capability与 boundary currentness。
- FT-08：真实 active current boundary接入 message-independent project producer；stable boundary exactly-once receipt；stale/revoked/archived/removed Agent 为 0 execution/0 Provider，无 Agent 自动级联。
- FT-10：只提供 closed query/command dispatcher seam，复用同一 reducer/principal/CAS/audit；未实现通用 shell、URL、文件写入或完整 confirmation/grant/compensation。
- FT-12：仅产生 recipient-scoped durable due/acceptance/verification outbox；未实现 flat notification center、read/handled aggregate、OS push。
- FT-13：closed record/event、exact guard、negative type、stable key/checksum、central repair registry、Desktop cache lifecycle与 fixed-watermark 证据已具备；未宣称横切终局全部完成。

## 6. Protocol、sync/repair 与 Desktop

- public `project.*` family 使用 exact allowlist、size bound、requestId/idempotency/expectedRevision，闭合 400/401/403/404/409/410/429/503；ACK 只表示 Authority commit，事实由 stable event/repair 收敛。
- stable event/outbox 对 fact、proposal、transfer 分别发布 canonical public projection；transfer accept 同事务发布 proposal changed 与 subject changed。unknown/extra/cross-Room/forged actor均 fail closed。
- fixed-watermark repair 按 central descriptor 单向注册，分页/buffer有界；覆盖 duplicate/out-of-order、cursor gap、512+ live buffer、reconnect、clear-cache、three-client、restart、repair中 revoke、archive/reopen、unknown record。
- Desktop J-04：Request timeline card 提供接受/拒绝/转交/取消与 recipient/requester authority。
- Desktop J-06：Goal/Decision proposal、确认、拒绝、supersede，与 confirmed fact、disputed Context清楚分离。
- Desktop J-07：offline、401/403/409/410/429/503、repair/replay/repair-failed 均有恢复动作；repair失败保留旧完整 projection。
- Project Panel：Goal、Decision、NextAction、Blocker/OpenQuestion、Ball、owner/verifier、due/reviewAt、source deep link；transfer resolve使用 subject revision CAS，stale proposal显示只读、`aria-disabled`、status/live通告且无动作按钮。
- 1440×900、840×560、100%–200%/150% zoom、keyboard、Esc focus restore、非颜色识别、ARIA、reduced motion均有 surface/root tests；没有 Agent typing animation。正式设计偏离：**无**。

## 7. 精确验证与 CI

最终实现候选 `fd9c027bb64683a173caaf3dee7fce26e315e4e2` 依次通过：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
corepack pnpm --filter @native-im/desktop smoke
git diff --check
```

- 全量：236 files（233 passed / 3 skipped / 0 failed）；2523 tests（2520 passed / 3 skipped / 0 failed）；实现候选本地 `pnpm test` 700.73s，证据候选经下述编排修正后为 736.74s。
- Core：11 files / 107 passed。
- Desktop：72 files / 576 passed。
- Server：153 files（150 passed + 3 skipped）/ 1840 tests（1837 passed + 3 skipped）。
- FT-09 专属：23 files / 183 passed。
- schema migration/history/rollback：13 files / 129 passed；其中 v25 3/3，40 statements/40 rollback positions。
- real AuthorityWorker/SQLite：Project authority/boundary/message/real-process 4 files / 74 passed；隔离 Worker client 1 file / 56 passed，合计 5 files / 130 passed。
- WebSocket/sync/repair：7 files / 211 passed。
- FT-09 Desktop/a11y：5 files / 60 passed。
- race/property/sentinel focused：6 files / 88 passed，覆盖真实进程 crash/ACK loss/restart、CAS双winner、bounded stale scan、provider zero-call、raw-body/actor spoof、transaction rollback与 deterministic Ball。
- Core boundary：无 I/O dependency/import；Desktop boundary：27 个 production renderer source 无 Node/Electron authority；真实 Electron smoke通过 native selection、secure preview 与 app bridge。
- CI run 32891609467：Node 22.x 17m21s success；Node 22.13.1 18m55s success。唯一 annotation 是 GitHub Actions 自身 Node 20 action runtime deprecation，不是产品或测试失败。

证据 PR 的初始 Node 22.13.1 全量运行在通用 jsdom 并行池中先后使两个不同的真实 Worker/SQLite 旧用例超过默认 5s 上限（5.688s 与 5.022s），两次其余 2519 tests 均通过。同一 Node 22.13.1 下隔离重复分别 10/10 与 5/5 通过；根因是真实 Worker 文件与 200+ 文件的跨文件 CPU/I/O 竞争。`vitest.config.ts` 因此只将 `worker-database-client.test.ts` 和 `context-snapshot-database-authority.test.ts` 收入仓库已有的 single-fork `worker-persistence` 组；未修改测试代码、断言、计数或 5s 上限。Node 22.13.1 下该组 16 files / 223 tests 全通过，随后全量 236 files / 2523 tests 也全通过；修正仅隔离真实持久化资源竞争，没有放宽任何门禁。

三个 OpenAI opt-in live suites（Agent、Router、Memory）因没有显式启用 live flag 和/或 secret 安全跳过。没有读取、打印、hash、比较或记录 secret 的值、长度、前后缀、Authorization header或可识别派生值；fake runtime、SSE parser、timeout/cancel、noauth、provider error与secret sentinel覆盖未降低。

## 8. 独立对抗审阅与已知风险

三个独立审阅方向覆盖：Desktop authority/error/a11y；runtime/Ball/reminder/restart/archive/transfer race；schema/principal/transaction/CAS/idempotency/repair。审阅中发现并修复了 timer authority、v24 migration、review_due transfer、stale transfer责任死锁、stable transfer event、Desktop transfer CAS、409 rebase与 stale UI 等问题。

最终结论：**无剩余 P0、P1 或 P2；无交付 blocker。** 最后生产变更 `2ea4da3` 经 Desktop reviewer复审无 P0/P1/P2；最后仅测试 fixture 提交 `fd9c027` 的 real-process E2E 29/29 与全量 2520/2520 passed，再由 CI 双 Node matrix复验。

已知非阻塞风险/运营项：GitHub marketplace actions仍声明旧 Node action runtime并产生 deprecation annotation，属于 CI dependency维护，不影响 Node 22.13.1/22.x 项目矩阵；三个真实 OpenAI live suites保持显式 opt-in，当前以 fake/provider parser/noauth/sentinel和边界 zero-call 证明替代，不把跳过写成通过。真实 Worker 跨文件资源竞争已通过上述测试编排修正闭合，不作为剩余缺陷或被忽略的 flake。

## 9. Git、保护文件、Blueprint 与 worktree

- 所有开发与证据工作均在隔离 worktree；原工作区 `/Users/leo/code/Dao` 始终保持分支 `codex/ft02a-delivery-trace-fix`、HEAD `979863e7936962626b54a130d0260a4689a9bfb0`，仅有四个既存未跟踪文件。
- 四个保护文件从未 stage、commit、stash、reset、移动、覆盖、格式化或删除；实现 PR 合入后复核 SHA-256：
  - FT-09 design：`88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122`
  - FT-09 implementation：`8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c`
  - FT-10 design：`8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578`
  - FT-10 implementation：`8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd`
- PR #73 merged 后，`authority`、`core/boundary`、`desktop`、`message`、`stage11 integration` 五个 worktree 均先检查 clean，再以非强制 `git worktree remove` 删除并执行 `git worktree prune`；目录和注册项均已消失。
- 本证据 worktree是唯一剩余 Stage 11 临时 worktree；证据 PR merged并再次验证远端状态后将非强制删除、prune并最终复核原工作区。最终结果由本任务的交付报告记录。
- 未修改 Blueprint，未调用执行者无权使用的 verified 状态迁移，也未自行标记 FT-09 verified。

## 10. 交付结论

以上证据只说明 FT-09 Stage 11 已满足实现、测试、审阅、CI 与远端交付条件；最终产品验收仍由 owner 执行。
