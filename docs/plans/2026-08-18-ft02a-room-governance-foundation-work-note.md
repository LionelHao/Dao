# FT-02A Room Governance Foundation Work Note

日期：2026-08-18

范围：FT-02 的刻意限定基础切片，只交付 Room Governance 基础，不代表完整 FT-02 或 M2 verified。

## 权威映射

- Requirement：`REQ-ROOM-001`、`REQ-ROOM-002`、`REQ-ROOM-003`、`REQ-PRIM-003`、`REQ-PRIM-005`、`REQ-NFR-002`、`REQ-NFR-004`、`REQ-NFR-011`。
- Feature：FT-02A；依赖 FT-01 已交付的 Human identity/session authority。
- 设计旅程：本切片只覆盖 Settings / Governance 的最小权限投影；J-07 archive settlement、冲突清单、项目责任 UI 均不在范围内。
- 设计分区与状态：Room Settings 的 Members / Governance 只读状态；owner/admin/member 文本标签、治理 revision、可管理/不可管理非颜色提示、`aria-label` 与 `aria-live`。
- 偏离：无。未覆盖的 FT-09/FT-10/FT-13 状态没有自行补造长期产品行为。

## 权威状态来源

| 可见或可写状态 | 权威来源 |
| --- | --- |
| `projectId` | server projection，严格等于 `roomId` |
| owner / Human role | `rooms.owner_actor_id` canonical state；membership owner role由 v13 trigger 维护为只读镜像 |
| `governanceRevision` | AuthorityWorker transaction + stable `room.governance.changed` event |
| transfer / role-set success | server ACK、audit、event、outbox 同一 transaction |
| stale CAS | server 409 `room_revision_conflict`，零写 |
| leave/remove 缺责任清理 | server 503 `dependency_unavailable`；owner leave 为 409 `ownership_transfer_required` |
| archive/reopen 缺 settlement/repair | server 503 `dependency_unavailable` |
| repair | authoritative room repair projection 的 `governance` record |

Renderer 不建立权威状态；它只消费已校验的 governance + memberships projection。

## 错误、离线与可访问性边界

- loading / empty / offline / retry：沿用现有同步与 WebSocket 基础设施；本切片未新增本地 optimistic governance state。
- 401：现有 session authentication。
- 403：`room_forbidden` / `role_forbidden`。
- 409：`room_revision_conflict` / `ownership_transfer_required`。
- 410 / 429：沿用现有 snapshot/session 合同，本切片无新分支。
- 503：`dependency_unavailable` 或 storage/repair barrier。
- repair：room repair 页携带 `governance` record，`projectId === roomId`。
- 键盘与焦点：本切片 UI 无新增写操作控件；语义 section/list 可由键盘和读屏顺序访问。
- 非颜色识别：角色与“可管理/不可管理”均为显式文本和 data state。
- 通告：revision/当前角色使用 polite live region。
- 缩放/reduced motion：没有新增固定像素布局或动画。

## 实现决策

1. Room 就是 Project；未创建 `projects` table 或第二 aggregate。
2. `rooms.owner_actor_id` 是唯一 canonical owner；v13 partial unique index 与 triggers 保证 owner 角色镜像只有一个、属于同 Room Human。
3. AuthorityWorker transaction 结束前再次验证 canonical owner + role mirror；transfer 只改 canonical owner，trigger 在同一 transaction 同步角色。
4. transfer 与 role-set 使用 `expectedGovernanceRevision`；idempotency fence 在权限变化后仍允许原调用者重放同一 ACK，但首次执行仍重新校验 owner。
5. FT-09 responsibility port、FT-10 settlement、FT-13 archive repair/cache 不存在时，旧 leave/remove/archive/reopen 立即失败闭合，不执行 adapter/worker domain mutation。

## TDD 与旧测试收紧

新增 Core guard/type tests、v13 migration tests、AuthorityWorker governance transaction tests、protocol tests、Desktop projection tests。实现过程中先观察到并固定了 schema 版本、owner 投影、stale CAS、repair record 和失败闭合的红测，再完成对应最小实现。

批准 PRD 覆盖的旧宽松断言没有删除，改为更严格语义：

- legacy `human.role.change` accepted matrix 改为 CAS `room.member.role.set`；
- accepted `member.remove` matrix 改为 ownership transfer matrix；
- Agent/Human remove 成功、archive 成功、repair lease preemption 成功改为 `dependency_unavailable` + 零写 + lease/cache 保持；
- direct owner membership deletion 改为数据库拒绝；
- room audit corruption mutation改为 immutable trigger 拒绝；
- v13 直接测试夹具改为 canonical owner 初始化，不再把未绑定的 owner role 当权威。

## 明确不在范围

- FT-09 Project 对象与 responsibility cleanup port；
- FT-10 confirmation settlement、完整 archive timer；
- FT-13 加密 cache / archive repair port；
- 完整 archive、reopen、冲突清单和项目责任 Desktop UI。
