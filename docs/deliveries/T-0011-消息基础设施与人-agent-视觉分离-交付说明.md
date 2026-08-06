# T-0011 消息基础设施与人 / agent 视觉分离 · 交付说明

## 1. 做了什么

建立 TypeScript 的持久化消息写入、真实 WebSocket 实时订阅/历史回放协议，并将桌面端的人类消息和 agent 消息渲染为两种不共用的视觉结构。

## 2. 逐条对照验收标准

1. **满足** — `@native-im/server` 执行 client `message.send` → 成员与作者校验 → JSONL 持久化（写入完成前不 ACK）→ `message.accepted` → 实时扇出；`docs/protocols/message-ack.md` 明确 ACK 是持久化接受，不是实时送达或 agent 完成。
2. **满足** — `packages/server/src/websocket.test.ts` 用三个真实 loopback WebSocket 客户端订阅同一房间，断言第二、第三客户端在 1 秒内收到 `message.created`；套件连续五次通过。
3. **满足** — 服务端先注册实时订阅再查历史；竞态测试在二者之间注入消息，断言加入者先收到原始 `message.created`、再收到 history，并按 `Message.id` 去重为一条。
4. **满足** — 同一房间的 3 位 human 与 4 位 agent 均能连接、订阅并发送；测试还断言每个参与客户端收到另一位参与者的实时消息。
5. **满足** — 本说明的「参照与偏离」逐项标明 Buzz 参照模块、TypeScript 翻译和有意偏离。

### 原语三层落地

本次覆盖 PRD 2.3 的 #1（人与 agent 共同在场的身份形态）与 #11（agent 消息作为记录的后续边界）。

| 层次 | 证据 | 状态 |
| --- | --- | --- |
| 数据层 | `Actor` 是 `HumanActor | AgentActor`：human 只有 `reachability`，agent 只有 `readiness` 与 `toolPermissions`；`Message.authorKind` 受服务端作者种类校验 | 满足 |
| 接口层 | `createMessageService` 拒绝未知作者、作者种类不符、非成员、空消息；WebSocket 返结构化错误，不让 UI 掩盖非法身份 | 满足 |
| 渲染层 | 人：圆头像 + `.message-bubble`；agent：圆角方头像 + `.message-role-rail` + 角色标签，无气泡。DOM 测试和设计稿 C-01 一一对照 | 满足 |

本任务不实现消息编辑/撤回、已读/已判定、正在输入、@ 或发言调度；这些原语各有后续任务与独立 API 契约。当前 V1 不扩展领域角色字段，agent 的可见 `displayName` 被明确翻译为角色标签及稳定色轨来源；若身份名与编制角色需要拆分，应新建领域任务而非在渲染层虚构字段。

## 3. 参照与偏离

- **参照什么** — Buzz `buzz-relay` 的 ingest / `dispatch_persistent_event`：先接受并持久化事件，再做提交后的分发；以及 `SubscriptionRegistry::register_scoped` 的“先注册未来订阅、再查历史”不丢消息顺序。
- **怎么翻译** — 将 Rust relay 的顺序约束翻译为 TypeScript `MessageService`：`await store.append()` 后构造 ACK，再通知订阅者；将 registry 顺序翻译为本地 `ws` 适配器的 `service.subscribe()` 在 `service.history()` 之前，并按 `Message.id` 去重。
- **为何偏离** — V1 是单租户本地房间，采用可重启读取的 JSONL 存储与 loopback WebSocket，而非 Buzz 的 Nostr 签名、公钥身份、多租户路由、Redis/工作流或 agent 全局队列。这些能力不是本产品当前非目标；人的圆头像/气泡和 agent 的方头像/角色色轨是本产品额外必须具备的原语分离，Buzz 不提供且不能照搬其共用参与者视觉。

## 4. 解锁了什么

为 T-0012、T-0013、T-0014、T-0037 与 T-0038 提供可持久化的消息基础、实时房间订阅和人 / agent 可区分的渲染基线；它们可以在此之上分别扩展身份/在场、@ 与任务、编辑撤回及端到端协作能力。

## 自检

- [x] 五条命令在隔离干净克隆上全过：install / typecheck / lint / test / build（35 tests）
- [x] 新增行为都有测试；无 `.skip` / `.only`；无未解释的 `@ts-expect-error`
- [x] 触及原语的三层均已对照
- [x] Buzz 参照、翻译与偏离已说明
- [x] 四段交付说明齐全
- [x] `gbp.py check --links` 零违规、零死链
- [x] 未改动自己认领任务的验收标准；蓝图写入均通过 `gbp.py`
