# T-0041 · 真实 Agent 运行时、模型供应商与工具权限 · 工作笔记

状态：owner 已于 2026-08-13 批准 R1 / P1 / 三工具目标；独立规格复审 PASS（C0 / I0 / M0）。本文保留权威验收标准、现状证据与方案取舍记录。

## 验收标准（实现前逐条复制）

1. 至少一个独立生产 ProviderAdapter 通过 server-side secret 调用真实外部模型 endpoint 并完成流式响应；生产 composition root 使用该适配器且不存在固定文案或 mock 回应分支。CI 使用同一接口的 fake adapter 覆盖流、错误与取消；另有 opt-in secret-safe live smoke 验证真实 endpoint 返回非 fixture 流且记录中无响应正文 / 密钥。
2. 至少两个 agent 配置物理不同的可执行目标（不同 adapter / endpoint / binary，而不是同一函数改名）的真实工具或数据能力；每次工具调用同时校验 actor 声明、room membership 授权和本次 execution grant。任一不匹配时服务端拒绝且工具函数调用次数为 0；fake 覆盖拒绝矩阵，opt-in live smoke 分别命中两个目标并只记录闭合结果摘要。
3. 每次调用持久化 queued / running / completed / failed / cancelled 状态、attempt、时间戳和闭合动作类别（模型生成 / 工具调用 / 等待上游）；客户端重启后仍可查询，界面不显示 agent 打字动画。
4. @ agent 可中断；中断后 AbortSignal 传播到进行中的模型或工具、禁止后续步骤、持久化取消原因并回到 ready。已产生的部分流不能落成 completed 消息，重复中断幂等。
5. 模型密钥只从 server-side secret provider 进入适配器；消息、权威事件、普通日志、错误响应和诊断导出均不得包含密钥。自动化测试使用哨兵密钥并扫描这些输出为零命中。
6. Agent attempt、调用状态和恢复游标权威持久化。仅闭合 transient 错误自动重试，最多 3 个 attempt，退避为 1 秒 / 4 秒且单次不超过 4 秒；每次调度与 dead-letter event 记录 executionId、attempt、errorCode、nextRetryAt。旧 attempt 的迟到结果不能覆盖新 attempt；预算耗尽进入可查询 dead-letter / failed 并有人工重试；queued / running 时进程退出，重启后任务被恢复或明确终结，不永久停在 running。
7. 工具声明 read-only 或 side-effecting。side-effecting 调用执行前必须展示目标、影响和可逆性，并取得一次性 confirmation；confirmation 绑定 executionId、toolId、规范化参数 SHA-256、roomId、human principal / session family 和 expiresAt，原子消费一次。参数变化、错误 principal / room、过期或重放均拒绝且工具调用次数为 0。取消不伪装成回滚；支持补偿的工具产生可追踪撤销 execution，不支持补偿的工具在确认前标明不可逆。

## 已核实的继承边界

- T-0013 已定义人类 `@` 请求与 Agent `@` 执行的不同语义，但当前真实执行仍是进程内 `AgentToolInvoker` fake；T-0041 需要把它接到权威运行面，不能保留生产 fixture 分支。
- T-0040 已提供 server-minted `InternalAgentCommandContext`、单一 AuthorityWorker writer、事务事件/outbox、Agent membership/tool permission 复核和基础 Agent execution 事实。T-0041 必须扩展这套权威模型，不能另建旁路状态库或可伪造 Agent 身份。
- 当前 `AgentExecution` 只有 `running / completed / interrupted / failed`，缺少 `queued / cancelled`、attempt、动作类别、恢复游标、闭合错误、重试/dead-letter、execution grant 和一次性 confirmation。
- 当前 production composition root 只装配 auth、room lifecycle、messages、collaboration primitives、sync 与 WebSocket；没有模型 Provider、Agent scheduler、工具 registry 或 secret provider。
- 当前公共 WebSocket 协议没有真实 Agent invocation / interrupt / manual retry / confirmation 入口；设计必须保持 human request 与 Agent execution 的数据、接口和渲染分离。

## 必须先裁决的设计问题

1. 首个独立生产 ProviderAdapter 使用哪个真实外部模型 endpoint。
2. 两个物理不同工具目标及 side-effecting 工具的安全沙箱边界。

owner 已确认下列裁决；设计文档通过独立规格审查后再进入生产实现。

## 运行时架构裁决

### R1 · 进程内有界 orchestrator + 独立 AuthorityWorker（推荐）

- `AgentRuntimeService` 在 server 主进程维护有界 room queue、AbortController 与 Adapter registry；网络模型调用、异步文件 I/O 和固定参数 child process 都不在事件循环做同步阻塞。
- 每个可观察 transition、attempt、grant、confirmation 和 retry/dead-letter 事实都先经既有 AuthorityWorker 单 writer 提交；运行时内存只保存当前活跃句柄和尚未提交的流片段。
- Provider 完整成功后，由一个权威命令原子写入 Agent message 与 execution completed；取消或失败时丢弃部分流，不能留下伪 completed message。
- 优点：最少新增跨线程协议，直接复用 T-0040 的事务/outbox/capability，Node 单进程 Alpha 的故障恢复边界清晰。
- 代价：恶意或 CPU-bound tool 不能直接运行在主进程；所有生产 tool adapter 必须是非阻塞远端调用、固定 allowlist child process 或受限 sandbox adapter。

### R2 · 独立 AgentRuntimeWorker + AuthorityWorker

- 新建第二个长期 Worker，独占 Provider stream、scheduler 与 tool adapters；主进程只转发 lifecycle 命令，AuthorityWorker 仍是唯一数据库 writer。
- 优点：运行面异常与 WebSocket 主循环隔离，适合后续 CPU-heavy 解析。
- 代价：Abort、stream、secret、tool confirmation 和 opaque capability 都要新增一套 closed worker protocol；跨 Worker crash/restart 次序更复杂，T-0041 大量工作会花在传输而非产品合同。

### R3 · 每个 execution 启动独立 child process

- 每次 Agent execution 以短生命周期 child 承载 Provider 与工具调用。
- 优点：最强进程隔离，可通过终止 child 强制停止。
- 代价：启动成本高；流式背压、secret 注入、confirmation、attempt recovery 和 child orphan 清理最复杂；容易把已存在的 AuthorityWorker 变成旁路协调器。

推荐 R1。当前 T-0040 明确是单服务进程 Alpha；R1 把“不可信或可能阻塞的实际目标”隔离在 adapter 对应的远端 endpoint、固定 binary 或 sandbox，而不是先为 orchestrator 本身增加第二套 worker protocol。

## Provider 裁决

- **P1 · OpenAI Responses API（推荐）**：生产 adapter 通过原生 `fetch` 调用 Responses endpoint，`stream: true` 解析 closed SSE 事件；`AbortSignal` 直接终止请求。模型名、base URL 与 secret 名均为服务端配置，API key 只由 server-side secret provider 交给 adapter。
- **P2 · Anthropic Messages API**：同一 ProviderAdapter 合同，生产实现改为 Anthropic stream；其余 scheduler、authority 和 tool gateway 不变。
- **P3 · 通用 OpenAI-compatible endpoint**：部署灵活，但各兼容实现的 SSE 事件、tool call 与错误分类容易漂移；首版需要把更多 provider-specific 差异留在运行时主合同之外，因此不推荐作为唯一生产验收目标。

CI fake 与 opt-in live smoke 都只依赖 ProviderAdapter；选择 P1 或 P2 不改变权威状态机。首版只实现一个独立生产 adapter，避免把“多 provider 框架”冒充“一个真实 provider 已可用”。

## 物理工具目标裁决

- `http-json.read`：read-only HTTPS endpoint adapter，只允许配置的 origin、固定响应字节上限和 JSON content type。
- `repository.git-status`：read-only 固定 binary adapter，只执行配置仓库上的固定 `git status --porcelain=v1`，不接受任意 argv 或 shell 字符串。
- `sandbox-file.write`：side-effecting sandbox adapter，只允许配置根目录内的规范化相对路径；确认卡展示目标、覆盖影响与可逆性。执行前保存前态摘要；成功后可由新的补偿 execution 恢复或删除，不能把取消描述成自动回滚。

至少两个 Agent 分别只获 `http-json.read` 与 `repository.git-status`，从物理 endpoint / binary 上证明能力差异；`sandbox-file.write` 专门闭合 side-effect confirmation 与 compensation 合同。生产不提供通用 shell。
