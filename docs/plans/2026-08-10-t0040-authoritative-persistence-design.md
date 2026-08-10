# T-0040 服务端权威持久化、多客户端同步与故障恢复设计

状态：设计方案已获 @lionel 同意，等待书面规格复核后进入实现计划。

基线：`main@41341af2411558398175bb0fcf2becd46858ff51`

## 1. 背景与目标

T-0039 建立了服务端身份、房间生命周期和经过鉴权的消息传输，但其状态仍分散在 session JSON、room JSON 和 message JSONL 三套存储里；实时消息在持久追加后直接由进程内监听器分发，没有服务端游标、事务 outbox、统一迁移或跨领域原子提交。

T-0040 要把服务端提升为权威状态源：所有 Alpha 必需的协作状态能够持久化、迁移、重放和按权限恢复。客户端缓存只负责体验，不能决定身份、权限或事实状态。

本设计选择 Node.js 22.13+ 的内置 `node:sqlite`，在统一 SQLite 数据库内实现领域表、不可变同步事件和事务 outbox。公开业务服务继续依赖 TypeScript 端口，领域内核保持零 I/O。

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
- 提供房间级服务端游标、增量同步、游标过期和全量修复协议。
- 提供上一版 schema 迁移和 T-0039 三种文件存储的一次性导入。
- 将历史、同步和订阅统一接入服务端权限判断。
- 保持现有鉴权、房间治理和消息接口的行为兼容，扩展同步接口。

### 3.2 非目标

- 不实现多进程或多主 SQLite writer 协调；Alpha 服务仍是单进程单写者。
- 不引入 PostgreSQL、外部队列或部署依赖。
- 不实现完整 Event Sourcing，也不要求所有领域状态都由事件重算。
- 不新增产品 UI；桌面端只需要能够消费新的同步结果。
- 不在本任务实现自动化保留周期调度；只提供可验证的事件压缩边界和游标过期语义。
- 不实现 T-0041 的真实 Agent runtime、工具调用和恢复策略，只持久化其执行事实合同。

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
WebSocket protocol
       │
       ▼
Auth / RoomLifecycle / Message / Sync services
       │
       ▼
AuthoritativeStore port
       │
       ├── SqliteAuthoritativeStore
       ├── MigrationRunner
       └── LegacyStateImporter
       │
       ▼
SQLite: domain tables + events + idempotency + outbox
       │
       ▼
OutboxDispatcher ──► SubscriptionRegistry ──► clients
```

### 5.1 `AuthoritativeStore`

这是服务端唯一持久化端口，公开异步方法，内部实现可以替换。它负责：

- 运行短事务和串行化同一路径写入；
- 维护领域事实、事件、幂等结果与 outbox 的原子性；
- 提供权限感知的历史、快照和增量读取；
- 暴露 migration、legacy import 和故障注入接缝。

业务服务不拼 SQL，不直接管理 SQLite transaction。

### 5.2 `SqliteAuthoritativeStore`

生产实现使用 `node:sqlite` 的 `DatabaseSync`，但同步调用只存在于适配器内部。每个数据库路径只有一个进程内 coordinator，所有写事务使用 `BEGIN IMMEDIATE`，事务保持短小且禁止执行网络 I/O。

连接初始化至少执行：

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = FULL`
- 有界 `busy_timeout`

`package.json` 的 Node engine 下限声明为 `>=22.13`；CI 必须覆盖该下限或更高的 Node 22 版本。

### 5.3 `SyncService`

负责解析服务端游标、权限检查、增量分页、全量修复和 watermark。它不拥有事实状态，只从 `AuthoritativeStore` 读取一致快照。

### 5.4 `OutboxDispatcher`

按房间事件序号读取 pending outbox，交给现有订阅注册表，再标记 dispatched。启动时自动继续处理遗留 pending 记录。发送失败或进程终止不会删除事实事件。

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

所有外键和 kind 约束在数据库与 TypeScript closed-schema guard 两层校验。真人已读与 Agent 判定是两个表；待答项与 Agent 执行是两个表；校准信号不能伪装成普通 reaction。这些分离直接落实 PRD 第 2 章的原语分裂。

### 6.2 事件流

`events` 保存不可变同步事件，核心字段为：

- `event_id`：全局稳定 ID，唯一；
- `room_id`：事件所属房间；
- `room_seq`：该房间严格递增序号，`(room_id, room_seq)` 唯一；
- `actor_id`、`event_type`、`occurred_at`；
- canonical JSON payload。

每个房间在 `room_streams` 中维护 `head_seq` 和 `retained_from_seq`。客户端游标只表示该房间已经应用到哪个 `room_seq`，不是授权凭证。

### 6.3 幂等记录

`idempotency_records` 保存：

- 操作作用域与 `idempotency_key`；
- canonical request hash；
- 对应 `event_id`；
- 已提交的稳定响应。

同一作用域、同一 key 和相同请求返回原响应；payload 不同则返回 `409 idempotency_conflict`。唯一约束在事务内裁决并发写入，禁止“先查再插”的竞态。

### 6.4 Outbox

`outbox` 以 `event_id` 为主键，保存 room sequence、状态、attempt 次数和最近错误。领域写、事件写和 outbox 写必须在同一事务里完成。

Outbox 可以重复尝试网络发送，但不能生成第二个事件或第二份领域事实。客户端以 `event_id` 和游标实现幂等应用，因此保证的是“恰好一次可见结果”，而不是无法在不可靠网络上证明的“只发送一个数据包”。

## 7. 写入、ACK 与故障恢复

所有可持久化命令遵循同一流程：

```text
认证 principal
→ 在事务内重新读取并校验权限
→ 校验 closed request schema
→ 裁决 idempotency key
→ 更新领域表
→ 追加 event
→ 追加 outbox
→ COMMIT
→ 返回 ACK
→ OutboxDispatcher 尝试实时分发
```

ACK 只在 SQLite `COMMIT` 成功后生成。以下故障点必须可注入：

1. 领域写前；
2. 领域写后、提交前；
3. 提交后、outbox 分发前；
4. 发送后、outbox 标记前。

前两点失败不留下领域事实、事件或 outbox。第三点重启后由 pending outbox 或游标补齐。第四点可以重发同一 `event_id`，但客户端应用结果仍只有一份。

## 8. 游标同步协议

### 8.1 帧合同

新增 closed-schema 请求：

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
  mode: "delta";
  events: PersistedRoomEvent[];
  nextCursor: RoomCursor;
  watermark: number;
  hasMore: boolean;
};

type RoomSyncRepairRequired = {
  mode: "repair_required";
  reason: "cursor_expired";
  retainedFromSeq: number;
  watermark: number;
};
```

`roomId` 不一致、游标版本未知、负数或未来游标返回稳定的 `400` 协议错误；游标过期是明确的业务状态，不伪装成空增量。

### 8.2 增量恢复

服务端先从当前权威成员关系校验读取权限，再读取 `afterSeq < room_seq <= watermark` 的事件。单页同时受事件数和 UTF-8 序列化字节限制；下一页从服务端返回的 `nextCursor` 继续。

每页事件严格按 `room_seq` 升序且无重复。多个客户端游标相互独立。

### 8.3 全量修复

游标低于 `retained_from_seq - 1` 时，客户端执行全量修复。服务端在同一只读事务中读取：

- 当前房间与可见成员；
- 全部可见消息；
- 已读、已判定、待答项、Agent 执行和校准信号；
- 对应 watermark。

快照与 watermark 来自同一数据库视图。客户端原子替换本地房间缓存，再从该 watermark 继续增量同步。清空缓存等价于从无 cursor 开始执行同一修复流程。

### 8.4 订阅切换

`room.subscribe` 接受可选 cursor。服务端先建立有界订阅闸门，再读取增量到确定 watermark，随后释放闸门中的更高序号事件。闸门按 `event_id` 去重，避免“先历史后订阅”产生间隙，也避免历史与实时重叠。

## 9. 权限与撤销

- 历史、增量同步、全量修复和实时订阅都必须用数据库中的当前成员关系授权。
- 客户端传入的 actor、成员列表、旧订阅或本地缓存不参与授权。
- 成员被移除或房间归档时，提交对应事件后主动终止不再合法的订阅。
- 即使撤销通知丢失，下一次历史、sync 或订阅请求仍会被当前权限拒绝。
- 权限校验和读取要么在同一事务视图完成，要么在发送前再次验证，不能在权限变化后继续泄露历史。

## 10. 迁移与旧数据导入

### 10.1 Schema migration

`schema_migrations` 保存版本、名称、checksum 和应用时间。最终 schema 版本固定为 2：v1 fixture 包含身份、房间、成员、审计和消息等已有权威事实；v2 增加六类协作事实、事件流、幂等记录、房间水位和 outbox。新数据库同样按 v1 → v2 顺序创建，避免另写一套只用于空库的 schema。

一次启动所需的完整升级链放在同一个外层事务中；任一 migration 失败则整条链回滚，数据库版本、表结构和原数据均保持启动前状态。服务拒绝以未知或未达到当前版本的 schema 启动。测试 fixture 覆盖 v1 升级到 v2 后历史仍可读，以及人为注入失败后的表、版本和数据均保持原样。

### 10.2 T-0039 legacy import

当权威数据库不存在而旧 session JSON、room JSON 或 message JSONL 存在时，`LegacyStateImporter` 执行一次性导入：

1. 只读并完整校验全部旧文件；
2. 在同目录临时数据库中运行全部 migration；
3. 在单一事务中导入身份、会话、房间、成员、审计和消息；
4. 写入唯一 import marker 和一个 snapshot-import watermark；
5. 成功关闭数据库后原子启用新文件。

任何文件损坏、引用不一致或写入失败都不得替换正式数据库。重复启动通过 marker 和稳定旧记录 ID 保持幂等。旧文件在 T-0040 中不自动删除，便于人工回滚和核验。

## 11. 错误合同

- `400 invalid_request`：closed-schema、游标形状或版本错误；
- `401 unauthenticated`：没有有效会话；
- `403 room_forbidden`：当前 principal 没有房间权限；
- `409 idempotency_conflict`：同 key 对应不同 canonical 请求；
- `503 storage_unavailable`：数据库暂时不可用，且没有 durable ACK；
- `repair_required/cursor_expired`：协议成功解析后的同步业务状态；
- migration/import 失败：启动失败并保留上一份可用状态，不降级为内存运行。

错误响应不得包含 token、SQLite 路径、SQL 文本或 payload 中的秘密字段。

## 12. 自动化验收矩阵

### 12.1 持久化与重启

逐类写入身份、房间、成员、消息、已读、已判定、待答项、Agent 执行和校准信号，销毁所有 service/store 实例后从同一数据库重建并逐字段读取一致。

### 12.2 幂等与并发

- 同一消息请求串行、并发和跨重启重试只生成一个事实与事件；
- 同 key 不同 payload 稳定返回 409；
- 待答项和执行 attempt 的重复提交不产生重复承诺。

### 12.3 三客户端同步

- A 在线持续接收；
- B 暂时离线后以仍有效的 cursor 补齐，不漏不重；
- C 的 cursor 被压缩边界淘汰，收到 `repair_required`，执行全量修复；
- 三者最终事实集合和 watermark 与服务端一致。

### 12.4 ACK 与崩溃窗口

故障注入在 COMMIT 后、首次实时分发前终止服务。重建服务后，未收到事件的客户端通过 pending outbox 或 cursor 取回同一 `event_id`，持久消息和客户端可见结果都只有一份。

### 12.5 Migration

上一版 fixture 升级后历史、权限和游标可读；中途抛错后 schema 版本与原数据不变。Legacy importer 的成功、损坏输入、重复启动和启用前终止均有覆盖。

### 12.6 权限与缓存

被移除成员不能查询历史、sync 或继续订阅；另一个合法成员不受影响。清空三个客户端的本地状态后均能从权威快照恢复。

### 12.7 全仓门禁

交付前必须重新执行：

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links
```

## 13. Buzz 参照与偏离

### 13.1 参照什么

- `buzz-relay handlers/ingest`：持久事件在事务内落库，事务完成后再分发；
- `buzz-relay handlers/req`：历史与订阅入口统一经过访问控制；
- `SubscriptionRegistry`：按资源索引订阅，便于精准广播和撤销；
- Buzz 分析 §11.6 的 Port/Adapter：领域服务依赖存储能力端口。

### 13.2 怎么翻译成 TypeScript

- 用 `AuthoritativeStore` 接口隔离 `node:sqlite`；
- 用 SQLite transaction 同时写领域表、event、idempotency record 和 outbox；
- 用 `SyncService` 与现有 WebSocket closed-schema protocol 暴露游标恢复；
- 用现有订阅注册表承接 OutboxDispatcher 的实时投递。

### 13.3 为何偏离

- 不照搬 Buzz `dispatch_persistent_event` 的提交后直接 spawn：进程可在提交与分发之间终止，因此改成事务 outbox；
- 不照搬 Rust/PostgreSQL 技术栈：当前是单机 Alpha，SQLite 能满足事务和恢复且部署成本更低；
- 不采用完整 Event Sourcing：T-0040 只需要可靠同步和恢复，领域表作为权威状态更直接；
- 不复用 Buzz 的人类与 Agent 统一身份语义：本产品继续保持真人已读/Agent 判定、真人待答/Agent 执行等独立模型。

## 14. 风险与控制

### 14.1 `node:sqlite` 在 Node 22 中仍属实验 API

通过 `AuthoritativeStore` 隔离实现，声明 Node engine 下限并在 CI 覆盖；若后续切换驱动，不改变业务服务合同。

### 14.2 同步 SQLite 调用阻塞事件循环

事务禁止网络 I/O，增量和快照必须分页并受字节上限约束。T-0040 不做长查询或无限历史帧；若 Alpha 数据量证明仍有阻塞，再把同一端口迁入 worker thread，而不是把并发细节泄露给领域服务。

### 14.3 实时网络无法保证物理数据包 exactly-once

系统用事务唯一约束、稳定 `event_id`、房间游标和客户端幂等应用保证恰好一次可见结果。文档和测试不得把它误报成传输层只发送一次。

### 14.4 单进程 writer 不是生产集群方案

T-0040 明确只支持单服务进程。跨进程 lease、PostgreSQL 或分布式队列是后续 hardening 候选，不能作为本任务已经交付的能力。

## 15. 交付边界

完成实现后，T-0040 只能由认领者写到 `delivered`，等待 @lionel 验收，不得自行写 `verified`。交付说明必须逐条对照六条标准，并说明 Buzz 的具体模块、TypeScript 翻译和偏离理由。

T-0040 verified 后将直接解锁 T-0041 的真实 Agent runtime，并为后续 Alpha 客户端完整恢复提供权威数据底座。
