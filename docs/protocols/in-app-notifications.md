# FT-12 In-app Notifications 协议

状态：Stage 14 生产合同。权威来源为 PRD `REQ-PRIM-017`、`REQ-PRJ-010`、
`REQ-PRJ-012`、`REQ-UX-003`、`REQ-UX-008`，以及正式设计旅程 J-07。

## 1. 权威边界

Notification 是 SQLite AuthorityWorker 内的 recipient-scoped durable fact。producer 只能提交
由既有 source authority 推导的 closed evidence；客户端不能提交 recipient、handled、source、
deep-link、标题、正文或任意 action。创建 fact、Identity stable event 与 principal outbox row
必须处于 source mutation 的同一事务；数据库唯一约束是最终 dedupe authority。

通知只保存最小安全投影：稳定 notification/source/boundary/revision 标识、recipient、时间、
read/handled revision 和 closed title key。不得保存 Provider body、hidden reasoning、header、
secret、tool body、附件二进制、无界 Room corpus、HTML 或来源正文副本。

`read` 与 `handled` 是独立轴：

- `notification.mark-read` 仅允许 notification recipient 的有效 Human session 调用；
- read ACK 和 `notification.read` stable event 来自服务端提交；
- handled 只能由 Request、confirmation、project boundary、tool review/result recovery、
  execution recovery 或 escalation 的权威终态投影；
- 打开 center、scroll、高亮和深链导航均为 local transient，不改变 handled；
- handled 不反向伪造 read。

## 2. Producer 与稳定绑定

批准的 notification kind 为 `human_mention`、`human_request`、`tool_confirmation`、
`project_due`、`tool_result`、`agent_execution_completed`、`agent_execution_failed`、
`cannot_answer_escalation`。每项使用
`(recipientActorId, sourceBoundaryId, notificationKind, ordinal)` 的唯一绑定，并另存 canonical
dedupe key。due 的 ordinal 是 boundary reminder ordinal；retry/new execution 使用新 lineage，
archive/reopen 不复活旧 boundary。

recipient 仅由服务端 source relationship 推导：mention target、Request target/requester、exact
confirmation principal、Human Ball holder、invocation/source Human、project holder/requester、
owner 或当前 administrators 的批准 fallback。Agent recipient 不生成 Human notification。
Room archived 时不创建新业务通知；保留成员仍可浏览已有安全投影。member removal、source
inaccessible 或 authorization loss 立即使查询省略该项，并由有界 revoke recovery 清理 durable
projection/outbox/cache。

member removal 是特殊的隐私边界：AuthorityWorker 在删除 membership 前以同一事务、单条
set-based 更新撤销该 recipient 的完整旧 Room projection，避免快速 rejoin 复活旧 boundary。
逐项 `notification.revoked` stable event/outbox 最多写 256 个；同事务的
`identity.room-access.changed(change=removed)` 是完整 Room notification/badge cache-clear 信号。
因此超过 256 项不会留下 durable tail，也不会在 rejoin 后误撤新 notification。

message recall 同样先在 source AuthorityWorker 事务内以单条 set-based 更新撤销该 message 的
全部历史 mention revision；合法 recall 不因累计 revision 超过 256 而回滚。该事务只为排序最前
的 256 项追加 `notification.revoked` stable event/outbox。durable pending
`room.message.recalled` outbox row 是唯一恢复 marker：OutboxDispatcher 每次 poll 调用内部 closed
`notification.recover-source-revocations` Authority 操作，最多补 256 个缺失的 deterministic
revoked event/outbox；`hasMore=true` 时 recall delivery 仅 deferred，不增加 attempt、不进入 retry
或 dead-letter；本轮 `recoveredCount>0` 也 deferred，下一 poll 确认 clean tail 后才发送 recall。
recalled source 不可 reopen，因此恢复无需
第二 scheduler 或 epoch fence；进程重启继续从同一 pending recall marker 推进。

## 3. Closed WebSocket

客户端请求：

- `notification.list { requestId, roomId, before, limit }`
- `notification.mark-read { requestId, notificationId, expectedReadRevision }`
- `notification.source.resolve { requestId, notificationId }`
- `notification.tool-result.acknowledge { requestId, notificationId }`
- `notification.execution-result.acknowledge { requestId, notificationId }`

`notification.list.result` 回显 requestId，并返回：

- 最多 `limit` 个安全 projection；
- `hasMore`；
- 同一 recipient 全部当前可访问 Room 的权威 `roomBadges`；
- AuthorityWorker 在该次读取中的 `identityWatermark`。

列表是 bounded online query，不是第二套 snapshot。keyset page 允许 center 增量浏览；完整
离线 cache 只能由 FT-13 的单一 Room repair registry 在 fixed watermark 下重建。客户端不得
跨不同 Identity watermark 把分页结果拼成新的权威 snapshot。实时 `notification.*` stable
event 走既有 principal outbox 与同一 WebSocket；eventId 去重，cache projection、event ledger
与 cursor 在同一加密 generation 事务提交。列表响应前到达的事件先缓冲，安装响应水位后丢弃
`<= identityWatermark` 的重复并应用更新事件。Room repair watermark 不是 Identity cursor。

`notification.read.ack` 含 requestId、notificationId、roomId、recipient、outcome、readAt、
readRevision 与 eventId；同 requestId/相同 payload 重放原 ACK，不同 payload 返回 409。
source resolve 每次重新校验 session、recipient、membership、Room lifecycle 与 source access；
无权或已消失时不返回标题、正文或 source metadata。

Tool result 只有在该通知绑定的 dispatch 已进入 `known_succeeded`、`known_failed` 或
`revoked_before_dispatch` 时，recipient Human 才能显式提交 acknowledge；
`outcome_unknown` 必须继续停留在 review/recovery 流程，不能用通知旁路关闭。成功返回
`notification.tool-result.ack`，handled stable event 仍由同一 AuthorityWorker transaction 发出；
重复 acknowledge 只返回 `already_acknowledged`，不会生成第二个 handled event。

Execution result acknowledge 只接受当前 recipient 的
`agent_execution_completed` / `agent_execution_failed` 通知，并在每次操作时重新核对 direct
execution 或 Project boundary execution 的同 Room、当前 terminal status 与 exact source
revision。成功返回 `notification.execution-result.ack`；首次操作与 `notification.handled`
stable event、principal outbox 同一 AuthorityWorker transaction 提交，重复操作返回
`already_acknowledged` 且不生成第二个 handled event。source 消失返回 410，recipient/成员权限
不成立返回 403，terminal status 或 revision 漂移返回 409，认证失效返回 401；均不得回退为
tool-result acknowledge 或本地 handled。

## 4. Repair、撤权与离线

Notification 是 closed Room repair record kind，每个 kind 仅一个 descriptor。materialized 与
streaming repair 都用当前 authenticated Human principal 过滤；同 Room 其他 Human、非成员
Tenant Administrator 均看不到。page/complete 继续复核 session family、membership、Room
lifecycle/access revision 与 credential generation，revoke 可抢占 repair。

Desktop 只展示完整、校验通过且加密的 active generation。离线仅可读，mark-read/source
action transport 调用数必须为 0；repair failed 保留旧完整且仍获授权的 cache，不提交 staging。
撤权、source inaccessible、解包/AAD/tag 失败必须锁定并清除相应 Room notification 与 badge。
不发送 OS push，不使用 Electron system notification，不建设旧 M4 五分区 inbox。

## 5. 错误与容量

closed error 按 code 决策：401 重新认证；403 清理不可访问 projection；409 载入最新 revision；
410 删除 source-inaccessible 项；429 使用 wire `retryAfterSeconds`，Desktop 只在 closed parser
中换算为 `retryAfterMs` 后重试；503 保持旧完整 cache 并提供显式
retry/offline-read-only。不得解析 message 或暴露 worker/database/internal path。

list limit 为 `1..256`；同一连接 notification 操作使用 10 秒/64 次的有界 token window，超限
返回 429 和正数 `retryAfterSeconds`。producer fanout 与每次 terminal mutation 最多处理 256 个
当前 `handled_at IS NULL AND revoked_at IS NULL` 的 pending fact；已 handled 的历史行不占批次，
新 source boundary/revision 不会被旧 terminal 投影。message recall 的 durable revoke 是上述
set-based 特例，逐项 event recovery 仍为每批最多 256。outbox 使用 FT-13
的有界 batch、退避、最大 attempt、dead-letter 与告警。10k notification 证据使用 keyset paging
和聚合 badge，不把全量事实一次复制到 renderer IPC。
