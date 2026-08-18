# FT-03 Message Authority：TDD 测试矩阵与实施计划

> 日期：2026-08-18
> 状态：待实施计划；**不表示 FT-03 已实现、已验收或 verified**。
> 本文仅安排未来的代码、schema、WebSocket、sync 和 Desktop 改动。本次交付只新增本文及配套设计文档。

## 1. 实施目标和不可越过的边界

目标是落实 [`FT-03 Message Authority 设计`](./2026-08-18-ft03-message-authority-design.md)：服务端唯一作者来源、消息/逐 target intent-or-rejection 原子提交、稳定 structured mention/reply、Human revision/recall、Agent append-only correction、同源 history/realtime/sync/repair，以及 J-02 的真实 ACK/失败状态。

实施期间必须维持下列边界：

- 不修改 Blueprint、不修改任务状态；不做 commit、push、PR、`git add -A`、`reset`、`checkout`、`clean` 或 `stash`。
- 不把 FT-01/02 未提交工作树接口作为编译依赖。开始代码前重新检查提交基线；必要时先写语义 adapter/前置阻塞说明。
- 不扩展到旧 Mobile/inbox/search/OS push/full Blueprint；不创建 Thread；不借附件 seam 实现 FT-04 pipeline；不把 sync/desktop live wiring 误做成 FT-03 独立产品交付。
- 不以自然语言 regex、displayName、前端 mention 样式或 preview 替代 server-side structured fact。
- 不在任何阶段让 `message.accepted` 表示 Agent execution/final、memory 完成或其他设备已收。

## 2. 开工前置条件与集成门

| 门 | 必须满足的已提交条件 | 未满足时的处理 |
| --- | --- | --- |
| Git/worktree | 记录 `git status --short --branch`；识别并绕开非 FT-03 修改。 | 不覆盖、不格式化、不清理他人文件。 |
| FT-01 | 有稳定 Human authenticated session context，并能在 AuthorityWorker transaction 复核 session/revoke；Agent 不可 public login。 | 用当前已提交 context编译，或等待其提交；不得 import 对方未提交符号。 |
| FT-02 | Room active/archive 和 Human/Agent membership/assignment 的单事务查询语义已稳定。 | 新 message command 不启用；不能用缓存 membership 补齐。 |
| FT-08 | 能 claim `AgentInvocationIntent`、CAS final、消费 scoped recall fence、restart recovery；并处理旧 broad human preemption 冲突。 | `@Agent` 只写 durable intent，recall feature flag保持关闭；不伪造 execution。 |
| FT-04 | attachment reference validator + operational exclusion seam。 | `attachments: []` 是唯一允许值；不实现本地路径/blob fallback。 |
| FT-05 | memory/read API 只走 operational message projection，能处理 revision/tombstone。 | 不打开 recall；不能让旧 raw retrieval继续运行。 |
| FT-13 | event/outbox、RoomCursor、repair staging、cache authorization/revocation semantics 已可承载新增 closed record。 | 先完成 server-side projections/tests，延后 live client activation。 |

FT-03 可以先完成 core、protocol、schema、AuthorityWorker 和 server tests；跨 FT feature flag 只能在上述相应 seam **已经提交并做契约测试**后开启。FT-09 不是 message submit 的前置：它后来消费 `HumanRequestIntent` 扩展 Request accept/reject/transfer；FT-14 负责 audit/export 的授权与保留政策。

## 3. TDD 原则

每个切片严格执行：先写失败的 guard/type/unit/integration test，再写最小生产实现，再跑该切片的 focused suite；只有上一层证据通过才进入下一层。禁止以 DOM fixture、mock preview 或直接 SQL seed 代替 command transaction 证据。

1. **closed before open**：先证明字段、union、类型不可赋值，再暴露 command/frame。
2. **transaction before dispatch**：先证明 domain + target outcomes + event + outbox + idempotency 原子，才接 runtime/memory/WS。
3. **projection before destructive-looking lifecycle**：先让 history/sync/repair 在 tombstone 下不泄露 raw data，再开放 recall。
4. **CAS before abort**：先持久 fence/cancel，再让 FT-08 abort controller 观察它；迟到 final 必须失败。
5. **recovery before UI success**：ACK loss、outbox replay、restart 和 cursor repair evidence 先于 J-02 success 文案。

## 4. 测试矩阵

| 编号 | 层 | 场景（必须先红） | 通过判据 |
| --- | --- | --- | --- |
| C1 | Core guards | Human draft注入 `authorId`/`authorKind`/actor/capability；未知 key；空/重复 ID。 | guard false；type test不可赋值；没有宽松 index signature。 |
| C2 | Core guards | valid/invalid target discriminant、UTF-16 range、重叠/越界/重复 `(kind,targetActorId)`。 | 只接受结构化 entity；不读取正文里的 `@`。 |
| C3 | Core guards | active Human、Agent final、tombstone、revision、outcome、repair/event variants。 | discriminant/optional key精确；tombstone没有 body/attachment。 |
| C4 | Type boundaries | public frame、agent runtime input、internal capability、audit projection 互不可赋值。 | `@ts-expect-error` 通过；外部不能构造 Agent author capability。 |
| P1 | Protocol parser | `message.send.v2` exact fields、body limits、requestId、reply/attachment/target nested unknown field。 | 固定 `invalid_request`；无 handler调用。 |
| P2 | Protocol parser | `message.revise`/`message.recall` expectedRevision；任何 author字段；Agent final wire frame。 | 前两者closed；author rejected；Agent final没有public frame。 |
| P3 | ACK/error | ACK的目标outcome只含intent/rejected；不得出现received/memory/execution completion字段。 | parse与snapshot test均拒绝越权字段；状态码/code稳定。 |
| D1 | Migration | fresh 当前 schema→下一版；旧数据库backfill为revision 1、空structure；未知未来版本拒绝。 | 旧 migration statements/checksum/fingerprint不变；新migration可重放。 |
| D2 | Migration rollback | 注入中途失败、backfill损坏、FK/trigger invariant错误。 | `user_version`、schema和历史数据完整回滚，无半张新表。 |
| D3 | DB invariants | same-Room reply、author kind、revision单调、target恰一 outcome、correction same-agent、recall audit retention。 | 手工 corrupt insert/update因 FK/trigger/check失败；全库invariant scan通过。 |
| A1 | Authority transaction | 一个 Human message + Human/Agent targets均有效。 | 一次 transaction有1 message、N outcome/N intent、1 event、1 outbox、1 idempotency receipt。 |
| A2 | Partial target revoke | N target中一个在提交序列化前已移除/assignment无效。 | message与其他target提交；唯一rejected outcome持久；无孤儿intent。 |
| A3 | Idempotency/ACK loss | commit后ACK前断连；同messageId相同payload、新requestId重试。 | 回放同message/event/outcomes；只更新response request correlation；无第二行。 |
| A4 | Idempotency conflict | 同messageId改变body、range、target、reply或attachment。 | `409 idempotency_conflict`，零新事实/event/outbox。 |
| A5 | Reply | self/normal active/tombstone同Room回复；跨Room或不存在。 | 前三者稳定link（按产品决策允许self）；非法回复不泄露另一Room。 |
| A6 | Revision | own active Human连续revision、并发same expected、Agent/other Human修改。 | append-only audit、一个CAS winner、structural links/frozen source不变。 |
| A7 | Recall | pending Human/Agent intents、queued/running/completed execution、confirmed fact分别存在。 | pending取消、fence持久、late final拒绝；completed/fact不回滚；tombstone保留。 |
| A8 | Agent final/correction | public伪造、capability错误execution、late attempt、same/different Agent correction。 | 只有合法 internal CAS创建final；原final不可变；correction追加且same-agent。 |
| S1 | History/read | history/revision query针对active/recalled；直接查询/运营投影。 | active一致返回current+chain；recalled仅tombstone，不含raw body/link/attachment。 |
| S2 | Event/delta | accepted→revise→recall并发/重复顺序；event重放。 | 按streamSeq/eventId收敛，messageId唯一，revision不移动时间线。 |
| S3 | Repair | 清缓存后fixed watermark repair；历史revision chain与tombstone；checksum错误。 | staging atomic swap后等同authority；recall raw零泄漏；错误保留旧完整cache。 |
| S4 | Outbox/crash | domain write、before commit、after commit before dispatch、after send before mark。 | 前两种全零；后两种重启后receipt/event可恢复；eventId去重。 |
| S5 | Multi-device | 两设备同时edit/recall、ACK丢失、一个设备old cursor repair。 | 一个CAS winner；双方最终同一tombstone/revision；无可见重复。 |
| R1 | Runtime seam | intent claim与member removal/recall并发；重启扫描。 | claim检查fence+成员；pending不enqueue；running以scoped cancel收敛。 |
| R2 | Preview | provider chunks、cancel/crash/reconnect。 | 0 messages/revisions/events/outbox/repair/memory candidate；只剩transient UI数据。 |
| U1 | J-02 reducer | idle→submitting→ACK、event先到ACK后到、ACK丢失、retry、4xx。 | 仅matching requestId或same messageId event完成本地提交；输入精确保留。 |
| U2 | J-02 visual/a11y | per-target rejected、accepted不等于Agent完成、revision/tombstone、preview。 | 文案/ARIA不谎称完成；preview `aria-live=off`；键盘focus到失败点。 |
| E1 | 真实 E2E | compiled AuthorityWorker/SQLite/WS三客户端、restart、clear cache、revocation。 | 多副本最终same operational view；没有preview/raw recalled data；精确outbox/idempotency证据。 |

测试数据必须包含：同 displayName 不同 actorId、改名后的 actor、正文里邮箱/代码/`@agent-id`但无 entity、两个合法 target + 一个撤权 target、reply 至 tombstone、重复 ACK/event、recalled message上已有 completed Agent final 和 confirmed source fact。这样能防止“测试刚好把 regex 当 entity”或“撤回仅验证 UI 隐藏”的假阳性。

## 5. 实施顺序与文件级切片

下表是未来实现顺序，列出的文件是预期改动面而非本次已改文件。每一阶段都先修改所列测试/类型测试，再修改生产文件。

### Slice 0 — 基线、命名和依赖探针

1. 运行只读 `git status --short --branch`、`git diff --check`，记录已存在的他人改动；检查当前 `AUTHORITY_SCHEMA_VERSION`、最新迁移 checksum、FT-01/02/08/13 已提交合同。
2. 在本设计的类型名称与当前 `Message`、`AgentInvocationIntent`、`CommandAcknowledgement` 之间做一次不写代码的 naming decision。若 FT-01/02 同时落地 schema，重新计算“next migration”，不预占版本号。
3. 写一个依赖契约测试清单：session principal、Room lookup、assignment lookup、runtime claim/fence、attachment validator、memory operational reader；任何未提交依赖均使对应 feature flag保持关。

### Slice 1 — Core closed contracts（C1–C4）

| 先写 tests | 再改生产类型 | 产出 |
| --- | --- | --- |
| `packages/core/src/index.test.ts` | `packages/core/src/index.ts` | v2 submit/timeline/revision/tombstone/target outcome guards。 |
| `packages/core/src/actor.type-test.ts`、新增或扩展 `packages/core/src/*message*.type-test.ts` | `packages/core/src/index.ts` exports | public draft、audit/timeline、Agent capability boundary不可赋值。 |
| `packages/core/src/sync.test.ts` | `packages/core/src/sync.ts` | message event与repair closed unions/guards。 |
| `packages/core/src/collaboration.type-test.ts` | `packages/core/src/collaboration.ts` | invocation intent必须有source message/target/revision，runtime public input不取得author capability。 |

不在这一阶段删除旧 `Message`；先让 legacy import/adapter可显式映射 `body → revision 1`。`AgentParticipation`、Router policy、Tool capability 不在此切片顺便重构。

### Slice 2 — 协议边界和服务端 capability（P1–P3）

| 先写 tests | 再改生产文件 | 产出 |
| --- | --- | --- |
| `packages/server/src/protocol.test.ts` | `packages/server/src/protocol.ts` | `message.send.v2`、revise、recall closed parser及稳定错误。 |
| `packages/server/src/persistence/contracts.type-test.ts`、`contracts.test.ts` | `packages/server/src/persistence/contracts.ts` | public Human command无作者；internal Agent commit capability无可序列化构造。 |
| `packages/server/src/websocket.test.ts` | `packages/server/src/websocket.ts` | request correlation、没有public Agent-final frame、error mapping。 |
| `packages/server/src/service.test.ts` | `packages/server/src/service.ts` | legacy service overload隔离/弃用；authority path仅受权上下文写作者。 |

安全要求：`mintInternalAgentMessageCapability`（名称待实际对齐）必须 module-private 或以不可从网络构造的 opaque brand 保护；现有可导出的 internal agent command context 也要在外部 public surface测试中证明不可由WebSocket调用。任何 `agent.invoke` 的现有 public self-declared intent 都不应用作 v2 target 的实现捷径。

### Slice 3 — 追加 migration 与 AuthorityWorker 写事务（D1–D3、A1–A5）

| 先写 tests | 再改生产文件 | 产出 |
| --- | --- | --- |
| `packages/server/src/persistence/schema.test.ts` | `packages/server/src/persistence/schema.ts` | 新逻辑表、trigger/FK/invariant、current→next migration、backfill和rollback。 |
| `packages/server/src/persistence/contracts.test.ts` | `packages/server/src/persistence/worker-protocol.ts`、`contracts.ts` | worker request/response closed command支持。 |
| `packages/server/src/persistence/worker-database-client.test.ts` | `worker-database-client.ts`、`authority-worker.ts` | command跨worker序列化但不泄漏capability。 |
| `packages/server/src/persistence/sqlite-authoritative-store.test.ts` | `authority-database-handler.ts`、`sqlite-authoritative-store.ts` | message assembler：author injection、reply validation、per target intent/rejection、event/outbox/idempotency。 |

本阶段唯一 writer transaction 使用已有 `executeIdempotently` 的 canonical hash discipline，但业务 scope 需从 `messageId` 定义并允许新 requestId replay。全部 target 在 `COMMIT` 前完成 current membership/assignment lookup。单 target rejection 是正常 receipt 数据；它绝不能通过抛错使整条 Human message rollback。

### Slice 4 — revision、recall、Agent final/correction 与 CAS（A6–A8、R1）

| 先写 tests | 再改生产文件 | 产出 |
| --- | --- | --- |
| `sqlite-authoritative-store.test.ts`、`authority-database-handler` focused tests | `authority-database-handler.ts` | append revision、tombstone、pending intent cancel、fence、Agent final/correction CAS。 |
| `packages/server/src/agent-runtime/worker-runtime-authority.test.ts` | `packages/server/src/agent-runtime/worker-runtime-authority.ts`、`runtime-authority-protocol.ts` | FT-08 读取/消费source-scoped fence与late final拒绝。 |
| `packages/server/src/agent-runtime/agent-runtime-service.test.ts` | `agent-runtime-service.ts` | commit-cancel-before-abort；preview清理；recovery scan不复活cancelled intent。 |
| `packages/server/src/human-preemption/human-preemption-runtime.test.ts` | 仅在FT-08批准范围内的对应实现 | broad preemption与recall fence不互相扩大取消范围。 |

此阶段须有一个“已完成 final + confirmed project fact”fixture，断言 recall 后 source message变tombstone但 final/fact行和事件仍在。禁止通过 delete/cascade来让测试“通过”。若 FT-08 scoped fence 未提交，revision可继续开发，recall protocol exposure必须保持关闭。

### Slice 5 — 同源读取、sync/repair/outbox（S1–S5、R2）

| 先写 tests | 再改生产文件 | 产出 |
| --- | --- | --- |
| `packages/server/src/sync-service.test.ts` | `packages/server/src/sync-service.ts` | history/delta采用同一 canonical operational projection。 |
| `packages/server/src/persistence/snapshot-worker-client.test.ts` | `packages/server/src/persistence/snapshot-worker.ts`、`snapshot-worker-client.ts` | revision/outcome/tombstone closed repair records、fixed-watermark staging。 |
| `packages/desktop/src/sync/client-sync-replica.test.ts` | `packages/desktop/src/sync/client-sync-replica.ts` | eventId/messageId/revision merge，tombstone purge，旧cursor repair。 |
| `packages/server/src/outbox-dispatcher.test.ts` | `packages/server/src/outbox-dispatcher.ts` | event replay不重复可见状态；commit与delivery分离。 |
| `packages/server/src/authority.e2e.test.ts`、`fixtures/authority-child.ts` | 仅必要的fixture/composition seam | crash windows、restart、三客户端、clear-cache、ACK loss真实证据。 |

要求以一套 `projectOperationalTimelineMessage()`（实际名待定）服务 history、event payload、sync reducer source 和 snapshot export；不得复制四份手写 `SELECT messages.body`。preview 测试要扫描 authority DB/WAL、event、outbox、repair page、client cache，确认chunk sentinel为零命中。

### Slice 6 — Desktop J-02 renderer/reducer（U1–U2）

| 先写 tests | 再改生产文件 | 产出 |
| --- | --- | --- |
| `packages/desktop/src/renderer/app.test.ts` | `packages/desktop/src/renderer/app.ts`、必要时 `styles.css` | composer有限状态、per-target result、revision/tombstone/correction/preview分层。 |
| `packages/desktop/src/sync/client-sync-replica.test.ts` | `client-sync-replica.ts` | ACK/event/repair竞态的store reducer。 |
| 若 FT-11 已提交真 transport seam，则其专属测试 | preload/main/IPC/transport files只在 FT-11 范围修改 | requestId correlation与凭证安全接线；否则保持adapter fake。 |

Desktop status文字必须区分“已保存”“调用意图已登记”“目标不可用”“执行中”“已完成”。没有 execution terminal event 时，永远不能把 send ACK 显示为“Agent 已完成”。失败不清 composer；retry保留 messageId和structure；nonretryable不自动生成第二条。

### Slice 7 — 全链路契约与迁移启用

1. 用真实 compiled AuthorityWorker/SQLite/WS 完成 E1：A/B/C 三客户端，两设备同作者，ACK在commit后丢失，outbox在send后崩溃，server重启，清本地cache后repair，成员/assignment撤权同时发生。
2. 做 legacy reader audit：所有 `messages.body` query 必须经 operational projection。用 sentinel recalled body/attachment ID 扫描 history、events、outbox、snapshot、delta、repair、memory seam输入、renderer cache和错误/诊断。
3. 先部署 reader/migration，再按 dependency gate开启 `message.send.v2`；最后才按 FT-04/05/08 接口启用 attachment refs、recall和Agent final/correction。旧客户端不能安全渲染tombstone时返回 `protocol_upgrade_required`，不是暴露raw v1 payload。
4. 只在所有测试及迁移/E2E evidence通过后，写一份独立交付说明；它仍不能自行修改任务状态或宣布 verified。

## 6. 权限与故障注入测试细化

| 风险 | 故障注入 / 并发编排 | 断言 |
| --- | --- | --- |
| Author spoof | WS JSON、direct service、persistent command三层分别注入 author字段。 | 三层都拒绝；Agent表/事件零写。 |
| target撤权 | 提交 transaction前在同一worker排入`member.remove`/assignment reduction。 | 决定性按提交顺序；撤权先发生时仅该target rejected。 |
| target孤儿 | 在domain write、target insert、event/outbox间注入throw/crash。 | rollback后无任一局部；commit后所有计数完整。 |
| ACK loss | server transaction commits，然后socket写失败/connection close。 | 重试receipt原样；event/repair最终有同一messageId。 |
| outbox duplicate | send成功后dispatch mark前崩溃。 | 至少一次frame；replica eventId去重，timeline一条。 |
| edit/recall race | 两个设备同expectedRevision，并行worker commands。 | 一个winner；loser409后refresh，无隐式last-write-wins。 |
| recall/final race | final completion和recall分别停在CAS前后。 | order可解释：final先commit则留存；recall/fence先commit则late final零写。 |
| completed fact | confirmed fact引用source revision后recall。 | fact值/confirmation不变；只加source recalled呈现状态。 |
| preview leak | 发送唯一chunk sentinel，取消/崩溃/repair。 | sentinel不在任何durable store/cache/repair/memory input。 |
| stale cursor | revision+recall后客户端使用expired cursor做repair。 | fixed snapshot收敛到tombstone；不回放旧revision raw。 |
| authorization cut | page 0后移除成员/session revoke。 | 后续history/sync/repair拒绝并清本地Room cache；无剩余raw。 |

## 7. 迁移和兼容性验收

### 7.1 Backfill 标准

- 每个既有 `messages` row 生成一条 envelope；Human 和 Agent均有 revision-1/audit source，但只有 Human active record暴露revision command。
- 既有 body 中的 `@foo` 一律只作为正文，`mentionedTargets=[]`；绝不创建补推的 Request/invocation，避免历史文本在升级时触发新工作。
- 既有 message 无 reply/attachment/correction link；任何关联只能从新v2 command开始。
- backfill不制造`room.message.accepted`新event、不改变现有streamSeq/outbox/历史事实；snapshot通过新projection读出同一timeline顺序。

### 7.2 兼容性终止条件

旧 `message.send` 只能写无结构legacy mapping，且绝不能在正文regex识别mention。一旦 Room内有revision或tombstone，无法安全表达新状态的 history/realtime client必须得到稳定升级错误；不得用旧 `Message.body` response泄露tombstone raw content。兼容期结束后删除v1 public write endpoint及其直接`MessageService.send(actorId, ...)`捷径，保留只读迁移adapter和audit data。

### 7.3 Rollback

数据库前向迁移不可回滚为删除表。运行时rollback只能关掉新frame/feature flag、停止新consumer claim，并继续使用新projection安全读取已有facts。任何回滚方案若会重新暴露recalled body、删除tombstone/revision/audit或重放cancelled invocation，均为不可接受。

## 8. 质量门与最终交付检查

实施完成时依次运行与记录（命令按仓库脚本实际名称确认后执行）：

1. focused Core、protocol、persistence、runtime、sync/repair、outbox、Desktop tests；
2. `corepack pnpm typecheck`；
3. `corepack pnpm lint`；
4. `corepack pnpm test`，包括真实 AuthorityWorker/SQLite restart suite；
5. `corepack pnpm build`；
6. `corepack pnpm verify:core-boundary`；
7. migration fresh/upgrade/future/rollback、ACK-loss/outbox-replay、三客户端repair和recalled-raw sentinel证据；
8. `git diff --check`；
9. `git status --short --branch`，逐项说明新增/修改文件、依赖已提交版本、已知未启用feature gate。

最终交付说明必须逐条列出本计划第 4 节的证据和未满足的外部前置；不因文档、静态 UI 或局部单测通过而宣布 FT-03 verified。
