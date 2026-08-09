# 真实身份、群与加入生命周期协议

本文定义 T-0039 的服务端权威边界。领域类型以 `@native-im/core` 为准，身份与群状态由 `@native-im/server` 执行；桌面端只提交意图，不能把界面状态当作授权结果。

## 1. 身份链：账户 → 会话 → 真人 actor

1. `IdentityAdapter.verify({ accountId, secret })` 验证账户凭据，并把账户映射到一个既有真人 actor。
2. `AuthenticationService.login()` 仅为 `kind: "human"` 的 actor 签发会话；账户错误返回 401，账户映射到 agent 等身份替换返回 403。
3. 服务端签发不可推导的 access token 与 refresh token，只把 SHA-256 token hash、账户、actor、token family 和过期时间写入状态。
4. `auth.resume`、消息发送、历史查询和订阅都从当前 access token 恢复同一个 principal。业务帧没有 actor 字段；`message.send.message` 只能包含 `id`、`roomId`、`body`、`sentAt`。
5. `MessageService` 根据已认证 `actorId` 和当前成员目录补全 `authorId` / `authorKind`。客户端传入任一作者字段都以 `identity_forbidden` / 403 拒绝，而不是覆盖服务端身份。

当前密码适配器使用 scrypt 和 `timingSafeEqual`；盐至少 16 bytes，派生 hash 固定为 64 bytes。缺失账户也执行同等 scrypt 工作量，状态与日志不保存明文密码或原始会话 token。

## 2. 会话生命周期

| 动作 | 输入 | 成功结果 | 权威规则 |
| --- | --- | --- | --- |
| 登录 | `auth.login` + 账户凭据 | `auth.authenticated`，带账户、actor 和新 token 对 | actor 必须由身份适配器映射，客户端不能选择 |
| 恢复 | `auth.resume` + access token | `auth.authenticated`，不重新下发 token | 服务重启或新客户端均从持久化 hash 恢复 principal |
| 刷新 | 已认证连接上的 `auth.refresh` + refresh token | 旋转后的新 token 对 | refresh 所属 principal 必须与当前连接一致；旧记录标记撤销 |
| 撤销 | 已认证连接上的 `auth.revoke` | `auth.revoked` | 整个 token family 立即撤销，并清除该连接身份与订阅 |

默认 access TTL 为 15 分钟，refresh TTL 为 30 天；过期边界使用 `now >= expiresAt`。access 过期不会删除仍有效的 refresh 会话。刷新 token 单次旋转；复用已撤销 refresh 会撤销其 token family。access/refresh TTL 可由服务端注入配置，客户端声明不生效。

会话状态使用 version 1 JSON 文档和原子临时文件替换，因此服务进程重启后仍按原过期时间、撤销状态和 token family 恢复。每次业务动作和实时投递前都会重新验证 access token；从另一连接撤销后，旧连接不能继续读写或接收实时事件。

## 3. 401 与 403

- **401** 表示无法建立有效认证：未登录、错误账户凭据、空/未知/篡改 token、access 或 refresh 已过期。此时没有可供业务授权使用的 principal。
- **403** 表示服务器识别到了受保护身份或会话，但本次行为被拒绝：已撤销会话、登录映射到非真人 actor、在已认证连接上用其他 principal 的 refresh token、客户端尝试提交 `authorId` / `authorKind`，或已认证 actor 没有房间权限。
- 房间生命周期的普通成员越权统一为 `room_forbidden` / 403；未提供或不存在的 actor 身份为 401。有效身份访问不存在的生命周期资源可以返回 404，非法输入可以返回 400，状态冲突可以返回 409。

## 4. 两条互不合并的加入路径

### 4.1 真人邀请

`HumanInvitationRequest` 固定为：

```ts
{
  kind: "human-invitation";
  roomId: string;
  inviteeActorId: string;
}
```

owner/admin 调用 `inviteHuman()` 后，服务端生成一次性邀请 token，只持久化 token hash，并记录 `inviterActorId`、目标真人和 pending 状态。只有被邀请真人可以调用 `respondToHumanInvitation(token, "accept" | "reject")`：接受后才以 `member` 身份进入房间；拒绝只形成终态记录，不创建成员关系。接受/拒绝均记录邀请人、决定人、结果和时间；已消费 token 不能再次决定。

### 4.2 Agent 配置

`AgentConfigurationRequest` 固定为：

```ts
{
  kind: "agent-configuration";
  roomId: string;
  agentId: string;
  participation: "active" | "on-mention" | "silent";
  toolPermissions: readonly string[];
}
```

owner/admin 调用 `configureAgent()` 后立即创建或替换 agent 成员关系，没有邀请、等待或接受步骤。参与度与工具权限字段必须同时出现；`toolPermissions` 必须至少包含一个无重复 grant，且每个 grant 都属于该 agent 已声明能力。桌面入口同样要求至少勾选一项工具权限，无可授予工具的 agent 可见但不可提交。服务端和桌面端必须独立执行这条规则，不能用界面校验替代接口校验。

两条路径在数据类型、服务方法、审计事件、桌面表单、提交回调和视觉表面上都不同：真人使用“等待接受/拒绝”的虚线邀请面；agent 使用“参与度 + 工具授权立即生效”的实线配置面。

## 5. 房间治理

创建房间的真人自动成为 owner。服务端在每个方法内部执行权限检查：

`RoomLifecycleService` 方法中的 caller `actorId` 是服务端适配层传入的已认证 principal，不是 wire client 可选择的请求字段；未来暴露房间管理 transport 时也必须从会话注入，不能把 caller actor 原样开放给客户端。

| 操作 | owner | admin | member |
| --- | --- | --- | --- |
| 重命名、归档 | 允许 | 允许 | 403 |
| 邀请真人 | 允许 | 允许 | 403 |
| 配置/重配 agent | 允许 | 允许 | 403 |
| 移出真人或 agent | 允许 | 允许，但不能移出 owner | 403 |
| 把真人设为 admin/member | 允许 | 403 | 403 |

归档是幂等终态：归档房间不再可用于消息访问，后续重命名、邀请、配置和移除被拒绝。界面可以根据角色隐藏操作，但隐藏不是权限控制，服务端方法始终重新检查当前成员关系和角色。

## 6. 消息访问、移除与审计

`MessageService.history()`、`subscribe()`、`send()` 都在调用时读取当前成员目录。WebSocket 上对应 `room.history`、`room.subscribe`、`message.send`：

- 缺少有效会话时三个入口分别返回 401；
- 已认证但不是当前成员时三个入口分别返回 403；
- `room.subscribe` 先注册实时监听，再读取并返回 `room.history`，客户端以 `Message.id` 合并可能重叠的 `message.created` 与历史结果；
- 已建立的订阅在会话撤销、过期、连接关闭或成员被移除后不再投递。

移除成员只修改当前成员关系，不改写消息存储。其历史发言仍可由剩余成员查询；被移除 actor 的历史、订阅、发送、实时投递和后续房间寻址权限立即失效。服务端保留并可按房间查询以下审计事件：

- `room.created`
- `room.renamed`
- `room.archived`
- `room.human.invited`
- `room.invitation.accepted`
- `room.invitation.rejected`
- `room.agent.configured`
- `room.member.removed`
- `room.member.role.changed`

审计记录含唯一 ID、房间、执行 actor、结果和时间；涉及成员时含目标 actor，邀请决定还保留邀请 ID 与邀请人，agent 配置还保留参与度和工具授权。对外返回的是分离副本，调用方不能借引用修改权威状态。

## 7. 当前持久化边界与 T-0040 交接

T-0039 为完成重启恢复，分别持久化 session version 1 JSON、room lifecycle version 1 JSON 和消息 JSONL。JSON 状态写入采用进程内队列、临时文件和 `rename` 原子替换；消息 JSONL 在同一进程内按规范化路径协调写入、重复 ID 和精确重放。这个边界不等同于统一事务存储：

- session、room、message 与审计仍是独立文件，跨文件变更没有原子事务；
- version 1 guard 能拒绝损坏或不可达状态，但没有正式 schema migration/rollback 管线；
- 协调锁是进程内的，不提供多进程 writer lease；消息列表仍需重读 JSONL；
- 没有统一事件游标、outbox、投递确认或失败恢复编排。

**T-0040 必须接手的准确范围**：把身份/会话、群成员与审计、消息写入纳入统一的 SQLite 持久化和迁移边界；定义 schema 版本升级与回滚/恢复；把“状态变更 + 待发布事件”写入同一事务 outbox；提供稳定事件游标、重放与 ACK；覆盖进程崩溃、持久化失败、outbox 重试和并发 writer 的故障注入。T-0040 不得重新允许客户端选择 actor，也不得合并真人邀请与 agent 配置语义。
