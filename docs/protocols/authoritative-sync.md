# 权威同步、持久 ACK 与故障恢复协议

本文记录 T-0040 的客户端/服务端闭合合同。SQLite authority 是事实源；Snapshot cache、renderer cache、进程内订阅表和已发送但未标记的帧都不是事实源。

## 1. 闭合帧与错误

客户端帧只接受下列 `type`，每种类型都拒绝额外字段：

- 身份：`auth.login`、`auth.resume`、`auth.refresh`、`auth.revoke`；
- 写入与旧兼容读：`message.send`、`room.history`、`room.subscribe`；
- v2 恢复：`workspace.bootstrap.begin`、`workspace.bootstrap.page`、`room.sync`、`room.repair.begin`、`room.repair.page`、`snapshot.complete`、`room.subscribe.v2`。

成功帧同样以 closed `type` 区分：`auth.authenticated`、`auth.revoked`、`message.accepted`、`message.created`、`room.event`、`identity.room-access.changed`、`auth.session-revoked`、`room.history`、`room.subscribed`、`workspace.bootstrap.page`、`room.sync.result`、`room.repair.page`、`snapshot.completed`、`room.subscribed.v2`、`room.subscribe.v2.retry`、`open-item.ack`、`light-task.ack`。请求/响应帧回显当前 `requestId`；异步 `room.event` 使用持久 `eventId` 与 `streamSeq`。

错误统一为：

```ts
{
  type: "error";
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | 503;
  code: ProtocolErrorCode;
  message: string;
  requestId?: string;
}
```

同步相关稳定 code 为 `invalid_request`、`unauthenticated`、`room_forbidden`、`room_not_found`、`room_archived`、`snapshot_forbidden`、`snapshot_family_revoked`、`snapshot_stale`、`snapshot_not_found`、`snapshot_expired`、`snapshot_busy`、`repair_barrier_active`、`storage_unavailable`。认证另有 `invalid_token`、`token_expired`、`session_revoked`。客户端必须按 code 决策，不能解析错误文案，也不能把内部 worker code、数据库路径或堆栈当作 wire 合同。

权威定义见 [`protocol.ts`](../../packages/server/src/protocol.ts) 与 [`sync.ts`](../../packages/core/src/sync.ts)。

## 2. Cursor、bootstrap、repair、delta、subscribe

`RoomCursor = { version: 1, roomId, afterSeq }` 表示客户端已原子应用到该 room stream 的序号。服务端 watermark 是固定读窗口的最高序号，不是“已推给所有客户端”的承诺。

恢复顺序固定为：

1. `workspace.bootstrap.begin`，随后按 `afterPage = 当前 page` 请求 catalog 后续页；全部页校验 checksum 后一次性替换本地 catalog。
2. 对发现的 room 发送 `room.sync`。无 cursor 返回 `repair_required/cursor_absent`；`afterSeq < retainedFromSeq - 1` 返回 `repair_required/cursor_expired`；仍在保留范围则返回按 `streamSeq` 连续的 `delta`。
3. 需要 repair 时，从 `room.repair.begin` 的 page 0 开始，后续页必须保持同一 `snapshotId`、mode、watermark 和 checksum。客户端只写 staging。
4. 全量页校验完成后，materialized snapshot 可直接原子 commit；streaming snapshot 必须先收到匹配 room/catalog version union 的 `snapshot.completed`，再原子 commit。完成前 live cache 保持空或旧的完整版本。
5. 从 snapshot watermark 继续 `room.sync`，直到 fixed watermark；最后用该 cursor 激活 `room.subscribe.v2`。

`room.subscribed.v2` 返回最终 cursor/watermark。若订阅闸门溢出，服务端发 `room.subscribe.v2.retry { reason: "gate_overflow", restartFrom }` 并清理未激活订阅；客户端从 `restartFrom` durable resync 后重新订阅。`eventId` 是 replica 可见幂等键：重放帧可重复到达，但同一 replica 只应用一次。

## 3. Materialized 与 streaming ordering

常规路径由 SnapshotWorker 在只读固定视图中建立 materialized cache。配额、deadline、WAL growth 或 worker build 失败必须回滚不完整 cache，并自动切到 streaming；这些限制只选择快慢路径，不能令有限且合法的 authority state 永久不可恢复。

Streaming 每次只持有一页并在 AuthorityWorker 里登记 target barrier。相关 room/catalog 的普通 durable mutation 返回 `503 repair_barrier_active` 且不得产生 ACK、事实、event 或 outbox；无关 scope 仍可写。`snapshot.complete` 核对最后一页、checksum、watermark/version 后释放 barrier，并在 tombstone 窗口内支持 completion ACK 结果重放。idle、断连、权限收紧或 session-family revoke 也必须释放或抢占 barrier。

客户端原子可见性不是“下载完最后一页”，而是：materialized 路径校验全部页/checksum 后 commit；streaming 路径还要等 `snapshot.completed` 后 commit。`ClientSyncReplica` 不累计全量 records/rooms 或 canonical string，只持有当前 page/envelope；cache staging port 负责逐页持久、canonical finalize 与 catalog room-id iteration，因此 replica 额外空间为 O(page)。实现与 10,000 条 mixed record 证据见 [`snapshot-worker-client.test.ts`](../../packages/server/src/persistence/snapshot-worker-client.test.ts) 和真实三客户端 [`authority.e2e.test.ts`](../../packages/server/src/authority.e2e.test.ts)。其中 compiled-child mixed fixture builder 先用 production core guard 验证每条 closed record、开启 FK，再用单事务批量落入 authority 表；分布为 1 room、2,000 memberships（来自 2,000 个不同合法 actor）、3,500 messages、1,999 human reads、500 judgments、500 open items、500 executions、1,000 calibrations。三连接同属一个 session family；A 用比生产上限更严格的 deep-only 50 records/page 完成 200 页 streaming fallback，B/C 在正常 quota 下各完成 100 页 materialized repair。C 的 test transport 在收到 materialized 最后一页、返回给 `ClientSyncReplica` 之前暂停：此时已收齐 10,000 records，而 clear 后的 live cache count/checksum 仍为空；释放后 replica 才校验并 commit。E2E cache 保存完整 values、独立重算 checksum 并深比较三份副本；字段 mutation 必须失败。它专门证明 finite mixed snapshot 的 fallback/分页/原子 swap，不声称经过 10,000 次 production command，也不把这些 fixture 行冒充对应 event/outbox 证据。

## 4. 权限复核与 session-family refresh

历史、sync、snapshot 每一页、complete 和 subscribe 都按当前 authority 权限复核，不能依赖连接建立时或 page 0 时的旧判断。成员移除、角色降级、房间归档与 session revoke 属于 access-reducing mutation，可以抢占 streaming barrier；后续页/complete 返回 forbidden、stale 或 revoked，不得泄露固定视图。

Streaming lease 归属 session family，而不是短寿命 access token。相同 family 可在 repair 中途通过 `auth.refresh` 持久化旋转 token，并在原连接或新连接继续；其他 family 返回 `snapshot_forbidden`。family revoke 后 terminal frame 可以按 session-family delivery 发送，即使普通 room delivery 已禁止。

## 5. Durable acceptance、outbox 与故障窗口

一个 human command 的 SQLite `BEGIN IMMEDIATE … COMMIT` 同时写领域事实、稳定 event、idempotency record 和 outbox delivery。`message.accepted` 只表示该事务 durable accepted；不表示任何订阅者、索引或 workflow 已完成。

OutboxDispatcher 在提交后读取 pending delivery，按当前权限授权、发送，再标记 dispatched。传输语义是可重放的 at-least-once，不宣称物理 exactly-once：

- `after-domain-write`：`message.send` 的 domain fact INSERT 已在真实事务内发生，但 event/outbox/idempotency 尚未写；同步 probe 在 hook 内观察 `1/0/0/0`，随后 child 退出码 81，SQLite recovery 后四者均为零；
- `before-commit`：domain/event/outbox/idempotency 已完成但事务尚未 COMMIT，child 退出码 82；SQLite recovery 后四者均为零；
- `after-commit-before-outbox`：退出码 83；客户端不得得到伪 ACK，重启后 pending outbox 或旧 cursor 找回同一稳定 `eventId`；同 idempotency key 重试返回原结果；
- `after-send-before-dispatch-mark`：退出码 84；重启后允许再次发送同一 frame，replica 以 `eventId` 去重。

81–84 只属于 deep constructor + compiled child fixture，不是服务退出码 API；package root 的 `StartAuthoritativeServerOptions` 没有 fault/quota/fixture 字段，正常启动不进入 `process.exit`。Child 不传 `--disable-warning`；harness 捕获 `stderr` 后只剥离格式与文本完全匹配的 SQLite ExperimentalWarning 行，任何无关 warning/产品错误仍失败。父测试 runner 不使用 `NODE_NO_WARNINGS` 或全局 warning 抑制。真实进程证据见 [`authority-child.ts`](../../packages/server/src/fixtures/authority-child.ts) 与 [`authority.e2e.test.ts`](../../packages/server/src/authority.e2e.test.ts)。

## 6. Migration 与 legacy import

Authority schema 和可丢弃的 snapshot-cache schema 分别版本化。fresh、上一版到当前版、未知目标版本、注入中途失败都必须测试；失败时 schema version 与原数据保持不变。升级要补齐 actor/membership revision，以及 room/identity stream 的 `head_seq` / `retained_from_seq`，保证旧历史可 repair、新事件序号连续。

schema v9 新增 closed `light_tasks` 权威事实。human 只有发送 `light-task.create` 显式确认后才创建任务；普通消息（包括“我来做”）不会推导任务。`light-task.transition` 只允许 todo→claimed→delivered→verified，`light-task.criterion.set` 只允许持久化验收者在 delivered 阶段更新稳定 criterion 的 `met`。每次成功写入都和 `room.light_task.changed`、room outbox、idempotency acknowledgement 同属一个 AuthorityWorker transaction；repair record 使用 `kind: "light-task"`，不会携带 deps、maturity、milestone 或 Blueprint task ID。

Legacy import 在正式激活新 authority 前解析并验证 closed 数据，使用 migration/事务写入临时目标；损坏输入、重复启动、启用前终止都不得留下半激活 authority。证据见 [`schema.test.ts`](../../packages/server/src/persistence/schema.test.ts) 和 [`legacy-importer.test.ts`](../../packages/server/src/persistence/legacy-importer.test.ts)。Snapshot cache 可随时删除重建，不能反向覆盖 authority。

## 7. Buzz reference / translation / deviation

| Buzz 参照 | 本项目 TypeScript 翻译 | 明确偏离及原因 |
| --- | --- | --- |
| `buzz-relay handlers/ingest`：验证、授权后持久接受事件 | closed command → `CommandStore` → AuthorityWorker SQLite 事务 | 不采用客户端签名 Nostr event；本产品由服务端身份与细分 human/Agent 原语约束写入 |
| `buzz-relay handlers/req`：历史和订阅共享访问控制 | `SyncQueryStore` / `SyncService` 在 history、sync、page、complete、subscribe 复核当前权限 | 不复制 Nostr filter/EOSE；使用 room cursor、repair page 与 closed v2 frame |
| Buzz `SubscriptionRegistry` 的资源反向索引 | TypeScript registry 按 room、principal、session-family 定位候选，OutboxDispatcher 再按当前权限授权 | Redis topic 不是授权边界；Alpha 为单机进程内 registry，durability 来自 SQLite outbox/cursor |
| `dispatch_persistent_event`：durable ACK 与提交后 fan-out 分离 | 同事务写 domain/event/idempotency/outbox，提交后 dispatcher 发送 | 不照搬提交后 `spawn` 的 best-effort 窗口；用事务 outbox 和稳定 eventId 恢复 |
| Buzz workflow `ActionSink` 能力端口 | `CommandStore` / `SyncQueryStore` 隔离服务与 `node:sqlite` | 只迁移 port/adapter 方法，不声称 Buzz 已提供本项目持久化接口 |
| Buzz relay / Postgres 单社区权威与黑盒 relay E2E | AuthorityWorker / SQLite 单机权威；compiled child + 真实 WS E2E | 不引入 Rust/Postgres/Redis/mesh，也不采用完整 Event Sourcing；领域表是当前权威状态，event stream 服务同步恢复 |

Buzz 事实依据为 `/Users/lionel/project/articles/prd/drafts/context/参照项目-buzz-仓库分析.md` 中 relay 持久事件、历史/订阅、ACK、副作用与黑盒 E2E 章节；本表明确区分参照、翻译和偏离，避免把相似思想写成代码复用。
