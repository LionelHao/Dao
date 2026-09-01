# Room data export 运行手册（FT-14）

> 直接 Requirement：`REQ-MSG-006`、`REQ-MSG-010`、`REQ-NFR-012`、`REQ-NFR-013`

## 1. 启动条件

只有 authenticated Human 且当前为目标 Room 的唯一 owner 可以发起。Room admin/member、Agent、未加入 Room 的 Tenant Administrator 均为拒绝。active 与 archived Room 均可读出既有权威历史；archive 不是 delete，也不会扩大权限。

服务端最终事实必须同时满足：session active、actor kind Human、tenant/Room match、membership owner、lifecycle 为 active/archived、access revision 未变化、export policy enabled。客户端自报 role、tenant、watermark、access revision 或 filesystem path 均不可信。

## 2. 数据范围

固定 watermark 内的 closed category：

- current/historical message 与 revision chain；
- tombstone/recall audit，以及 owner-authorized recalled original；
- Goal、Decision、Request、NextAction、Blocker、Ball；
- memory、source/version/provenance；
- attachment inventory/hash/MIME/size/source，不含未授权任意 host file；
- membership/governance audit；
- Agent execution/tool review metadata；
- source links/version。

禁止 Provider credential、session/password/token、hidden reasoning、HTTP header、encryption key、cache/DB path、unrelated Room、其他 tenant/account 数据。Provider raw request/response 本就不得持久化，因此也不可能成为 export source。

## 3. 操作步骤

1. owner 在 Room Settings 发起，确认导出范围和本地保存风险；renderer只发 domain intent。
2. server authorize 后固定 watermark并返回 export job/stream capability；非 owner必须在0 bytes时失败。
3. 每页最多256 records；每record最多1 MiB；累计最多1,000,000 records/2 GiB。每页使用keyset cursor，不使用unbounded OFFSET或全Room内存数组。
4. page前和complete前重验session/owner/lifecycle/access revision/export policy。撤权、ownership transfer、session revoke或policy change立即终止。
5. 每条trusted row验证tenantId/roomId/watermark scope；cross-scope是terminal security failure，不能丢弃后继续。
6. 完成时校验manifest、category counts、content digest与manifest digest；服务端写secret-free audit。
7. main process使用native save dialog选择目标。renderer不得提供path，preload不得暴露generic fs/shell。
8. 保存成功后删除server temp；失败/取消也进入≤1h cleanup。

## 4. 恢复与支持

- stream中断：旧capability不自动恢复；重新鉴权并创建新export，避免把变化后的权限拼进旧watermark。
- ownership/access变更：停止；新owner需显式创建新export。
- checksum mismatch：丢弃本地临时文件，不打开；用新exportId重试并调查storage/transport。
- capacity failure：保持closed失败；需要产品批准的分片策略，不能扩大内存或hard bound。
- temp cleanup dead-letter：按worker runbook人工review/requeue；告警只含opaque exportId/age/attempt/state。

## 5. 验收证据

必须覆盖non-owner/Tenant Admin/cross-Room零读取、fixed watermark、revoke mid-page/complete、checksum、capacity、restart/temp cleanup、recall原文仅授权export可见、secret sentinel，以及Desktop arbitrary path/channel/fs拒绝。当前本地候选已接入AuthorityWorker、closed WebSocket、同认证session和Desktop native save，并覆盖v1/legacy fixed-watermark兼容、非协作iterator取消与真实producer；仍需在credential backend阻塞解除后随最终Stage 14 head重新审阅，并取得内容PR/required CI/merge证据。
