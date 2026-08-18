# FT-09 Project Loop 拆环实施计划

> 状态：**计划冻结 / 尚未实施**。本文件不宣称 FT-09 已交付或 verified。
>
> 设计依据：[FT-09 Project Loop 生产工程设计冻结稿](2026-08-18-ft09-project-loop-design.md)

## 1. 目标、非目标与完成门槛

目标是在不建立第二 Project aggregate 的前提下，把 Goal、Decision、Request、NextAction、Blocker/OpenQuestion、transfer、Ball/NeedsAction、due reminder 与 confirmed project fact 做成 Room-scoped 生产 authority，并以明确 transaction seam 解开 FT-02/FT-09/FT-10 循环依赖。

非目标：不把 `OpenItem`、`LightTask`、旧 `BallInCourt` 改名；不扩展 Blueprint；不设计跨 Room 五分区 inbox；不增加 OS push；不允许 Agent 确认 Human 承诺；不在本设计任务中改 `packages/**`。

实施完成门槛不是“页面可见”，而是：闭合 Core/type tests、immutable migration、real AuthorityWorker transaction、protocol/WS、FT seams、FT-13 repair registry、Desktop J-04/J-06/J-07、三客户端/restart/race/a11y E2E 全部通过，并产生独立交付说明和 verification evidence。本文本身不满足该门槛。

## 2. 合入顺序：解除 FT-02 / FT-09 / FT-10 循环

| 顺序 | 可独立合入的合同/能力 | 解开的依赖 | 禁止提前做的事 |
|---|---|---|---|
| 0 | **Contract spine**：Core project IDs、closed records、guards、commands/events；server-private `AuthorityTransactionView`、departure contributor、pending-confirmation contributor 接口；全为 fail-closed contract tests | 让 FT-02、FT-09、FT-10 可并行引用稳定接口而不互相 import 实现 | 不加 protocol，不改 UI，不用 stub 返回空掩盖已启用功能 |
| 1 | **FT-09 authority base**：实际 predecessor 后的 migration、Goal/Decision/Request/NextAction/Obstacle/transfer/boundary 表与 dispatcher；departure collector 聚合 FT-09 自有责任 | FT-09 不再等待 FT-02；形成同事务可查询事实 | 不接 FT-03 自由文本，不暴露 Agent write shortcut |
| 2 | **FT-02 departure integration**：leave/remove 在同一 AuthorityWorker transaction 调 collector，并在 membership mutation 前 final recheck | 解除 FT-02 对“未来 FT-09 端口”的 503；FT-02 只观察合法终态 | 不替目标 Human accept/complete/transfer；不在事务外预查 |
| 3 | **FT-03 Request participant**：`message.send.v2` structured Human target → pending Request，同事务 ACK/event/outbox | 解除 FT-09 Request 创建对 FT-03 的依赖 | 不以 message body 解析或 project command 代替 intent |
| 4 | **FT-10 adapter**：project read/write tool dispatcher；pending confirmation contributor 注册到 departure collector | FT-10 获得 project boundary；FT-02 可检查 pending confirmation | 不让 tool grant 越过 domain principal matrix；participant 缺失必须 503 |
| 5 | **FT-02 archive settlement**：FT-10 先 settlement security confirmation，FT-09 冻结业务 timer/boundary，FT-02 commit lifecycle | 解开 archive/reopen 与 pending confirmation/project timer 的最后环 | 不复活 terminal responsibility；不把 archive 当完成/取消 |
| 6 | **FT-08/12/13 adapters + Desktop**：boundary invocation、recipient notification、repair registry、J-04/J-06/J-07 | 完成下游消费与可恢复 UI | 不做跨 Room inbox或 OS push；不在 repair 之外造第二事实源 |

关键依赖方向冻结为：Core contracts ← feature descriptors/adapters；Authority transaction host 注入 contributors；FT-02/03/10 不反向 import FT-09 persistence internals；FT-09 不反向 import FT-13 registry assembly。这样可用接口和 contract fixtures 先合入，再按 participant registration 逐步启用，避免空实现互相等待。

## 3. TDD 切片

每个切片按“先红 contract/type test → 最小 domain/authority 实现 → real SQLite test → protocol/repair/UI（如适用）→ restart/race 回归”执行。任何切片不得用旧 status alias 让测试变绿。

### S0 — 基线与 closed contract spine

**红测**

- exact-key guards 拒绝 extra field、错 `projectId`、跨 Room source、unknown union member、Agent-as-Human verifier；
- compile-time exhaustiveness 覆盖 Goal/Decision/Request/NextAction/Obstacle/Transfer/Boundary/DepartureConflict；
- contributor registry 对 duplicate kind、缺失已启用 contributor、非 transaction view 访问 fail closed；
- Requirement fixture 固定 FT-09 的 24 个直接 Requirement ID。

**实现**

- 在 Core 新建 Project Loop 专属模块，不塞入旧 OpenItem/LightTask union；
- 冻结 command/event/projection、principal capability、source ref、revision/CAS、error reason code；
- 新建 server-private transaction participant contracts，不暴露到 public protocol。

**退出条件**：zero-I/O domain tests 和 type tests 通过；旧 API 无变化；无 schema/protocol/UI 写入。

### S1 — immutable schema 与 legacy compatibility

**红测**

- empty DB、当前生产 fixture、重复 migrate、未知较新 schema、partial migration、旧 OpenItem/LightTask/Ball fixture；
- 唯一 active primary Goal、单 active transfer、boundary stable key、reminder unique key；
- backfill 不产生 confirmer/verifier/acceptance/source revision，不进入 canonical active queries。

**实现**

- 在实施时实际 predecessor 后 append migration，不在计划中预占版本；
- 新建 project domain/audit/idempotency/event/outbox/boundary/reminder 表和必要 partial unique index；
- legacy compatibility 只读 mapper 与 provenance，禁止新 command 双写旧表。

**退出条件**：migration 可重复、数据不可变、forward-fix rollback 原则有测试；旧二进制/feature gate 行为明确。

### S2 — Goal / Decision authority

**红测**

- Agent propose/Human confirm；Agent confirm 403；第二 active Goal 409；replacement 同事务；stale source/revision 409/410；
- Decision confirm/reject/supersede 终态；跨 Room source/replace 拒绝；幂等重放原 ACK/event IDs；
- crash after domain write / before commit 为零行。

**实现**

- closed dispatcher、SQLite statements、append-only confirmation/replacement rows、event/outbox/idempotency；
- `ConfirmedProjectFactCheckpointPort` 首批 Goal/Decision mapper。

**退出条件**：real AuthorityWorker/SQLite 单事务证明唯一 Goal 和 replacement/supersede 链。

### S3 — Request handshake 与 FT-03 structured target seam

**红测**

- `message.send.v2` 中 message + HumanRequestIntent + pending Request + event/outbox 原子；任一点故障零写；
- pending Request 的协调 Ball 仍归 requester，target 只有 recipient-scoped acceptance action、没有 project responsibility；target accept 原子创建 NextAction/OpenQuestion/Blocker 并迁移 Ball；
- non-target accept 403；accept/cancel race 只有一个胜者；recall-before/create-after 与 create-before/recall-after 两种 ordering；
- per-target invalid 不影响合法目标且不伪造 Request；message ACK 不表示 accepted。

**实现**

- FT-09 transaction participant 消费 FT-03 frozen payload；
- Request accept/reject/cancel 与 linked responsibility factory；
- pending acceptance/source recall boundary mapper。

**退出条件**：real message authority + SQLite + WS restart E2E 可证明接受前无 Human 承诺。

### S4 — NextAction Human/Agent 分治

**红测**

- 必填 owner/deliverable/显式 criteria 合同，due 可选；Agent owner 缺具名 Human verifier 拒绝；role-only verifier 拒绝；
- 无 verifier 的 Human owner direct done；有 verifier 的 Human owner先 deliver；Agent update/deliver；只有原具名 verifier可 done/reject delivery；role 变化不偷换 verifier；
- cancel/rejected terminal 不可 reopen；Room reopen 不改变 terminal；owner departure 被 collector 检出；
- deliver/verify、verify/revoke、reopen/transfer races CAS 唯一胜者。

**实现**

- NextAction state reducer、principal checks、completion/delivery/verification audit；
- work 与 pending verification boundary；fact checkpoint。

**退出条件**：Human/Agent matrix 每格都有正反 test，Agent 无任何 done code path。

### S5 — Blocker / OpenQuestion / transfer / escalation

**红测**

- 单 owner、impact、due/reviewAt；deferred 无 reviewAt 失败；cannot_answer 无 reason/escalation 失败；两状态序列化不相等；
- pending responsibility transfer 不换 owner；accept 原子换 owner/boundary/chain；Human NextAction 新 owner 回 proposed 并再次接受；Request target handoff 则保持 pending acceptance 且不产生责任；reject/cancel/expire 不换 owner；一个 subject 不得两个 active proposal；
- target departure、subject revision、transfer expiry、cannot_answer escalation 的 race；immutable chain 无 update/delete；
- departure conflicts 覆盖 blocker、open_question、pending transfer acceptance。

**实现**

- discriminated obstacle reducer 和独立 guards；
- 通用 TransferProposal dispatcher、expiry escalation boundary、append-only chain。

**退出条件**：所有非法转换 409，deferred/cannot_answer 从 DB 到 repair/UI 不合并。

### S6 — Ball/NeedsAction、多 source、due/24h reminder

**红测**

- 同 Room 多 source 并存，每 boundary 单 holder；unread 变化不影响 NeedsAction；
- dueAt-1ms 无 claim，dueAt ordinal 0 一次，+24h ordinal 1 一次；重启、双 scan、多进程竞争不重复；
- transfer/reopen/due revision/archive-resume 换 boundary，旧 reminder 不复活；无 due 仍有 Ball但无 reminder；
- Agent boundary 只生成 FT-08 intent，Human boundary 只生成 FT-12 recipient notification；不能把多个 queued route 都标成同一 source。

**实现**

- project responsibility → Ball materialized projection；稳定 boundary ID/generation；
- reminder claim/event/outbox 同事务；旧 ball-runtime 只作 compatibility，不参与新 authority。

**退出条件**：real SQLite clock fixture + restart + concurrent worker 证明 ordinal 稳定。

### S7 — FT-02 departure port 与 lifecycle

**红测**

- conflict kinds 至少 Request、NextAction、Blocker、OpenQuestion、pending acceptance、pending confirmation、pending verification；
- conflict ID 同 revision 稳定、revision 后变化、Room-scoped、无 body/secret/raw corpus，allowed resolution 可 deep-link；
- transaction 外查询不能传入；first check 后注入 race，final recheck 阻止 leave/remove；空集才 membership/event/outbox/idempotency 同事务 commit；
- FT-02 不产生 accept/done/transfer rows；已启用 FT-10 contributor 缺失返回 503；
- archive 冻结非终态 duration、settle confirmation；reopen 新 boundary 且不复活 terminal。

**实现**

- 聚合式 `DepartureResponsibilityPort` 与 FT-09/FT-10 contributors；
- FT-02 leave/remove 同 transaction 两次检查；archive/reopen lifecycle generation 与 timer suspension。

**退出条件**：real AuthorityWorker concurrency test 证明 final recheck；FT-02 合法终态之外无绕过。

### S8 — FT-10 read/write tool boundary

**红测**

- Room-scoped project read 返回 closed projection且无 raw corpus；跨 Room 403；archived/revoked 410/403；
- project write tool 与 public command 使用相同 reducer、principal、CAS、idempotency；
- Agent 仅 propose/update/deliver 自身 action，尝试 Human accept/confirm/done 均 403；
- tool pending confirmation 被 departure collector 发现，确认 race 后 final recheck 正确。

**实现**

- 只读 query port 和内部 command dispatcher adapter；不复制第二套业务逻辑；
- pending confirmation contributor 注册与 fail-closed health signal。

**退出条件**：tool path 与 WS path 对相同命令得到相同 event/projection，权限无漂移。

### S9 — protocol / WebSocket / sync / FT-13 repair

**红测**

- 每个新 frame exact field allowlist、size limit、error mapping、ACK replay；旧 frame 不接受新字段；
- room event ordering、subscribe barrier、repair pagination/checksum、snapshot mapper、未知 record fail closed；
- FT-13 descriptor checklist：closed union/guard/type test、domain+event+outbox+idempotency、readonly mapper、registry assembly、Desktop reducer/cache、lifecycle policy、三客户端/restart/sentinel；
- 401/403/409/410/429/503 与 reconnect/repair flows。

**实现**

- 独立 `project.*` protocol family 和 WS handlers；
- FT-09 repair descriptors/records/events，在 FT-13 central assembly 单向注册；
- projection cache 清理与 revoked/archived visibility。

**退出条件**：WS ACK、event、repair、restart 后 projection 完全一致；旧 compatibility API 不冒充新 contract。

### S10 — FT-05 / FT-08 / FT-12 adapters

**红测**

- confirmed project checkpoint 可建 memory proposal；memory proposed/confirmed/disputed 均不能反向改变 project row；project supersede 触发复核 event；
- FT-08 只接受 confirmed active unconsumed boundary，重复 claim 一次，source-scoped cancel；
- FT-12 唯一 recipient+boundary+kind+ordinal，read 不等于 handled，责任完成/转移才 handled；
- offline/reconnect/restart 不重复 notification/invocation。

**实现**

- server-private adapters 与 stable outbox payload；
- 不设计全局 inbox布局、不增加 OS push。

**退出条件**：adapter contract tests 与 real outbox/restart tests 通过，feature unavailable 时 503/fail closed。

### S11 — Desktop J-04 / J-06 / J-07

**红测**

- reducer 明确区分 local transient、ACK、stable event、projection/repair；optimistic UI 不显示已接受/已确认/已完成；
- J-04 pending/accept/reject/transfer/cancel、J-06 proposed/confirmed/rejected/superseded/source stale、J-07 offline/read/handled/repair failed；
- 401/403/409/410 给恢复动作，429/503/timeout 同 key retry；
- 1440×900、840×560，规定 zoom；键盘顺序、Esc 焦点恢复、非颜色状态、screen-reader announcement、reduced motion；
- Room archive/reopen 不显示 terminal responsibility 复活。

**实现**

- 正式 Project panel/timeline cards/NeedsAction segment 与 source deep link；
- 840×560 将右 panel 收入 timeline/project segment；
- 权威低频更新 `aria-live=polite`，streaming preview `aria-live=off`。

**退出条件**：逐状态回指设计旅程与 Requirement；视觉回归、DOM/a11y 和 keyboard E2E 都通过。设计偏离仍为“无”；若实现发现设计缺态，停止并请求 owner 决策。

### S12 — 生产级端到端与 failure matrix

**红测/最终证据**

- real AuthorityWorker + real SQLite + real protocol parser + real WS，禁止 mock store 替代；
- 三客户端并发：create/accept、confirm/replace、deliver/verify、transfer/leave、reminder/complete；
- kill/restart：commit 前 crash 零行，commit 后 ACK 丢失幂等 replay，删除 Desktop cache 后 repair 一致；
- session revoke、membership remove、archive/reopen、recall/source revision、FT participant unavailable/outbox retry；
- legacy DB migration 没有伪造 authority；旧 OpenItem/LightTask/Ball 与新 Project Loop 可并存且不互相污染。

**退出条件**：Requirement trace、design-state evidence、repair checksum、audit/event/outbox SQL evidence 和 accessibility report 齐备，才可另行编写 FT-09 交付说明；不得以本计划勾选代替 verification。

## 4. 文件所有权与依赖规则

以下是实施期建议 ownership，具体新增文件名可在 slice 内微调，但依赖方向不可改变。

| 区域 | 单一 owner slice | 允许修改 | 禁止耦合 |
|---|---|---|---|
| Core Project contracts/guards | S0 | `packages/core/src/project-*.ts`、Core index/type tests | 不 import server/Desktop；不修改旧对象语义 |
| Authority schema/mappers | S1 | `packages/server/src/persistence/*project*`、migration/tests | 不把 legacy 表升级为新 authority；不预占计划版本号 |
| Domain dispatcher | S2–S6 | `packages/server/src/project-loop/**`、worker protocol/handler | 不从 Agent message body解析 command；不依赖 WS types |
| Departure/lifecycle participants | S7 | `packages/server/src/room-governance/**` 或等价私有 adapter | 不在 FT-02 复制 project SQL；不在 transaction 外 check |
| FT-10 adapter | S8 | project tool adapter/confirmation contributor | 不复制 reducer；不提升 principal |
| Public protocol/WS | S9 | `packages/server/src/protocol.ts`、`websocket.ts` 及 tests | 旧 `open-item.*`/`light-task.*` 不承载新字段 |
| Repair registry | S9 | Core sync record、FT-09 descriptor、FT-13 central assembly/tests | feature descriptor 不反向 import assembly |
| FT-05/08/12 adapters | S10 | 各 server-private port adapter/outbox mapper | 不互写对方 aggregate；无跨 Room inbox/OS push |
| Desktop | S11 | renderer state/reducer/components/styles/tests | 不把 local state 当 authority；不沿用 preview 作为 production panel |
| E2E fixtures | S12 | authority child/WS/restart/a11y fixtures | 不只测 in-memory facade或 mocked worker |

并行工作必须按文件 owner 分支；同一时刻 `collaboration.ts`、`sync.ts`、migration entry、`protocol.ts`、`websocket.ts`、Desktop root renderer 各只有一个 slice owner。跨 slice 先合 contract spine，再由 owner 串行整合，避免多人同时扩大 closed union。

## 5. 测试矩阵与 Requirement 回指

| 证据层 | 必测合同 | 主要 Requirement |
|---|---|---|
| Core/type | exact keys、union exhaustiveness、非法状态、principal matrix | `REQ-PRJ-001`～`REQ-PRJ-013`、`REQ-PRIM-003/015/016` |
| SQLite/Authority | CAS、unique Goal、accept+responsibility、transfer、audit/event/outbox/idempotency 原子 | `REQ-ROOM-001/003`、`REQ-PRJ-001`～`REQ-PRJ-012` |
| Boundary/runtime | 多 source 单 holder、due/24h、FT-08 invocation、FT-12 recipient | `REQ-AGT-005/006`、`REQ-PRIM-010/017`、`REQ-PRJ-010`～`REQ-PRJ-012` |
| Memory | checkpoint、confirmed/disputed 分离、supersede复核 | `REQ-MEM-005`、`REQ-PRJ-012` |
| Protocol/WS/repair | exact frames、ACK/event、offline/reconnect、registry/checksum/restart | `REQ-PRJ-013` 及 FT-13 辅助 Requirement |
| Desktop/a11y | J-04/J-06/J-07 全状态、错误恢复、focus/zoom/reduced motion | `REQ-UX-004` 及设计覆盖矩阵相关行 |
| Lifecycle/race | archive/reopen、departure、recall/revision、revoke、final recheck | `REQ-ROOM-003` 及 FT-02/03/10/13 的 lifecycle 辅助 Requirement |

每个测试名称至少包含一个 Requirement ID 或在同目录 trace fixture 中一对一映射；最终扫描必须确认 FT-09 24 个直接 ID 全部至少有 design、unit/contract、authority/E2E 中适用的证据，不能用一个宽泛 smoke test 覆盖整组 Requirement。

## 6. 分支、提交与发布纪律

- 建议按 `codex/ft09-contracts`、`codex/ft09-authority-*`、`codex/ft09-desktop` 等独立分支推进；每个提交只跨一个可回滚 slice。
- migration、Core union、protocol、Desktop 各自独立提交；schema 与其 migration tests 同提交，不能先合不可读 schema。
- push、PR、merge 只在 owner 明确授权后进行；本计划不授权自动合并。
- 每个 slice 合入前运行受影响 package tests、real authority tests、Requirement trace、文档链接扫描和 `git diff --check`；最终再运行仓库约定全量门禁。

## 7. 实施检查清单

- [ ] Room/Project 同一 aggregate，无第二 project membership/lifecycle。
- [ ] Goal/Decision proposal/confirmation/replacement/supersede 闭合。
- [ ] Request pending acceptance，接受前无目标 Human 责任。
- [ ] NextAction Human/Agent owner 与具名 Human verifier 分治。
- [ ] Blocker/OpenQuestion 单 owner；deferred/cannot_answer 分离。
- [ ] TransferProposal 未接受不换 holder；链不可变且可升级。
- [ ] 多 source 单 holder；due/24h reminder 跨重启稳定去重。
- [ ] confirmed project fact 与 memory proposal/confirmed/disputed 分层。
- [ ] FT-02 departure 同事务 final recheck，冲突安全、稳定、可操作。
- [ ] FT-03/05/07/08/10/12/13 seams 有 fail-closed contract tests。
- [ ] archive/reopen、recall/revision、revoke/race 无隐式事实改写。
- [ ] J-04/J-06/J-07 全状态、错误恢复和 accessibility 有证据。
- [ ] legacy compatibility 不伪造 confirmer/verifier/source/acceptance。
- [ ] real AuthorityWorker/SQLite/WS/三客户端/restart E2E 通过。
- [ ] 独立 delivery/verification 尚未完成前，不宣称 FT-09 implemented/delivered/verified。

达到以上门槛后，才可请求 FT-09 的实现验收；本次冻结任务只产出设计与实施计划。
