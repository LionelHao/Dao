# T-0014 编辑撤回与表情回应的人 / agent 分治 · 交付说明

## 1. 做了什么

在 API 层拒绝 agent 消息的编辑/撤回，支持追加关联更正；同时将人对人的社交表情和人对 agent 的校准信号拆为不同记录与呈现。

## 2. 逐条对照验收标准

1. **满足** — 「人的消息可编辑可撤回；agent 的消息在 API 层就拒绝编辑与撤回请求（返回明确错误，不是 UI 隐藏按钮）」：`editMessage`/`recallMessage` 更新 human `MessageState`；agent 目标在 API 立即抛出 `agent_message_immutable`，服务端测试直接断言错误码。
2. **满足** — 「agent 消息的更正走追加：原消息保留不变，更正内容以关联条目追加在后，两者在界面上都可见（设计稿 C-05）」：`correctAgentMessage` 生成 `AgentCorrection.originalMessageId`，不修改原 `MessageState`；预览保留原 agent 消息并展示 `data-correction-for="preview-agent-data"` 更正卡。
3. **满足** — 「人对人的表情回应不触发任何系统行为；人对 agent 的 👍/👎 写入一条校准信号，可被发言判定逻辑读取」：human 目标只进入 `SocialReaction`；agent 目标且 emoji 为 👍/👎 才进入 `CalibrationSignal`，可由 `calibrationSignalsFor(agentId)` 读取。测试断言两组各一条且不混用。
4. **满足** — 「存在测试：对 agent 消息发起编辑或撤回请求，断言返回错误码而非成功」：`primitives.test.ts` 连续断言两种调用均为 `CollaborationPrimitiveError("agent_message_immutable")`。

## 3. Buzz 参照与偏离

- **参照了什么：** Buzz 的 append-first 持久事件和 ACK 后副作用不回滚语义。
- **怎么翻译：** 以 TypeScript 的不可变原消息状态与单独 `AgentCorrection` 关联项保留历史；校准不与社交表情共用数组或查询 API。
- **为何偏离：** 不照搬 Nostr 可替换事件、审计链或 Buzz 的统一参与者行为；PRD 律三要求 agent 是行为记录，只能追加更正，且本产品把 agent 👍/👎 翻译为发言判定输入。

## 4. 解锁了什么

为后续 M3 的在线校准/噪音率分析提供只读 `CalibrationSignal` 输入，并保持 agent 历史可追溯。

## 5. 交付前自检

- [x] 五条命令在干净克隆上全过：install / typecheck / lint / test / build
- [x] 新增行为都有测试；无 `.skip` / `.only`；无未解释的 `@ts-expect-error`
- [x] 触及的原语已逐条对照 PRD 2.3 与设计稿，且数据层 / 接口层 / 渲染层三层都落地
- [x] 参照 Buzz 的地方写明了：参照什么 / 怎么翻译 / 为何偏离
- [x] 交付说明四段齐全
- [x] `gbp.py check --links` 零违规、零死链
- [x] 当前唯一 ⚠「可认领池为空」来自 @lionel 明确要求本轮认领全部可认领任务；统一验收后再由 @lionel 排定下一波，不是链接或宪法告警
- [x] 没有改动自己认领任务的验收标准
- [x] 没有写入蓝图；所有蓝图写入仍应仅由主协调者走 `gbp.py` 命令
