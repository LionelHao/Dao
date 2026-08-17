# T-0019 「球」的统一定义与持球义务实施计划

日期：2026-08-17
状态：已达到交付条件，等待 owner 验收
权威来源：`docs/plans/2026-08-12-t0021-expand-m3.md` 的 T-0019；本文件只拆解已批准设计，不修改 Blueprint。

## 六条验收标准（逐条原文复制）

1. 定义闭合 BallInCourt 投影及唯一状态映射：awaiting / transferred OpenItem 由 currentOwner 持球；claimed LightTask 由 claimant 持球；delivered LightTask 由已持久化的 verifierActorId 持球；todo / verified LightTask 不产球；Blueprint adapter 的 claimed / awaiting 由权威 assignee 持球，blocked mention 只在权威 blocked fact 明确点名一个 actor 时产球。每个球包含唯一 holder、roomId、source kind / id、reason、since 与 deadline，不能用消息文本、verifierRole 或多人集合猜 holder。
2. 同一查询接口覆盖讨论阶段（OpenItem）、轻量群（OpenItem + LightTask）和蓝图群（GBP adapter）；相同 source 重放去重，事实关闭或转交后旧 holder 立即消失且新 holder 原子可见。
3. agent 持有逾期球时产生不可抑制的结构触发，必须回答、回报进展或持久化 failed / blocked reason；human 持球只产生“待我处理”条目和按通知策略的提醒，绝不自动替 human 发言或强制回应。
4. 默认阈值有确定性时钟：OpenItem 使用配置的冷却/到期值，Blueprint task / awaiting 默认 7 天，blocked mention 立即进入 holder 视图。阈值前无逾期事件，边界到达恰好一次，重启不重复。
5. Ball 查询、逾期事件和 route summary 遵守当前 room / principal 权限；被移除成员不能读取新球，历史承诺事实不删除。多客户端同步后 holder 与服务端一致。
6. M3 只交付 room-scoped NeedsActionProjection 与 ReminderCandidate，不建设跨群五分区收件箱、通知策略或送达通道；room UI 将“纯未读”和“需要我动”分开显示，同一消息可已读但仍有球。端到端测试覆盖 OpenItem 转交、LightTask 交付、Blueprint-adapter awaiting 三种来源的 holder 变化，并断言逾期 agent 球进入 T-0016 的 BallSummary 后只产生一次结构触发。Blueprint adapter 在本任务只提供只读投影端口与契约测试，实际 GBP 接入和写入仍属于 M5，跨群收件箱与通知属于 M4 T-0022 / T-0023。

## 文件级切片与 TDD 顺序

1. Core closed contracts：先在 `packages/core/src/collaboration.test.ts`、`collaboration.type-test.ts` 和 `sync.test.ts` 写失败测试，再在 `collaboration.ts`、`sync.ts`、`index.ts` 增加 BallInCourt、NeedsActionProjection、ReminderCandidate、BallOverdueTrigger 及严格 guard/投影函数。
2. Authority schema v10：先扩展 `packages/server/src/persistence/schema.test.ts` 的 fresh、v1-v9 历史升级、future/unknown refusal、迁移中断回滚和 invariant 测试，再只追加 immutable v10 migration、checksum、fingerprint。
3. Authority query/clock：先为真实 SQLite worker 写 OpenItem 转交、LightTask 交付、权限撤销、边界 exactly-once、重启去重测试，再实现统一 `ball.query` / `ball.scan-overdue` operation；OpenItem 到期值由 server-private config 显式传入，Blueprint 默认七天，时钟由调用方注入。
4. Blueprint read-only seam：先写 adapter contract tests，再实现只读 `BlueprintBallProjectionPort` 与 bounded empty production adapter；不创建或写入 GBP task。
5. Route integration：先补 route authority/decision 测试，确认仅逾期 agent 球写入 T-0016 `BallSummary`/`hasBall`，且 ball trigger 跳过软抑制并 exactly-once；human 球只投影 needs-action/reminder。
6. Sync/WebSocket/Desktop：先补 closed frame、repair、DOM 测试，再加入 room-scoped query/ack、同步记录和独立“需要我动”区域；read receipt 不改变 ball。
7. E2E/交付：补 real-worker、SQLite restart、多客户端、cache-clear 和 Blueprint fake-port E2E；运行全量门禁，记录精确文件/测试数并编写交付说明。

## 验收映射

| 标准 | 代码切片 | 自动化证据 |
| --- | --- | --- |
| 1 | Core projection、Blueprint read port | closed guard/type tests、状态映射反例 |
| 2 | Authority `ball.query`、source 唯一键 | 转交/关闭原子可见、重放去重 E2E |
| 3 | overdue trigger、needs-action/reminder split、route input | agent/human 分流及不可抑制 route tests |
| 4 | v10 overdue claims、deterministic scan clock | threshold 前/边界/重启 exactly-once tests；v10 checksum `a7a668d54ddd3636f2e2bafcb7e55be8c9771d56c19a6ca5e3c79027a6647105`，fingerprint `7fd3399cc25e505de80d69adae24f7fc5a027de57cfb3e0b56df294e454c91fb` |
| 5 | membership-scoped query/event/route snapshot | removed-member、multi-client sync E2E |
| 6 | room-scoped projections、desktop split、Blueprint read seam | read-vs-needs-action DOM tests及三来源 E2E |

## 边界

- 不读取消息文本来猜 holder，不从 verifierRole 展开多人。
- 不建设跨 room inbox、通知投递、T-0020 让位策略或 M5 GBP 写入。
- 不修改 Blueprint HTML/JSON，不把 T-0019 标为 verified。
