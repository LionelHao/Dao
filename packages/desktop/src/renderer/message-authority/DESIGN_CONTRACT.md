# Desktop Message Authority 设计与权威映射

> 范围：FT-03 Stage 5 的 feature-local renderer view-model / component contract。这里不含 transport、WebSocket、IPC、token、SQLite、cache key 或服务端 authority；也不把 callback、fixture 或 preview 当 production E2E。与正式设计稿偏离：**无**。

## Requirement / FT / Journey / 分区

| 范围 | 权威映射 | 本切片合同 |
| --- | --- | --- |
| 消息身份与 durable commit | `REQ-ID-001`、`REQ-PRIM-006`、`REQ-MSG-001/002`、`REQ-UX-007`；FT-03/FT-13；`J-02` composer → ACK/error/retry | renderer 不选择作者。`submitting` 仅 local；匹配 requestId 的 `message.accepted` 或同 messageId stable event 才显示“消息已保存”；timeline 按 eventId/messageId 去重。 |
| structured mention | `REQ-PRIM-010/011`、`REQ-MSG-003`；FT-03/08/09；`J-02/J-03/J-04` composer mention picker | picker 使用 stable `actorId`；相同 displayName 以 kind、职责/成员标签和 actorId 区分。正文中的邮箱、代码或 `@文本` 不产生 target，绝不 regex 寻址。 |
| reply / revision / recall | `REQ-PRIM-007/008`、`REQ-MSG-004/005/006`；FT-03；`J-02` timeline/reply banner/tombstone/version | reply 固定同 Room messageId，不创建 Thread；revision event 只替换 body/version；mention、reply、attachment、target outcome 不漂移；recall event 将 operational entry 原子换为无 body tombstone。 |
| Agent final / correction / preview | `REQ-MSG-007/008`、`REQ-PRIM-012`；FT-03/08；`J-03` execution cards / timeline | Agent final/correction 只由 stable message projection出现，原 final 不变；preview 是独立点线层、`aria-live=off`、可丢弃且不进入 timeline/repair。 |
| Human Request 与 Agent intent | `REQ-PRIM-010/011`、`REQ-MSG-001`；FT-03/08/09；`J-03/J-04` target outcome | ACK 逐 target 只显示“请求意图已登记”“Agent调用意图已登记”或“目标不可用”。Request 尚未被目标接受；invocation 尚未 running/completed。 |
| execution 产品态 | `REQ-PRIM-012`、`REQ-AGT-001/002/008/010`；FT-08；`J-03` execution card | accepted/running/completed/failed/cancelled 只来自 stable event/projection。只有 completed terminal projection 显示“Agent已完成”；message ACK/intent outcome 永不推断 execution terminal。 |
| offline / repair / lifecycle | `REQ-NFR-004/007/010/011/014`；FT-02/13；`J-07` banner + old complete timeline | offline、repairing、repair-failed 和 archived 均禁写。repair staging 不可见；失败保留旧完整 projection；complete generation 才一次替换。revoke 锁定并清除可见 Room 内容。 |
| Desktop 布局与 a11y | `REQ-UX-002/003/009`；FT-11/16；正式 1440×900 与最小 840×560 | 1440 三栏下本 feature 属时间线；840 时右 panel 收入 segment，但消息、Request、execution、error/recovery 核心动作仍可见。支持规定 zoom、键盘、焦点、非颜色标记、有限通告和 reduced motion。 |

## 可见状态与 authority source

| 可见状态 | source | 禁止推断 |
| --- | --- | --- |
| draft、picker query、reply banner、submitting、preview | local transient | 不得成为作者、target outcome、消息、Request、execution 或 final。 |
| `message.accepted`、closed error | server ACK，且 requestId 必须匹配当前提交 | ACK 不代表其他设备已收到、Agent running/completed、Request accepted 或 memory 更新。 |
| message/revision/recall/final/correction、execution product state | stable event（eventId 去重） | event 不能按 displayName 合并；stale/duplicate event 不重复 timeline。 |
| timeline、reply tombstone、target outcome、execution、repair generation | canonical projection | cache/DOM 不是事实源；repair 未完成不能展示 staging。 |

ACK 与 event 允许任一先到：matching ACK 结束本地 submitting；同 messageId event 可在 ACK 丢失时收敛为 accepted-via-event；后到 ACK/event 只合并同一记录。retry 保留原 messageId、targets、UTF-16 ranges、reply、attachments 与 canonical payload，只更换 transport requestId。

## loading / empty / 错误 / 恢复

| 状态 | 表面与恢复 |
| --- | --- |
| loading / empty | 初始 loading 只用于等待已授权 projection；权威 timeline 为空时显示明确 empty，不注入样例消息。 |
| 400 | 保留草稿，聚焦 composer/entity 可修复处；不自动重发。 |
| 401 | 保留草稿但锁定 Room 内容，重新认证；认证前不闪现旧内容。 |
| 403 | 停止写入并返回 Room catalog/access 恢复；revoke 时清相应 Room cache。 |
| 404 | 定位 reply banner，移除或重新选择引用；不得泄漏跨 Room target 是否存在。 |
| 409 | revision/idempotency/recalled conflict 载入最新 projection，由 Human 决定重试或新 messageId；不 last-write-wins。 |
| 410 | `protocol_upgrade_required` 提示升级；snapshot/source gone 重新 repair 或回来源；不回退 unsafe legacy body。 |
| 429 | 保留完整 payload，遵守 retry hint 后显式重试。 |
| 503 / timeout | retryable；保留 payload 与 messageId，显式重试；callback 未抛错不算成功。 |
| offline | 只读最后完整且仍获授权的 projection；发送、编辑、撤回均零调用，无本地 queue/ACK。 |
| repair / repair failed | 旧完整 generation 可读；staging 不可见；失败提供重试且没有永久 spinner。 |

## 组件、键盘、焦点与非颜色语义

- composer：原生 textarea；`⌘/Ctrl+Enter` 只发出 local intent，host 负责 closed bridge。submitting 禁重复；失败保留输入。
- mention picker：每个选项的 accessible name 包含 Human/Agent、职责/成员标签与 stable actorId；重复名字仍独立可选。
- reply banner：显示 stable source；tombstone 只显示“引用消息已撤回”，无原文摘录。
- timeline authority rail：`LOCAL / ACK / EVT / PROJ / PREVIEW` 等宽文字 + 实线/虚线/点线，不依赖颜色。
- execution：静态图标和文字；不使用 typing 点、脉冲、旋转球。preview `aria-live=off`。
- edit/recall：只有 current viewer === active Human author 且 Room active/online 可见；Agent final、tombstone、archived/offline/repair 均无控制。
- 只有一个有限 `aria-live=polite` / `role=status`，在 submission 或 execution 产品态改变时播报短摘要；不逐 chunk/event/page播报。
- 错误渲染后焦点到错误摘要/恢复动作；关闭局部 overlay 时归还触发器。全产品 shell 继续承担 `Cmd+1/2/3`、`Cmd+K`、`Option+↑/↓` 与 Esc 的跨区焦点导航。
- 1440×900 验证 100/125/150/200%；840×560 验证 100/125/150%。允许单轴区域滚动，不裁切核心动作，不产生双轴页面滚动。
- `prefers-reduced-motion: reduce` 把 transition/animation 降至 `0.01ms`；状态识别不依赖运动。

## 后续 shared bridge / Core API 需求

FT-11/FT-13 integration owner 后续需要提供 message-specific closed bridge：

- queries：canonical Room timeline/history、message revisions、actor picker projection；
- commands：`message.send.v2`、`message.revise`、`message.recall`，controller 生成 requestId，renderer 不取得 idempotency secret/token/raw socket；
- subscriptions：stable message/execution events与 ClientSyncReplica atomic projection generation；
- correlation：ACK 回显 requestId；event 有 eventId/messageId；retry 接受原 canonical payload并产生新 requestId；
- access/lifecycle：offline/repair/archive/revoke 在 transport 前 fail closed；revoke 先锁 UI 与清 cache；
- Core 接线：本目录暂用语义等价 structural types；Core vNext 合入后由 integration owner 以窄 adapter 替换，不能在 renderer 复制 parser/authority guards。

不得用 generic IPC、generic WebSocket send、mock callback、静态 fixture、renderer local author、正文 regex 或 fake transport 宣称 production/live/E2E。
