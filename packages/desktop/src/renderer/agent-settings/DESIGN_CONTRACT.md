# FT-07 Desktop Agent Settings 设计与权威映射

> 范围：FT-07 的 renderer-safe Profile / Assignment DTO、状态 reducer、Settings surface 与 FT-11 live transport seam。该 feature 不持有 token、Provider secret、SQLite、raw WebSocket、internal invocation origin 或服务端权限事实。设计偏离：**无**。

## Requirement / FT / Journey 映射

| 范围 | 权威映射 | 本组件合同 |
| --- | --- | --- |
| 两层身份 | `REQ-ID-004`、`REQ-PRIM-011`；FT-07；J-01 / Settings | Global Profile 使用稳定 `profileId/actorId` 与全局职责/上限；Room Assignment 使用独立 revision、房间职责与上限子集；改名不改变 actorId。 |
| 两条加入流程 | `REQ-PRIM-004`、`REQ-UX-005`；FT-01/02/07/11；Settings drawer | Human invitation 与 Agent assignment 使用两个带文字标题的 section；Agent 不获得 Human invitation token。 |
| participation / availability | `REQ-PRIM-013`、`REQ-AGT-003`、`REQ-AGT-004`；J-03 | participation 只允许 `active/on-mention`；availability 只读 `ready/busy/paused/noauth`，同时显示 glyph、英文状态与解释；不存在 `silent`。 |
| 权限主体 | `REQ-ID-004`、`REQ-UX-005`；FT-01/02/07 | Tenant Administrator 才可修改 Profile，但不会因此获得 Room role/read；Room owner/admin 才可修改 Assignment；member 只读。 |
| 工具 / capability | `REQ-AGT-003`、`REQ-AGT-004`；J-05 / Settings | 展示 Profile ceiling、Assignment subset 与 effective subset；guard 拒绝越界、重复、乱序和未知 ID。on-mention 的 direct invocation 不缩减 Assignment 内有效权限。 |
| Provider 披露 | `REQ-NFR-006`；J-01 invitation disclosure / Settings | 只读显示单 Provider、单模型、credential readiness 与 retention-disabled；无选择器、无客户端 key 字段、无 fallback。 |
| 稳定收敛 | `REQ-UX-005`、`REQ-NFR-002`、`REQ-NFR-010`；J-01/J-03/J-07 | local submit 只进入 `submitting`；匹配 ACK 只进入 `acknowledged`；匹配 stable event 才更新 Profile/Assignment 并进入 `succeeded`。同步 callback 不产生成功事实。 |
| 恢复 | `REQ-NFR-003/004/007/008/011`；FT-13；J-07 | offline、repairing、repair-failed 保留上一份完整授权 projection 且写锁定；repair completed 在固定 watermark 原子替换；revoked 立即清 Profile/Assignment。 |
| 可访问性 | `REQ-UX-009`；FT-16 | native label/input/select/button；唯一克制 `aria-live=polite`；错误摘要/撤权恢复可聚焦；状态不只靠颜色；840×560 重排、桌面 200% zoom、可见 focus ring、reduced motion。 |

## 可见状态与 authority source

| 可见状态 | authority source | 禁止推断 |
| --- | --- | --- |
| 表单输入、selection、`submitting` | local transient | 不改变 Profile/Assignment revision、availability、membership 或 Provider readiness。 |
| `acknowledged` / closed error | server ACK/error，匹配 `requestId + command` | ACK 不代表 stable event 已应用；error 不清除稳定表单值。 |
| Profile/Assignment 改名、职责、participation、pause/remove | stable event，按 `eventId/cursor` 去重 | displayName 不作路由 ID；迟到/重复 event 不倒退 projection。 |
| loading / empty / room lifecycle / availability / Provider/model | atomic snapshot projection | 不用本地 callback、静态 catalog 或旧 actor readiness 伪造事实。 |
| offline / repair / revoked | connection/repair/access projection | repair staging 不展示；revoked 后不显示 Room 名称、Profile 或 Assignment。 |

## 错误与恢复闭集

| 状态 | 显示与恢复 |
| --- | --- |
| 400 | 保留输入并聚焦错误摘要；修正 malformed/unknown-field/subset 输入。 |
| 401 | 锁定未授权内容；重新认证。 |
| 403 | 说明 Profile/Room 角色边界；查看权限；access revoke 时清缓存。 |
| 409 | 保留输入，载入最新 Profile/Assignment/Room revision 后由 Human 复核再提交。 |
| 410 | 资源或 snapshot 已失效；刷新权威状态/重新 repair。 |
| 429 | 保留输入，按 server hint 有界冷却后显式重试。 |
| 503 | 保留上一份完整 projection 与输入；显式重试，不自动换 Provider/model。 |
| offline | 有效 lease 下只读完整 cache；mutation 在 bridge 前零调用，不进入离线队列。 |
| repair / repair failed | 旧 generation 保持只读；成功后一次原子 flip；失败提供明确重试。 |
| archived | Room 业务只读；只展示 Assignment pause/remove 等安全缩减，不允许 create/resume/扩大。 |

## FT-11 production adapter seam

`AgentSettingsBridge` 只允许 `getSnapshot({roomId})`、`submit({requestId,intent})`、`onAuthorityMessage(listener)`。main/preload 集成必须：

- 在受信主 frame 内生成 requestId/idempotency key；idempotency key 不返回 renderer；
- 对参数与返回 DTO 调用本 feature 的 exact guards，拒绝 symbol/unknown key、`silent`、availability/provider/model/internal origin 注入；
- 订阅 Authority stable event 与 FT-13 repair/access 消息；renderer reducer 不连接 raw socket；
- offline/repair/revoked 在 transport 前 fail closed；unsubscribe/shutdown 有界；
- 关闭 drawer 后由 FT-11 host 将焦点归还「Room 设置」触发器，并在 drawer 内实现 Tab 圈定/Esc 关闭；Esc 不可绕过另行确认的 destructive dialog。
