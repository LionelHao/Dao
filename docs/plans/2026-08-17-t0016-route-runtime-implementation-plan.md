# T-0016 · 四层发言判定与单次路由架构 · 实施计划

状态：实施完成，等待 owner 验收。权威合同来自 `docs/plans/2026-08-12-t0021-expand-m3.md`；T-0041 已由 owner 确认并通过 PR #12 合入 `main`，合并提交为 `6eccfa8`。本计划只实现 T-0016，不提前实现 T-0020 的人来让位策略或 T-0019 的持球事实来源。

## 1. 基线与保护边界

- Git 基线：`main` / `origin/main` at `6eccfa8`；T-0041 最终验证为 33 文件 / 750 测试。T-0016 从该合并基线开始，所有未提交改动均属于本实施计划。
- schema 只新增 immutable v7；v1-v6 statements、checksum、fingerprint 不修改。
- RouterProvider 与 AgentRuntimeProvider 保持不同 closed input/output；Router 不接收完整历史、secret、工具参数或凭据。
- 显式 direct `@agent` 和 structured help 是确定性 mandatory intent；Provider 失败、漏项或 malformed 不得删除 mandatory intent。
- T-0019 尚未提供真实 BallSummary 来源，因此只实现 closed `BallSummary` 注入 seam 与空生产投影；不伪造持球事实。

## 2. 七条验收标准（从 T-0021 展开合同逐条原文复制）

1. 每条新 room message 恰创建一个持久 RouteJob / 一份逻辑判定；该 Job 的 ProviderAdapter 可按标准 7 最多调用 3 个 attempt，但 room 内 agent 数量不得扩大 Job 数。输入只含该消息、room phase、每个 agent 的 role / participation / capability 摘要、校准摘要和持球摘要；不得为 N 个 agent 各建一个 Job，也不得把完整 room history、模型密钥或工具凭据放进路由输入。T-0013 的显式 `@agent` 解析改为同消息内的持久 mandatory invocation intent，而不是在路由旁边直接再启动一次 execution。
2. RouterProvider 返回闭合有序主动候选计划：每项含 agentId、触发类别（领域 / 风险 / agent 点名 / 持球）、顺序、闭合 reasonCode 与非空 reasonText。确定性地址层先产生两类 intent：direct `@` 对 silent / on-mention / active 生效，闭合 structured indirect help 对 on-mention / active 生效；两类都在 provider 候选前合并，按 `(sourceMessageId, agentId)` 只保留一条 execution 并以 direct `@` 优先记录 reason。provider 超时、取消、漏项或 malformed 不得删除任何适用的地址 intent。额外字段、重复候选、非成员或无权限 agent fail closed，且所有 intent 都做独立权限复核。
3. 三档参与度严格生效：silent 平时只读，但任一当前 room member（human 或 agent）对该 agent 的直接有效显式 `@` 会产生一次性唤醒，回应后立即回到 silent；它不响应未直接寻址的领域、风险或持球触发。on-mention 除直接 `@` 外，还响应另一个 agent 发出的闭合结构化点名 / 求助 intent，但不接受领域、风险或持球触发；因此两档差异是“只认直接寻址”与“也认结构化间接求助”。active 才允许全部四类触发。结构化持球触发不靠模型猜测，且不会被冷却、阶段收紧或“人类优先（软）”抑制。
4. 四条抑制默认值有确定性时钟测试：`topicKey` 由最近 8 条可见消息使用固定 embedding 模型版本与 cosine ≥ 0.82 聚类并持久化，同 agent / 同 topicKey 10 分钟冷却；无人类插入时 agent 连续往返最多 3 轮；60 秒内达到第 3 条 human message 时抑制领域触发但保留风险、点名、持球，第 2 条不抑制；执行阶段同样禁用领域而保留风险、点名、持球。边界前后各有测试，模型 / N / 阈值变化必须版本化而不能静默漂移。
5. 每个 RouteJob 都以创建时的当前 room member agent 集合作为闭合集合，每个成员恰持久化一个最终 judgment：无需回应 / 将回应 / 被抑制，并记录闭合 reasonCode、非空 reasonText、sourceMessageId 与最终 routeAttempt；mandatory 命中、权限拒绝、provider 失败 / 漏项分别有独立 reasonCode。不得少写、重复写或以“未评估”省略任何当前 agent；重试和重启不重复写，客户端可从同步事件恢复。
6. human 对 agent 的“有用 / 这条不必”分别记 +2 / -2，👍 / 👎 分别记 +1 / -1；按 `(agentId, topicKey)` 幂等累计并截断到 [-4, 4]。得分 ≤ -3 时抑制该 agent 的领域触发，得分 ≥ 3 时领域触发可穿透“human 60 秒软降级”但仍受冷却、轮次与阶段收紧；human 对 human 的表情不产生 calibration，相同事实重放分数不变。
7. provider 超时、取消或 malformed 时持久化闭合失败 judgment，不伪造主动 agent 回应且不删除 mandatory invocation；主动路由最多尝试 3 次，退避 250 毫秒 / 1 秒且单次不超过 1 秒，并产生 route.retry-scheduled / route.failed 事件和 attempts-exhausted metric。消息发送 ACK 不等待路由完成。

## 3. TDD 与文件级切片

1. Core：先扩展 `collaboration.test.ts` / type tests / `sync.test.ts`，再增加 closed RouteJob、RouterPlan、RouteJudgment、topic/calibration/BallSummary contracts 与 guards。
2. Persistence：先写 v7 fresh/historical/future/rollback/invariant tests，再追加 route_jobs、route_attempts、route_judgments、route_intents、message_topics、calibration_scores/facts 与 lifecycle events。
3. Runtime：先写 deterministic address merge、participation、四抑制、250ms/1s/3 attempts、closed-provider-failure tests，再实现 server-private `RouteRuntimeService` 与 `RouterProviderAdapter`。
4. Integration：消息 authority transaction 创建唯一 RouteJob；message ACK 后异步调度。Route completion 原子写全体 judgment、mandatory/routed invocation intent 与 outbox，随后调用 T-0041 runtime；不建立旁路 writer。
5. Sync/Desktop：v7 judgment/route lifecycle 可 repair；桌面显示 will-respond/no-response/suppressed 的闭合 reason，不显示 routing typing animation。
6. Evidence：real AuthorityWorker/SQLite restart、multi-agent one-job、secret/input sentinel、metrics；编写 T-0016 delivery 并运行完整质量门。
