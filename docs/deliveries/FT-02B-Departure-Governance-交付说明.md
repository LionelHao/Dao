# FT-02B Departure Governance 交付说明

> 日期：2026-08-19
> 状态：交付条件已满足，等待 owner 验收；不宣布 FT-02 或 Blueprint verified。

## 1. 结果

FT-02B 已把 Human self-leave、owner/admin 受限 remove、ownership-transfer-before-leave、只读 conflict preflight、同 transaction final responsibility recheck、原子 membership/access/audit/event/outbox/receipt 与 Desktop conflict/recovery 闭合到真实 AuthorityWorker/SQLite 路径。

## 2. 服务端合同

- `room.departure.conflicts` 是授权只读查询，不创建 mutation receipt。
- `room.member.leave` 与 `room.member.remove` 必须带 non-negative `expectedGovernanceRevision`；remove target 由 closed `targetActorId` 表达，caller identity/role/principal/session family 均由 server session 派生。
- coordinator 在 branded Authority transaction 内做 reauth、current Human membership、role/owner mirror、lifecycle/CAS 检查；final collect 紧邻同步 commit callback。
- responsibility 只通过 production `DepartureResponsibilityPort` aggregate 收集；不复制 FT-09/FT-10 SQL/reducer。missing/throw/malformed/cross-room contributor 统一安全 503、零写。
- 非空 conflict 返回最新 409 `departure_blocked` closed details；不会泄露 message body、tool params、grant/token、path、SQL、stack 或 provider body。
- success 原子执行 Human membership delete、governance revision CAS、truthful left/removed audit、governance/access stable events、outbox、target access epoch/invalidation 与 idempotency receipt；commit 后只 preempt target subscription/repair/cache。

## 3. 权限矩阵

| Caller / target | 结果 |
| --- | --- |
| member self-leave | 允许；fresh command 需 final responsibility empty |
| owner self-leave | 未 transfer 时 409 `ownership_transfer_required` |
| owner remove admin/member | 允许；仍需 final responsibility/CAS/access reduction |
| admin remove ordinary member | 允许 |
| admin remove owner/peer admin | 403，零写 |
| member govern another actor | 403，零写 |
| Agent issue Room governance command | 拒绝 |
| revoked/expired session | transaction reauth 后 401/403，零写 |
| archived Room safety-reducing Human leave/remove | 允许；不唤醒业务 worker |

Agent removal 继续使用既有合法治理路径，没有扩张 FT-02B 产品语义。

## 4. 幂等、CAS 与 race

- exact same scope/key/payload 在 self-leave 后仍从 durable receipt 返回原 ACK/event IDs；changed payload 冲突。
- two distinct-key remove 由 single writer + governance CAS 收敛为一胜一 stale/absent；不会重复 audit/outbox。
- preflight empty 后新增责任，final collect 返回最新 409 且 membership/audit/event/outbox/receipt 全零写。
- owner transfer vs leave、admin remove vs owner promote、session revoke vs mutation、ACK loss/restart 都由 transaction-local recheck/CAS/receipt 收敛。

## 5. Desktop

- Settings → Governance 显示 owner/admin/member 文本身份；transfer picker 只列 current Human member。
- leave/remove 先显示 preflight，grouped conflict sheet 支持 source/action；final 409 替换旧列表。
- submitting、acknowledged、succeeded、failed 分离；只有 ACK 加 matching stable event/projection 或 authoritative repair 才成功。
- 401/403/404/409/410/429/503、offline、repair-failed、revoked 都有 closed 状态；keyboard、focus return、non-colour 与 `aria-live` 已覆盖。

## 6. 证据

- coordinator focused：17/17；与真实 aggregate/FT-10 contributor 相邻 suite 共 4 files / 36 tests。
- protocol/contracts/WebSocket RED 先出现 21 failures/226 existing pass；GREEN 为 247/247。
- real process suite 18/18，含三客户端、CAS race、remove、crash-before-commit、commit-before-ACK 与 exact restart replay。
- 最终全仓：Test Files 84 passed / 2 skipped / 0 failed（86）；Tests 1234 passed / 2 skipped / 0 failed（1236）。
- 代码经 [PR #38](https://github.com/LionelHao/Dao/pull/38)、[#39](https://github.com/LionelHao/Dao/pull/39)、[#40](https://github.com/LionelHao/Dao/pull/40) 依赖顺序 squash merge；双版本 GitHub quality checks 全部 success。

## 7. 风险与建议 reviewer

- 建议 FT-09/FT-10 reviewer 复核 conflict source/safe summary/resolution 闭合与 final collect 相邻性。
- 建议 identity/access reviewer 复核 target-only access epoch、offline issuance revoke 与 remove→re-add→remove future schema 边界。
- 本文不把 owner transfer、责任对象或 Agent remove 的 owning FT 重新实现为 FT-02B 私有状态机。
