# 消息持久化 ACK 协议

## `message.accepted` 的含义

服务端仅在以下两个条件都成立后发送 `message.accepted`：

1. 消息通过作者身份、作者种类、房间成员关系与非空正文校验；
2. 消息已追加到当前配置的持久化存储。

因此 ACK 是 **persisted acceptance**：它表示此消息已被服务端接受并落入耐久存储。它**不**表示其他客户端已经收到实时事件、未来 worker 已经处理它，或某个 agent 已经生成回应。

`message.accepted.requestId` 回显客户端 `message.send` 帧的 `requestId`，用于请求关联；`messageId` 是被持久化的消息 ID；`persistedAt` 是服务端写入完成后记录的时间。

## 历史与实时订阅

对 `room.subscribe`，服务端必须先注册该连接的实时订阅，再查询并返回 `room.history`。这样在订阅注册和历史查询之间新写入的消息会以 `message.created` 推送给连接，不会落在两条链路的间隙中。

这也意味着客户端可能先收到 `message.created`，后收到包含同一条消息的 `room.history`。客户端必须以 `Message.id` 为去重键合并两种帧；不得把历史帧当作覆盖实时状态的较新快照。

同一房间重新订阅时，服务端以最新订阅为准，旧订阅尚未完成的 history 或错误不会再发送给客户端。
