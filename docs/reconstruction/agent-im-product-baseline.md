# Agent IM 产品基线

> **历史重建稿提示（2026-08-18）：** 本文的“待 owner 审核”和“遗失设计稿”判断已被后续批准与交付取代。当前产品定义请使用[已批准 PRD](./2026-08-agent群聊协作模式-prd.reconstructed.md)，当前 UI / 交互基线请使用[设计基线索引](../design/README.md)。本文仅保留为重建过程证据，不再作为新 spec 的规范入口。
>
> 状态：**重建稿，待 owner 审核**
>
> 版本：Reconstruction Baseline 0.1，2026-08-17
>
> 代码锚点：`main@bbf3d087f593cea8e193311a8ca51a1160db67a0`
>
> 配套索引：[Agent IM 产品证据索引](./agent-im-evidence-map.md)

本文是一份依据现存代码、测试、计划、协议、交付说明、迁移快照与陈旧蓝图形成的**新产品基线候选**。它不是遗失 PRD、桌面设计稿或交互原型的原文，也不声称恢复了原稿措辞、页面布局或 owner 验收状态。

> 档案警示：旧 Blueprint 的 T-0036 与当前仓库 T-0036 同 ID 异义；旧 PRD、设计稿、交互原型和 journal 相对链接均已断裂；本基线不继承任何旧任务状态。**A/D 证据**见配套索引 7.1～7.4。

本文每条规范或结论使用以下等级：

- **A｜已恢复决策**：现存权威文档或多个独立证据直接支持。
- **B｜实现反推**：当前代码/测试如此工作，但无法证明与遗失原稿相同。
- **C｜重建提案，待 owner 批准**：为形成可执行新基线而新增的候选要求。
- **D｜未知**：证据不足，保留未知，不补猜。

路径约定：首次引用使用绝对本地路径；后文的“同上”、`T-xxxx 交付/计划`、`authority-database-handler.ts` 等短名，均回指配套证据索引 2.2、2.3 与附录 A 中列出的唯一绝对路径。

组合标记约定：`A+B`、`B+D` 等不是新等级，只表示同一行分别陈述了 A/B/D 内容；每个子句仍按原等级解释。

## 1. 一页产品定义

### 1.1 产品定位

| 项目 | 基线表述 | 等级与来源 |
| --- | --- | --- |
| 产品类别 | 为 Human 与多个 AI Agent 持续、共享、多方在场地协作而原生设计的 IM | **A｜已恢复的早期意图**；`/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:56-60`、`:1073` |
| 不是什么 | 不是现有 IM 加 Bot，也不是给 Agent 工具套聊天壳 | **A｜已恢复的早期意图**；同上 |
| 核心假设 | 对复杂 idea，持续、共享、多方在场的空间，相比一次性调用能产生独特协作价值 | **A｜已恢复的早期意图，仍待验证**；蓝图 `:58`、`:108-152` |
| 核心设计法则 | Human 与 Agent 在身份、在场、已读/已判定、@、编辑/撤回、表情、发言判定、承诺、工具权限和消息顺序上保持类型、权限与视觉分离 | **A｜已恢复决策**；T-0011～T-0014、T-0016～T-0020、T-0039～T-0041 交付与协议，逐项见证据索引第 3 节 |
| 承诺原则 | 群聊发言不自动成为约束；只有进入 OpenItem、LightTask 或外部 Blueprint 承诺层后才产生权威义务；BallInCourt 回答当前由谁行动 | **A｜已恢复决策**；蓝图 `:59-60`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:76-113` |
| 自动化边界 | “用户始终在环、不做无人值守”是 **A｜早期意图**，当前批准状态 **D**；side-effecting 工具的一次性 Human confirmation 是 **A｜当前 M3 决策** | 蓝图 `:62-67`；T-0041 交付 `:49-54`、`:71-79` |
| 当前成熟度 | Core/Server 已有大量 M2/M3 权威领域能力与闭合测试；shipping Desktop 仍是静态 review shell，尚未接通 auth/WebSocket/sync/command，不能称为端到端可用 IM | **B｜实现反推**；`/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`、`preload.ts:1`、`renderer/main.ts:14-23`、desktop `package.json:6-14` |

### 1.2 新基线候选产品承诺

**C｜重建提案，待 owner 批准：**

> 在一个持续存在的共享房间里，Human 能与多个身份、参与度、能力和工具权限明确的 Agent 协作；系统让每条消息是否已被 Human 阅读、是否已被 Agent 判定、谁会回应、Agent 正在做什么、承诺由谁持有、何时需要 Human 行动都可见、可解释、可恢复，并始终让新 Human 输入优先进入权威顺序。

该表述是对已恢复目标和当前实现的重新编写，不是原 PRD 引文。来源边界：蓝图 `:56-60`、`:1073`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:37-42`、`:48-126`。

### 1.3 非目标

以下是 **A｜已恢复的早期意图**；是否继续作为当前非目标，整体属于 **C｜待 owner 重新批准**：

1. 音视频。
2. 文件网盘。
3. 组织架构。
4. 审批流。
5. 外部 IM 桥接。
6. 通用 Agent 角色库与提示词工程。
7. Thread/串。
8. 无人值守全自动执行。

来源：`/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:62-67`。其中 Thread、外部桥接和无人值守边界没有找到当前 owner 的 superseding decision，因此其当前批准状态为 **D｜未知**。

## 2. 当前基线的能力边界

| 能力层 | 当前事实 | 基线判断 |
| --- | --- | --- |
| Core 类型与不变量 | Actor、membership、message、read/judgment、OpenItem、LightTask、Ball、runtime/route/preemption、reaction/calibration 均有类型、guard 和测试 | **B｜已实现领域底座**；`/Users/leo/code/Dao/packages/core/src` |
| 权威持久化 | SQLite schema v11、事务内领域事实/event/idempotency/outbox、room streamSeq、sync/repair/restart | **A+B｜当前事实源**；`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md`；`/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:4`、`:1354-1359` |
| 身份与房间 | 服务层支持 Human 登录、治理、邀请与 Agent 配置加入；但治理命令未暴露到当前 WebSocket ClientFrame | **B｜库能力存在、产品面不完整**；`room-lifecycle.ts:313-361`、`:1226-1327`；`protocol.ts:256-281`；`authoritative-server.ts:239-244`、`:387-396` |
| M2 原语 | Human read/calibration 已有 SQLite authority 但无 ClientFrame；edit/recall/correction/social reaction/`@all/@here` 只在 compatibility/UI；M2 AgentJudgement 与 M3 RouteJudgment 是两套事实 | **A+B｜规格存在、当前网络面/事实模型有缺口**；证据索引 4.1 |
| Agent runtime | 真实 OpenAI Responses provider、状态机、取消/恢复、三种真实工具；显式 Human invocation 可走 side-effect confirmation，自动 routed/replacement 当前不能执行 side effect | **A+B｜服务端实现边界**；T-0041 交付；`agent-runtime-service.ts:475-504`；`authority-database-handler.ts:5299-5302` |
| 单次路由 | 正文消息有 RouteJob、确定性意图/provider/judgment；但显式 ClientFrame `agent.invoke` 可绕过 RouteJob，和现行单次路由合同冲突 | **A+B｜合同已恢复、实现不闭合**；T-0016/T-0021；证据索引 B-SURFACE-04a |
| 承诺层 | OpenItem/LightTask 是 SQLite 持久事实；Ball/NeedsAction/Reminder 是读时投影，另有 boundary claim/overdue event，客户端通过 `ball.query` 获取 | **A+B｜服务端边界**；T-0017～T-0019；`/Users/leo/code/Dao/packages/core/src/sync.ts:55-69`；`/Users/leo/code/Dao/packages/server/src/websocket.ts:1640-1650` |
| 人来让位 | commit/cancel/abort/route/replacement fence 与恢复存在 | **A+B｜服务端已实现，有待批准安全例外**；T-0020 交付与 human-preemption 代码 |
| Desktop | Human/Agent 视觉、承诺卡、执行状态等静态 review fixtures；client replica 是需注入 transport/cache 的库 | **B｜非 live 产品接线**；`packages/desktop/src` |
| 外部真实性 | 两个 OpenAI live smoke 本次因未启用环境变量/secret 而跳过；真实 endpoint、目标网络与 SLA 未验证 | **B｜跳过事实 + D｜外部可运行性未知**；两个 `*.live.test.ts:6-10` |
| 真实团队价值 | 未找到 H1/H1b/H3 结果或连续四周团队数据 | **D｜产品假设未证实**；蓝图 `:108-152` |

## 3. Actor、身份与房间模型

### 3.1 Human 与 Agent

| 维度 | Human | Agent | 等级与来源 |
| --- | --- | --- | --- |
| Actor 状态 | reachability | readiness + toolPermissions | **A+B**；T-0011 交付 `:17-25`；`/Users/leo/code/Dao/packages/core/src/index.ts:1-21` |
| 房间成员身份 | owner/admin/member 的社会治理角色 | silent/on-mention/active participation + room tool grants | **A+B**；identity protocol `:35-67`；`core/src/index.ts:55-77` |
| 登录 | 认证 Human principal/session | 不通过 Human 登录获得会话 | **A+B**；identity protocol `:5-13`；`server/src/auth.test.ts:334` |
| 加入 | 一次性邀请，Human 接受或拒绝 | owner/admin 配置 participation 与 grants 后立即生效 | **A+B**；identity protocol `:35-67` |
| 消息作者 | 服务端从 Human principal 与 membership 派生 | runtime/authority 内部铸造，客户端不能伪造 | **A+B**；identity protocol `:28-33`；`core/src/index.ts:97-104` |
| 阅读语义 | 已读 receipt | 已判定 judgment，不伪装成“已读” | **A**；T-0012 交付 `:5-24` |
| 消息修订 | 可编辑/撤回 | 不可编辑/撤回，只能追加更正 | **A**；T-0014 交付 `:5-18` |
| 表情 | Human→Human 是社交事实 | Human→Agent 的 👍/👎 是 calibration | **A**；T-0014 交付 `:11-22` |
| 视觉 | 圆头像 + 气泡 | 方头像 + 角色色轨 + 无气泡结构 | **A+B**；T-0011 交付 `:21-25`；`desktop/src/renderer/app.ts:191-388` |

### 3.2 房间治理不变量

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| ID-01 | 客户端不得选择消息 `authorId` 或 `authorKind`；服务端必须从认证 principal 和当前 membership 派生。 | **A**；`/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:28-33` |
| ID-02 | Human invitation 与 Agent configuration 必须是不同 command、事实和权限路径。 | **A**；同上 `:35-67` |
| ID-03 | 房间权限必须在服务端 command 内检查；UI 隐藏不能代替授权。 | **A**；同上 `:69-91` |
| ID-04 | 移除成员后必须保留历史消息，同时立即停止其新读写、寻址和实时投递。 | **A**；同上 `:93-106` |
| ID-05 | Agent room grants 必须是其 actor capability 的合法子集；每次工具 dispatch 还要重新检查当前 membership 与 execution grant。 | **A**；T-0041 交付 `:17-21`、`:49-54` |
| ID-06 | Actor profile/presence 的更新合同必须闭合：displayName、全局 tool capability、reachability/readiness 各自的 producer、权限、heartbeat/TTL 与持久/临时语义。 | **C｜待 owner 批准**；当前整个 Actor payload 只有静态 seed，证据 `/Users/leo/code/Dao/packages/server/src/persistence/authority-worker.ts:400-466`、`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:140-152` |
| ID-07 | owner transfer、多 owner、最后 owner 离开或被移除的行为。 | **D｜未知**；T-0039 交付 `:65-70` 明确仍待收紧 |
| ID-08 | 是否允许无工具权限的纯对话 Agent 入群。 | **D｜未知**；当前协议要求非空 grants，identity protocol `:51-67` |

## 4. 权威事实模型

| 事实 | 规范语义 | 当前权威产品面 | 等级与来源 |
| --- | --- | --- | --- |
| Room / Membership | 房间、治理角色、Agent participation/tool grants | SQLite 与 service 已有；WebSocket 治理命令未接 | **A+B**；identity protocol；`room-lifecycle.ts`；`protocol.ts:256-281` |
| Message | 已耐久接受的 Human/Agent 内容，作者由服务端派生 | WebSocket 已有 send/ack/history/sync | **A+B**；message-ack protocol；`service.ts:118-186` |
| HumanReadReceipt | Human 对消息的已读事实 | SQLite authoritative command/event/outbox/repair 已有；当前 ClientFrame 未暴露 | **A+B**；T-0012 交付；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2630-2672`；`protocol.ts:256-281` |
| M2 AgentJudgement | Agent 对 source message 的 will_respond/no_response/suppressed 与原因 | 独立 `agent_judgments` authoritative fact/event/repair；当前 ClientFrame 未暴露 | **A+B**；T-0012 交付；`authority-database-handler.ts:3473-3525`；`/Users/leo/code/Dao/packages/core/src/sync.ts:55-67`、`:165-175` |
| AgentCorrection | Agent 消息的追加式更正，原消息不变 | compatibility primitives 与静态 UI；非当前权威 ClientFrame | **A+B**；T-0014 交付；`primitives.ts:839-865` |
| SocialReaction | Human→Human 纯社交 reaction | compatibility primitives；非当前权威 ClientFrame | **A+B**；T-0014 交付；`primitives.ts:867-906` |
| CalibrationSignal | Human→Agent 的有用/不必、👍/👎 校准 | route calibration authority 部分已有；通用客户端 reaction command 未暴露 | **A+B**；T-0016 交付；route/authority 源码 |
| AgentExecution | Agent 调用/路由工作的状态、attempt、动作、结果与取消 | SQLite、runtime、WebSocket 已有 | **A+B**；T-0041 交付；agent-runtime 源码 |
| M3 RouteJob / RouteJudgment | 每条消息的单次路由与创建时 Agent 闭集判定 | 独立 `route_judgments`；route 不填 M2 `agent_judgments`；显式 `agent.invoke` 又可绕过 RouteJob | **A+B｜未统一/有旁路**；T-0016；`authority-database-handler.ts:3994-4028`、`:4275-4297`、`:4735-4822` |
| OpenItem | 唯一 owner 的待答承诺与转交链 | SQLite、显式 ClientFrame、sync 已有；正文 `@human` 不自动创建 | **A+B**；T-0017 交付；`protocol.ts:206-225` |
| LightTask | Human 显式创建的四态轻任务，角色分权验收 | SQLite 与 ClientFrame/sync 已有 | **A+B**；T-0018 交付；authority 源码 |
| BallInCourt | OpenItem/LightTask/Blueprint 的单 holder 派生投影 | 读时 projection；生产 Blueprint adapter 为空，不属于 sync repair record | **A+B**；T-0019 交付；`core/src/sync.ts:55-69`；ball 源码 |
| NeedsAction / ReminderCandidate | Human 的本人行动项/提醒候选；不代替 Human 发言 | 读时 room-scoped query；无跨群或 durable reminder 送达 | **A+B**；T-0019 交付 `:23-45`、`:65-73`；`websocket.ts:1640-1650` |

**A｜已恢复决策：** SQLite Authority 是持久事实及 Ball 边界事实的事实源；Ball/NeedsAction/Reminder 本身按权威事实读时派生。snapshot、renderer cache、内存订阅和已发未标记帧不是事实源。来源：`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:1-3`、`:33-53`。

## 5. 功能规格

### 5.1 消息接受、同步与恢复

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| MSG-01 | 服务端只有在身份、membership、非空内容校验和耐久写入完成后才能 ACK。 | **A**；`/Users/leo/code/Dao/docs/protocols/message-ack.md:5-12` |
| MSG-02 | ACK 不得表示其他客户端已收到、异步工作已完成或 Agent 已回应。 | **A**；同上 |
| MSG-03 | 客户端必须先注册实时订阅，再读历史，并按稳定 `Message.id` 去重；历史不得覆盖更新的实时状态。 | **A**；同上 `:14-20` |
| MSG-04 | command 的领域事实、稳定 event、idempotency 与 outbox 必须同事务提交。 | **A**；`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:61-72` |
| MSG-05 | transport 是 at-least-once；客户端必须按稳定 `eventId` 逻辑去重，不得宣称物理 exactly-once。 | **A**；同上 |
| MSG-06 | 缓存必须可清空并从 server snapshot/delta/repair 原子重建；repair 完成前不得半暴露新状态。 | **A+B**；authoritative-sync protocol；`desktop/src/sync/client-sync-replica.ts:246-566` 及测试 |
| MSG-07 | 消息展示与路由时序应由 server timestamp/`streamSeq` 定义，客户端 `sentAt` 只可作为受校验的展示元数据。 | **C｜待 owner 批准**；当前客户端可控时间影响排序，`protocol.ts:512-521`、`authority-database-handler.ts:2432-2448` |
| MSG-08 | durable acceptance 必须形成稳定、可恢复的 accepted outcome；提交后工作失败不得把已接受消息语义改成“未接受”。 | **A**；message-ack protocol `:5-12`；authoritative-sync protocol `:61-70` |
| MSG-09 | 当前 composition 在 message commit 后等待 human preemption；若其抛错，WebSocket 可返回 error 而无 ACK。 | **B｜实现差距**；`authoritative-server.ts:202-220`、`websocket.ts:1539-1556` |
| MSG-10 | 采用 commit 后立即 receipt、可恢复 preemption outbox 或等价机制满足 MSG-08。 | **C｜修复方案待 owner 批准**；若不修，必须显式 supersede MSG-08 |

### 5.2 已读、已判定、@、编辑与 reaction

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| PRIM-01 | Human 的 read receipt 与 Agent judgment 必须是不同事实、不同类型和不同 UI。 | **A**；T-0012 交付 `:5-24` |
| PRIM-02 | 每个被纳入 RouteJob 的 Agent 都必须留下一个闭合 judgment 与可读原因；不发言不能表现为无记录。 | **A**；T-0016 计划 `:66-72` |
| PRIM-03 | `@human` 必须表达请求；`@agent` 必须表达调用；不能因同一输入双写 OpenItem 与 AgentExecution。 | **A**；T-0013/T-0017 交付与 T-0021 计划 `:76-87` |
| PRIM-04 | Human 请求可以 answered、deferred/cannot-answer 或 transferred；Agent owner 的 OpenItem 只能回答，失败不能自动释放 owner。 | **A**；T-0013 交付 `:11-12`；T-0017 交付 `:29-34` |
| PRIM-05 | Human 消息可编辑/撤回；Agent 消息只能追加更正；Human→Human reaction 不触发系统行为，Human→Agent calibration 可影响 route。 | **A**；T-0014 交付 `:5-22` |
| PRIM-06 | 当前权威网络协议尚未完整提供 PRIM-01/03/05 的客户端命令面；显式 `agent.invoke` 又允许客户端提交三种 intent kind 并绕过 RouteJob。 | **B**；`/Users/leo/code/Dao/packages/server/src/protocol.ts:256-281`、`:829-843`；`websocket.ts:1656-1685`；compatibility `primitives.ts:628-906` |
| PRIM-07 | Alpha 应把已批准的 read/judged、mention、edit/recall/correction 和 reaction/calibration 语义暴露到同一 authoritative command/sync 路径，或逐项明确删除/延期。 | **C｜待 owner 批准**；依据 PRIM-01～06 |
| PRIM-08 | direct mention 应使用结构化 ActorId entity；显示名解析、歧义和正文渲染规则需形成客户端/服务端共同合同。 | **C｜待 owner 批准**；当前只识别 raw Actor ID，`authority-database-handler.ts:3980-3985` |

### 5.3 Agent runtime 与工具

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| RUN-01 | 生产 composition 必须使用真实 ProviderAdapter；不能存在固定 fixture 或 mock fallback。缺 secret 必须显式 noauth。 | **A**；T-0041 交付 `:5-15`、`:65-79` |
| RUN-02 | execution 必须持久化 queued/running/completed/failed/cancelled、attempt、时间戳和闭合动作类别；UI 不得用 typing animation 冒充执行状态。 | **A**；同上 `:23-28` |
| RUN-03 | 中断必须先提交 cancelled，再传播 AbortSignal；partial stream 不成为 completed message，迟到旧 attempt 不覆盖新 attempt。 | **A**；同上 `:30-47` |
| RUN-04 | 只有闭合 transient 错误自动重试，最多 3 attempts，退避 1 秒/4 秒；预算耗尽必须可查询并可人工重试。 | **A**；同上 |
| RUN-05 | 模型 secret 只从 server-side secret provider 进入 adapter，不得进入消息、事件、日志、错误或诊断导出。 | **A**；T-0041 交付 `:36-40`、`:71-79` |
| RUN-06 | 每次工具调用必须取 capability ∩ current membership grant ∩ execution grant，并在 dispatch 再检查。 | **A**；同上 `:17-21`、`:49-54` |
| RUN-07 | side-effecting 工具必须展示目标、影响、可逆性，并消费一次绑定 execution/tool/args hash/room/Human session/expiry 的 confirmation；取消不冒充回滚。 | **A**；同上 `:49-54`、`:71-79` |
| RUN-08 | 进入模型的多方消息必须保留可辨认的 speaker identity/kind，不能把所有参与者抹平成同一 `user`。 | **C｜待 owner 批准**；当前 authority input 仅有 authorId、无 kind，adapter 又丢 authorId，`core/src/collaboration.ts:252-259`、`authority-database-handler.ts:4705-4733`、`openai-responses-provider.ts:109-112` |
| RUN-09 | B：runtime callback 只看全局 key，Actor.readiness 是静态 seed，route/direct invoke 忽略它，tool dispatch 才要求 ready；D：正确门禁点与 direct invocation 对 silent/on-mention 的工具权限未知。 | **B+D**；证据索引 B-SURFACE-07/08 |
| RUN-10 | 是否按 Agent 配置不同 provider/model/credential。 | **D｜未知**；当前为全局单配置，`authoritative-server.ts:245-251`、`:276-295` |
| RUN-11 | Alpha 前应闭合 confirmation 自动过期、sandbox symlink/二进制补偿、checkpoint 续跑、恢复 intent provenance 和 shutdown drain 风险。 | **C｜待 owner 批准**；当前 recovery 清空 continuations 并重构为 `direct_mention`，证据索引 6.1 |

### 5.4 单次路由与发言判定

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| ROUTE-01 | 每条新 room message 恰创建一个持久 RouteJob；Agent 数量不得扩大 Job 数。 | **A**；T-0021 计划 `:62-74` |
| ROUTE-02 | Router 输入只含当前消息、room phase、Agent role/participation/capability 摘要、calibration 与 Ball 摘要；不得包含完整历史、模型 secret 或工具 credential。 | **A**；同上 |
| ROUTE-03 | direct `@` mandatory intent、structured Agent help、Ball 与 provider candidates 必须确定性合并；同 sourceMessage/agent 最多一个 execution，direct `@` 优先。 | **A**；同上 `:66-72` |
| ROUTE-04 | participation 必须严格执行：silent 只响应 direct `@`；on-mention 另响应 structured help；active 才能响应领域/风险/Ball。 | **A**；同上 |
| ROUTE-05 | 当前抑制默认值为：同 Agent/topic 10 分钟冷却；无 Human 插入时最多 3 轮 Agent 往返；60 秒第 3 条 Human message 抑制领域触发；execution phase 也抑制领域触发；风险/点名/Ball 按规定穿透。 | **A**；同上 `:69-72` |
| ROUTE-06 | 每个 snapshot Agent 必须恰有一个最终 judgment；provider 失败/漏项不能删除 mandatory intent；消息 ACK 不等待路由。 | **A**；同上 |
| ROUTE-07 | calibration 权重为 useful/not-needed `+2/-2`、👍/👎 `+1/-1`，按 Agent/topic 幂等累积并截断 `[-4,4]`。 | **A**；同上 `:69-72` |
| ROUTE-08 | 当前 topicKey 是 versioned stable-hash 64 维、最近 8 条、cosine 0.82。 | **B｜实现反推**；`/Users/leo/code/Dao/packages/server/src/route-runtime/route-decision.ts:142-177` |
| ROUTE-09 | stable-hash 是否作为 Alpha 正式基线，或迁移到真实语义 embedding。 | **C｜待 owner 批准**；遗失设计没有恢复这一实现选择 |
| ROUTE-10 | room phase producer、discussion→execution 权限与 structured Agent help producer。 | **D｜未知**；当前 phase 恒 discussion、structured help 为空，`authority-database-handler.ts:2517-2534`、`:4210-4219` |
| ROUTE-11 | mandatory/`will_respond` intent 不得在 RouteJob terminal 后静默丢失。 | **A**；T-0021 计划 `:66-74` |
| ROUTE-12 | 当前 route 可先 completed，再在 invoke 异常时只 report；recovery 只捞 queued job。 | **B｜实现差距**；`route-runtime-service.ts:228-239`；`authority-database-handler.ts:4299-4381` |
| ROUTE-13 | 采用原子 handoff、可恢复 outbox 或等价机制满足 ROUTE-11。 | **C｜修复方案待 owner 批准** |
| ROUTE-14 | 显式 `agent.invoke` 当前绕过 RouteJob，且客户端可提交 `structured_help`/`routed_candidate`，与单次路由合同冲突。 | **B｜实现差距**；`protocol.ts:829-843`；`websocket.ts:1656-1685`；`agent-runtime-service.ts:443-457` |
| ROUTE-15 | 显式 Human invocation 应并入 source message 的唯一 RouteJob；若保留旁路，必须限制 kind 并显式 supersede ROUTE-01/03。 | **C｜待 owner 批准** |
| ROUTE-16 | Router 当前看到全局 Agent capability，未按 room grant 收窄；dispatch 才取交集并 fail closed。 | **B｜实现边界**；`authority-database-handler.ts:2540-2607`、`:4114-4198`、`:4683-4704`、`:5270-5496` |

### 5.5 OpenItem

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| OI-01 | OpenItem 是闭合权威事实，包含唯一 currentOwner、requester、source、status、转交链与时间；awaiting/transferred 必须有 owner。 | **A**；T-0021 计划 `:76-87` |
| OI-02 | 状态只有 awaiting/answered/deferred/transferred；answered/deferred 为终态，转交链不可改写且链尾等于 currentOwner。 | **A**；同上；T-0017 交付 `:5-21` |
| OI-03 | 只能由三种显式来源产生；不能从自然语言猜 proposal/target。 | **A**；T-0017 交付 `:17-21`、`:65-71`；T-0021 计划 `:80-82` |
| OI-04 | Human owner 可 answer/defer/transfer；Agent owner 只能 answer；Agent failure 是独立事实且不自动改 owner。 | **A**；T-0017 交付 `:29-34` |
| OI-05 | 请求 source 是否必须由 requester 自己发出、defer reason 是否持久、answer 对应哪条消息、同 source/target 是否允许多 item。 | **D｜规范未知**；B：当前 create 不要求 source.author=requester，terminal 不存 defer reason/answer linkage，WS idempotency 固定 kind/source/target；`authority-database-handler.ts:2703-2724`、`:3157-3202`；`websocket.ts:1572-1574` |

### 5.6 LightTask

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| LT-01 | 普通“我来做”只是意图；只有显式 command 才创建 LightTask。 | **A**；T-0021 计划 `:89-100` |
| LT-02 | LightTask 只包含轻量字段和 todo→claimed→delivered→verified；不得注入 GBP deps/maturity/milestone/task ID。 | **A**；同上；T-0018 交付 `:36-46` |
| LT-03 | claim 冻结 claimant role；deliver 解析唯一、不同角色的 verifier actor；只有该 verifier 能逐项确认 criteria。 | **A**；T-0018 交付 `:23-34` |
| LT-04 | 当前 authoritative command 只允许 authenticated Human 创建与流转；verifier 必须唯一解析到当前 Human。 | **B｜实现反推**；`authority-database-handler.ts:2852-3038` |
| LT-05 | Alpha 是否允许 Agent 创建、claim、deliver 或 verify；多名 Human 同角色时 verifier 如何选择。 | **D｜未知**；计划与实现边界不完全一致 |

### 5.7 BallInCourt 与 Needs Action

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| BALL-01 | Ball 是 OpenItem、LightTask、只读 Blueprint fact 的权威投影，不是可单独写入的第二状态库。 | **A**；T-0021 计划 `:102-113` |
| BALL-02 | 每个 source 只能有一个 holder；只能从结构化 owner/claimant/verifier/assignee/blocked mention 推导，不能从正文、角色名或多人集合猜。 | **A**；同上；T-0019 交付 `:9-21` |
| BALL-03 | Human Ball 只生成本人 needs-action/reminder；系统不能代 Human 发言，已读不清除行动项。 | **A**；T-0019 交付 `:23-45`、`:65-73` |
| BALL-04 | Agent overdue Ball 持久化一次不可被软抑制的结构化触发，由下一次唯一 RouteJob 消费；不另建 autonomous invocation。零 queued 时保留 claim 等待下一次 RouteJob。 | **A**；T-0019 交付 `:90-91`；`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:80-84` |
| BALL-05 | M3 只提供 room-scoped projection/candidate；跨群 inbox、通知策略和送达属于 M4。 | **A**；T-0021 计划 `:104-111` |
| BALL-06 | 当前生产 Blueprint adapter 恒空；Ball/NeedsAction/Reminder 是 `ball.query` 读时投影；Human reminder 没有 durable delivery，scan 返回结果未送达。 | **B｜实现反推**；`ball-runtime/contracts.ts:3-13`；`ball-runtime-service.ts:71-80`；`websocket.ts:1640-1650` |
| BALL-07 | 当前 scan 会持久化 boundary claim、`room.ball.overdue` event/outbox。零 queued 时首个后续新 RouteJob 会消费 claim；但有多个既有 queued RouteJob 时会全部标 `has_ball` 且不消费 claim，之后新 RouteJob 仍可能再次消费，未保证唯一消费。 | **B｜部分符合、实现差距**；`authority-database-handler.ts:283-300`、`:2564-2614`；`ball-authority.test.ts:108-169` |
| BALL-08 | 保持 BALL-04 的候选修复是禁止 scan 改写既有 queued snapshots，并在 boundary 之后首个新 RouteJob 创建时原子绑定、消费 claim；把 claim 绑定到某个既有 Job，或 scan 立即创建/唤醒 autonomous invocation，均是需要 owner 显式批准并 supersede BALL-04 的替代方案。 | **C｜修复方案待 owner 批准** |

### 5.8 人来让位

| ID | 规范 | 等级与来源 |
| --- | --- | --- |
| PREEMPT-01 | 新 Human message 必须先耐久接受，再处理同 room 可安全取消的旧 work，最后基于最新状态创建唯一 RouteJob/replacement。 | **A**；T-0021 计划 `:115-126` |
| PREEMPT-02 | cancel 必须 commit-before-abort；旧 attempt 的迟到结果不能落消息或 completed。 | **A**；T-0020 交付 `:3-30`、`:70-78` |
| PREEMPT-03 | 当前实现不取消已开始 model generation 或已 dispatched side-effect；只取消 queued、waiting_upstream 与尚未开始的 tool call。 | **B｜实现反推**；`authority-database-handler.ts:4411-4519` |
| PREEMPT-04 | replacement 当前是新 execution，并用 supersedes lineage 关联旧 execution。 | **B｜实现反推**；同上 `:4563-4681` |
| PREEMPT-05 | 接受 PREEMPT-03 的安全例外，并把 PREEMPT-04 作为规范术语。 | **C｜待 owner 批准** |

## 6. 关键用户流程与当前可用性

| 流程 | 权威顺序 | 当前可用性 |
| --- | --- | --- |
| Human 登录并加入房间 | 登录获得 Human session → 收到邀请 → accept/reject → membership 生效 | **A+B**：服务层/SQLite 已有；**B**：当前 Desktop/WS 未提供完整 live 流程。来源：identity protocol；desktop/server composition |
| Agent 加入房间 | owner/admin 选择 Agent → 配 participation + grants → 服务端校验 capability 子集 → 立即入群 | **A+B**：服务层已实现；**B**：当前 live Desktop/WS 未暴露治理命令 |
| Human 发消息 | A 合同：认证/成员/内容校验 → message/event/idempotency/outbox 同事务 → stable accepted outcome → at-least-once sync；B 当前：commit 后等待 preemption，再 ACK 或进入 post-commit error 窗口 | **A+B｜有实现差距**；MSG-01～10；Desktop 也未接线 |
| direct `@agent` | A 合同：正文/结构化 direct intent 合并进唯一 RouteJob mandatory；B 当前：正文 raw `@ActorId` 走 RouteJob，但显式 `agent.invoke` 直接建 execution，并允许三种 client-supplied kind | **A+B｜合同冲突**；ROUTE-14/15 |
| 自动发言判定 | message → RouteJob → deterministic intents + provider candidates → 每 Agent RouteJudgment → ordered executions；当前 terminal→invoke 有异常丢 handoff 窗口 | **A+B｜有实现差距**；**D**：room phase/structured help producer 未闭合 |
| Agent 执行与工具 | queued→running→model/tool；显式 Human invocation 可提供 side-effect confirmation，routed/replacement 当前无 confirmation context、会被拒绝 side effect；final 才成为权威消息 | **A+B｜实现边界**；**D**：真实 endpoint 未验证，Desktop 无 live UI |
| `@human` 请求 | 显式 OpenItem create → awaiting owner → answer/defer/transfer → terminal/chain | **A+B**：显式 command 已有；**B**：消息正文 mention 不自动创建，旧双语义只在 compatibility path |
| LightTask | Human 显式 create → claim → deliver/resolve verifier → verify criteria | **A+B**：server 已实现；**D**：Agent 参与和多同角色 verifier 规则未批准 |
| Ball / needs action | 读时从承诺事实派生单 holder → Human needs-action/reminder 或 Agent overdue contract | **A+B**：room query 已有、无跨群/送达、Blueprint 恒空；**B 差距**：同一 Agent overdue boundary 未保证只由下一次唯一 RouteJob 消费 |
| Human 来让位 | Human message commit → cancel commit → abort → fence → fresh route/replacement | **A+B**：server 已实现；**C**：dispatched side-effect 例外待批准 |
| 多客户端恢复 | bootstrap/catalog → fixed watermark pages → delta/live → gap/expiry repair → atomic cache commit | **A+B**：server 和 replica 测试已闭合；**B**：shipping Desktop 未装配 transport/cache |

## 7. Desktop 产品表面基线

### 7.1 已恢复且应保留的视觉语义

| UI 语义 | 规范 | 等级与来源 |
| --- | --- | --- |
| Human/Agent 消息 | Human 圆头像+气泡；Agent 方头像+角色色轨+无气泡；actor kind guard 禁止混用 | **A+B**；T-0011 交付 `:21-25`；`renderer/app.ts:191-388` |
| Read/Judged | Human 展示 read；Agent 展示 judgment outcome 与 reason，不能用同一“已读”图标 | **A**；T-0012 交付 `:5-24` |
| Runtime | 展示权威状态和动作类别；不能以 typing animation 表示 Agent 正在工作 | **A**；T-0041 交付 `:23-28` |
| Agent correction | 原消息与追加更正都可见；不能覆写 Agent 原消息 | **A**；T-0014 交付 `:7-10` |
| Reaction | Human 社交 reaction 与 Agent calibration 在记录、控件和反馈结果上分开 | **A**；T-0014 交付 `:11-22` |
| Needs action | 未读与需要我行动必须分开；已读不清除 Ball/commitment action | **A**；T-0019 交付 `:23-45` |

### 7.2 当前 Desktop 事实

- **B｜实现反推**：默认 Electron 只打开本地空群页面；query 参数可打开 M2 primitives、join、visual review。来源：`/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`、`renderer/main.ts:14-23`。
- **B｜实现反推**：preload 为空，desktop package 不依赖 server；全目录没有 live auth/WebSocket/IPC/fetch 装配。来源：`preload.ts:1`、desktop `package.json:6-14`。
- **B｜实现反推**：renderer 的中断、编辑/撤回、join 等交互主要改变 DOM 或调用注入回调；硬编码 fixtures 不等于权威 command 已执行。来源：`renderer/app.ts:391-492`、`:623-1053`、`:1264-1271`、`:1315-1537`。
- **B｜实现反推**：client sync replica 已有分页、watermark、repair、dedupe 与 clear-cache 测试，但需外部注入 transport/cache。来源：`desktop/src/sync/client-sync-replica.ts:22-64`、`:246-566`。

### 7.3 Alpha live Desktop 最小范围

以下全部是 **C｜重建提案，待 owner 批准**；它们只把已存在的权威事实接到产品表面，不规定遗失设计稿的布局：

1. Human 可登录、恢复 session、看到自己有权访问的房间，并完成邀请 accept/reject。
2. owner/admin 可执行已批准的房间治理和 Agent configuration；权限拒绝来自 server，而不是 UI 隐藏。
3. 房间 timeline 使用 client replica 接入 bootstrap/delta/live/repair，并清楚区分本地发送、已耐久 ACK、同步失败和 repair。
4. composer 使用结构化 mention entity；Human/Agent 寻址触发不同权威 command，不在 renderer 猜语义。
5. 消息表面呈现 read/judged、route reason、execution state/action、tool confirmation、OpenItem、LightTask、Ball 与 preemption notice。
6. Human/Agent 视觉和权限差异沿用 7.1；所有按钮调用 authoritative command，并用 event/sync 结果更新，不只改本地 DOM。
7. cache 清空、cursor 过期、gap、断线重连、成员撤权和 session revoke 都有可理解的 loading/error/recovery 状态。

原桌面稿中的窗口结构、导航层级、控件位置、尺寸、动效、移动端适配和无障碍细节均为 **D｜未知**；本文不补画伪原稿。

## 8. 十四条原语占位基线

没有恢复完整原名或 P-01～P-14 映射。下表编号只用于新基线审阅；详细证据见证据索引第 5 节。

| 槽位 | 当前可恢复语义 | 状态 |
| --- | --- | --- |
| 1 | Human/Agent 共同在场，身份与视觉分离 | **已恢复｜A** |
| 2 | Human 已读 / Agent 已判定 | **已恢复｜A** |
| 3 | Agent 正在做什么：权威 execution state/action | **已恢复｜A** |
| 4 | `@human` 请求 / `@agent` 调用 | **已恢复｜A** |
| 5 | A：编辑/撤回、追加更正与 calibration 现行语义部分可恢复；D：#5 原名及与 #12 分工 | **部分恢复｜A；精确映射未知｜D** |
| 6 | Human 邀请加入 / Agent 配置加入 | **已恢复｜A** |
| 7 | 未读与“需要我动”分离 | **已恢复｜A** |
| 8 | Agent participation 进入发言判定 | **已恢复｜A** |
| 9 | 人来让位 | **已恢复｜A** |
| 10 | 无可唯一归属语义 | **未知｜D** |
| 11 | Agent 消息是不可覆写的行为记录，只能追加更正 | **已恢复到语义｜A；正式标题未知** |
| 12 | A：Human→Agent reaction/calibration 现行语义部分可恢复；D：#12 原名及与 #5 分工 | **部分恢复｜A；精确映射未知｜D** |
| 13 | membership 与可见工具权限的人机分离 | **已恢复到语义｜A；正式标题未知** |
| 14 | 无可唯一归属语义 | **未知｜D** |

**C｜待 owner 批准：** owner 应为每个槽位批准正式名称、是否沿用该编号、Human 语义、Agent 语义、权限、视觉、权威事实、客户端 command 和当前实现覆盖。批准前不得把本表称为“恢复的原十四条”。

## 9. 里程碑基线

以下里程碑名称和方向是 **A｜已恢复的早期意图**；“当前证据”不是任务状态，也不代替 owner 验收。

| 里程碑 | 目标边界 | 当前证据 |
| --- | --- | --- |
| M1 前置验证与解阻 | H1/H1b/H3 与 go/no-go；GBP 权威版本 | **D**：实验数据和正式决定未找到；当前代码越过 M1 不等于假设已通过。来源：蓝图 `:76-82`、`:108-152` |
| M2 IM 底座 | 在场、已读、@、编辑撤回、表情、成员列表的人机分离 | **A+B**：文档与领域/服务/UI 证据存在；**B**：权威网络面和 live Desktop 不完整。来源：蓝图 `:83-86`；T-0011～T-0014/T-0039/T-0040；当前代码 |
| M3 发言判定与承诺原语 | 旧 exit：四层判定/单次路由、待答项、轻任务、Ball 统一、噪音率可测；当前 T-0021 扩展另加入真实 runtime 与人来让位 | **A**：现行合同已恢复；**B**：schema/runtime 大量实现；**B 差距**：显式 invoke 旁路、Ball boundary→next RouteJob 的 exactly-once claim consumption、route handoff、room phase/help、LightTask human-only、Desktop 未接；**D**：真实 endpoint 与 owner 验收。来源：蓝图 `:87-91`；T-0021/T-0016～T-0020/T-0041；证据索引 6 |
| M4 高频路径与多端 | 跨群五分区 inbox、四级通知/紧急规则、移动端看/回/批/验、共用搜索索引 | **A**：只恢复方向；**D**：详细规则未恢复。M3 当前只提供 room projection/candidate。来源：蓝图 `:92-95`；T-0019/T-0021 边界 |
| M5 蓝图接入 | GBP 三字段、串行写入/版本确认、分权验收、自托管 | **A**：只恢复方向；**B**：生产 adapter 当前为空。来源：蓝图 `:96-100`；T-0019 交付与 server composition |
| M6 形态验证 | ≥3 Human、≥4 Agent 的真实团队跑通完整 idea 与连续四周指标 | **A**：早期目标；**D**：真实团队数据和指标定义未找到。来源：蓝图 `:101-106`、`:69-74` |

历史任务标题完整目录见证据索引 8.2；其旧 `todo/verified` 状态不进入本基线。

## 10. 质量、安全与可运行性门槛

### 10.1 当前验证事实

- **B｜实现验证**：本主审计实跑 `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm build`、`corepack pnpm test` 均退出 0；test 内的 core-boundary 通过，Vitest 40 个文件通过、2 个 live 文件跳过，827 个测试通过、2 个跳过，共 829 个。
- **D｜未知**：真实 OpenAI endpoint、真实工具目标、目标部署网络、跨设备连接和外部 SLA 未在本环境验证。
- **B｜实现边界**：server 是需调用方传配置的库式 composition root，没有 CLI/统一 launcher；默认 WebSocket 是 `ws://127.0.0.1:<随机端口>`。来源：`server/package.json:15-20`、`server/src/index.ts:8-12`、`authoritative-server.ts:41-66`、`websocket.ts:1776-1796`、`:2079-2089`。

### 10.2 新基线的 Alpha 验收候选

以下全部是 **C｜重建提案，待 owner 批准**：

1. 5.1～5.8 中所有 A 级不变量继续通过自动化测试；所有 B 级实现具体化已由 owner 接受或改写。
2. 7.3 的 live Desktop 最小范围通过真实进程端到端测试，不以 fixtures/review route 代替。
3. 真实 Provider 和至少两个物理不同工具在目标环境通过 secret-safe live smoke；日志、事件、错误、diagnostic 对 sentinel secret 零命中。
4. auth、membership removal、session revoke 对 durable event 与 ephemeral preview 都立即生效。
5. 既有 ACK、单次路由和 Agent overdue Ball 的 A 级合同已满足：没有 post-commit ambiguous outcome、显式 invoke 旁路、route→execution 丢 handoff，且同一 overdue boundary 恰由一个 RouteJob 消费并产生一次结构触发。
6. side-effect sandbox 闭合 symlink、preimage、二进制补偿和 size boundary。
7. confirmation expiry、retention/backoff、checkpoint/provenance recovery、shutdown drain 与 sandbox side-effect 边界闭合。
8. clear-cache、cursor expired、gap、send-before-mark、process restart、partial stream、late attempt 与 human preemption 都有真实 composition E2E。
9. owner 明确签署本基线第 12 节 P0 决策；未决 D 项不能被实现者自行默认为需求。

## 11. 产品验证与指标

### 11.1 可恢复的早期目标

以下均为 **A｜已恢复的早期意图**，不是当前已达成指标：

- H1/H1b 有明确结论并形成 go/no-go。
- 十四条 IM 原语全部完成人/Agent 分离，并与遗失设计稿 P-01～P-14 逐条一致。该完成目标为 **A｜早期意图**，但完整名称和映射已经遗失，所以当前验证状态为 **D｜未知**。
- 一个真实团队以至少 3 名 Human、4 个 Agent 完整跑通 idea；至少 2 个 Agent 有不同工具或数据源。
- 连续四周：“M3 主线噪音率” `<10%`、“M7 多真人群占比” `>50%`、“M5 验收打回率” `>0`。
- Blueprint 自托管，“M4 闸门覆盖率” `>80%`。

来源：`/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:69-74`。

### 11.2 指标限制

- **D｜未知**：“M3/M4/M5/M7”是指标编号还是里程碑引用；尤其路线只有 M1–M6，却出现 M7。
- **D｜未知**：噪音率、多真人群占比、验收打回率、闸门覆盖率的分母、窗口、事件源、排除规则和统计负责人。
- **C｜待 owner 批准**：在把上述阈值用作验收前，先批准每个指标的名称、公式、事件 schema、采样窗口、数据质量门槛和 go/no-go 规则；在此之前不得声称指标达标。

## 12. Owner 决策清单

### 12.1 P0：批准本基线前必须决定

| ID | 决策/阻断项 | A/B/D 证据 | C｜候选决定 | 未决定时 |
| --- | --- | --- | --- | --- |
| OD-P0-01 | 本文是否成为新基线 | 原文遗失；旧 T-0036 同 ID 异义 | 批准本文，并明确“不恢复原文、不继承旧状态”；或列出修改后版本 | 继续称“重建稿”，不得称已批准 PRD |
| OD-P0-02 | 产品定位与非目标 | A：只能恢复早期意图；D：当前批准状态未知 | 逐条批准 1.1/1.3，或明确 supersede | 未批准项保持 D |
| OD-P0-03 | 十四条原语正式目录 | A：部分语义；D：完整原名/编号未知 | 以第 8 节占位表逐项命名/编号 | 不得称已恢复原十四条 |
| OD-P0-04 | H1/H1b/H3 | D：没有实验结论 | 选择重跑、用真实团队验证替代，或正式取消旧门槛 | 产品假设保持未证实 |
| OD-P0-05 | live Desktop 范围 | B：shipping Desktop 未接线 | 批准 7.3，或明确更小但端到端的 Alpha 表面 | 不得称端到端可用 IM |
| OD-P0-06 | authoritative 网络命令面 | A：M2 语义；B：ClientFrame 不完整、compatibility 混杂 | 逐项批准 read/judged、mention、edit/recall/correction、reaction/calibration、room governance 的上线/延期 | 仅能声明库/领域能力，不声明产品可用 |
| OD-P0-07 | 模型上下文身份 | B：authority 缺 authorKind，adapter 又丢 authorId | 要求保留 speaker identity/kind；另行决定 per-Agent provider/model | 多方在场语义不能视为模型输入已满足 |
| OD-P0-08 | LightTask 的 Agent 权利 | B：当前 human-only；D：批准边界未知 | 选择 Human-only / Agent 可 claim+deliver / 全 actor，并定义多同角色 verifier | 维持 B 实现，但不得称批准需求 |
| OD-P0-09 | 人来让位安全例外 | B：已 dispatched side effect 不强杀；replacement 为新 execution | 批准该安全例外与 supersedes lineage，或给出替代合同 | 现行实现语义仍未获产品批准 |
| OD-P0-10 | ACK 与 route handoff | A：stable accepted outcome、mandatory intent 不得丢；B：存在 post-commit error 与 terminal→invoke 窗口 | 选择 commit receipt/outbox、原子 handoff或等价修复 | 属实现阻断，不是可自由放弃的需求；放弃需显式 supersede A 合同 |
| OD-P0-11 | 显式 `agent.invoke` 旁路 | A：显式 `@agent` 应并入唯一 RouteJob；B：当前可直建 execution/提交三种 kind | 并入 RouteJob；或限制旁路并显式 supersede 单次路由合同 | RouteJudgment 与 execution 可能不一致，M3 不闭环 |
| OD-P0-12 | Agent overdue Ball | A：一次持久结构触发由下一次唯一 RouteJob 消费；B：durable event/outbox 与零 queued 后首个新 RouteJob 消费已实现，但多既有 queued 时可能重复绑定，随后再被新 RouteJob 消费 | 默认保留 A 并修复为原子唯一消费；只有 owner 要求 overdue 即时 autonomous invocation 时才显式 supersede A | exactly-once 属实现阻断；产品语义若不变，无权把它降级为可选项 |

### 12.2 P1：实现具体化与治理

| ID | 当前 B 事实 / D 未知 | C｜待批准候选 | 未决定时 |
| --- | --- | --- | --- |
| OD-P1-01 | 整个 Actor payload 是静态 seed；displayName、全局 tool capability、reachability/readiness 都不能在线更新，heartbeat/TTL/持久临时边界为 D | 分字段定义更新权限、producer、TTL/transition 与 route/runtime readiness 门禁 | 只能显示启动配置态，不能宣称实时在场或可在线改资料/能力 |
| OD-P1-02 | 入群要求非空 grants；纯对话 Agent 是否允许为 D | 允许空 grants，或明确“无工具 Agent 仅在目录、不入群” | 维持当前 B，不称为长期产品原则 |
| OD-P1-03 | 只有 active 获得 room grants；自动 route 无 confirmation context | 定义 direct invoke 的 tool 权限和自动 side effect 的 Human confirmation principal/时点 | 自动 routed/replacement 继续只能用 read-only 工具 |
| OD-P1-04 | Router 看全局 capability，dispatch 才按 room grant fail closed | 让 router capability 摘要也按 room grant 收窄，或批准显式暴露策略 | provider 仍可能基于本房间不可用能力决策 |
| OD-P1-05 | OpenItem source/requester、defer reason、answer linkage、多 item 为 D | 逐项定义并补权威审计字段/幂等合同 | 保持实现具体化，不称为批准语义 |
| OD-P1-06 | OpenItem/LightTask 当前默认 24 小时 | 批准、修改或改为 room policy | 24 小时只保留 B 实现值 |
| OD-P1-07 | topicKey 为 stable-hash 64d/window8/cosine .82 | 批准为 Alpha version，或要求语义 embedding/migration | 只称 B 实现，不称原设计 |
| OD-P1-08 | room phase 恒 discussion；structured help producer 为空 | 定义 producer、转换权限和审计入口 | 保持 D，相关主动路由能力不闭环 |
| OD-P1-09 | 客户端 `sentAt` 可影响排序/判定 | 批准 server timestamp/streamSeq 合同 | 风险保持 D 待验证 |
| OD-P1-10 | ephemeral preview 不重验 membership | 要求与 durable outbox 同等级撤权检查 | preview 撤权风险保持 D |
| OD-P1-11 | 无默认 retention/backoff，checkpoint/provenance 未真续跑，preemption 无 drain | 批准 Alpha 运维门槛/default policy | 只称已知实现风险，不称生产可运维 |
| OD-P1-12 | legacy JSON/JSONL/in-memory 与 authority 并列导出 | 标记 compatibility/legacy 或移出默认 public surface | 调用方仍可能误选事实源 |
| OD-P1-13 | M2 AgentJudgement 与 M3 RouteJudgment 两套事实未统一 | 合并、建立权威映射，或批准两套各自用途与 UI | 不得把二者写成同一“已判定”事实 |

### 12.3 P2：后续里程碑

- **C｜待 owner 批准**：M4 五分区名称/排序/聚合、四级通知名称/阈值/DND/紧急穿透、移动端最小交互和搜索索引合同必须另行重建；当前只有方向。
- **C｜待 owner 批准**：M5 GBP 权威版本、三字段、读取/写回、串行闸门、版本冲突、LightTask 升级和分权验收必须另行形成 adapter contract；当前生产 adapter 为空。
- **C｜待 owner 批准**：M6 真实团队规模、周期、场景、指标和 go/no-go 应在指标定义后重新确认。

## 13. 明确保留的未知

以下均为 **D｜未知**，owner 未决前不进入批准需求：

1. 遗失 PRD/设计稿/原型的原文和布局。
2. 正式 Blueprint decision 记录；陈旧蓝图实际为 0 条。
3. 当前各任务的 Blueprint 状态与 owner 验收状态。
4. 十四条原语完整原名与 P-01～P-14 对照。
5. H1/H1b/H3 与 U-01～U-06 的回答。
6. owner transfer、多 owner、最后 owner 离开规则。
7. Thread/桥接/无人值守等早期非目标的当前批准状态。
8. M4/M5 的详细产品与协议合同。
9. 目标部署拓扑、发现、TLS、跨设备和外部 SLA。
10. 真实团队是否已证明核心产品假设。

## 14. Owner 审核记录模板

本节是 **C｜重建提案，待 owner 使用**；填写它不会自动修改 Blueprint 或任务状态。

```text
Owner：
审核日期：
基线决定：批准 / 修改后批准 / 拒绝
批准版本：Reconstruction Baseline 0.1 / 其他：

已批准的 C 项：
-

要求修改的条目 ID：
-

继续保留的 D 项：
-

明确 supersede 的旧意图：
-

备注：
-
```

在 owner 完成审核前，本文的正确称谓是“产品基线重建稿”，不是“恢复的原 PRD”，也不是“已批准产品规格”。
