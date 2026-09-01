# Production Provider No-retention 与披露清单（FT-14）

> 直接 Requirement：`REQ-MEM-010`、`REQ-MEM-012`、`REQ-NFR-006`、`REQ-NFR-009`  
> 本清单是当前生产 adapter 的 closed inventory；新增 adapter 若未登记并通过同等 no-retention gate，必须拒绝 production readiness。

## 1. Closed inventory

| adapter | 生产路径 | authority input | request bound | response bound | retention / fallback |
| --- | --- | --- | ---: | ---: | --- |
| `openai-responses` | `packages/server/src/agent-runtime/openai-responses-provider.ts` | frozen compiled snapshot；trusted system/developer、必要 untrusted group blocks、闭合 tool continuation | 256 KiB hard，且受 snapshot `maxInputBytes` 更短边界 | 256 KiB hard，且受 execution `maxOutputBytes` | `store:false`；固定 startup model；无 Provider/model fallback |
| `openai-router` | `packages/server/src/route-runtime/openai-router-provider.ts` | summary-only route input；不含 visible conversation corpus | 128 KiB | 64 KiB | `store:false`；固定 startup model；无 fallback |
| `openai-memory-steward` | `packages/server/src/room-memory/openai-memory-provider.ts` | 当前 eligible frozen sources；网络前和结果后重验 source | 384 KiB | 64 KiB | `store:false`；固定 startup model；无 fallback |

机器可枚举 inventory 与 runtime encoder 位于
`packages/server/src/privacy-operations/provider-security-policy.ts`。三个 adapter 都通过同一 encoder 强制：model 必须等于 startup fixed model、`store` 必须精确为 `false`、body 必须是 finite/bounded JSON、禁止 credential/header/secret/previous response/prompt cache/hidden reasoning 等字段。任何 guard failure 在 fetch 前闭合失败。

## 2. 请求最小化与 corpus 边界

- Agent runtime 只接受 `compiled-context-envelope.v1`；snapshot 绑定 model、manifest、compiler/config version、source revision 与预算，不存在 legacy 最近 64 条生产 fallback；
- Router 只发送 summary/candidate facts，不发送 Room visible conversation、attachment正文或任意历史 corpus；
- Memory steward 只发送当前 batch 内、network 前重验仍 eligible 的 frozen source；输出后再次重验所有 referenced source；recalled/disputed/revoked source不能提交；
- Provider credential 只进入 HTTP `Authorization` header，不进入 JSON body；endpoint 必须是无 userinfo/hash 的 HTTPS URL；
- 没有第二 Provider、自动换模型、BYOK、客户端 provider/model 选择或 fake production adapter。

## 3. Response / error / shutdown 边界

- Agent SSE buffer 默认 256 KiB，允许范围 1 KiB–1 MiB；execution output 另受 256 KiB hard bound；未完成/拒绝 response body 会 cancel；
- Router JSON body streaming read 至 64 KiB，UTF-8/shape/closed plan 校验；Provider错误只按 status 分类，不回显 body/header；
- Memory response streaming read 至 64 KiB，duplicate-key/UTF-8/closed schema/source/provenance 校验；`reasoning` transport item不进入 plan、event、日志或持久化；
- timeout/abort/network/HTTP error 均映射 closed code；错误对象不携带 raw Provider body/header/secret；
- shutdown/cancel 使用 bounded AbortSignal/reader release，不把 partial body 记入 authority/event/outbox/repair。

## 4. Room 用户披露

批准 disclosure 是：`providerId=openai-responses`、固定 `modelId`、`ready|noauth`、`retentionDisabled=true`、`selectionPolicy=server-managed-single`，以及同一披露事实的 revision/time。禁止字段：credential generation、key version、secret、长度/hash/前后缀、endpoint token、backend/path、HTTP header。

`createProviderSecurityDisclosure` 已提供闭合私有 DTO；当前共享 Tenant Administration public DTO 仍只有 provider/model/readiness，Desktop 又本地补 `retentionDisabled=true`。shared integration owner 需把 revision/time 与 retention-disabled 作为服务端权威 disclosure 接入，不能由 renderer 静态伪造；此接入不得暴露 generation/keyVersion。

## 5. Sentinel 与变更门

- `provider-security-policy.test.ts`：closed inventory、`store:false`、fixed model、forbidden fields、finite/bounded body、safe disclosure；
- 三个 adapter focused tests：secret 只在 authorization header、JSON body 不含 secret、missing secret zero fetch、Provider error body/header不回显、bounds/cancel/closed output；
- `agent-runtime/secret-sentinel.test.ts`：真实 SQLite/WAL、event/message/wire/error/diagnostic 与 Provider body扫描；
- `room-memory/secret-sentinel.test.ts`：raw message/attachment、Provider body/header、hidden reasoning、secret 在 memory/outbox/repair/diagnostics中零命中；recalled raw只保留在获授权 authority audit/export边界。

新增或修改 adapter 必须同时更新 machine inventory、runtime encoder、本文、secret/corpus/error-body sentinel 与 production composition；不支持可审计 no-retention 的 adapter readiness 必须 fail closed。

