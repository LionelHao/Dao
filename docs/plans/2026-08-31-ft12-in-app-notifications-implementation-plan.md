# FT-12 In-app Notifications：Stage 14 implementation plan

> 日期：2026-08-31  
> 依赖：[FT-12 design](./2026-08-31-ft12-in-app-notifications-design.md)、产品 PRD、
> `docs/protocols/` 与 `docs/design/README.md` 当前正式审阅稿

## 1. TDD 与文件 ownership

每个切片执行 RED → 最小 GREEN → focused regression → shared integration。feature Agent只改私有模块；主集成 owner串行修改 schema v28、AuthorityWorker/handler、protocol/WebSocket、repair assembly、Desktop main/preload/app shell和 delivery。

## 2. Slice 1 — Core closed contracts

- 在 `packages/core/src/notification.ts` 定义 closed kinds、fact/projection/event/repair record/read ACK/guards、canonical dedupe与 source/deep-link安全字段。
- type/runtime tests 拒绝 arbitrary kind、extra field、raw正文/HTML、invalid revision/time/hash、`sourceAccessible:false` 携带 metadata。
- package root仅导出 safe domain types，不导出 server authority/test fixtures。

完成门：八类 kind、七类 source、read/handled独立轴与 revoked minimal event都有 closed guard。

## 3. Slice 2 — Producer/domain/private SQLite helpers

- `packages/server/src/notifications/` 定义 recipient resolver ports、producer matrix、canonical dedupe、source handled projection、archive/revoke规则与 feature-private repository。
- RED：每 producer exactly-once、错误 recipient、transfer/handoff/new execution lineage、archive/reopen、recall/revoke、due ordinal与 cannot_answer。
- SQLite helper先使用私有 fixture schema证明 unique constraint、read CAS、source handled projection与10k keyset list；不改 shared schema。

完成门：服务端从 authority source计算 recipient；客户端输入无法覆盖。

## 4. Slice 3 — schema v28 与 Authority transaction

- append immutable v28 `in-app-notifications`；不改 v1-v27 checksum/fingerprint。
- fresh v1→v28、每个历史版本→v28、future/unknown refusal、每 statement fault rollback、reopen/legacy importer/invariants。
- 增 AuthorityWorker closed operations：create-from-trusted-source、recipient list、mark-read、project handled/revoke；fact/event/outbox/receipt同 transaction。
- producer adapters连接 message/project/tool/runtime stable transactions或 post-commit durable jobs；不允许 callback-only success。

完成门：crash points、ACK loss、at-least-once、business unique constraint与拒绝零写入。

## 5. Slice 4 — protocol / WebSocket / repair

- closed list/query、mark-read、source resolve frames；requestId ACK，closed error/retryAfter。
- parse拒绝 recipient/actor/handled/arbitrary source；WebSocket从 authenticated principal注入。
- `RoomRepairRecord`/kind map/guard/descriptor加入 `notification`，registry 34 kinds恰好一一对应；materialized/streaming parity、canonical bytes/order/checksum更新。
- page/complete recipient filter与 session/membership/revision/generation revalidation；multi-page revoke抢占。

完成门：同 Room peer、non-member Tenant Administrator、旧 session均零泄漏。

## 6. Slice 5 — Desktop replica、J-07 与 shell

- feature-private `notification-center` contracts/replica/view-model/surface先完成状态与a11y tests。
- 接入 `ClientSyncReplica`/encrypted generation：event+ledger+cursor transaction、repair staging/flip、revoked purge。
- closed main/preload domain bridge；无 generic channel/token/fs/shell/URL/binary。
- app shell接 flat center、Room badge、deep link，center/badge只消费同 projection。
- 覆盖 loading/empty/unread/read-unhandled/handled/offline/repairing/repair-failed/revoked/archived/recalled/inaccessible、401/403/409/410/429/503/retry/overflow/bounded list。

完成门：两 session stable event与断线 repair收敛，offline mark-read transport=0，840×560/zoom/keyboard/focus/VoiceOver/reduced-motion通过。

## 7. Slice 6 — producers、restart 与 capacity

- 将 mention/Request/confirmation/due/tool result/execution completed/failed/cannot_answer逐个接线；每项有 source revision/boundary/ordinal。
- due：边界立即一次，仍未解决每24h新 ordinal；处理/transfer/defer停止；archive冻结；reopen不重放旧 boundary。
- real AuthorityWorker/file SQLite/server restart、three-client/Desktop restart、clear-cache、repair、revoke/archive race。
- 10k notification、多 Room flat list、badge overflow与 bounded worker/dead-letter capacity。

## 8. 验证与交付

运行 FT-12 focused、schema、repair parity、multi-session/restart、10k capacity、Desktop J-07/a11y、Electron smoke及全仓 typecheck/lint/test/build/boundary/diff。交付说明逐条映射5条 Requirement、producer/read-handled matrix、repair/recipient过滤、J-07、无OS push/五分区、精确计数与 reviewer结论。
