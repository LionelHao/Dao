# T-0041 · 真实 Agent 运行时、模型供应商与工具权限 · 交付说明

状态：已达到交付条件、等待 owner 验收；未标记 verified，未 commit、push 或创建 PR。

## 1. 一句话结果

server 生产 composition root 已无条件装配有界 `AgentRuntimeService`、真实 OpenAI Responses 流式 Provider、三个受限生产 Tool Adapter 与 AuthorityWorker 单 writer 权威状态机；schema v6、WebSocket/sync、桌面呈现、恢复、安全哨兵和 opt-in live smoke 证据已完成。

## 2. 七条验收标准映射

### 标准 1 · 真实生产 Provider

- 生产代码：`packages/server/src/agent-runtime/openai-responses-provider.ts` 使用原生 `fetch` 调用 Responses API，固定 `stream: true`、`store: false`，使用 `AbortSignal` 和闭合 SSE parser；`environment-secret-provider.ts` 是 server-side secret 唯一入口。
- composition：`packages/server/src/authoritative-server.ts` 始终选择真实 Provider；缺少 `OPENAI_API_KEY` 时 runtime readiness 为 `noauth`，invoke 返回闭合 `agent_configuration_missing`，不存在固定回复或 mock fallback。
- 自动化：`openai-responses-provider.test.ts`、`sse-parser.test.ts`、`agent-runtime-service.test.ts` 覆盖流、分块、闭合事件序列、错误、超时、取消、`store:false` 与无认证；`openai-responses-provider.live.test.ts` 是 opt-in live smoke。

### 标准 2 · 物理不同工具与每次调用复核

- 生产代码：`http-json.read` 是固定 HTTPS origin/path 的 JSON adapter；`repository.git-status` 是固定 `/usr/bin/git`、固定 repository root 与固定 argv 的 child-process adapter；`sandbox-file.write` 是根目录内原子写 adapter。没有通用 shell、任意 binary/argv、任意 URL/cwd 或任意文件写入口。
- 权威门禁：`authority-database-handler.ts` 在 prepare 和 dispatch 前同时复核 Agent actor capability/readiness、活跃 room/agent membership、membership tool permission、execution/attempt/grant/tool/参数 hash/expiry；`tool-gateway.ts` 只在 AuthorityWorker 成功 claim 后调用 adapter。
- 自动化：`tool-gateway.test.ts` 的拒绝矩阵断言所有失败路径 adapter call count 为 0；`tool-adapters.test.ts` 命中 HTTPS JSON、真实 Git binary、真实 sandbox filesystem；`worker-runtime-authority.test.ts` 使用两个不同 Agent 命中 Git 与 sandbox 两个物理目标并验证撤权后 adapter 0 次调用。

### 标准 3 · 权威执行状态与桌面分离

- schema v6 权威持久化 `queued/running/completed/failed/cancelled`、attempt/retry、动作类别、dispatch phase、queued/started/updated/completed/dead-letter 时间、恢复游标与闭合错误；snapshot/sync/repair 投影使用同一 `AgentExecution` closed type。
- `@human/OpenItem` 与 `@agent/AgentExecution` 保持不同类型、guard、repair discriminant 和桌面 class；没有 T-0017/T-0020 行为实现。
- `packages/desktop/src/renderer/app.ts` 显示 execution 状态、动作类别、attempt 与闭合原因；partial preview 使用独立 `authoritative=false` DOM/ARIA，不使用 typing class/animation，不进入 messages/events/history/repair。
- 自动化：core closed guard/type tests、schema/snapshot/restart tests、`app.test.ts`。

### 标准 4 · interrupt 的提交次序与 partial 丢弃

- `AgentRuntimeService.interrupt` 先 await AuthorityWorker 把 execution 原子提交为 `cancelled`，随后才 abort 运行中的 Provider/Tool controller，并从队列移除；重复 interrupt 返回相同 terminal execution。
- completion、checkpoint、tool claim 都校验 executionId + current attempt；取消后的 partial 仅清空内存，迟到 Provider/tool 结果不能写 message 或覆盖新 attempt。
- 自动化：`agent-runtime-service.test.ts` 明确断言 `cancel-committed` 发生在 `abort-propagated` 之前、partial 不调用 complete、重复取消幂等；`worker-runtime-authority.test.ts` 断言 stale attempt completion 为 `execution_conflict`。

### 标准 5 · secret 零落盘/零外泄

- secret 只由 `EnvironmentSecretProvider` 在 Provider 发请求时读取；Provider 对 HTTP/body/header/SSE 失败只返回闭合错误，不携带原始正文、headers、内部推理或凭据。
- 权威库只保存闭合 execution/tool summary、SHA-256 与必要的规范化 tool call/checkpoint；Provider 原始正文、headers、reasoning 与 secret 不写 messages/events/outbox/snapshot/diagnostics。
- `secret-sentinel.test.ts` 使用哨兵 secret 扫描 SQLite、WAL、snapshot cache、events/outbox/messages、wire/error/diagnostic/stdout/stderr 为零命中；Provider 单测也检查请求错误不回显 secret/header/body。

### 标准 6 · attempt、重试、dead-letter 与恢复

- scheduler room 内 FIFO 串行，跨 room 默认最多 8 active、每 room 最多 32 queued；超限闭合为 429 `agent_queue_full` + `retryAfterMs`。partial、SSE、HTTP body、stdout/stderr、queue、timeout 与 close 都有硬上限。
- 只有闭合 transient code 自动重试，最多 3 attempts，退避固定 1 秒/4 秒；每次 retry/dead-letter lifecycle event 带 executionId、attemptSeq、errorCode、nextRetryAt。第三次失败进入 `failed/dead-letter`；人工 retry 创建带 `manualRetryOfExecutionId` 的新 execution。
- 重启扫描 queued/running：纯模型/只读阶段创建新 attempt；过期 confirmation 明确失败；等待确认恢复等待并可从持久化规范化 tool checkpoint 继续；side-effect 已 dispatch/已成功但模型后续未提交时转 `outcome_unknown`，不自动重放；旧 attempt CAS 拒绝迟到结果。
- 自动化：`agent-runtime-service.test.ts`、`worker-runtime-authority.test.ts`、`authority.e2e.test.ts` 覆盖 FIFO/8/32/429、1s/4s/3 attempts、manual retry、SQLite/worker restart、waiting-confirmation restart、stale result 与 outcome_unknown。

### 标准 7 · side effect、一次确认与补偿

- `sandbox-file.write` 声明 `side-effecting/compensatable`。prepare transaction 产生一次性 confirmation 与 execution grant，绑定 executionId、attempt、toolId、规范化参数 SHA-256、room、human principal、session family、expiresAt；claim transaction 重新复核全部绑定并原子消费 confirmation + grant、插入 dispatch。
- `agent.tool.confirmation-required` 是权威 room event，只公开确认所需的 target/impact/reversibility/expiresAt；桌面 confirmation card 展示四项，并用一次性按钮发出 closed `{confirmationId, executionId}`。
- 参数变化、错误 principal/family/room、过期、重放或撤权都在 adapter 前拒绝。取消不触发补偿；显式人工补偿创建带 `compensatesExecutionId` 的新 execution。写入使用 expected-current SHA-256 fence 与原子 fsync/rename；补偿 token 由 server-side AES-GCM sealing，已派发不确定结果记录 `outcome_unknown`。
- 自动化：`tool-gateway.test.ts`、`worker-runtime-authority.test.ts`、`agent-runtime-service.test.ts`、`tool-adapters.test.ts`、core sync 与 desktop renderer tests。

## 3. 关键新增/修改文件

- Core 合同：`packages/core/src/collaboration.ts`、`packages/core/src/sync.ts`、`packages/core/src/index.ts` 及相应 tests/type tests。
- Runtime/Provider/Tools：`packages/server/src/agent-runtime/` 全目录。
- 权威 writer/schema：`packages/server/src/persistence/schema.ts`、`authority-database-handler.ts`、`authority-worker.ts`、`worker-protocol.ts`、`worker-database-client.ts`、`snapshot-worker.ts`。
- 生产接线/协议：`packages/server/src/authoritative-server.ts`、`protocol.ts`、`websocket.ts`、`index.ts`。
- 桌面：`packages/desktop/src/renderer/app.ts`、`app.test.ts`、`styles.css`。
- 计划与交付：`docs/plans/2026-08-17-t0041-agent-runtime-implementation-plan.md` 与本文。

## 4. schema v6 与旧数据兼容

- `AUTHORITY_SCHEMA_VERSION = 6`；v6 migration 名为 `agent-runtime-authority`，checksum 为 `87b3d62db40e9e7f8fa3e643315a62c26f01968d4065fb743fa502a7251d9257`，schema fingerprint 为 `0e5c764a0fae33f00eae7bfd2e21dbbc4d54781d43ef5aa967c6dfeef8c58035`。
- v1-v5 的 statements、历史 checksum 与 fingerprint 未修改；v6 仅追加 execution canonical fields、attempt/intent/step/grant/confirmation/dispatch 与 T-0016/T-0020 server-private fence seam。
- `schema.test.ts` 30 个测试覆盖 fresh v1→…→v6、历史 v1/v2/v3/v4/v5→v6、future v7/unknown refusal、checksum/fingerprint/invariant、v6 migration 中途故障整笔回滚与 legacy execution 映射。

## 5. Provider、授权、副作用、取消、重试、恢复安全边界

- Provider：仅 OpenAI Responses P1；原生 fetch、closed SSE、`store:false`、AbortSignal、无生产 mock fallback；缺 secret 安全 noauth。
- 工具：三个 closed tool id，HTTPS allowlist、固定 Git binary/root/argv、sandbox root + path normalization + hash fence；无通用执行面。
- 授权：公开 WebSocket frame 不接收 provider/capability/grant/secret/actor spoof；所有权威决策在现有 AuthorityWorker transaction 完成。
- 副作用：confirmation+grant 单事务消费；dispatch append-only；失败或崩溃可能已产生副作用时只记 `outcome_unknown`，不自动重放；补偿是新的可追踪 execution。
- 取消：cancel commit-before-abort；partial 永不权威化；terminal/attempt CAS 阻止迟到写。
- 重试/恢复：仅 transient，1s/4s/3 attempts；side effect fence 优先于自动恢复，waiting confirmation 可跨 restart 恢复。
- 数据最小化：只持久化闭合状态、摘要、hash、恢复必要的规范化 tool call；原始 Provider body/header/reasoning/credential 不持久化。

## 6. 验证结果与精确测试计数

按仓库 pnpm 10.14 工具链执行：

1. `corepack pnpm typecheck`：通过。
2. `corepack pnpm lint`：通过，0 warnings。
3. `corepack pnpm test`：通过；**33 个测试文件，其中 32 passed、1 skipped；750 个测试，其中 749 passed、1 skipped**。
4. `corepack pnpm build`：通过。
5. `corepack pnpm verify:core-boundary`：通过。
6. `git diff --check`：通过。

相对基线 25 文件/709 测试，新增后为 33 文件/750 测试；唯一 skip 是 opt-in OpenAI live smoke。

## 7. live smoke

当前环境未提供 `OPENAI_API_KEY`，且未启用 `DAO_OPENAI_LIVE_SMOKE=1`，因此 `openai-responses-provider.live.test.ts` **安全跳过**。未因此降低 fake Provider、closed SSE parser、取消、闭合错误、真实本地工具与 secret sentinel 覆盖；没有向源码、测试、提示词、日志或本文写入真实 key。

## 8. 已知风险与建议 reviewer

- 已知部署风险：真实 endpoint 的配额、区域网络和所选模型可用性只能由目标环境的 opt-in live smoke 最终确认；无 secret 的 CI 不声称验证了外部服务 SLA。
- 已知产品边界：R1 是单 server 进程内有界 orchestrator；CPU-bound/恶意扩展工具仍不应直接接入，新增工具必须继续使用远端 allowlist、固定 binary 或受限 sandbox。
- 建议 reviewer：一位 server/SQLite reviewer 重点检查 v6 migration、CAS、AuthorityWorker 事务与恢复；一位 security reviewer 检查 secret/data minimization、URL/path/binary allowlist、confirmation binding 与 compensation sealing；一位 desktop reviewer 检查 execution/OpenItem 视觉分离、confirmation card 与无 typing animation。

## 9. Git 状态

- 开始基线：`main...origin/main`，clean，25 测试文件/709 测试。
- 交付时：仅 T-0041 相关 source/test/docs 为 modified 或 untracked；没有 staged 文件，没有 commit/push/PR，没有 Blueprint HTML/JSON 改动。
- 详细逐文件状态以最终交付消息中的 `git status --short --branch` 为准。
