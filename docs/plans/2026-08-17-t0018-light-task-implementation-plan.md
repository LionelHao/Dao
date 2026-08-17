# T-0018 · 轻任务：轻量群的最小承诺 · 实施计划

## 权威输入与范围

- 权威任务合同：`docs/plans/2026-08-12-t0021-expand-m3.md` 的 T-0018 六条验收标准。
- 复用 T-0040 AuthorityWorker、room event/outbox/idempotency/sync/repair，复用 T-0017 的承诺事实与 closed WebSocket 模式；不建立第二套 writer、状态库或身份旁路。
- 不实现 T-0019 BallInCourt、M5 Blueprint adapter 写入或 GBP 专属状态；不修改 Blueprint HTML/JSON。

## 六条验收标准（逐条复制）

1. LightTask 是闭合权威事实，完整字段为 id、roomId、sourceMessageId、title、`claimant: ActorId | null`、`claimantRoleAtClaim: RoleId | null`、verifierRole、`verifierActorId: ActorId | null`、criteria（可为空）、status（todo / claimed / delivered / verified）、createdAt / claimedAt / deliveredAt / verifiedAt；todo 的 claimant / claimantRoleAtClaim / verifierActorId 均为 null，claimed 原子冻结 claimant 与 claimantRoleAtClaim 且 verifierActorId 为 null，delivered 必须把不同于 claimantRoleAtClaim 的 verifierRole 解析为唯一且不同于 claimant 的当前 room member并写入 verifierActorId，verified 保留这些审计字段。所谓“轻量”明确指不含 deps、maturity、milestone、blocked、dropped、superseded 等 GBP 专属规划字段，而不是省略事实身份、角色快照与来源字段。
2. 群消息里的“我来做”仍只是意图；只有 human 显式确认创建 LightTask 后才成为承诺。创建命令绑定 sourceMessageId 和稳定幂等键；取消确认或 ACK 重试均不产生幽灵/重复任务。
3. 状态只允许 todo→claimed→delivered→verified 的前向转换。claimed 需要当前 room member；delivered 时 verifierRole 必须不同于 claimantRoleAtClaim 且恰好解析到一个当前成员，零人、多人、同一 actor 或不同 actor 但同 role 均返回 409；verified 只能由该 verifierActorId 执行。criteria 非空时必须逐条 met；为空时需要验收者显式确认。测试矩阵明确覆盖同身份拒绝、不同身份同角色拒绝、不同角色唯一 actor 通过。
4. LightTask 创建、转换、criteria 勾选与 room event / outbox / idempotency 同事务；多客户端、服务重启和清缓存恢复后状态一致，认领者被移除后历史保留但新转换按当前权限拒绝。
5. 桌面端显示四态、认领者、验收者角色与 criteria；不渲染依赖图、maturity 或里程碑入口。直接调用 API 注入这些字段被 closed parser 拒绝，不以 UI 隐藏代替。
6. 提供不依赖 GBP 的只读投影，能无损导出标题、认领人、四态、criteria 与来源；不得在本任务中写 Blueprint 或伪造 GBP task ID，升级写入留给 M5 适配任务。

## 文件级切片与测试顺序

1. `packages/core/src/collaboration.test.ts`、type tests 与 `sync.test.ts` 先红：closed `LightTask`、criteria、四态时间戳/角色/actor 不变量、只读 projection 与 repair/event union；再改 core contracts/exports。
2. `packages/server/src/persistence/contracts.test.ts` 先红：human-only create/claim/deliver/verify/criterion commands，严格拒绝 deps/maturity/milestone/GBP id/status 注入；再改 closed parsers、primitives 与 worker protocol。
3. `packages/server/src/persistence/schema.test.ts` 先红：immutable v9、fresh v1→v9、历史 v1…v8→v9、future/unknown refusal、失败回滚、角色快照与状态不变量；保持 v1-v8 migration/checksum/fingerprint 不变。
4. `sqlite-authoritative-store.test.ts` 先红：显式确认创建、取消零写、幂等、前向 CAS、claim role freeze、verifier 0/1/N 与同 actor/同 role 矩阵、criteria met/empty confirm、成员移除、event/outbox 同事务。
5. `protocol.test.ts` / `websocket.test.ts` 先红：closed human frames/acks、403/409、未知/GBP 字段拒绝；再接 production composition。
6. snapshot/sync/replica 与 `authority.e2e.test.ts` 覆盖真实 worker/SQLite restart、clear-cache、多客户端重放和不依赖 GBP 的无损只读 projection。
7. `packages/desktop/src/renderer/app.test.ts` 先红：四态、claimant、verifier role/actor、criteria 与无 GBP 控件；再改 renderer/style。
8. 编写 `docs/deliveries/T-0018-轻任务轻量群的最小承诺-交付说明.md`，逐条映射证据；运行全部质量门并报告精确测试计数。

## 预期 schema v9

- 新增 immutable `light_tasks`，criteria 以有界、闭合且保持顺序的 `criteria_json` 存储；状态与时间戳、claimant/role/verifier 字段由 CHECK/trigger 闭合，criteria 的稳定 ID、文本与顺序由 trigger 锁定，仅允许验收阶段更新 `met`。
- criteria 勾选与状态转换在同一个 AuthorityWorker transaction；verified 后事实不可改写，历史成员移除不级联删除。
- v1-v8 migration statements、checksum 与 fingerprint 保持字节级不变。
