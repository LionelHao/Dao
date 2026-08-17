# T-0017 · 待答项：最轻的承诺单位 · 实施计划

## 权威输入与范围

- 权威任务合同：`docs/plans/2026-08-12-t0021-expand-m3.md` 的 T-0017 六条验收标准。
- 复用 T-0040 的 AuthorityWorker、room event/outbox/idempotency/sync/repair，复用 T-0041 的 AgentExecution 与 server-minted Agent capability；不建立第二套状态库或身份旁路。
- 不实现 T-0018 LightTask、T-0019 BallInCourt、T-0020 human preemption，也不手改 Blueprint HTML/JSON。

## 六条验收标准（逐条复制）

1. OpenItem 是闭合权威事实，包含 id、roomId、sourceMessageId、content、唯一 currentOwner（human 或 agent）、requester、status（awaiting / answered / deferred / transferred）、transferChain、createdAt / respondedAt；awaiting 与 transferred 必须有 currentOwner，后者必须等于 transferChain 的最后接收者；answered / deferred 为终态且不再产生活跃 owner。类型层禁止无 owner、多 owner、链尾不一致或未知状态。
2. 三种产生方式均持久化且幂等：human 明确 @ human；Agent execution 输出闭合 risk / challenge proposal（含 targetActorId、sourceExecutionId、sourceMessageId 与非空 reason）并通过服务端权限 / 同 room 校验；human 手动把消息标记为“这事没完”。不得从自然语言猜 proposal 类型或 target。重复命令只返回同一 OpenItem；source message 必须同 room 且当前可见。
3. @ agent 继续只创建 Agent execution，不创建 OpenItem；@ human 只创建 OpenItem，不触发 Agent execution。自动化测试同时断言两张事实表和对应事件，防止双写或串义。
4. human owner 可回答、搁置、说明做不了或转交给当前 room member；转交追加不可改写的完整链。agent owner 不能拒绝/搁置/转交，只能回答；其 execution failed 时 OpenItem 保持 awaiting 且 currentOwner 不变，同时追加失败 reason / attempt 事件，允许按 T-0041 人工重试，human requester 仍可显式转交或 deferred，BallInCourt 继续由该 agent 持有直到权威状态转换。越权状态转换在 API 层返回 403 / 409。
5. OpenItem 创建与转换和 room event / outbox / idempotency 同事务；服务重启、客户端清缓存及多客户端重放后只出现一次，历史 source message 不因成员移除而删除，但后续操作遵守当前权限。
6. 桌面端按设计稿 D-01 显示内容、唯一 owner、来源和四态；human 请求提供回应 / 搁置 / 转交，agent 调用不出现这些 human-only 操作。DOM / class 与 API 负例共同锁定差异。

## 文件级切片与测试顺序

1. `packages/core/src/collaboration.test.ts`、`sync.test.ts` 与 type tests 先红：新 OpenItem closed union、creation provenance、agent failure event；再改 `collaboration.ts`、`sync.ts`、`index.ts`。
2. `packages/server/src/persistence/contracts.test.ts` 先红：human mention/manual、server-private agent proposal、closed transition/failure 命令与 human/agent command union 分离；再改 contracts、worker protocol/client。
3. `packages/server/src/persistence/schema.test.ts` 先红：immutable v8、fresh v1→v8、历史 v1…v7→v8、future/unknown refusal、故障回滚、旧 OpenItem 迁移与 v1-v7 checksum/fingerprint 不变；再改 `schema.ts`。
4. `packages/server/src/persistence/sqlite-authoritative-store.test.ts` 先红：三种创建、权限矩阵、终态/CAS、完整 transfer chain、agent failure event、同事务 event/outbox/idempotency、重启重放；再改 AuthorityWorker handler。
5. `packages/server/src/protocol.test.ts`、`websocket.test.ts` 先红：closed v2 frames、403/409、@human 与 @agent 双表/事件负例；再接 `protocol.ts`、`websocket.ts`、composition root 的 OpenItem service。
6. Agent proposal 通过 server-private runtime seam 接入；production provider 只接受闭合结构化 proposal，不从正文猜测。Fake 只在 deep test seam 注入。
7. `packages/desktop/src/renderer/app.test.ts` 先红：D-01 内容、唯一 owner、来源、四态和 human-only actions；再改 renderer/style，不混入 AgentExecution 操作。
8. `authority.e2e.test.ts` 与 client replica tests 覆盖 real worker/SQLite restart、清缓存、多客户端重放和成员移除后历史保留/新操作拒绝。
9. 编写 `docs/deliveries/T-0017-待答项最轻承诺单位-交付说明.md`，逐条映射代码/测试；运行全部仓库质量门并报告精确测试计数。

## 预期 schema v8

- 重建 `open_items` 为 closed v8 物理合同：`current_owner_actor_id` 可空但由状态约束，status 仅 `awaiting/answered/deferred/transferred`，creation provenance 闭合，agent proposal 才允许 execution/proposal 元数据。
- 新增 append-only `open_item_agent_failures`，记录 item/execution/attempt/reason/timestamp；失败不改变 OpenItem owner/status。
- v1-v7 migration statements、checksum 与 fingerprint 保持字节级不变。
