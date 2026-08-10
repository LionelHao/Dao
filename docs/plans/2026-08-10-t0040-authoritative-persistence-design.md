# T-0040 服务端权威持久化、多客户端同步与故障恢复设计

状态：设计方案已获 @lionel 同意，等待书面规格复核后进入实现计划。

基线：`main@41341af2411558398175bb0fcf2becd46858ff51`

## 1. 背景与目标

T-0039 建立了服务端身份、房间生命周期和经过鉴权的消息传输，但其状态仍分散在 session JSON、room JSON 和 message JSONL 三套存储里；实时消息在持久追加后直接由进程内监听器分发，没有服务端游标、事务 outbox、统一迁移或跨领域原子提交。

T-0040 要把服务端提升为权威状态源：所有 Alpha 必需的协作状态能够持久化、迁移、重放和按权限恢复。客户端缓存只负责体验，不能决定身份、权限或事实状态。

本设计选择 Node.js 22.13+ 的内置 `node:sqlite`，在统一 authority SQLite 数据库内实现领域表、不可变同步事件和事务 outbox；可丢弃的分页快照使用独立 derived cache。公开业务服务继续依赖 TypeScript 端口，领域内核保持零 I/O。

## 2. 验收标准（原文）

认领者不得修改或放宽以下标准：

1. 身份、群、成员、消息、已读、已判定、待答项、agent 执行和校准信号写入持久存储；服务进程重启后逐类读回一致
2. 写入使用稳定事件 ID 或幂等键；客户端重试同一写入不会产生重复消息或重复承诺，有自动化测试覆盖
3. 客户端以服务端游标断线重连；游标仍在保留范围内时增量恢复不漏不重，游标过期时服务端返回明确状态并触发全量历史修复，修复完成后的水位与服务端一致；至少三客户端并发测试通过
4. ACK 只表示 durable acceptance。自动化故障注入在持久提交后、实时分发前终止服务；恢复后，未收到事件的客户端通过游标或可重放记录补齐且只出现一次。实现使用事务 outbox 或等价机制，不依赖进程内 best-effort 任务
5. 持久化结构有版本化迁移；从上一版 schema 升级到当前版后历史可读，失败时不会留下部分迁移状态
6. 历史查询与实时订阅遵守群权限；客户端本地缓存不是权威源，清空缓存后可从服务端完整恢复

## 3. 范围与非目标

### 3.1 本任务范围

- 统一持久化身份、会话、房间、成员和六类协作事实。
- 提供稳定 ID、幂等冲突检测、事务 outbox 和可重放事件日志。
- 提供登录后的房间发现、房间级服务端游标、增量同步、游标过期和可分页全量修复协议。
- 提供上一版 schema 迁移和 T-0039 三种文件存储的一次性导入。
- 将历史、同步和订阅统一接入服务端权限判断。
- 提供客户端 staging replica，使多页快照完整校验后才能原子替换本地缓存。
- 保持现有鉴权、房间治理和消息接口的行为兼容，扩展同步接口。

### 3.2 非目标

- 不实现多进程或多主 SQLite writer 协调；Alpha 服务仍是单进程单写者。
- 不引入 PostgreSQL、外部队列或部署依赖。
- 不实现完整 Event Sourcing，也不要求所有领域状态都由事件重算。
- 不在 T-0040 重做产品 UI；桌面端新增的工作只限无视觉的 `ClientSyncReplica` 接线与既有原语渲染回归。
- 不在本任务实现自动化保留周期调度；只提供可验证的事件压缩边界和游标过期语义。
- 不实现 T-0041 的真实 Agent runtime、工具调用和恢复策略，只持久化其执行事实合同。

### 3.3 原语三层落地的外部交付门禁

T-0040 新增的是权威存储和同步层，但它触及的五组原语必须继续满足《验收总则》的数据 / 接口 / 渲染三层：

- T-0012 已交付真人已读与 Agent 已判定三态、原因及独立渲染；
- T-0013 已交付待答项与 Agent 执行的不同 API、状态和视觉；
- T-0014 已交付 social reaction 与 calibration signal 的不同记录和视觉。

这三个任务当前仍是 `delivered`、等待 @lionel 验收，改动位于 `feat/claude/m2-primitives` worktree，尚未进入 `main`。T-0040 不复制、不重写、也不冒充验收它们；实现可以继续，但交付前必须满足以下门禁：

1. T-0012、T-0013、T-0014 已由 @lionel verified 并按项目规则合入最新 `main`；
2. T-0040 rebase 后，`packages/server/src/primitives.test.ts` 与 `packages/desktop/src/renderer/app.test.ts` 的原语回归全部通过；
3. 从 repair snapshot 恢复出的已读、判定、待答、执行和校准 records 输入同一 renderer，class、文案和人 / Agent 视觉不发生合并。

如果到 T-0040 交付时上游仍未 verified/merged，T-0040 必须转 `blocked` 并点名等待 @lionel 验收这三项，不能把只有数据层和接口层的结果写成 delivered。

## 4. 方案选择

### 4.1 采用：权威领域表 + 事务事件日志 + Outbox

领域表直接回答当前状态，事件日志负责增量同步和审计，outbox 负责提交后的可靠实时分发。三者在同一 SQLite 事务里写入。

这个方案延续现有 service API，避免为了同步能力把整个系统改写为 Event Sourcing，也能直接用数据库唯一约束证明幂等性。

### 4.2 不采用：完整 Event Sourcing

完整 Event Sourcing 的审计能力更强，但需要投影版本、全量重建和更复杂的迁移语义。T-0040 的验收目标不要求领域状态只能从事件计算，该复杂度不会解锁更多 Alpha 能力。

### 4.3 不采用：文件追加日志与快照

文件方案需要自行实现跨记录事务、索引、崩溃恢复、游标保留和迁移协议，相当于重造一个不完整数据库。现有三套文件存储已经证明跨领域一致性边界不足。

## 5. 架构与模块边界

```text
WebSocket protocol ◄──────────────────────► ClientSyncReplica
       │                                         │
       ▼                                         └── staging cache → atomic swap
Auth / RoomLifecycle / Message / Sync services
       │
       ├── CommandStore port
       └── SyncQueryStore port
                    │
                    ▼
       WorkerDatabaseClient（main thread 仅异步消息）
                    │
                    ├── AuthorityWorker ──► authoritative.sqlite
                    │     ├── SqliteAuthoritativeStore
                    │     ├── MigrationRunner / LegacyStateImporter
                    │     └── FaultInjector（仅测试构造参数）
                    └── SnapshotWorker ──► authoritative.sqlite（read-only）
                                          + snapshot-cache.sqlite（derived）
                    │
                    ▼
OutboxDispatcher ──► SubscriptionRegistry ──► clients
```

### 5.1 `CommandStore` 与 `SyncQueryStore`

业务服务只依赖两个窄端口，方法均为异步合同，内部实现可以替换：

- `CommandStore` 运行领域命令事务，维护事实、事件、幂等结果与 outbox 的原子性；
- `SyncQueryStore` 提供权限感知的房间目录、历史、物化快照和增量读取。

业务服务不拼 SQL，不直接管理 SQLite transaction。Migration、legacy import 和故障注入都不是业务端口：前两者只在适配器启动期使用，故障注入只通过测试构造参数启用。

### 5.2 Worker 隔离与 `SqliteAuthoritativeStore`

生产实现使用 `node:sqlite` 的 `DatabaseSync`，但 main thread 不运行任何 SQLite 调用。`WorkerDatabaseClient` 通过 worker message channel 暴露异步端口：

- 单一 `AuthorityWorker` 独占 read-write authority connection；每个数据库路径只有一个 coordinator，所有领域写使用 `BEGIN IMMEDIATE`，事务保持短小且禁止网络 I/O；
- 单一 `SnapshotWorker` 用 read-only WAL connection 固定 authority 视图，同时把 canonical pages 写入独立的 `snapshot-cache.sqlite`；它不取得 authority write lock，因此完整扫描不会阻塞领域 writer，也不会阻塞 WebSocket heartbeat；
- Snapshot build 全局一次只运行一个；room 请求以 `(principalId, sessionFamilyId, roomId, headSeq, accessRevision)`、catalog 请求以 `(principalId, sessionFamilyId, catalogRevision)` single-flight。只复用同一 session family 内、剩余 TTL 不少于 60 秒的已完成 snapshot。等待队列上限 16，超过返回 `429 snapshot_busy`；
- Materialized snapshot TTL 固定 5 分钟，没有 complete/release 删除动作；多个消费者可在 TTL 内独立、幂等重读任意 page，一个消费者完成不会影响其他消费者。只有过期 manifest/pages 会被清理，启动时另清理未 COMMIT transaction。Streaming snapshot 使用 `snapshot.complete` 或失效条件释放 scoped barrier，不写入可复用 pages；
- Cache 默认配额 512 MiB。配额只通过清理过期 snapshot 回收，不能提前删除仍在 TTL 内的 snapshot；配额不足不是 repair 终态，而是自动转入下述 streaming fallback；
- SnapshotWorker 每批最多读取 200 条并检查 60 秒 build deadline 与 128 MiB WAL-growth 门禁；超过任一边界就结束 authority read transaction、回滚 cache build 并自动转入 streaming fallback。这两个保护边界可配置，但生产不能关闭。

### 5.3 保证完成的 streaming fallback

Materialized snapshot 因 cache 配额、deadline 或 WAL pressure 失败时，`FallbackRepairCoordinator` 提供 O(page) 资源的保证完成路径。Barrier lease 由单一 AuthorityWorker 持有并与 command transaction 串行裁决；SnapshotWorker 只能请求 acquire/page/complete，不能自行冻结写入。服务进程退出会释放全部 lease 并使未完成的 streaming snapshot 失效。

1. Room repair 只获取目标 room 的 mutation barrier；catalog repair 只获取当前 human actor 的 catalog barrier。其他房间、其他 actor 和全局只读请求继续运行，禁止使用全局写屏障；
2. Barrier 等待当前相关 transaction 完成后，拒绝该 scope 内新的普通 durable mutation：返回 `503 repair_barrier_active` 和 retry hint，不进入内存队列，也不产生 event/outbox；
3. `auth.refresh` 始终穿透 barrier。Snapshot 绑定 `sessionFamilyId` 而不是某一枚 access token；同 family 刷新后可以在新连接上继续原 snapshot，access token 超过 15 分钟不会迫使全量恢复从头开始；
4. Session family revoke、目标成员移除、权限降级或房间归档是可抢占 barrier 的 access-reducing mutation。它们优先提交，使 snapshot stale/forbidden、释放 barrier；Owner/Admin 因此始终可以终止恶意或卡死的 streaming repair；
5. 加人、升权、普通消息、判定和其他会改变 snapshot 内容但不降低访问权的 mutation 在 barrier 期间返回可重试 503；
6. SnapshotWorker 不复制完整数据库，按稳定 table/entity 主键次序直接从 authority 每次读取一页并增量计算 checksum；main thread、只读查询和 WebSocket heartbeat 继续运行；
7. Streaming repair 没有总记录数、总字节数或总时长上限。相邻 page 请求的 idle timeout 为 30 秒；客户端持续取页即可处理任意有限的已接受 authority state；
8. 客户端校验最后一页但继续保持 staging，不先暴露为 live cache；它发送 `snapshot.complete`，服务端在当前 authority 视图重新验证 session family、权限、snapshot kind/version/checksum，返回幂等 `snapshot.completed` 后释放 barrier。客户端只有收到 `snapshot.completed` 才原子替换 live cache；断开、idle timeout 或 access-reducing preemption 会释放 barrier、使 snapshot 失效且 staging 必须丢弃。

Streaming fallback 是房间级或 actor-catalog 级的罕见可用性降级，不允许普通成员冻结全局服务。它保证不会出现“数据已经合法写入、却因设计配额永远无法完整恢复”的状态；最坏代价是目标 scope 在恢复期间暂时拒绝普通写入。

Snapshot cache 是可丢弃派生数据，不是权威存储；删除它只会让客户端重新 begin repair。已 COMMIT 的 manifest/pages 使用独立 cache schema version 1，因此服务进程重启后、TTL 内仍可继续读取。

连接初始化至少执行：

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = FULL`
- 有界 `busy_timeout`

AuthorityWorker 负责设置上述安全 pragma。Snapshot cache connection 使用独立 WAL/FULL 配置；authority read-only connection 不尝试修改 `journal_mode`，只验证它已经是 WAL，否则拒绝启动 snapshot worker。`package.json` 的 Node engine 下限声明为 `>=22.13`；CI 必须覆盖该下限或更高的 Node 22 版本。

### 5.4 `SyncService`

负责解析服务端游标、权限检查、增量分页、全量修复和 watermark。它不拥有事实状态，只从 `SyncQueryStore` 读取一致快照。

### 5.5 `OutboxDispatcher`

按 stream sequence 读取 pending outbox，交给从现有 `MessageService` 内部 Map 抽出的 `SubscriptionRegistry`，再标记 dispatched。启动时自动继续处理遗留 pending 记录。发送失败或进程终止不会删除事实事件。

### 5.6 `ClientSyncReplica`

这是无 UI 的客户端数据适配器。它保存 room cursor，执行 bootstrap、delta 和 repair；repair 时把所有分页写入 staging cache，校验 snapshot ID、页序、checksum 和最终 watermark 后才原子替换 live cache。任何 401、403、snapshot 过期、缺页或 checksum 错误都丢弃 staging，不污染当前缓存。

## 6. 数据模型

### 6.1 权威领域表

最终 schema 至少包含：

- `actors`、`sessions`
- `rooms`、`room_memberships`、`room_invitations`、`room_audit`
- `messages`
- `human_read_receipts`
- `agent_judgments`
- `open_items`
- `agent_executions`
- `calibration_signals`
- `streams`、`events`、`idempotency_records`、`outbox_deliveries`

所有外键和 kind 约束在数据库与 TypeScript closed-schema guard 两层校验。真人已读与 Agent 判定是两个表；待答项与 Agent 执行是两个表；校准信号不能伪装成普通 reaction。这些分离直接落实 PRD 第 2 章的原语分裂。

每个 human actor 维护 `catalog_revision`，每条 room membership 维护 `access_revision`。建房、重命名、真人加入/角色变化/移除和归档会在同一治理事务内递增所有受影响 human actor 的 catalog revision；成员自身的权限变化同时递增对应 access revision。Agent 配置和普通房间事实不改变 catalog，因为 catalog 不包含参与者列表或消息水位。Snapshot manifest 绑定这些 revision，用于在物化完成及每次发送前判断当前授权是否仍与固定视图一致。

### 6.2 通用事件流

`streams` 同时承载房间流和身份流：

- `stream_kind`：closed enum `room | identity`；
- `stream_id`：房间 ID 或 actor ID；human actor ID 同时是可登录 principal ID，Agent actor 也有 identity stream 但没有 session；
- `head_seq`：该流已提交的最高序号；
- `retained_from_seq`：仍可用于增量读取的最早序号。

`events` 保存不可变事件，核心字段为：

- `event_id`：全局稳定 ID，唯一；
- `stream_kind`、`stream_id`、`stream_seq`，三者联合唯一；
- `room_id`：仅 `room` 流必填，`identity` 流必须为空；
- `actor_id`、`event_type`、`occurred_at`；
- 经过对应 TypeScript closed-schema guard 的 canonical JSON payload。

房间命令写 `room` 流，客户端 room cursor 只消费该流。Actor 注册、room access 变化和 session issued/rotated/revoked 写对应 actor 的 `identity` 流；身份流不混入房间历史。游标是流内位置，不是授权凭证。

### 6.3 Closed command 与 event union

所有持久化输入和同步事件使用 discriminated union；未知字段、未知 type、错误 actor kind 或跨原语字段均被拒绝。Command payload 与 server-minted event payload 分开定义，actor 字段只出现在后者：

| Command | Command payload（不含发起 actor） | Persisted event | Event payload（服务端注入 actor） |
| --- | --- | --- | --- |
| `message.send` | 现有 `MessageDraft` | `room.message.accepted` | `Message`，author 来自 context |
| `human.read.record` | `{ messageId }` | `room.human_read.recorded` | `HumanReadReceipt { id, messageId, readerId, readAt }` |
| `agent.judgment.record` | internal-only `{ messageId, outcome, reason }` | `room.agent_judgment.recorded` | `AgentJudgement { id, messageId, agentId, outcome, reason, decidedAt }` |
| `open-item.create/transition` | 来源消息、content、唯一 owner 或状态动作；owner 是业务目标，不是发起 actor | `room.open_item.changed` | 完整 `OpenItem`，含 requester、`pending_response \| responded \| deferred \| transferred` 与 transfer chain |
| `agent.execution.transition` | internal-only 来源消息、tool、状态动作和结果；不含 agentId | `room.agent_execution.changed` | 完整 `AgentExecution`，含 agentId、`running \| completed \| interrupted \| failed` 与时间/结果 |
| `calibration.record` | `{ sourceMessageId, emoji: "👍" \| "👎" }` | `room.calibration.recorded` | `CalibrationSignal { id, sourceMessageId, actorId, agentId, emoji, createdAt }`，两个 actor 均由 human context 与目标消息注入 |

`AgentJudgement.outcome` 必须复用 T-0012 verified 后的 canonical union；当前 delivered artifact 为 `will_respond | no_response_needed | suppressed`。三个 outcome 的 `reason` 都是非空必填字段，不只 suppressed 有原因。OpenItem、AgentExecution 和 CalibrationSignal 同样直接复用 T-0013/T-0014 verified 后的 canonical types；持久层只能增加 event ID/stream sequence 等 envelope 元数据，不能私自改 status 字面量或另造 renderer model。

房间治理事件同样是 closed union：`room.created/renamed/archived`、`human.invitation.issued/accepted/rejected`、`human.role.changed`、`member.removed`、`agent.configured`。身份事件为 `identity.actor.registered`、`identity.session.issued/rotated/revoked` 和 `identity.room-access.changed`；最后一种只包含 room ID 与 `joined | updated | removed | archived`，用于让指定 actor 刷新房间目录，不携带消息历史。实现不得退回现有宽松的 `Event.type: string` 作为持久化边界。

这些类型分别落入独立领域表并以同名 event 同步，因此“已读/已判定”“待答项/Agent 执行”“社交 reaction/校准信号”在数据层和接口层都不共用类型。T-0040 不定义 T-0041 的工具调用参数、重试策略或 dead-letter，只冻结执行事实的持久 envelope。

### 6.4 命令接口与幂等记录

所有真人发起的 mutation service 接受服务端构造的 authenticated context，principal 不能由 payload 指定：

```ts
type AuthenticatedCommandContext = {
  sessionId: string;
  principal: AuthenticatedPrincipal;
  requestId: string;
  idempotencyKey: string;
};
```

Agent 事实不使用真人 session。服务端另有不可从 JSON 反序列化、不可从公共 package 导出的 capability context：

```ts
type InternalAgentCommandContext = {
  authority: InternalCommandAuthority; // server-private opaque capability
  agent: AgentPrincipal;
  requestId: string;
  idempotencyKey: string;
};
```

只有服务端 `AgentFactWriter` factory 持有 `InternalCommandAuthority`，测试通过 server fixture 获得受控 writer。`agent.judgment.record`、`agent.execution.transition` 以及 Agent 创建/转交待答项必须使用该 context；agent ID 从 context 注入，wire payload 出现 `agentId` 直接拒绝。真人已读和 calibration 必须使用 human session context，human ID 同样从 principal 注入。两种 context 都在事务内复核 actor 存在及当前房间成员关系。T-0040 的 fixture 可以由内部 writer 产生 Agent 事实以验证持久化，T-0041 只负责把真实 runtime 接到同一 writer，不需要 T-0040 伪造一个 Agent session。

幂等作用域固定为 `(actorId, commandType, aggregateKind, aggregateId, idempotencyKey)`；human context 的 actorId 是 principal ID，internal context 的 actorId 是 Agent ID。`aggregateId` 对房间写入是 room ID，对 session 命令是 session family ID；建房使用 principal ID 作为创建作用域。现有 `message.send` 继续把 `MessageDraft.id` 作为该作用域内的幂等 key，避免破坏 T-0039 wire contract；房间治理方法和新增六类 command 必须显式接收 `idempotencyKey`。

`idempotency_records` 保存该作用域、canonical business-payload hash、primary event ID、该命令生成的全部 event IDs，以及不含 transport correlation 字段的稳定业务响应。Hash 明确排除 `requestId` 和 `idempotencyKey`；重放时 WebSocket adapter 把当前请求的 `requestId` 重新绑定到已存业务响应。同一作用域、同一 key 和相同请求返回原响应；payload 不同则返回 `409 idempotency_conflict`。唯一约束在事务内裁决并发写入，禁止“先查再插”的竞态。

登录允许用户主动创建新 session，不把两次独立登录强行合并；每次 session issuance 仍有稳定 event ID。Refresh 由 refresh record/session family 唯一标识并沿用 T-0039 的原子 expected-principal 约束，revoke 以 session family 为幂等 aggregate。

### 6.5 Outbox

`outbox_deliveries` 以 `(event_id, target_kind, target_id)` 为联合主键，保存 `target_kind: room | principal | session-family`、target ID、stream sequence、状态、attempt 次数和最近错误。同一事件可以有多个投递目标；一个领域命令也可以在同一事务内生成多个事件。

所有 accepted mutation 都在事务内更新领域表并写稳定 event。房间创建、重命名、真人成员加入/更新/移除或归档时，同一事务写一个 room event，并为每个受影响 actor 写独立 `identity.room-access.changed` event；各事件拥有自己的稳定 event ID。房间可见 event 写 room target；human 目录 event 写 principal target，Agent identity event 在没有 runtime observer 时只持久化、不制造空 delivery；正常 refresh 的 `identity.session.rotated` 由当前 ACK 返回新 token，只持久化而不创建 terminal delivery；显式 revoke 或 refresh replay 触发的 `identity.session.revoked` 才写 session-family target。纯 session issuance 同样没有提交后的远端观察者。需要 outbox 的命令，其领域写、多事件映射和全部 delivery rows 必须在同一事务完成。

Dispatcher 按 target kind 使用不同规则，不能统一套用成员权限：

- `room`：每个收件连接必须 session 有效且当前仍是该 room 成员；
- `principal`：连接 principal 必须等于 target，且当前 session 有效；不要求仍是相关 room 成员，因此被移除者能收到目录失效通知；
- `session-family`：连接的 family 必须等于 target；该类事件正用于通知已撤销 family，不能要求数据库 session 仍有效。发送稳定的 terminal auth frame 后立即清 credential、撤销订阅并关闭连接。

Outbox 可以重复尝试网络发送，但不能生成第二个事件或第二份领域事实。客户端以 `event_id` 和游标实现幂等应用，因此保证的是“恰好一次可见结果”，而不是无法在不可靠网络上证明的“只发送一个数据包”。

## 7. 写入、ACK 与故障恢复

所有 mutation 遵循同一事务骨架；第一步按 context kind 分流：

```text
解析 human session context 或验证 server-private internal Agent capability
→ BEGIN IMMEDIATE
→ human：重新读取 session，校验未过期、未撤销且 principal 匹配
→ internal Agent：重新读取 agent identity 和房间编制，校验 capability 中 agent 匹配
→ 在同一事务内重新读取并校验当前领域/房间权限
→ 校验 closed request schema
→ 裁决 idempotency key
→ 更新领域表
→ 追加 event
→ 若存在提交后实时副作用则追加 outbox
→ COMMIT
→ 返回 ACK
→ OutboxDispatcher 尝试实时分发
```

事务内 session 复核关闭“认证之后、提交之前被另一连接撤销”的 TOCTOU；internal Agent 复核防止测试或未来 runtime 在移出房间后继续写事实。历史、sync 和 snapshot 读取也在同一只读视图中同时复核 session 与房间权限。`SubscriptionRegistry` 保存 session ID 与 family ID；OutboxDispatcher 按 target-kind 规则发送。Session family revoke 提交后，session-family delivery 会使本进程活动连接的 credential generation 失效并撤销其订阅；正常 refresh 只撤销旧 token record 并在同一 family 内签发新 record，不发 terminal frame。即使进程在 revoke 通知前崩溃，重启后也不存在旧连接。

ACK 只在 SQLite `COMMIT` 成功后生成。以下故障点必须可注入：

1. 领域写前；
2. 领域写后、提交前；
3. 提交后、outbox 分发前；
4. 发送后、outbox 标记前。

前两点失败不留下领域事实、事件或 outbox。第三点必须让测试子进程在确认 COMMIT 后立即退出，重启后的独立进程再由 pending outbox 或游标补齐。第四点可以重发同一 `event_id`，但客户端应用结果仍只有一份。

## 8. 游标同步协议

### 8.1 房间发现与增量帧

客户端登录、恢复会话或本地没有房间目录时，先发送 `workspace.bootstrap.begin`。服务端把该 principal 当前可见的 room summaries 物化为有界、可分页的 catalog snapshot；后续 `workspace.bootstrap.page` 只能读取同一个 snapshot ID。这样清空缓存的客户端不需要预先知道 room ID。

```ts
type WorkspaceBootstrapRequest = {
  type: "workspace.bootstrap.begin";
  requestId: string;
};

type WorkspaceBootstrapPageRequest = {
  type: "workspace.bootstrap.page";
  requestId: string;
  snapshotId: string;
  afterPage: number;
};

type SnapshotDeliveryMode =
  | { mode: "materialized"; expiresAt: string; idleExpiresAt?: never }
  | { mode: "streaming"; idleExpiresAt: string; expiresAt?: never };

type WorkspaceBootstrapPage = {
  type: "workspace.bootstrap.page";
  requestId: string;
  snapshotId: string;
  page: number;
  rooms: RoomSummary[];
  catalogRevision: number;
  snapshotChecksum: string;
  hasMore: boolean;
} & SnapshotDeliveryMode;
```

`RoomSummary` 是 closed type，只含 room ID、名称、状态和当前 human principal 的成员 role；不包含参与者列表、消息历史或 room watermark。Catalog 只负责房间发现；权威 watermark 由随后独立授权的 `room.repair` / `room.sync` 给出，避免每条消息都让所有成员的 catalog 失效。

房间增量使用 closed-schema 请求：

```ts
type RoomSyncRequest = {
  type: "room.sync";
  requestId: string;
  roomId: string;
  cursor?: { version: 1; roomId: string; afterSeq: number };
  limit?: number;
};
```

服务端返回两种业务结果：

```ts
type RoomSyncDelta = {
  type: "room.sync.result";
  requestId: string;
  mode: "delta";
  events: PersistedRoomEvent[];
  nextCursor: RoomCursor;
  watermark: number;
  hasMore: boolean;
};

type RoomSyncRepairRequired = {
  type: "room.sync.result";
  requestId: string;
  mode: "repair_required";
  reason: "cursor_absent" | "cursor_expired";
  retainedFromSeq: number;
  watermark: number;
};
```

没有 cursor 表示本地没有可信权威副本，服务端必须返回 `repair_required/cursor_absent`，不能只返回保留窗口内的事件。`roomId` 不一致、游标版本未知、负数或未来游标返回稳定的 `400` 协议错误；游标过期是明确的业务状态，不伪装成空增量。

### 8.2 增量恢复

服务端在同一个只读事务中复核 session 和当前成员关系，再固定本页 watermark，并读取 `afterSeq < stream_seq <= watermark` 的房间事件。单页同时受事件数和 UTF-8 序列化字节限制；下一页从服务端返回的 `nextCursor` 继续。

每页事件严格按该房间流的 `stream_seq` 升序且无重复。多个客户端游标相互独立。

### 8.3 可分页全量修复

收到 `repair_required` 后，客户端发送：

```ts
type RoomRepairBeginRequest = {
  type: "room.repair.begin";
  requestId: string;
  roomId: string;
};

type RoomRepairPageRequest = {
  type: "room.repair.page";
  requestId: string;
  snapshotId: string;
  afterPage: number;
};

type RoomRepairPage = {
  type: "room.repair.page";
  requestId: string;
  snapshotId: string;
  roomId: string;
  page: number;
  records: RoomRepairRecord[];
  watermark: number;
  snapshotChecksum: string;
  hasMore: boolean;
} & SnapshotDeliveryMode;

type SnapshotVersion =
  | { kind: "room"; roomId: string; watermark: number }
  | { kind: "catalog"; catalogRevision: number };

type SnapshotCompleteRequest = {
  type: "snapshot.complete";
  requestId: string;
  snapshotId: string;
  version: SnapshotVersion;
  snapshotChecksum: string;
};

type SnapshotCompleted = {
  type: "snapshot.completed";
  requestId: string;
  snapshotId: string;
  version: SnapshotVersion;
};
```

所有 page 编号从 0 开始。`*.begin` 成功时直接返回 `page = 0` 的完整 page frame；空 catalog 或空房间也返回一个 `hasMore = false` 的 page 0。只有 `hasMore = true` 时才允许请求下一页，`afterPage = N` 明确表示请求 `page = N + 1`。每个响应的 `requestId` 取当前请求，而不是 snapshot 创建请求，便于同一连接并发关联。

`RoomRepairRecord` 是 closed union，只能包含当前房间、成员、消息、真人已读、Agent 判定、待答项、Agent 执行和校准信号，不能退化为任意 JSON。

`SnapshotWorker` 在 `snapshot-cache.sqlite` 中维护 `repair_snapshots` 与 `repair_snapshot_pages`。`room.repair.begin` 执行以下单飞流程：

1. 在 authority read-only WAL connection 上开启 deferred read transaction；
2. 在该固定视图内复核 access token 对应的 session family、当前房间权限和 actor/room identity，读取 `access_revision`、全部权威房间状态和 room stream watermark；
3. 按配置的记录数和 UTF-8 字节上限生成 canonical pages，每 200 条检查 deadline 与 WAL-growth 门禁；
4. 在独立 snapshot-cache transaction 中写入绑定 `snapshotId + principalId + sessionFamilyId + roomId + accessRevision + watermark + checksum + expiresAt` 的 durable manifest 与 pages；
5. Cache COMMIT 成功后关闭 authority read transaction；任一失败回滚 cache transaction；
6. 通过单一 AuthorityWorker 的当前视图重新复核 access token 所属 session family、当前 membership 和 `access_revision`；该复核与所有治理 transaction 串行排序，是本次 page read 的授权线性化点：撤权先提交则复核失败，复核先完成则该 page 逻辑上发生在后续撤权之前。Main thread 在 sendFrame 前再核对连接 credential generation，且复核结果到 sendFrame 之间禁止任何 `await`；全部通过才返回 page 0；
7. 任一复核失败都把 snapshot 标为 invalid 并删除其 cache rows，返回 401/403，不发送 page 0。

Authority read transaction 从不写权威数据库，且所有 SQLite 工作都在 SnapshotWorker；因此长房间扫描不会占用 authority write lock或 main event loop。跨多个 WebSocket 请求读取的是已物化的同一份数据库视图，不依赖长期占用 SQLite read transaction。Snapshot 在进程重启后仍可继续读取，但有明确 TTL；过期返回 `snapshot_expired`，客户端丢弃 staging 并重新 begin。

每个 `room.repair.page` 都要求一枚当前有效的 access token，重新复核它与 snapshot 的 `principalId + sessionFamilyId` 绑定、当前房间权限和 manifest 的 `access_revision`，并在 sendFrame 前核对当前 credential generation。同一 family 的 refresh 可以在原连接或新连接继续读取原 snapshot；其他 family 即使属于同一 principal 也不能接管。Session family 被撤销、成员在分页期间被移除或角色降级、房间被归档时立即返回 401/403/stale，客户端必须丢弃所有 staging pages。Page 请求在 TTL 内是只读且幂等，不会触发清理。全部 pages 顺序、snapshot ID、watermark 和 checksum 匹配后，materialized path 的 `ClientSyncReplica` 才原子替换该房间 live cache，并把 cursor 设为 snapshot watermark；streaming path 还必须等待下述 `snapshot.completed`。两种路径随后都执行 `room.sync` 补齐 snapshot 固定视图后的事件。

Materialized mode 不需要 complete/release，仍按 TTL 保留以支持同一 session family 的多消费者重试。Streaming mode 在 scoped barrier 下先按稳定顺序做一次 O(page) checksum pass，再从同一未变 authority state 分页；客户端校验末页后仍把数据留在 staging，并发送 `snapshot.complete`。Room repair 发送 `{ kind: "room", roomId, watermark }`，catalog repair 发送 `{ kind: "catalog", catalogRevision }`；服务端在当前权限下同时验证 kind/version/checksum，返回可幂等重放的 `snapshot.completed`，随后释放 barrier，并保留 30 秒 completion tombstone 处理 ACK 丢失。Tombstone 重放仍必须重新验证当前 token 属于原 session family、room access/catalog revision 仍有效；期间发生 revoke、撤权或 catalog 变化时返回 401/403/stale，不能用旧 completed 授权客户端换入数据。客户端收到 completed 后才原子替换 live cache，再从该 version 执行 delta；若 complete 被拒或失效则删除 staging。Streaming 客户端断开或连续 30 秒不请求 page/complete 时释放 barrier 并作废 snapshot；它没有总时长上限。

### 8.4 Catalog snapshot 与清缓存恢复

`workspace.bootstrap.begin/page` 复用同一 durable snapshot 机制，但 records 只包含 principal 当前可见的 `RoomSummary`，不复制消息水位。每个 catalog page 都带同一个 `catalogRevision`、`snapshotChecksum` 和明确的 `materialized|streaming` mode。Catalog manifest 绑定 `principalId + sessionFamilyId` 与固定视图中的 `catalog_revision`；cache COMMIT 后、page 0 发送前，以及每个后续 page 发送前，都在当前 authority 视图复核 access token 的 session family 和 revision。同一 family 刷新后可在新连接继续，其他 family 不可接管。Revision 变化、family revoke 或当前 actor 的 access-reducing governance 使整个 catalog snapshot stale/forbidden，客户端丢弃 staging 并重新 begin，而不是接收已经被移除的房间目录。

Catalog materialized mode 读完最后一页即可原子替换目录；catalog streaming mode 末页仍留在 staging，必须以 `{ kind: "catalog", catalogRevision }` 完成 `snapshot.complete`，收到 `snapshot.completed` 后才原子替换目录。服务端验证当前 session family、权限和 version/checksum 后才释放当前 actor 的 catalog barrier。该 barrier 只拒绝会改变这个 actor 目录的普通 durable mutation；`auth.refresh` 始终可提交，成员移除、权限降级、房间归档和 session-family revoke 可以抢占并作废 snapshot。其他 actor 的 catalog、无关房间写入和全局只读请求不受影响。目录完成后，客户端逐房间执行 `room.repair.begin/page`，每个房间仍独立复核当前权限。

房间创建、重命名、真人加入/角色变化/移除和归档同时写相关 principal 的 identity event/outbox，活动客户端收到后重新 bootstrap；即使该实时提示丢失，下一次登录、resume 或显式恢复仍会 bootstrap。由此“清空缓存”闭合为：认证 → catalog snapshot → 每房间 repair snapshot → delta → subscribe，不依赖任何本地 room ID。

### 8.5 订阅切换与 T-0039 兼容

现有无 cursor 的 `room.subscribe` 和 `room.history` 帧保持 T-0039 行为：服务端先注册监听，再返回当前消息历史，不能因为 T-0040 直接变成 400。该 legacy 路径继续受现有权限和 outbound frame 上限约束，但不承担游标恢复验收。

新增 `room.subscribe.v2`，必须携带已完成 delta 或 repair 的 cursor。服务端先复核 session 和房间权限并建立有界订阅闸门，再读取增量到确定 watermark，随后释放闸门中的更高序号事件。闸门按 `event_id` 去重，避免“先历史后订阅”产生间隙，也避免历史与实时重叠。新 `ClientSyncReplica` 只使用 v2；旧客户端可继续使用 legacy 帧，形成明确的协议兼容边界。

```ts
type RoomSubscribeV2Request = {
  type: "room.subscribe.v2";
  requestId: string;
  roomId: string;
  cursor: RoomCursor;
};

type RoomSubscribedV2 = {
  type: "room.subscribed.v2";
  requestId: string;
  roomId: string;
  cursor: RoomCursor;
  watermark: number;
};

type RoomSubscribeV2Retry = {
  type: "room.subscribe.v2.retry";
  requestId: string;
  roomId: string;
  reason: "gate_overflow";
  restartFrom: RoomCursor;
};
```

每个订阅闸门最多暂存 256 个 event 或 256 KiB canonical bytes，任一先到即算溢出。溢出时服务端原子丢弃未激活闸门和临时订阅，返回 `room.subscribe.v2.retry`；不得返回 `room.subscribed.v2`，也不得静默丢事件。客户端从 `restartFrom` 重新执行 durable `room.sync`，必要时进入 repair。只有历史增量已应用且闸门完全排空后，服务端才返回带最终 cursor/watermark 的 `room.subscribed.v2` 并把订阅标为 active。

## 9. 权限与撤销

- 历史、增量同步、全量修复和实时订阅都必须在同一数据库视图中复核当前 session 与成员关系。
- 客户端传入的 actor、成员列表、旧订阅或本地缓存不参与授权。
- 成员被移除或房间归档时，提交对应事件后主动终止不再合法的订阅。
- 即使撤销通知丢失，下一次历史、sync 或订阅请求仍会被当前权限拒绝。
- Snapshot 每页都再次验证 session 与房间权限；outbox 按 `room/principal/session-family` 的不同规则授权，既不能向已移除成员泄露 room event，也不能吞掉发给被移除 actor 或已撤销 family 的失效通知。
- `ClientSyncReplica` 在修复完成前不暴露 staging 数据；权限失败时删除 staging，而不是保留一个未完成的权威副本。

## 10. 迁移与旧数据导入

### 10.1 Schema migration

`schema_migrations` 保存版本、名称、checksum 和应用时间。最终 authority schema 版本固定为 2：v1 fixture 包含身份、session、房间、成员、审计和消息等已有权威事实；v2 在一个 migration 中执行以下确定性步骤：

1. 创建六类协作事实表、`streams`、`events`、`idempotency_records` 与 `outbox_deliveries`；
2. 为 actor 增加非空 `catalog_revision`，为 membership 增加非空 `access_revision`，所有 v1 既有记录确定性初始化为 0；
3. 为每个既有 room 插入 `stream_kind = room`、`stream_id = room.id`、`head_seq = 0`、`retained_from_seq = 1`；
4. 为每个既有 human 或 agent actor 插入 `stream_kind = identity`、`stream_id = actor.id`、`head_seq = 0`、`retained_from_seq = 1`；这里 stream ID 是 actor ID，不是假定只有可登录 human 的 principal ID；
5. 校验每个 session 都能引用 human actor、每条消息都能引用 room/actor，且所有 revision/stream 都存在，随后记录 v2 checksum。

既有历史不伪造 event，v2 升级后的首次客户端恢复走 repair snapshot，新变更从 stream sequence 1 开始。新数据库同样按 v1 → v2 顺序创建，避免另写一套只用于空库的 schema。Derived `snapshot-cache.sqlite` 使用独立 schema version 1；它不参与 authority migration，版本不兼容时可以删除重建，因为客户端会重新 begin repair。

一次启动所需的完整升级链放在同一个外层事务中；任一 migration 失败则整条链回滚，数据库版本、表结构和原数据均保持启动前状态。服务拒绝以未知或未达到当前版本的 schema 启动。测试 fixture 覆盖 v1 升级到 v2 后历史仍可读，以及人为注入失败后的表、版本和数据均保持原样。

### 10.2 T-0039 legacy import

当权威数据库不存在而旧 session JSON、room JSON 或 message JSONL 存在时，`LegacyStateImporter` 执行一次性导入：

1. 只读并完整校验全部旧文件；
2. 在同目录临时数据库中运行全部 migration；
3. 在单一事务中导入身份、会话、房间、成员、审计和消息；
4. 写入唯一 import marker；每个导入 actor 的 `catalog_revision = 0`，每条导入 membership 的 `access_revision = 0`；每个导入房间建立 `room` stream，初始化 `head_seq = 0`、`retained_from_seq = 1`，每个导入 actor 建立对应 `identity` stream；
5. 成功关闭数据库后原子启用新文件。

任何文件损坏、引用不一致或写入失败都不得替换正式数据库。导入历史没有伪造逐条 event；首次客户端恢复必须走权威 repair snapshot，导入后的第一个新房间事件从 `stream_seq = 1` 开始。重复启动通过 marker 和稳定旧记录 ID 保持幂等。旧文件在 T-0040 中不自动删除，便于人工回滚和核验。

## 11. 错误合同

- `400 invalid_request`：closed-schema、游标形状或版本错误；
- `401 unauthenticated`：没有有效会话；
- `403 room_forbidden`：当前 principal 没有房间权限；
- `403 snapshot_forbidden`：snapshot 属于其他 principal 或 session family；不得透露 snapshot 内容或绑定主体；
- `409 idempotency_conflict`：同 key 对应不同 canonical 请求；
- `409 snapshot_stale`：catalog/access revision 已变化，客户端丢弃 staging 并重新 begin；
- `410 snapshot_expired`：durable snapshot 已超过 TTL，客户端必须丢弃 staging 并重新 begin；
- `429 snapshot_busy`：snapshot build 队列已满，客户端按服务端 retry hint 重试；
- `503 repair_barrier_active`：streaming fallback 正暂停目标 room 或当前 actor catalog scope 内的普通 durable mutation；写请求未被接受，客户端按 retry hint 重试；
- `503 storage_unavailable`：数据库暂时不可用，且没有 durable ACK；
- `repair_required/cursor_absent|cursor_expired`：协议成功解析后的同步业务状态；
- migration/import 失败：启动失败并保留上一份可用状态，不降级为内存运行。

Materialized build 的 cache capacity、deadline 和 WAL pressure 只是服务端选择 streaming fallback 的内部 telemetry，不作为“无法修复”的终态返回给客户端。错误响应不得包含 token、SQLite 路径、SQL 文本或 payload 中的秘密字段。

## 12. 自动化验收矩阵

### 12.1 持久化与重启

测试启动独立 writer 子进程，逐类写入身份、房间、成员、消息、已读、已判定、待答项、Agent 执行和校准信号并正常退出。随后启动不共享 module cache、coordinator 或内存状态的 reader 子进程，从同一数据库逐字段读取一致。仅销毁 service/store 实例不计作“进程重启”证据。

### 12.2 幂等与并发

- 同一消息请求串行、并发和跨重启重试只生成一个事实与事件；
- 参数化覆盖房间治理及六类协作 command：同 key 同 payload 返回原 ACK，同 key 不同 payload 稳定返回 409；
- 待答项和执行 attempt 的重复提交不产生重复承诺；
- closed command/event guard 拒绝 unknown type、额外字段，以及把 human read 当作 Agent judgment、把 social reaction 当作 calibration 的跨原语 payload；
- public wire 无法构造 `InternalAgentCommandContext`，human payload 夹带 `agentId` 不落库；server fixture 的 `AgentFactWriter` 可以写入并重启读回 Agent judgment/execution。

### 12.3 三客户端同步

- 三个真实 WebSocket client 分别使用独立 `ClientSyncReplica` 和本地 cache；
- A 在线持续接收；
- B 暂时离线后以仍有效的 cursor 补齐，不漏不重；
- C 清空目录与房间 cache，经 bootstrap 重新发现房间；其旧 cursor 另被压缩边界淘汰，收到 `repair_required` 后完成分页 repair；
- 三者并发 repair 时，同一 principal/room/head 复用 single-flight snapshot；SnapshotWorker 工作期间 AuthorityWorker 仍能提交新消息，main thread 的 WebSocket heartbeat 按时响应；
- 两个消费者复用同一 snapshot 时，一个读完不会删除 pages；另一个和网络重试仍能在 TTL 内幂等读取，过期后两者都得到 410 并重新 begin；
- 压力 fixture 至少覆盖 10,000 条混合 records；另分别把 materialized cache 配额、deadline、WAL threshold 注入到必然失败，证明 cache build 回滚后自动切到 streaming，所有 records/checksum/watermark 仍完整恢复；
- Streaming 测试证明内存只保留一页、总页数不受 primary 配额限制；target barrier 期间相关普通写请求得到 503 且无 ACK/事实，无关房间和其他 actor catalog 的写入仍成功；`snapshot.complete` 后同一写重试成功并由 delta 补齐；idle/disconnect 会释放 barrier，complete ACK 丢失可在 30 秒 tombstone 内幂等重放；
- 把 access token TTL 与 page latency 注入到 repair 中途过期：同一 session family 执行 `auth.refresh` 必须在 barrier 存在时仍能持久化旋转，并可用新 token 在原连接或新连接继续同一 snapshot；不同 family 不得接管；
- 在 streaming room/catalog repair 中分别撤销 session family，以及由 owner/admin 移除目标成员、降级权限或归档房间；这些 access-reducing mutation 必须抢占普通 barrier、使 snapshot stale/forbidden、释放 scope，且后续 page/complete 不得泄露旧数据；
- Catalog materialized 与 streaming 两种路径都从 page 0 到末页携带稳定 `catalogRevision`；streaming complete 使用 catalog version union，清缓存客户端据此原子替换目录，再逐房间恢复；
- 三者最终事实集合和 watermark 与服务端一致；materialized path 在最后一页前、streaming path 在 `snapshot.completed` 前，C 的 live cache 都保持空或旧的完整版本，不出现半快照。

### 12.4 ACK 与崩溃窗口

测试用独立服务子进程打开故障点；SQLite COMMIT 完成后、OutboxDispatcher 获得控制权前，子进程立即以专用退出码终止。父测试确认旧 PID 已退出，再启动全新服务进程。未收到事件的客户端通过 pending outbox 或 cursor 取回同一 `event_id`，持久消息和客户端可见结果都只有一份。

### 12.5 Migration

上一版 fixture 升级后，所有既有 actor/membership 得到 revision 0，所有 room/actor 得到 `head_seq = 0`、`retained_from_seq = 1` 的正确 stream，历史与权限可由 repair snapshot 读取，新事件从 1 开始；snapshot cache schema 可创建及丢弃重建。中途抛错后 authority schema 版本与原数据不变。Legacy importer 同样断言 revision/stream 初始化，并覆盖成功、损坏输入、重复启动和启用前终止。

### 12.6 权限与缓存

被移除成员不能查询历史、sync、snapshot 后续页或继续订阅；另一个合法成员不受影响。Target-kind 测试证明 room delivery 不再发给已移除成员、principal delivery 仍能通知其刷新目录、session-family delivery 即使 session 已撤销仍会发送 terminal frame 并关闭连接。并发测试在连接完成认证后暂停命令，另一连接 revoke 该 session，再恢复原命令；原命令必须在事务内返回 `session_revoked`，且不产生领域事实、event 或 outbox。另一个确定性 interleaving 在 snapshot 固定视图后暂停 build、撤销 session 或移除成员，再完成 cache COMMIT；page 0 必须被最终复核拦截且 cache snapshot 失效。清空三个客户端的房间目录、游标和房间 cache 后，均能通过 bootstrap → repair → delta → subscribe 从服务端恢复。

### 12.7 协议与原语渲染回归

- T-0039 legacy `room.subscribe` 不带 cursor 时仍先注册、再返回 history 并继续 live fanout；
- v2 bootstrap/sync/repair 的每个成功 frame 都有 closed `type` 和当前请求的 `requestId`，begin/page 的 0-based 页序被运行时 guard 拒绝越界；room/catalog 的 `snapshot.complete` version union 不能互换或省略；
- `room.subscribe.v2` 成功返回最终 cursor/watermark；把闸门阈值注入为 1 后，第二个 event 触发 retry frame、未激活订阅被清理，客户端 durable resync 后不漏事件；
- 在 T-0012/T-0013/T-0014 verified 并合入后，把 repair records 输入既有 renderer，真人已读 / Agent 判定、待答项 / Agent 执行、social reaction / calibration 的 DOM class 和文案仍分别断言。

### 12.8 全仓门禁

交付前必须重新执行：

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links
```

## 13. Buzz 参照与偏离

### 13.1 参照什么

- `buzz-relay handlers/ingest`：持久事件在事务内落库，事务完成后再分发；
- `buzz-relay handlers/req`：历史与订阅入口统一经过访问控制；
- Buzz `SubscriptionRegistry`：按资源索引订阅，便于精准广播和撤销；
- Buzz 分析 §11.6 的 workflow `ActionSink`：业务编排依赖能力端口，而不是直接持有基础设施实现。

### 13.2 怎么翻译成 TypeScript

- 把 `ActionSink` 的模式迁移为 `CommandStore` / `SyncQueryStore`，隔离 `node:sqlite`；这不是复用 Buzz 的存储接口；
- 用 SQLite transaction 同时写领域表、event、idempotency record 和 outbox；
- 用 `SyncService` 与现有 WebSocket closed-schema protocol 暴露游标恢复；
- 从现有 `MessageService` 内部 listener Map 抽取本项目的 `SubscriptionRegistry`，承接 OutboxDispatcher 的实时投递。

### 13.3 为何偏离

- 不照搬 Buzz `dispatch_persistent_event` 的提交后直接 spawn：进程可在提交与分发之间终止，因此改成事务 outbox；
- 不照搬 Rust/PostgreSQL 技术栈：当前是单机 Alpha，SQLite 能满足事务和恢复且部署成本更低；
- 不采用完整 Event Sourcing：T-0040 只需要可靠同步和恢复，领域表作为权威状态更直接；
- 不复用 Buzz 的人类与 Agent 统一身份语义：本产品继续保持真人已读/Agent 判定、真人待答/Agent 执行等独立模型。
- Buzz 的 `ActionSink` 面向 workflow action，本项目只迁移“依赖能力端口”的设计方法，不宣称它是现成的持久化抽象。

## 14. 风险与控制

### 14.1 `node:sqlite` 在 Node 22 中仍属实验 API

通过 `CommandStore` / `SyncQueryStore` 隔离实现，声明 Node engine 下限并在 CI 覆盖；若后续切换驱动，不改变业务服务合同。

### 14.2 同步 SQLite 调用阻塞事件循环

所有 `DatabaseSync` 调用从第一版起就在 worker thread。AuthorityWorker 只做短事务；常规完整快照由 SnapshotWorker 的 read-only authority transaction 生成到独立 cache，不持有 authority write lock。分页、single-flight、全局一个 materialized build、16 请求队列、5 分钟 TTL 和 512 MiB cache 配额共同限制常规路径的 CPU、内存与磁盘压力；main thread 始终可以处理 WebSocket heartbeat 和 backpressure。

这些数值只决定是否走快速 materialized path，不限制 authority 可接受的数据规模。任何有限的合法 authority state 都必须能通过 streaming fallback 以 O(page) 资源完成修复；代价是 fallback 期间目标 room 或当前 actor catalog scope 内的普通 durable mutation 明确返回可重试 503。其他 scope 继续读写，`auth.refresh` 继续提交，owner/admin 的移除、降级、归档与 session-family revoke 可以抢占并终止恢复。自动化压力测试至少使用 10,000 条真实 closed records，并用低阈值确定性强制 fallback；不得把一次小 fixture 通过写成 materialized path 具有无限容量。

### 14.3 实时网络无法保证物理数据包 exactly-once

系统用事务唯一约束、稳定 `event_id`、房间游标和客户端幂等应用保证恰好一次可见结果。文档和测试不得把它误报成传输层只发送一次。

### 14.4 单进程 writer 不是生产集群方案

T-0040 明确只支持单服务进程。跨进程 lease、PostgreSQL 或分布式队列是后续 hardening 候选，不能作为本任务已经交付的能力。

## 15. 交付边界

完成实现后，T-0040 只能由认领者写到 `delivered`，等待 @lionel 验收，不得自行写 `verified`。交付说明必须逐条对照六条标准，并说明 Buzz 的具体模块、TypeScript 翻译和偏离理由。

T-0040 verified 后将直接解锁 T-0041 的真实 Agent runtime，并为后续 Alpha 客户端完整恢复提供权威数据底座。
