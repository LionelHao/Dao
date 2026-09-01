# Diagnostics 与 Room data export 隔离运行手册（FT-14）

> 日期：2026-08-31  
> 直接 Requirement：`REQ-NFR-009`、`REQ-NFR-012`、`REQ-NFR-013`  
> 状态：安全合同与 feature-private adapter 已实现；AuthorityWorker、协议和 Desktop native save 的共享接入由 Stage 14 主集成完成。

## 1. 两条路径不是同一种“导出”

| 边界 | Diagnostics | Owner Room data export |
| --- | --- | --- |
| 用途 | 定位 schema、worker、queue、repair、配置能力和 closed error class | 由当前 Room owner 取回该 Room 的权威内容与审计 |
| principal | deployment operations principal；当前 closed adapter 只接受 authenticated Tenant Administrator | authenticated Human + 当前 Room membership `owner` |
| Room 权限 | 不接受 `roomId`，不调用 Room corpus reader | 必须指定单一 Room，逐页与 complete 重验 owner/session/access/lifecycle/policy |
| 原文 | 永不包含 | 仅包含该 Room 中 PRD 批准的正文、版本、recall audit/original 等类别 |
| secret | 永不包含 | 永不包含 |
| 输出 | ≤10,000 entries、≤1 MiB、deterministic NDJSON + SHA-256 | fixed watermark、≤256 records/page、≤1 MiB/record、≤1M records/2 GiB、streaming NDJSON + manifest/checksum |
| retention | server artifact 最多 24h | server temp artifact 最多 1h；native save 后副本由 owner 管理 |

Tenant Administrator 不是 Room role。即使其可以生成无 corpus 的 diagnostics，也不能因此 history、sync、context 或 export 任一 Room。Room owner 也不会因 owner 身份自动得到 diagnostics 中的部署能力信息。

## 2. Diagnostics 生成流程

1. 从 authenticated session 推导 Tenant Administrator；请求只允许 `actorId/sessionFamilyId` 的 server-internal binding，拒绝 `roomId` 和额外字段。
2. 只从 closed operations source 读取 allowlisted entries，最多 10,000 条。
3. 在 artifact sink 之前完成 category、field、opaque token、finite number、entry count、总 bytes 与 corpus/secret canary 检查。
4. 生成 deterministic canonical NDJSON、safe filename、category list、entry count、byte length 与 SHA-256。
5. 用 atomic artifact sink 发布完整 bytes；禁止 partial file 被下载。
6. success audit 只含 actor/time/artifact opaque ID/count/bytes/digest；failure audit 只含 closed classification，不含异常正文。
7. retention janitor 在 24h exact boundary 后清理 server artifact；archive 不冻结该清理。

任一 authorize/source/guard/sink 失败不得产生可下载 artifact。不得为了“方便排障”添加 message、prompt、Provider body/header、tool raw、attachment text、stack、DB/cache path、token/secret 等字段。

## 3. Room export 流程

1. `authorize` 重验 active Human session、同 tenant、当前 membership owner、Room active/archived、access revision 与 export policy；非 owner 在第一个 byte 前失败。
2. AuthorityWorker 固定 watermark，创建 opaque export ID；不把 raw export 写入 event/outbox/repair/log。
3. 每页前重新读取 session 与 Room access；任何 role、lifecycle、access revision 或 policy 变化终止流。
4. projection adapter 绑定 tenantId/roomId/accessRevision/watermark；返回行仍逐条验证 tenant/Room binding，再移除内部 scope 字段后编码。
5. complete 前最后复核权限；最终 manifest 记录 count/category/content digest，success audit 只记 requester/Room/watermark/manifest digest/time/result。
6. Desktop renderer 只提交 domain intent和接收进度；保存路径只能由 main process native save dialog 决定。renderer 不得提交 path 或获得 generic fs/shell/channel/binary API。

## 4. 事件响应

- `forbidden`：确认 session、owner membership、Room lifecycle/access revision；不得用 Tenant Administrator 或 admin role绕过。
- `access_revoked`：立即停止后续 page/complete；删除未完成 server temp，不尝试在旧 watermark 上继续。
- `invalid_authority_record` / cross-scope：按安全事件处理，停止输出并检查 projection query 的 tenant/room predicate；不得过滤后继续。
- `capacity_exceeded`：保持失败可见；不要提高 hard bound绕过，应使用分页/分片产品决策。
- `storage_unavailable`：不把 bytes 回落到日志、event 或 renderer memory；修复临时存储后用新 exportId重启。
- canary 命中：隔离 artifact、停止下载、记录 closed classification；禁止在告警中复制 canary正文。

## 5. 发布检查

- diagnostics request schema没有 `roomId`，source port没有 Room corpus方法；
- diagnostics/Room export 使用不同 authority、artifact、audit和retention路径；
- non-owner、Tenant Administrator without membership、cross-Room 请求在读取 adapter前为0；
- recalled raw 仅在 owner-authorized export/audit边界，Provider/context/diagnostics为0；
- secret/corpus sentinel 扫描 artifact、audit、log、event、outbox、repair、wire 和 Desktop；
- shared production composition、closed protocol、native save和真实 restart/revoke测试完成前，不得把 feature-private adapter 宣称为端到端交付。
