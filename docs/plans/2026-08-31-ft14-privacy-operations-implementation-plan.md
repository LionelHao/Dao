# FT-14 Privacy & Operations：Stage 14 implementation plan

> 日期：2026-08-31  
> 依赖：[FT-14 design](./2026-08-31-ft14-privacy-operations-design.md) 与 [Stage 14 rebaseline](./2026-08-31-stage14-notifications-privacy-operations-rebaseline.md)

## 1. TDD与ownership

feature-private security/privacy modules先RED/GREEN；主Agent串行接入shared schema/Authority/composition/WebSocket/Desktop main/preload/app。credential backend production adapter在owner批准架构前保持显式blocked，不以test backend替代。

## 2. Slice A — lease policy与keyring

- closed constants：发布配置显式default 8h（生产缺失拒绝启动）、min 5m、hard max 24h、skew 0、previous overlap 24h。
- startup/env schema验证missing/default、min/max、0/negative/NaN/Infinity/over-max、client shorter/over-max、refresh horizon。
- active/previous keyId、issuance cutoff、verification cutoff、restart recovery、exact expiry；旧key不能签发或无限验证。
- 接入AuthorityWorker issuer与Desktop verifier/composition；删除任何隐式24h fallback。

完成门：threat-policy matrix、exact expiry、key overlap/cutoff、lost device/cache/safeStorage/downgrade tests。

## 3. Slice B — Provider/credential security

- closed adapter inventory和no-retention encoder；将三生产adapter统一接`store:false`、bounded body/SSE/error sanitizer。
- disclosure revision/time只暴露public fields；noauth/ready跨restart派生并驱动availability。
- rotation metadata/audit/recovery/frozen execution binding先私有TDD；Tenant Admin ACL/Room zero-read tests。
- owner指定backend后实现production port、closed deployment management transport、rate/payload/log limits与composition；rotation crash windows/restart/rollback/forward recovery。
- secret/corpus/provider-error sentinels扫描DB/WAL/event/outbox/log/wire/diagnostics/export/build surface。

完成门：非admin/Room owner/member mutation adapter=0/DB=0；running generation不漂移；无fallback。

## 4. Slice C — diagnostics与Room export

- `privacy-operations/diagnostics` closed allowlist、determinism、checksum、filename/entry/byte bounds和canary。
- `room-export` owner/session/membership/lifecycle/access revalidation、fixed W、keyset page、streaming NDJSON、manifest/checksum/audit。
- 建real Authority read adapter覆盖message revision/recall/project/memory/attachment/governance/execution/tool/source；不把本体写event/outbox/repair。
- closed protocol/IPC：server request/status/stream capability；Desktop main native save flow；renderer无path/fs。
- race：nonowner/Tenant Admin/cross-Room 403 zero bytes、revoke midstream、archive readable、capacity、restart/temp cleanup。

完成门：diagnostics无corpus，owner export完整且不含secret，两个路径权限和字节完全分离。

## 5. Slice D — retention与worker operations

- closed retention classification和Authority janitor persistence/retry/dead-letter；context/tool existing states接入。
- startup/periodic/batch100/tail/yield/timeout/restart/archive cleanup/outcome_unknown retain/capacity。
- closed worker inventory连接现有policy/alert sinks；为notification/export/diagnostics/retention补bounded runtime。
- runbooks记录backlog/dead-letter、requeue/review、shutdown与secret/corpus-safe metrics。

完成门：无永久queued/running/spinner/tail loss/hot loop，alert无raw payload。

## 6. Slice E — Electron security

- 审计main/preload/window/attachment/renderer/CSP所有production surface。
- RED覆盖generic channel/fs/shell/URL/path/binary、senderFrame、path traversal、malicious link/MIME/malware/preview navigation/download/permission、CSP与renderer import。
- 最小修复保持closed bridge/native dialogs/sandbox preview；不放宽`verify:desktop-boundary`。
- real Electron smoke验证840×560与secure preview/save/export flow。

## 7. Slice F — shared integration/schema

- v28由FT-12拥有。FT-14追加v29仅用于不含secret/raw corpus的 retention retry/dead-letter metadata；一位owner修改schema/worker/handler/composition。
- fresh v1→final、每个history→final、v28→v29（如有）、future/unknown、checksum/fingerprint、statement fault rollback、restart/legacy importer/invariants。
- real SQLite/Authority/Desktop restart、rotation during execution、revoke during export、archive/retention/worker races。

## 8. 文档、验证与review

补`docs/protocols/privacy-operations.md`、offline lease threat model、credential rotation、diagnostics/export separation、Room export、retention、worker/dead-letter runbooks。运行FT-14 focused、credential/lease crash matrix、diagnostics/export/retention/capacity/sentinels、Electron/IPC、OpenAI opt-in live smoke和全仓门禁。

独立Sol reviewer重点检查secret ingress、rotation crash window、Tenant Admin越权、lease hard max/old key、diagnostics/raw export混淆、recall operational leak、generic IPC与历史migration。所有P0/P1及明确P2安全/正确性问题必须关闭并在最终head复审。
