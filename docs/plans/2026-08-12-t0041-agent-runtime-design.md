# T-0041 · 真实 Agent 运行时、模型供应商与工具权限 · 设计稿

状态：**owner 已批准 R1 / P1 / 三工具目标；独立规格复审 PASS（C0 / I0 / M0）。**

本设计采用工作笔记中的推荐组合：进程内有界 orchestrator、既有 AuthorityWorker 单 writer、OpenAI Responses API 生产 Provider、HTTPS JSON 与固定 Git binary 两个物理工具目标、受限 sandbox write 验证确认与补偿。若 owner 改选 Provider 或工具目标，只替换相应 Adapter，不改变权威运行时合同。

## 1. 目标与非目标

### 1.1 目标

- 把 T-0013 已验收的 `@agent = 可中断执行` 从内存 fake 接到真实模型与真实工具。
- 复用 T-0040 的 Agent capability、AuthorityWorker、事务 event/outbox 与多客户端同步，建立唯一权威 Agent execution 生命周期。
- 对调用、重试、取消、工具授权、一次性确认、补偿和进程恢复给出 fail-closed 合同。
- 为 T-0016 的 RouterProvider 与 T-0020 的人来让位提供可复用执行面，不在本任务实现路由或人来让位策略。

### 1.2 非目标

- 不实现多 provider 负载均衡、跨服务进程队列或分布式锁。
- 不提供通用 shell、任意 binary、任意 URL 或任意文件系统写入。
- 不实现 T-0016 的四层发言判定、T-0017 的新 OpenItem 合同或 T-0020 的让位规则。
- 不把模型的内部推理或 provider 原始响应持久化、记录到日志或发送给客户端。

## 2. 原语与三层落地

### 2.1 原语 #3：正在做什么

- **数据层**：`AgentExecutionActionCategory = model_generation | tool_call | waiting_upstream`，与 human typing 状态不同名不同型；每个 attempt 记录当前类别。
- **接口层**：运行时只能通过权威 transition 改类别；客户端不能伪造 Agent busy 或 typing。
- **渲染层**：显示“正在生成 / 正在调用 <tool display name> / 等待上游”，不得渲染打字点动画。

### 2.2 原语 #4：@ 是请求 / 调用

- **数据层**：human `@` 继续产生 OpenItem；Agent `@` 产生 `AgentInvocationIntent` 与 AgentExecution，两者不可互赋。
- **接口层**：Agent invocation 必定落成 queued execution 或闭合拒绝；可中断、可人工重试、可对 side effect 确认。human OpenItem 的拒绝/延迟/转交接口不适用于 Agent execution。
- **渲染层**：继续保留现有 human/Agent mention class；Agent execution 卡显示动作、attempt、中断/重试/确认操作，不显示 human 的“搁置/转交”。

### 2.3 原语 #6 / #13：能力编制与工具权限

- **数据层**：复用 agent membership 的 `toolPermissions`；新增 server-owned `ToolDescriptor` 与短生命周期 execution grant，不把凭据放进 membership。
- **接口层**：每次工具调用在实际 Adapter 前同时复核 capability actor、活跃 room membership、membership tool permission、execution grant。任一失败时 Adapter 调用计数为零。
- **渲染层**：成员列表仍展示已配置的 permission；执行卡只展示 tool display name、目标、影响和可逆性，不展示 secret 或内部 argv。

## 3. 深模块与 seam

### 3.1 外部 Interface：AgentRuntime

`AgentRuntime` 是调用方与测试共同使用的深模块 Interface：

```ts
interface AgentRuntime {
  invoke(context: AuthenticatedCommandContext | InternalAgentCommandContext, intent: AgentInvocationIntent): Promise<InvocationAccepted>;
  interrupt(context: AuthenticatedCommandContext, executionId: string, reason: AgentCancellationReason): Promise<AgentExecution>;
  retry(context: AuthenticatedCommandContext, executionId: string): Promise<InvocationAccepted>;
  confirmTool(context: AuthenticatedCommandContext, confirmation: ToolConfirmationInput): Promise<AgentExecution>;
  compensate(context: AuthenticatedCommandContext, executionId: string): Promise<InvocationAccepted>;
  close(): Promise<void>;
}
```

调用者只需知道：命令身份、幂等、错误码、提交顺序和关闭语义。Provider stream、tool call、attempt CAS、backoff、recovery cursor、secret 与 partial output 不进入该 Interface。

`invoke` 同时支持 authenticated human 与 server-private Agent capability，以承接 human/Agent 对 Agent 的直接 `@`；结构化 JSON 或 WebSocket 客户端不能构造 `InternalAgentCommandContext`。side-effect confirmation、人工 retry 与 compensation 始终要求 human session。T-0020 的系统让位不伪装成人或 Agent，后续通过单独的 server-private control capability 接入现有 `interrupt` 内部命令，不扩大公共 Interface。

### 3.2 内部 seams

- `ProviderAdapter`：true external seam。生产是 OpenAI Responses Adapter，测试是 deterministic fake。
- `ToolAdapter`：不同物理目标各自 Adapter；共同实现闭合 descriptor 与 `execute({ parameters, signal })`。
- `SecretProvider`：只返回指定 server secret；生产 environment adapter，测试 sentinel adapter。
- `RuntimeAuthority`：AuthorityWorker 的内部 facade，负责权威读写、claim attempt、一次性 confirmation consumption 与恢复扫描。
- `RuntimeClock`：确定性 retry / expiry 测试；生产 monotonic wall clock adapter。

Provider 与 tool seams 都确有生产/测试或多个物理 Adapter，不为假设性扩展制造公共抽象。它们是 AgentRuntime 的内部 seams，不从 package root 暴露 raw authority 或 secret 方法。

## 4. 权威数据模型

T-0041 增加 immutable schema migration；不修改既有 v1-v5 migration。

### 4.1 Agent execution

`agent_executions` 扩展或重建为闭合 canonical record：

- `id`, `room_id`, `agent_id`, `source_message_id`, `requester_actor_id`
- `state`: `queued | running | completed | failed | cancelled`
- `action_category`: `model_generation | tool_call | waiting_upstream`
- `tool_dispatch_phase?`: 仅 `tool_call` 时允许 `not_started | dispatched | finished`
- `current_attempt_seq`: 全局单调 attempt identity
- `retry_cycle`, `retry_ordinal`：同一自动重试周期内 `retry_ordinal=1..3`
- `provider_id`, `model_id`（非 secret）
- `recovery_cursor`：仅 closed provider/tool cursor；不可含正文或 credential
- `queued_at`, `started_at`, `updated_at`, `completed_at?`
- `cancellation_reason?`, `terminal_error_code?`, `dead_lettered_at?`
- `result_message_id?`，只在 completed 时指向同事务创建的 Agent message
- `manual_retry_of_execution_id?`, `compensates_execution_id?`

另有 `agent_invocation_intents`，以 `(sourceMessageId, targetAgentId)` 唯一；保存闭合 `intentKind=direct_mention | structured_help | routed_candidate` 与最终 executionId。direct mention 优先覆盖同消息的低优先级 reason，但不创建第二个 execution。human/Agent message replay、WebSocket request retry、T-0016 后续 mandatory merge 都只能得到同一 execution ACK。

状态迁移：

```text
queued -> running
running -> completed | failed | cancelled | queued(retry next attempt)
failed(dead-letter) -> new manual-retry execution
completed(compensatable side effect) -> new compensation execution
```

同一 execution 的 `attemptSeq` 单调递增。所有 terminal transition 都带 expected attempt；`WHERE id=? AND current_attempt_seq=? AND state='running'` CAS 不命中即拒绝迟到结果。人工 retry 与 compensation 创建新 execution，保留追踪链，不复活旧 terminal record。

`tool_dispatch_phase` 不增加第四种动作类别。它专门区分尚可安全取消的 tool step 与已经可能产生副作用的 dispatch；T-0020 后续可使用 `action_category=tool_call && tool_dispatch_phase=not_started`，不得把所有 running tool call 都视为可取消。

### 4.1.1 v5 → v6 兼容迁移

- T-0041 只追加 immutable v6；v1-v5 statement、checksum 与 physical fingerprint 逐字不改。
- 旧 `running` 行迁移为 `running / currentAttemptSeq=1 / retryCycle=1 / retryOrdinal=1 / actionCategory=tool_call / toolDispatchPhase=dispatched`，启动恢复时按 outcome-unknown 保守终结，不能盲目重跑旧工具。
- 旧 `completed/failed` 保持 terminal；旧 `interrupted` 明确映射 `cancelled`，cancellation reason=`legacy_interrupted`。
- 旧 `tool_name/result_json/requester/source/start/completed` 必须逐字段保留；无法闭合的旧行令 migration 整体回滚，schema version 保持 5。
- v6 checksum、physical fingerprint、startup invariant、fresh v1→…→v6 与历史 v1/v2/v3/v4/v5→v6、future/unknown refusal、注入故障回滚均有真实 SQLite 测试。

### 4.2 Attempt 与调度事件

独立 `agent_execution_attempts`：executionId + monotonic `attemptSeq` 复合主键，记录 `retryCycle`, `retryOrdinal(1..3)`、`queued/running/completed/failed/cancelled`、动作类别、started/finished、closed errorCode、nextRetryAt、recoveryCursor。每次：

- 初次调度：`agent.execution.queued`
- 开始：`agent.execution.started`
- retry：`agent.execution.retry-scheduled`
- terminal：`agent.execution.completed/failed/cancelled/dead-lettered`

事件 payload 固定包含 `executionId, attemptSeq, retryCycle, retryOrdinal, actionCategory`；retry/dead-letter 另含 `errorCode, nextRetryAt?`。不得放 provider response、prompt、tool result 正文或 secret。

自动 transient retry 只在同一 `retryCycle` 内把 retryOrdinal 从 1 推到 2、3，绝不产生第 4 个自动 attempt。人工 retry 创建新 execution。T-0020 未来的 human fence 也不是自动 retry：旧 execution 被取消后保持 terminal；新 RouteJob 只为最终选中的 Agent 创建带 `supersedesExecutionIds` 追踪链的新 execution。这样 attempt identity 永不复用，旧 terminal 不会被隐式复活，人的新输入也不消耗 provider 自动重试预算。

### 4.2.1 Provider-neutral step checkpoint

`agent_execution_steps` 以 `(executionId, attemptSeq, stepSeq)` 为主键，只保存完成一轮后经过 closed parser 的 provider-neutral checkpoint：step kind、canonical tool call、bounded tool result、input/output SHA-256 与完成时间；不保存 raw SSE body、reasoning、HTTP headers 或 secret。`recovery_cursor` 是最高已提交 `stepSeq`，而不是依赖第三方响应 ID。

每一轮 Provider 完整结束后，先事务提交 checkpoint，再允许 tool dispatch 或下一轮 Provider。进程重启根据 source message、授权 room context与这些 checkpoint 重建请求；`store:false` 下不依赖 provider 保存会话状态。未完成 SSE round 没有 checkpoint，按 attempt retry 处理。

### 4.3 Execution grant

每个 tool step 在 AuthorityWorker 中生成 server-only grant：

- `grantId`, `executionId`, `attemptSeq`, `agentId`, `roomId`, `toolId`
- canonical parameter SHA-256
- `issuedAt`, `expiresAt`, `consumedAt?`

运行时在 Adapter 前调用 `claimToolGrant`。单事务复核：opaque Agent capability actor = execution agent、room active membership、membership permission 含 toolId、execution/attempt 正在运行、hash 相同、未过期/未消费。read-only grant 在开始调用时消费；side-effecting grant 还必须同时消费有效 human confirmation。

### 4.3.1 Tool dispatch 与 outcome

`tool_dispatches` 是独立、append-only 的副作用事实：`dispatchId`, executionId, attemptSeq, grantId, toolId, parameterHash, state=`dispatched | succeeded | failed | outcome_unknown`, dispatchedAt, settledAt?, closedSummary?, sealedCompensation?。唯一键保证一个 grant 只有一个 dispatch。

side-effect Adapter 前的**同一个 AuthorityWorker transaction**必须完成全部 actor/membership/permission/execution/attempt/hash/expiry 复核、消费 grant、消费 confirmation、CAS `toolDispatchPhase=not_started→dispatched` 并插入唯一 dispatchId；Adapter 只能持该已提交 dispatchId 执行。事务提交后崩溃，无论实际外部调用是否开始，都保守追加 `outcome_unknown`，绝不自动重放。

若 execution 在 dispatch 后被取消，AbortSignal 仍传播，execution 保持 cancelled 且绝不能写 Agent message/completed；但 Adapter 的迟到 settle 可以只凭 `(dispatchId, executionId, attemptSeq, grantId)` CAS 追加 `succeeded | failed | outcome_unknown`、closed summary 与 sealed compensation token。它不能改变 execution terminal state。这保证“取消不是回滚”，同时不会丢掉已经发生的真实副作用和可追踪补偿凭据。

### 4.4 Side-effect confirmation

`tool_confirmations` 绑定：

- `confirmationId`, `executionId`, `attemptSeq`, `toolId`, canonical parameter SHA-256
- `roomId`, `humanPrincipalId`, `sessionFamilyId`, `expiresAt`
- `target`, `impact`, `reversibility`: `compensatable | irreversible`
- `consumedAt?`

确认输入不接收 actor/room 的自由字段；从 authenticated context 派生 principal/family。消费与 grant claim 在同一 AuthorityWorker transaction 内完成。参数变化、错误 principal/family/room、过期、replay、execution 已取消均返回闭合 403/409/410，Adapter 调用次数为零。

只有 execution requester 或当前 room owner/admin 可以中断、人工 retry 或提交 side-effect confirmation；compensation 还要求原 side effect 的确认 principal 或当前 room owner/admin。每个入口都在 AuthorityWorker 事务内复核 session、role、room 和 execution identity，客户端不能用隐藏按钮代替权限合同。

### 4.5 Room-scoped Agent readiness projection

运行时 readiness 不依赖进程内 `finally`，也不覆盖注册 Actor 的静态配置。Authority 查询按 `(roomId, agentId)` 从非 terminal execution 派生：存在 queued/running/waiting execution 时为 `busy`，否则为 `ready`；缺 secret 或必需 tool configuration 时为 `noauth`，管理员暂停时为 `paused`。同一 room 多条活跃 execution 以最早 queued、最高 attempt 的当前 action 作为展示摘要，不能任意挑一条。

每个 execution transition 的 room event 足以让当前 room 客户端重算该投影；room snapshot/repair 同样从权威 execution facts 派生。因此 cancel commit 后即使 runtime 尚未完成 Abort cleanup，重放结果也已经是 cancelled，且最后一个非 terminal execution 消失时 readiness 为 ready。跨 room 是否全局串行不是本任务承诺；每个 room 只展示本 room 的工作状态。

## 5. 调用与完成顺序

### 5.1 Invoke

1. authenticated human 或 server-private Agent capability 提交 invocation intent；AuthorityWorker 从 context 派生 requester，复核 source message 的真实 author、requester/target Agent 当前 membership、Agent readiness/config，并以 `(sourceMessageId,targetAgentId)` 幂等合并。
2. 同事务创建 queued execution + attempt1 + room event/outbox；返回 ACK，不等待模型。
3. scheduler 以 `claim attempt(expected state=queued)` 原子转 running。
4. runtime 构建完整但有界的授权执行上下文，调用 ProviderAdapter stream；流 delta 只存于有限内存 buffer，并通过带 executionId/attempt/streamSeq 的 closed ephemeral frame 向当前连接发送非权威进度（若连接存在），不创建消息。
5. provider 完成后解析 closed output plan：最终文本和零个或多个 closed tool calls。tool calls 按 provider 顺序逐个处理，任何时刻至多一个 grant/Adapter dispatch 在飞；不并行执行多个 side effect。malformed fail closed。
6. 无 tool：一个 AuthorityWorker 命令原子写 Agent message、execution completed、事件/outbox。只有此事务成功后消息可见。
7. 有 tool：transition actionCategory=tool_call，生成 grant；read-only 直接 claim，side-effecting 先 transition waiting_upstream 并发布 confirmation-required event。

### 5.2 Partial stream

- partial text 不进入 messages/events/diagnostic exports。
- cancellation、provider error、process crash 都丢弃 partial buffer。
- partial buffer 有字节上限；超限是 closed non-transient failure，不截断后伪 completed。
- 客户端可显示“生成中”与临时预览，但必须明确非消息，并在 reconnect 后消失；T-0041 不要求持久 token-level stream。
- ephemeral frame 必须通过现有 WebSocket bounded send/backpressure gate；断线、overflow 或发送拒绝只停止预览，不改变权威 execution，客户端靠 room event/sync 恢复最终事实。

### 5.3 Tool result and continuation

- Adapter 返回 closed `ToolOutcome`：success 摘要、bounded model input、可选 compensation token（sealed/server-only）。
- 原始 stdout/HTTP body 不写普通日志；模型只收到经过 descriptor-specific parser 与上限裁剪的内容。
- read-only/side-effecting tool 成功后 transition 回 model_generation，ProviderAdapter 继续同一 attempt 或以 recovery cursor 恢复。
- 任何后续 step 前再次读取 execution state/attempt；取消或 supersede 后不再调用 Provider 或工具。

## 6. 调度、重试与恢复

### 6.1 有界调度

- room 内 FIFO 串行；跨 room 最多 8 active；每 room queued 32。默认值由 constructor 验证，非法配置拒绝启动。
- 超限 invocation 返回 429 + `retryAfterMs`，不创建半条 execution。
- T-0020 后续复用 scheduler 的 cancel/requeue Interface；本任务不实现 human-preemption policy。

### 6.2 错误分类

- transient：provider `rate_limited`, `upstream_timeout`, `upstream_unavailable`, tool `target_busy`。
- terminal：authentication/configuration/malformed response/permission/invalid parameter/confirmation/error from side effect after dispatch。
- 未知 provider/tool 错误一律 terminal sanitized `provider_failure` / `tool_failure`，不猜 transient。

自动 retry 最多 3 attempts：attempt1 失败后 1s，attempt2 失败后 4s；attempt3 失败进入 failed + dead-letter。注入 clock 测试边界且每次 backoff <=4s。side-effecting Adapter 一旦 dispatch 开始，错误默认 terminal ambiguous-side-effect，不自动 retry，避免重复副作用。

每次自动 retry 都是一个 AuthorityWorker transaction：以 expected `attemptSeq` CAS 将旧 attempt 终结为 transient failed，更新 execution 的 `currentAttemptSeq/retryOrdinal/nextRetryAt`，插入新的 queued attempt，并写 `agent.execution.retry-scheduled` event/outbox。第三次失败则在同一 transaction 写 failed + dead-letter event/outbox，不再创建 attempt4。任何 crash 只能看到完整的旧 terminal + 新 queued，或完整的旧 running，不能看到“已终结但未排队”的中间态。

### 6.2.1 T-0020 server-private human fence seam

本任务只提供两个 server-private 权威步骤，不实现 T-0020 的路由策略：

1. `cancelForHumanFence` 在一个 transaction 内复核 durable human accepted message 与 execution 同 room，并只取消以下旧 attempt：`state=queued`，或 `actionCategory=waiting_upstream`，或 `actionCategory=tool_call && toolDispatchPhase=not_started`。`model_generation`、已 `dispatched` 的 tool call 以及 terminal attempt 必须拒绝，不能被调用方用模糊的 “running” 绕过。成功时只把旧 attempt/execution 终结为 cancelled，记录 durable fence、event/outbox；**不创建 replacement**。唯一键 `(fenceMessageId, executionId, oldAttemptSeq)` 令 replay 返回同一 cancellation。
2. T-0016 必须在上述 cancellation commit 后，读取包含该 human message 的最新 room state，创建并完成一个 RouteJob。随后 `enqueueFenceReplacement(fenceId, routeJobId, selectedAgentId, expectedJudgmentId)` 在 AuthorityWorker transaction 内复核 fence 已提交、RouteJob 属于同 room 且已 terminal、selected Agent judgment 为“将回应”，再创建新的 queued execution。新 execution 保存 `supersedesExecutionIds`；关联表以 `(fenceId, oldExecutionId)` 唯一，保证每个被取消 execution 最多进入一个 replacement。调用幂等键 `(fenceId, routeJobId, selectedAgentId)`，重复调用返回同一 execution；未被 RouteJob 选中的 Agent 不得得到 replacement。

取消与路由完成之间，旧 execution 是稳定 terminal `cancelled`，room 中可以暂时没有 replacement；readiness 只从剩余非 terminal facts 派生。replacement 是新 execution、`retryOrdinal=1`，不得复活旧 execution 或继承旧 provider context。冻结顺序因此严格为 `human accepted → cancel commit → RouteJob from latest state → selected replacement enqueue`。人工 retry 仍是另一条 human-authorized 新 execution 路径，不能冒充 fence replacement。

### 6.3 Crash recovery

启动时 AuthorityWorker 扫描：

- queued 且 nextRetryAt 到期：重新入有界队列。
- running model/read-only tool：将旧 attempt 标记 `runtime_restarted`，若预算剩余则 schedule 新 attempt，否则 dead-letter。
- running side-effecting 在 dispatch 前：可安全重新排队；dispatch 已开始但无结果：先把对应 append-only `tool_dispatches` 行 CAS 为 `outcome_unknown`，再终结 execution 为 `side_effect_outcome_unknown`，等待 human 明确审查/补偿，不自动重跑。
- waiting_upstream confirmation：若未过期继续等待；过期则 failed `confirmation_expired`。

所有 recovery decision 本身持久化事件；任何 execution 重启后最终恢复或 terminal，不留永久 running。

## 7. 中断与关闭

- `interrupt` 在 AuthorityWorker 先 CAS `queued/running -> cancelled` 并写 reason/event；重复同 actor/同 reason 或任意 terminal execution 返回稳定当前 record。
- commit 后运行时 abort 对应 controller。这样即使进程在 commit 与 abort 间崩溃，重启扫描也看到 cancelled，不会续跑。
- Provider 与 Tool Adapter 必须接收同一 attempt AbortSignal；abort 后返回的 Provider/read-only output 因 state/attempt CAS 失败，不能创建消息或 completed。已经提交 `dispatchId` 的 side-effecting tool 迟到 settle 仍可按 §4.3.1 只追加 dispatch outcome/compensation 事实，但绝不能改变 cancelled execution 或继续模型步骤。
- Agent readiness 是权威活跃 execution 投影：有 running/waiting 则 busy，否则 ready；不依赖内存 finally 才恢复。
- `close()` 先停止新 claim，再持久化/取消活跃 lease，abort adapters，等待 bounded cleanup；AuthorityWorker 最后关闭。每一阶段 all-settled，避免前一 close failure 泄漏下一资源。

## 8. Provider 与 secret

### 8.1 ProviderAdapter

```ts
interface AgentRuntimeProviderInput {
  purpose: 'agent_runtime';
  invocation: AgentInvocationIntent;
  visibleConversation: readonly AuthorizedConversationEntry[];
  availableTools: readonly ToolDescriptor[];
  committedSteps: readonly ProviderNeutralCheckpoint[];
  limits: AgentRuntimeContextLimits;
}

interface ProviderAdapter {
  readonly id: string;
  stream(input: AgentRuntimeProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
```

`AgentRuntimeProviderInput` 是完整但有界的授权执行上下文：只含调用 intent、当前 actor 可见的 room conversation、已授权 tool descriptors 和已提交 provider-neutral checkpoints；它不含 secret、raw authority handle 或越权 room body。

未来 T-0016 必须定义不同名、不同 discriminant 的 `RouterProviderInput { purpose:'route_decision', ... }`，只含路由所需摘要，不能访问 tool result、secret 或完整消息正文。type tests 必须证明 `RouterProviderInput` 与 `AgentRuntimeProviderInput` 互不可赋值，避免把便宜路由模型与真实执行模型误接到同一 seam。

`ProviderEvent` 为 closed union：`response_started | text_delta | tool_call_delta | usage | completed`。Adapter 对 SSE 做 exact parser、sequence 单调与恰一个 started/completed 校验；未知事件可以明确忽略的只有官方列为 forward-compatible metadata 的类别，其余 fail closed。

### 8.2 OpenAI Responses Adapter

- 原生 `fetch` POST configured Responses endpoint，`stream:true`、`store:false`；Authorization header 只在 Adapter 内构造。
- 只接收配置 model；agent/input 不能选择 base URL、header、secret name 或 model。
- HTTP status 映射 closed errors；response body/error message 不穿过 Adapter seam。
- live smoke 由显式环境开关和 secret 启用；只断言收到恰一个 `response_started`、至少一个 delta、恰一个 completed、非 fixture 摘要 hash/长度和 secret sentinel 零命中，不保存正文。

### 8.3 SecretProvider 与脱敏

- production 从 server environment secret provider 读取；缺失时 Agent readiness=`noauth`，调用返回 closed configuration error。
- key 不进入 Actor、membership、command、event、message、error、diagnostic snapshot 或 JSON serialization。
- 测试用高熵 sentinel 扫描：authority DB/WAL/cache、outbox payload、WebSocket frames、captured stdout/stderr、structured logs、errors、diagnostic export 均零命中。
- 日志只含 executionId、attempt、providerId、modelId、closed errorCode、duration/usage 数字。

### 8.4 Production composition root

- `startAuthoritativeServer` 的生产 options 必须接收闭合 Agent runtime 配置并无条件构造 OpenAI Responses Adapter、三个生产 Tool Adapter 与 environment SecretProvider；没有 `fake`, `fixture`, 固定文案或 test mode 分支。
- 缺失模型 secret 不替换 Adapter：服务可启动，但相关 Agent readiness 权威投影为 `noauth`，invoke 返回闭合 configuration error。这样 production composition 始终是同一个真实 Adapter，secret 可在部署层补齐。
- deterministic fake 只由 deep test constructor 注入，package root 的类型与 runtime surface 均不导出 fake/raw Provider/Secret/RuntimeAuthority seam。
- composition shutdown 顺序为：停止 transport 新请求 → runtime 停止 claim/abort 并 bounded drain → snapshot client → AuthorityWorker；各阶段 all-settled，前一失败不跳过后续资源释放。

## 9. 工具 adapters

### 9.1 `http-json.read`

- read-only；配置固定 HTTPS origin/path template，参数只填 schema 定义的 path/query value。
- 禁止重定向到其他 origin、私网/IP literal（除非配置明确）、非 JSON content type；响应/解压后字节上限。
- live smoke 命中受控 endpoint，只记录 status category、schema-valid boolean、body hash/byte count。

### 9.2 `repository.git-status`

- read-only；固定 binary path 与固定 argv `git -C <configured-root> status --porcelain=v1 --untracked-files=no`。
- 不通过 shell，不接受 cwd/argv/env 注入；清理继承环境，只传 allowlist env；stdout/stderr bounded。
- live smoke 使用临时 repository，断言确实启动配置 binary，记录 exit category 与 line count。

### 9.3 `sandbox-file.write`

- side-effecting；root 在 server config，输入只有规范化相对 path、UTF-8 content 与 expected current SHA-256。
- confirmation 展示绝对目标的安全相对表示、create/replace 影响、compensatable。
- 原子 temp + fsync + rename；在执行前保存前态 sealed compensation record。补偿创建新 execution，按 expected post-write hash 恢复旧内容或删除新文件；hash 不符拒绝，避免覆盖后来的人类修改。
- cancellation 只停止尚未 dispatch 的写入；rename 后取消记录 completed side effect，不声称回滚，需显式 compensation。

## 10. 公共 transport 与客户端

新增 closed v2 frames，名称最终在实现计划冻结：

- invoke / accepted
- interrupt / execution result
- manual retry / accepted
- tool confirmation submit / result
- compensate / accepted

execution 事实继续作为 room event 经 outbox/v2 sync 恢复。WebSocket request 只传业务 ID 和闭合参数，不传 Agent capability、provider configuration、secret、grant 或任意 command payload。

客户端 execution 卡按权威状态渲染 queued/running/waiting/terminal、attempt、动作类别与 closed reason。临时 stream preview 与 durable Agent message 使用不同 class/ARIA label；preview 在取消/断线后移除，不能被历史恢复成消息。

## 11. 测试与验收证据

### 11.1 CI deterministic tests

- Provider fake：多 delta、tool call、malformed、timeout、abort、迟到 completion。
- scheduler：room FIFO、cross-room 8、queue32、retry 1s/4s、attempt3 dead-letter、stale CAS、crash recovery。
- retry/requeue 原子性：自动 retry 的旧 attempt terminal、新 queued attempt、event/outbox 要么同现要么全无；T-0020 fence 对 queued/waiting/not-started tool 只做 cancellation，对 model generation/dispatched tool 拒绝；RouteJob terminal 后只为 selected Agent 幂等创建新 replacement，未选 Agent 为零。
- tool denial matrix：actor / membership / permission / execution / attempt / tool / parameter hash / expiry / confirmation principal-family-room / replay，每项 Adapter call count=0。
- side effect：confirmation consume 与 write dispatch 原子门禁、ambiguous outcome 不 auto retry、compensation chain/hash conflict。
- provider seam type tests：runtime 与 router input 互不可赋值；ProviderEvent started/delta/completed 次序与计数闭合。
- secret sentinel 全存储/传输/日志/诊断扫描。
- renderer：human request 与 Agent execution 三层不同；动作类别无 typing animation；partial preview 不能进入 history。

### 11.2 Opt-in live smoke

- OpenAI：真实 server secret + Responses stream，closed outcome only，无正文/secret log。
- HTTP tool 与 Git binary：分别由两个 Agent 身份/permission/execution grant 命中；只记 closed summaries。
- smoke 默认跳过必须由显式 env 启用；CI fake 仍全覆盖，不把没有 secret 的 PR 判失败。

### 11.3 Real-worker integration

- 真实 AuthorityWorker/SQLite + runtime restart；queued/running/waiting 各一例。
- interrupt commit 后注入 crash，restart 不续跑；partial stream 无 message。
- retry schedule/dead-letter/outbox 与 v2 client restart query。
- sentinel 扫 authority.sqlite* 与 snapshot cache bytes。

## 12. 参照 Buzz 与明确偏离

### 12.1 参照什么

- `buzz-acp/EventQueue`：按频道串行、有界队列、retry budget、dead-letter、steer/cancel。
- `PoolLifecycle`：attempt ID 拒绝迟到结果、显式 Waking/Ready/Failed 与 bounded backoff。
- `PromptContext`：模型、工具、超时、cwd/credential 由 composition root 注入；执行边界复核 membership/allowlist。
- relay 历史+实时：权威事实先持久化，ACK 不代表异步 Agent 已完成，重启按 cursor/事实恢复。

### 12.2 TypeScript 翻译

- Rust queue/pool 翻译为进程内有界 AgentRuntime scheduler + AbortController + AuthorityWorker CAS facts。
- PromptContext 翻译为内部 AgentRuntimeProviderInput/ToolInvocation；secret 和 raw tool configuration 不进入公共 command。
- relay durable events 翻译为 T-0040 既有 SQLite event/outbox/v2 sync，不新建第二条 Agent event bus。

### 12.3 为何偏离

- 不采用 Nostr/public key/community/multi-tenant/Redis；本项目是单进程 Alpha 权威服务。
- Buzz human/Agent 共用 participant 抽象；本项目保留 human request 与 Agent execution 的不同数据、接口、视觉。
- Buzz 通用 steer 不等同 T-0020 的 human durable-message 硬 fence；本任务只提供可取消 execution，不提前实现路由政策。
- Buzz 的工具配置更通用；本项目因 side-effect confirmation 与 secret 边界，首版只开放闭合 HTTPS、固定 binary 与 sandbox write adapters。

## 13. 方案取舍与批准门

选择 R1/P1 的理由：

- AuthorityWorker 已是唯一 writer，AgentRuntime 放主进程可用最小 Interface 获得最大 leverage，不复制 closed worker protocol。
- Provider 与工具本身跨远端/child/sandbox seam，CPU/副作用风险不在 orchestrator 内执行。
- production + fake 使 Provider seam 真实；多个物理 tool adapters 使 Tool seam 真实。

放弃 R2/R3 的原因：当前没有 CPU-heavy 本地模型或不可信任意代码需求；新增长期 Worker/每调用 child 会扩大 secret、Abort、恢复与 capability 传输面，而不增加 T-0041 的用户价值。

owner 已于 2026-08-13 明确批准以下三项，且独立规格复审已通过；可据此进入实现计划：

1. R1 进程内 orchestrator + AuthorityWorker。
2. P1 OpenAI Responses API。
3. HTTPS JSON read + fixed Git status read + sandbox file write 三种工具目标。
