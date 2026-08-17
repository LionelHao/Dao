# T-0041 · 真实 Agent 运行时、模型供应商与工具权限 · 实施计划

状态：实现与自动化证据已完成，等待 owner 验收。权威设计为 `2026-08-12-t0041-agent-runtime-work-note.md` 与 `2026-08-12-t0041-agent-runtime-design.md`；本文件只安排已批准设计的生产实现与证据，不重新设计。

## 1. Git 基线与保护边界

- 2026-08-17 开始时分支为 `main...origin/main`，`git status --short --branch` 无已修改、未跟踪或暂存文件。
- 不修改 Blueprint HTML/JSON，不修改 v1-v5 历史 migration/checksum/fingerprint，不 commit、push、创建 PR 或声明 verified。
- Fake Provider、Fake Tool、Fake Secret 与故障注入只留在 deep test seam；production composition root 不接受或选择 fixture/mock 分支。

## 2. 七条验收标准（从工作笔记逐条原文复制）

1. 至少一个独立生产 ProviderAdapter 通过 server-side secret 调用真实外部模型 endpoint 并完成流式响应；生产 composition root 使用该适配器且不存在固定文案或 mock 回应分支。CI 使用同一接口的 fake adapter 覆盖流、错误与取消；另有 opt-in secret-safe live smoke 验证真实 endpoint 返回非 fixture 流且记录中无响应正文 / 密钥。
2. 至少两个 agent 配置物理不同的可执行目标（不同 adapter / endpoint / binary，而不是同一函数改名）的真实工具或数据能力；每次工具调用同时校验 actor 声明、room membership 授权和本次 execution grant。任一不匹配时服务端拒绝且工具函数调用次数为 0；fake 覆盖拒绝矩阵，opt-in live smoke 分别命中两个目标并只记录闭合结果摘要。
3. 每次调用持久化 queued / running / completed / failed / cancelled 状态、attempt、时间戳和闭合动作类别（模型生成 / 工具调用 / 等待上游）；客户端重启后仍可查询，界面不显示 agent 打字动画。
4. @ agent 可中断；中断后 AbortSignal 传播到进行中的模型或工具、禁止后续步骤、持久化取消原因并回到 ready。已产生的部分流不能落成 completed 消息，重复中断幂等。
5. 模型密钥只从 server-side secret provider 进入适配器；消息、权威事件、普通日志、错误响应和诊断导出均不得包含密钥。自动化测试使用哨兵密钥并扫描这些输出为零命中。
6. Agent attempt、调用状态和恢复游标权威持久化。仅闭合 transient 错误自动重试，最多 3 个 attempt，退避为 1 秒 / 4 秒且单次不超过 4 秒；每次调度与 dead-letter event 记录 executionId、attempt、errorCode、nextRetryAt。旧 attempt 的迟到结果不能覆盖新 attempt；预算耗尽进入可查询 dead-letter / failed 并有人工重试；queued / running 时进程退出，重启后任务被恢复或明确终结，不永久停在 running。
7. 工具声明 read-only 或 side-effecting。side-effecting 调用执行前必须展示目标、影响和可逆性，并取得一次性 confirmation；confirmation 绑定 executionId、toolId、规范化参数 SHA-256、roomId、human principal / session family 和 expiresAt，原子消费一次。参数变化、错误 principal / room、过期或重放均拒绝且工具调用次数为 0。取消不伪装成回滚；支持补偿的工具产生可追踪撤销 execution，不支持补偿的工具在确认前标明不可逆。

## 3. 文件级切片与 TDD 顺序

### A. Core 闭合合同

1. 先在 `packages/core/src/collaboration.test.ts`、`collaboration.type-test.ts`、`sync.test.ts` 写失败用例：v6 execution/attempt/action/dispatch、invocation/confirmation、ephemeral preview 与 persisted room event 的严格分离、RouterProviderInput 与 AgentRuntimeProviderInput 互不可赋值。
2. 再修改 `packages/core/src/collaboration.ts`、`sync.ts`、`index.ts`：加入 closed unions/guards；保留 `OpenItem` 与 `AgentExecution` 不同 discriminant、类型与 API。

### B. SQLite v6 与 RuntimeAuthority

1. 先扩展 `packages/server/src/persistence/schema.test.ts`：fresh v1→…→v6、historical v1/v2/v3/v4/v5→v6、future/unknown refusal、v6 中途故障整笔回滚、旧 execution 字段保留、legacy running outcome-unknown 语义。
2. 再只向 `schema.ts` 追加 immutable v6：canonical execution、attempt、intent、step、grant、confirmation、dispatch 与必要索引/trigger；v1-v5 内容、checksum、fingerprint 保持逐字不变。
3. 先在 `contracts.test.ts`、`worker-database-client.test.ts`、`sqlite-authoritative-store.test.ts` 写 RuntimeAuthority 失败测试，再扩展 `contracts.ts`、`worker-protocol.ts`、`authority-database-handler.ts`、`worker-database-client.ts`、`sqlite-authoritative-store.ts`：queued 创建、attempt claim/CAS、retry/dead-letter、cancel、grant/confirmation/dispatch 原子消费、checkpoint、recovery scan 与 manual retry 新 execution。

### C. 有界 Runtime 与 Provider

1. 新增 deep 测试 `packages/server/src/agent-runtime/agent-runtime.test.ts`：room FIFO、跨 room active=8、每 room queued=32、429/retryAfterMs、1s/4s/3 attempts、stale result、interrupt commit-before-abort、partial 丢弃、bounded close/recovery。
2. 实现 `agent-runtime/contracts.ts`、`scheduler.ts`、`agent-runtime-service.ts`、`runtime-authority.ts`，只在主进程保存 bounded queue/controller/partial buffer。
3. 新增 `openai-responses-provider.test.ts` 与 `sse-parser.test.ts`，先覆盖 closed SSE 次序、分块边界、malformed、HTTP closed errors、AbortSignal、buffer/timeout 上限与 `store:false`；再实现原生 fetch Provider、environment SecretProvider。新增 opt-in `openai-responses-provider.live.test.ts`，无 secret 安全跳过。

### D. 三个生产 Tool Adapter 与安全门禁

1. 新增 `tool-gateway.test.ts` 拒绝矩阵：capability actor、活跃 membership、membership permission、execution/attempt、tool、参数 hash、expiry、principal/family/room、replay，每项 Adapter 调用为 0。
2. 分别先写再实现 `http-json-read`（HTTPS allowlist/JSON/redirect/body 上限）、`repository-git-status`（固定 binary/root/argv、无 shell、清洁 env、bounded stdout/stderr）、`sandbox-file-write`（规范化相对路径、expected hash、一次确认、原子 write、sealed compensation/hash conflict）。
3. side-effect dispatch 与 confirmation/grant claim 在 AuthorityWorker 同一事务；dispatch 后不确定结果写 `outcome_unknown` 且不自动重放；补偿创建新 execution。

### E. Composition、WebSocket、sync 与桌面

1. 先扩展 `protocol.test.ts`、`websocket.test.ts`，再修改 `protocol.ts`、`websocket.ts`：closed v2 invoke/interrupt/retry/confirm/compensate frame；公共输入不含 capability/provider/secret/grant；ephemeral preview 走既有 bounded backpressure gate。
2. 修改 `authoritative-server.ts` 与 `index.ts`：production 无条件装配 environment SecretProvider、OpenAI Responses Adapter、三生产 Tool Adapter 与 AgentRuntime；无 secret 启动成功、readiness=noauth、invoke 闭合配置错误；shutdown 顺序 transport→runtime→snapshot→AuthorityWorker，all-settled 且有界。
3. 扩展 `sync.ts`/snapshot repair 使 v6 execution 权威事实可恢复；preview 不进入 repair/history/event/outbox。
4. 先扩展 `packages/desktop/src/renderer/app.test.ts`，再修改 `app.ts`/`styles.css`：execution 卡展示 queued/running/terminal、attempt、动作类别/closed reason；preview 使用独立 class/ARIA，取消/断线移除，不显示 Agent typing animation；human OpenItem 操作不出现在 Agent execution。

### F. 真实 worker、sentinel 与交付

1. 扩展 `authority.e2e.test.ts` 与 compiled child fixture：真实 AuthorityWorker/SQLite restart 覆盖 queued/running/waiting、cancel commit 后 crash、retry/dead-letter/outbox、客户端清 cache 恢复。
2. 新增 secret sentinel 扫描 authority DB/WAL/snapshot cache/events/outbox/messages/WebSocket/errors/logs/stdout/stderr/diagnostic export；Provider/tool 原始正文、headers、reasoning 不落库。
3. 编写 `docs/deliveries/T-0041-真实Agent运行时模型供应商与工具权限-交付说明.md`，逐条映射本文件七条标准与精确测试证据。

## 4. 七条标准到预期证据的映射

| 标准 | 生产证据 | 自动化证据 |
| --- | --- | --- |
| 1 | OpenAI Responses fetch adapter、environment secret、production composition | SSE/fake/abort/error/sentinel + opt-in live smoke |
| 2 | HTTP JSON 与固定 Git 两个物理 adapter、ToolGateway 四重门禁 | 两 agent 真目标 + 完整拒绝矩阵，拒绝时 call count=0 |
| 3 | v6 execution/attempt/action timestamps、sync/repair、desktop card | SQLite restart/readback + renderer DOM/无 typing |
| 4 | cancel transaction→AbortController、attempt CAS | partial 丢弃、重复 interrupt、迟到 completed 拒绝、restart ready |
| 5 | SecretProvider 仅在 Provider 内取值、sanitized closed errors | DB/WAL/cache/outbox/wire/log/stdout/stderr/diagnostic sentinel 零命中 |
| 6 | attempts/checkpoints/retry/dead-letter/recovery transactions | 1s/4s/attempt3、stale CAS、manual retry 新 ID、queued/running restart |
| 7 | confirmation+grant 原子消费、append-only dispatch、compensation execution | hash/principal/family/room/expiry/replay 拒绝、outcome_unknown、hash conflict |

## 5. 最终验证顺序

1. `corepack pnpm typecheck`
2. `corepack pnpm lint`
3. `corepack pnpm test`
4. `corepack pnpm build`
5. `corepack pnpm verify:core-boundary`
6. `git diff --check`
7. 精确统计 Vitest 收集的测试文件数与测试数；检查 opt-in live smoke 为通过或因无 secret 安全跳过；最后记录 `git status --short --branch`。
