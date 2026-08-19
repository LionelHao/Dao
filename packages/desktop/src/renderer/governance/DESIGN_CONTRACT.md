# Desktop Governance 设计与权威映射

> 范围：FT-02B departure governance、FT-02C archive/reopen 的 feature-local renderer contract。这里没有 transport、token、raw WebSocket、cache key 或 server authority；`app.ts`、`main.ts`、`preload.ts`、`ClientSyncReplica` 均未接线。偏离：**无**。

## Requirement / FT / Journey / 分区映射

| 范围 | 权威映射 | 本组件合同 |
| --- | --- | --- |
| Room / Project 边界 | `REQ-ROOM-001`、`REQ-PRIM-003`；FT-02/FT-11 | `projectId === roomId`；Room list、治理、历史、项目事实必须来自同一 projection。 |
| 角色与唯一 owner | `REQ-ROOM-002`、`REQ-PRIM-005`、`REQ-UX-005`；FT-02B/FT-16；Settings drawer / Governance | owner/admin/member 使用文本标签；owner 管理 admin/member/普通 Agent；admin 只能管理 member/普通 Agent，不能管理 owner/peer admin；member 治理区只读。 |
| 离群责任门 | `REQ-ROOM-003`、`REQ-ID-005`；FT-02B/FT-09 seam；正式设计 J-04 的 Request 接受/转交语义、Settings 的 Departure conflict sheet | preflight 仅用于展示；final `409 departure_blocked` 必须替换陈旧清单。分组覆盖 Request、NextAction、Blocker/OpenQuestion、pending acceptance、pending verification、pending confirmation，只显示安全 summary/source 与 server-supplied closed resolution。 |
| archive / reopen | `REQ-ROOM-004`、`REQ-NFR-012`、`REQ-NFR-014`、`REQ-PRIM-005`；FT-02C；PRD J-07、状态分支「归档 Room」 | archive 有明确确认；archived banner 持续显示 archive time；history/attachment/project fact/audit 可读；composer/project mutation/Agent 业务控制禁用并解释；owner/admin 可重开。 |
| Room list 与启动 | `REQ-UX-003`、`REQ-UX-006`、`REQ-ID-003`、`REQ-ID-005`；FT-11 narrow seam / FT-13；正式设计 J-01 | active/archived catalog 状态来自 projection；启动、撤权、fatal 前不显示未授权 Room。此 feature-local 组件只定义 selected Room 的治理表面，Room list 仍由 FT-11 集成 owner 负责。 |
| 异步权威收敛 | `REQ-UX-007`、`REQ-NFR-002`、`REQ-NFR-010`；FT-02B/02C/11/13 | local 只可产生 dialog、输入、选择和 `submitting`；匹配 requestId 的 ACK 进入 acknowledged；stable event / projection 才改变 role、revision、membership、active/archived。callback 返回不代表成功。 |
| offline / repair / revoke | `REQ-NFR-003`、`REQ-NFR-004`、`REQ-NFR-007`、`REQ-NFR-008`、`REQ-NFR-011`；FT-13；正式设计 J-07 | offline 与 repair 只读旧完整 projection、mutation 为零调用；repair failed 保留旧 generation并提供重试；revoked 立即锁 UI、清 cache 后不显示 Room 名称或内容。 |
| Desktop 安全 | `REQ-NFR-001`、`REQ-NFR-013`；FT-11/FT-13 | renderer 只消费 closed projection/connection/operation DTO；不接触 token、SQLite、cache key、lease signing material、Node API、generic channel 或 raw socket。 |
| 可访问性 | `REQ-UX-009`；FT-16；J-01/J-04/J-07 与 FT-16 验证矩阵 | native button/label；dialog focus trap/close return；Esc 不绕过 archive confirmation；角色/状态/错误不只靠颜色；单一有限 `aria-live`; 1440×900 100/125/150/200%，840×560 100/125/150%；reduced motion 无位移动画。 |

## 可见状态与 authority source

| 可见状态 | source | 不允许的推断 |
| --- | --- | --- |
| picker、dialog、选择、输入、submitting | local transient | 不改变 member、role、conflict 终态或 lifecycle。 |
| accepted / closed error | server ACK，必须匹配当前 requestId / command | ACK 不等于所有客户端已收敛，也不允许提前移除 member 或切换 active/archived。 |
| membership / lifecycle transition | stable event，按 eventId/stream sequence 去重 | 重复或迟到 event 不重复 banner、purge 或重开。 |
| 最终 owner/role/revision/lifecycle/archive time/repair generation | projection / atomic cache generation | repair 未 complete 前不展示半个新 generation；cache 不是事实源。 |

## 错误与恢复

| 状态 | 表面与恢复 |
| --- | --- |
| 401 | 内容不闪现；重新认证。 |
| 403 | 解释权限；若是 revoke，锁定并按 scope 清 cache。 |
| 404 | member/Room 已不存在；刷新 catalog/governance projection。 |
| 409 | departure 使用 final conflict list 替换 preflight；revision conflict 载入最新版本；不静默成功。 |
| 410 | snapshot 已过期；重新开始完整 repair，旧完整且仍获授权的 cache 只读。 |
| 429 | 保留输入；按 server hint 有界冷却后显式重试。 |
| 503 | 保留旧完整 view 与输入；明确 dependency/service unavailable 后显式重试。 |
| offline | 只读有效 lease 下的完整 cache；所有 mutation 零调用、无 outbox、无 local ACK。 |
| repair / repair failed | staging 不可见；成功后一次 atomic flip；失败保留旧 generation并提供明确重试。 |

## 后续 shared bridge / API 需求

后续 FT-11/FT-13 integration owner 需要提供 domain-specific、exact DTO 的窄 bridge：

- queries：`governance.get`、`departure.conflicts`；
- commands：`ownership.transfer`、`member.leave`、`member.remove`、`room.archive`、`room.reopen`，全部由 controller 生成有界 requestId/idempotency key，并携带 `expectedGovernanceRevision`；
- subscriptions：closed governance/lifecycle projection 与 repair/access state；
- correlation：ACK/error 必须带 requestId；stable event/replica projection需要能与 causation request 关联，同时仍接受其他客户端产生的权威更新；
- lifecycle no-op：`already_archived` / `already_active` 是成功结果而非 409 错误；ACK 必须携带当前 governance projection（或触发有界 authority refresh），避免等待一个不会产生的重复 event；
- revoke ordering：先锁 renderer、清 Room/account cache，再允许任何恢复；
- shutdown/reconnect：subscription 可取消且有界；重连先 auth/catalog/access recheck，再 sync/repair；offline mutation 在 transport 前 fail closed。

不得用 mock callback、generic IPC、generic WebSocket send、token 透传或 renderer local lifecycle 来满足这些 seam。
