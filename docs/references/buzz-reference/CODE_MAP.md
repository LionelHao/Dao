# Buzz 代码地图

本文按“要解决什么问题”组织，而不是简单复述目录树。默认根路径为仓库中的 `buzz/`。进入任一目录前，先阅读其适用的 `AGENTS.md`；特别是 Agent 配置代码受 `buzz/desktop/src/features/agents/AGENTS.md` 约束。

## 先从哪里开始

| 参考目标 | 第一入口 | 接着阅读 |
| --- | --- | --- |
| 频道聊天整体页面 | `desktop/src/features/channels/ui/ChannelPane.tsx` | `ChannelScreen.tsx`、`useChannelPaneMessages.ts`、`MessageTimeline.tsx` |
| 消息时间线与 Human / Agent 渲染 | `desktop/src/features/messages/ui/MessageRow.tsx` | `TimelineMessageRow.tsx`、`MessageHeader.tsx`、`formatTimelineMessages.ts` |
| 消息编辑器与发送 | `desktop/src/features/messages/ui/MessageComposer.tsx` | `MessageComposer.types.ts`、`useStableSendToChannel.ts`、`sendToChannelSemantics.ts` |
| `@Agent` 选择和发送校验 | `desktop/src/features/messages/ui/useMentionSendFlow.ts` | `MentionAutocomplete.tsx`、`useMentions.ts`、`agentMentionRevalidation.ts` |
| Agent 正在工作 / 活动侧栏 | `desktop/src/features/channels/ui/AgentSessionThreadPanel.tsx` | `AgentSessionTranscriptList.tsx`、`observerRelayStore.ts`、`activeAgentTurnsStore.ts` |
| Agent 工具调用如何呈现 | `desktop/src/features/agents/ui/AgentSessionToolItem/ToolItem.tsx` | 同目录的 `ToolDetailBlocks.tsx`、`ShellCommandBlock.tsx`、`ViewImageToolPreview.tsx` |
| Agent 管理页面 | `desktop/src/features/agents/ui/AgentsScreen.tsx` | `AgentsView.tsx`、`UnifiedAgentsSection.tsx`、`ManagedAgentRow.tsx` |
| Agent 创建与配置 | `desktop/src/features/agents/ui/AgentDialog.tsx` | `AgentDefinitionDialog.tsx`、`AgentConfigFields.tsx`、`lib/agentConfigCore.ts` |
| Agent 本地进程生命周期 | `desktop/src-tauri/src/managed_agents/runtime.rs` | `restore.rs`、`storage.rs`、`readiness/`、`commands/agents.rs` |
| 频道事件如何触发 Agent | `crates/buzz-acp/src/main.rs` | `relay.rs`、`queue.rs`、`pool.rs`、`acp.rs` |
| Agent 的 LLM / tool loop | `crates/buzz-agent/src/agent.rs` | `wire.rs`、`llm.rs`、`mcp.rs`、`handoff.rs` |
| Agent 可用的开发工具 | `crates/buzz-dev-mcp/src/lib.rs` | `shell.rs`、`str_replace.rs`、`read_file.rs`、`rg.rs`、`tree.rs` |
| 服务端消息权威管线 | `crates/buzz-relay/src/handlers/event.rs` | `crates/buzz-core/src/kind.rs`、`crates/buzz-db/`、`crates/buzz-pubsub/` |

## 1. Desktop 应用壳与频道页面

### 应用组合

- `desktop/src/main.tsx`：React / Router / 全局 Provider 启动入口；
- `desktop/src/app/App.tsx`：应用根组件；
- `desktop/src/app/AppShell.tsx`：主工作区壳，组合导航、频道、右侧辅助面板和覆盖层；
- `desktop/src/app/AppShellChannelSurface.tsx`：频道 surface 的路由与装配；
- `desktop/src/app/router.tsx`、`routes.ts`：路由定义。

### 频道主界面

- `desktop/src/features/channels/ui/ChannelScreen.tsx`：频道加载、成员、消息、线程、Profile / Agent 辅助面板的上层协调；
- `desktop/src/features/channels/ui/ChannelPane.tsx`：聊天区域主体，组合时间线、Composer、线程面板、Agent 活动面板、媒体上传和 moderation 状态；
- `desktop/src/features/channels/ui/ChannelScreenHeader.tsx`：频道头部；
- `desktop/src/features/channels/ui/RightAuxiliaryPane.tsx`：线程、资料和 Agent 活动等右侧 surface 的统一容器；
- `desktop/src/features/channels/ui/FocusThreadDrawer.tsx`、`ThreadViewModeToggle.tsx`：线程抽屉与视图切换；
- `desktop/src/features/channels/ui/useChannelPaneMessages.ts`：把查询、实时事件和 UI 所需消息状态接入 ChannelPane。

**适合借鉴：** 大页面如何把查询 / 状态 hook 与纯 UI surface 分开，右侧辅助面板如何复用 shell，以及线程与 Agent 活动如何共享布局但保持不同语义。

## 2. 消息时间线、消息行与线程

### 时间线投影与虚拟列表

- `desktop/src/features/messages/lib/formatTimelineMessages.ts`：把底层事件归一成时间线消息；
- `desktop/src/features/messages/lib/timelineItems.ts`、`virtualizedTimelineItems.ts`：构造虚拟列表项目；
- `desktop/src/features/messages/ui/MessageTimeline.tsx`：时间线状态、分页、锚定滚动和渲染入口；
- `desktop/src/features/messages/ui/TimelineMessageList.tsx`：虚拟列表；
- `desktop/src/features/messages/ui/TimelineMessageRow.tsx`：按消息类别分派到普通消息、diff 或 system row；
- `desktop/src/features/messages/ui/useAnchoredScroll.ts`：历史插入、实时追加与尾部跟随时的滚动锚定；
- `desktop/src/features/messages/ui/useBufferedTimelineMessages.ts`、`useTimelineRetention.ts`：实时消息缓冲与窗口保留。

### 消息行

- `desktop/src/features/messages/ui/MessageRow.tsx`：普通消息的核心渲染，识别 Agent 身份、回复树、附件、回应、操作条、提醒与消息状态；
- `desktop/src/features/messages/ui/MessageHeader.tsx`：作者、角色、元信息；
- `desktop/src/features/messages/ui/MessageAgentOwner.tsx`：Agent 与 owner 关系提示；
- `desktop/src/features/messages/ui/MessageActionBar.tsx`：回复、编辑、删除、跟随线程、发送回频道等动作；
- `desktop/src/features/messages/ui/MessageReactions.tsx`：回应投影；
- `desktop/src/features/messages/lib/messageGrouping.ts`：连续消息分组；
- `desktop/src/features/messages/lib/threadTreeLayout.ts`、`threading.ts`：线程树和引用关系。

### 线程

- `desktop/src/features/messages/ui/MessageThreadPanel.tsx`：线程详情 surface；
- `desktop/src/features/messages/ui/MessageThreadSummaryRow.tsx`：主时间线中的线程摘要；
- `desktop/src/features/messages/useThreadReplies.ts`、`useIndependentThreadPanel.ts`：回复加载与独立面板状态；
- `desktop/src/features/messages/lib/threadPanel.ts`、`messageThreadPanelLayout.ts`：线程面板投影和布局合同。

**适合借鉴：** 消息领域对象与渲染对象分离、Human / Agent 身份在同一时间线中的稳定视觉区分、虚拟列表锚定和线程树布局。具体视觉必须回到 Dao 权威设计稿。

## 3. Composer、草稿、附件与 `@Agent`

### Composer 主链

- `desktop/src/features/messages/ui/MessageComposer.tsx`：富文本编辑、草稿、附件、链接预览、emoji、mention、typing 和发送锁；
- `desktop/src/features/messages/ui/MessageComposer.types.ts`：外部合同；
- `desktop/src/features/messages/lib/useRichTextEditor.ts`：Tiptap 编辑器能力；
- `desktop/src/features/messages/lib/useDrafts.ts`、`ui/useDraftPersistSnapshot.ts`：草稿持久化与恢复；
- `desktop/src/features/messages/lib/useMediaUpload.ts`、`backgroundMediaUploadStore.ts`：附件生命周期；
- `desktop/src/features/messages/ui/useStableSendToChannel.ts`、`lib/sendToChannelSemantics.ts`：发送目标绑定与语义检查。

### Mention 与 Agent 发送

- `desktop/src/features/messages/ui/MentionAutocomplete.tsx`：Human / Agent 候选 UI；
- `desktop/src/features/messages/lib/useMentions.ts`：mention 编辑器状态、候选与标签提取；
- `desktop/src/features/messages/lib/mentionCandidates.ts`、`mentionRanking.ts`：候选构造与排序；
- `desktop/src/features/messages/ui/useMentionSendFlow.ts`：发送前准备被点名 Agent、处理非成员与运行状态、闭合发送流程；
- `desktop/src/features/messages/ui/useMentionSendFlow.helpers.ts`：可测试的准备 / 运行状态判断；
- `desktop/src/features/messages/lib/agentMentionRevalidation.ts`：发送时重新校验 Agent 可见性与权限；
- `desktop/src/features/messages/lib/effectiveExplicitAgentPubkeys.ts`：显式 Agent audience；
- `desktop/src/features/messages/lib/persistentAgentAudience.ts`：线程中的持续 Agent audience；
- `desktop/src/shared/api/agentControl.ts`：停止当前 Agent turn 等控制命令。

**适合借鉴：** 编辑器 UI 只收集意图，发送前再按最新权威数据校验；同步发送锁防止重复提交；把 Human mention 和 Agent invocation 的特殊准备逻辑从 Composer 主体拆出。

## 4. Agent 活动、执行状态与工具详情

### 事件接入和内存投影

- `desktop/src/features/agents/useAgentObserverIngestion.ts`：订阅并接入 Agent observer 事件；
- `desktop/src/features/agents/observerRelayStore.ts`：去重、窗口保留、按 Agent / channel 归档与订阅；
- `desktop/src/features/agents/activeAgentTurnsStore.ts`：活动 turn 的闭合投影；
- `desktop/src/features/agents/agentWorkingSignal.ts`：将 observer turn 与 typing fallback 合并为统一 working signal；
- `desktop/src/features/agents/ui/useObserverEvents.ts`：UI 读取 live / archived observer 数据；
- `desktop/src/features/agents/ui/agentSessionTypes.ts`：活动与 transcript 类型。

### 活动面板

- `desktop/src/features/channels/ui/AgentSessionThreadPanel.tsx`：按 Agent 和 channel 展示活动，提供 raw / transcript 切换、停止、历史分页和滚动锚定；
- `desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx`：Agent 管理与 Profile 场景使用的活动 surface；
- `desktop/src/features/agents/ui/AgentSessionTranscriptList.tsx`：活动列表、live 状态、空态、时间戳、reduced motion 和 `aria-live`；
- `desktop/src/features/agents/ui/agentSessionTranscriptGrouping.ts`：把原始 observer 事件组合成可读 display blocks；
- `desktop/src/features/agents/ui/agentSessionTranscriptPresentation.ts`：呈现规则；
- `desktop/src/features/agents/ui/TurnLivenessIndicator.tsx`：turn 活性提示；
- `desktop/src/features/agents/ui/RawEventRail.tsx`：原始 ACP 活动调试视图。

### 活动分类与工具详情

- `desktop/src/features/agents/ui/activityRenderClasses/TranscriptActivityItem.tsx`：按活动类别分派；
- 同目录的 `ThoughtActivity.tsx`、`PlanActivity.tsx`、`ToolActivity.tsx`、`MessageActivity.tsx`、`LifecycleActivity.tsx`：不同活动的专用渲染；
- `desktop/src/features/agents/ui/AgentSessionToolItem/ToolItem.tsx`：单次工具调用；
- 同目录的 `ToolDetailBlocks.tsx`、`ShellCommandBlock.tsx`、`TodoToolSummary.tsx`、`ViewImageToolPreview.tsx`：按工具类型渐进展示输入、输出和预览；
- `desktop/src/features/agents/ui/agentSessionToolClassifier.ts`、`agentSessionToolSummary.ts`：工具分类和摘要。

**适合借鉴：** 原始事件、运行中投影和面向人的展示模型分层；历史批次不播放入场动画、实时追加才播放；可中断条件由权威 working 状态驱动；工具摘要与完整输入 / 输出渐进披露。

## 5. Agent 管理、配置与运行位置

查阅本节前必须先读 `desktop/src/features/agents/AGENTS.md`。其核心约束是：Harness 能力事实来自 Rust runtime catalog，前端只做投影，不维护第二份能力表。

### 管理界面

- `desktop/src/features/agents/ui/AgentsScreen.tsx`、`AgentsView.tsx`：页面入口和数据装配；
- `desktop/src/features/agents/ui/UnifiedAgentsSection.tsx`：Agent 列表分组；
- `desktop/src/features/agents/ui/ManagedAgentRow.tsx`：运行状态、错误、模型、工作频道和操作入口；
- `desktop/src/features/agents/ui/AgentStatusBadge.tsx`：受管 Agent 状态标签；
- `desktop/src/features/agents/ui/ManagedAgentLogPanel.tsx`：日志展示。

### 创建与编辑

- `desktop/src/features/agents/ui/AgentDialog.tsx`：创建 / 编辑对话框路由；
- `AgentDefinitionDialog.tsx`、`AgentInstanceEditDialog.tsx`：定义级与实例级编辑；
- `AgentConfigFields.tsx`、`AgentConfigPanel.tsx`：共享字段渲染；
- `desktop/src/features/agents/lib/agentConfigCore.ts`：把 Rust runtime metadata 投影为前端字段模型；
- `desktop/src/features/agents/ui/agentConfigOptions.tsx`：选项和就绪门控辅助；
- `ModelPicker.tsx`、`ProviderConfigFields.tsx`、`McpServersSection.tsx`、`EnvVarsEditor.tsx`：具体配置 surface；
- `WhereToRunSection.tsx`、`RespondToField.tsx`、`OwnerOnlyAccessField.tsx`：运行位置与访问边界；
- `desktop/src/features/agents/useAgentManagement.ts`、`useManagedAgentRuntimeReconciliation.ts`：UI 操作和运行时对账。

### 频道内 Agent surface

- `desktop/src/features/channels/ui/QuickBotBar.tsx`、`BotActivityBar.tsx`：频道内 Agent 快捷入口和活动提示；
- `AddChannelBotDialog.tsx`、`MembersSidebarAgentControls.tsx`：向频道添加 / 管理 Agent；
- `useChannelAgentSessions.ts`、`agentSessionSelection.ts`：频道内 Agent 活动选择；
- `ChannelComposerActivityAccessory.tsx`：Composer 附近的 Agent 活动入口。

## 6. Tauri 原生层与受管 Agent 生命周期

### IPC 命令

- `desktop/src/shared/api/tauri.ts`：前端 Tauri API 聚合入口；
- `desktop/src-tauri/src/commands/agents.rs`：Agent CRUD 与启动 / 停止命令；
- `desktop/src-tauri/src/commands/agent_config.rs`、`agent_models.rs`、`agent_providers.rs`：配置、模型和 provider；
- `desktop/src/shared/api/agentControl.ts`与`observerRelay.ts`：运行中 turn 的停止 / 切模控制通过 observer relay 发送，不走本地 Tauri command；
- `desktop/src-tauri/src/lib.rs`：Tauri command 注册与应用装配。

### 受管 Agent 核心

- `desktop/src-tauri/src/managed_agents/mod.rs`：模块出口与共享不变量；
- `runtime.rs`：进程启动、停止、取消和状态更新；
- `restore.rs`：应用重启后的 Agent 恢复；
- `storage.rs`：受管 Agent 持久化记录；
- `spawn_snapshot.rs`：用于判定配置变更与重启的启动快照；
- `readiness/`：运行前就绪检查；
- `discovery/runtime_metadata.rs`：Harness 能力的权威目录；
- `config_bridge/`：Codex、Claude、Goose、Buzz Agent 配置桥；
- `backend.rs`：本地 / provider backend 抽象；
- `runtime_commands.rs`：受管运行时对账与 lifecycle command；
- `agent_events.rs`：可公开同步的 Agent 配置投影，使用显式 allowlist 避免泄露密钥；
- `parallelism.rs`：Harness 并发限制；
- `process_lifecycle.rs`：Windows 进程树清理；Unix 进程组清理在 `runtime.rs`。

**适合借鉴：** UI 不直接管理进程；启动前做闭合 readiness；配置变更与当前进程使用的 snapshot 对比；停止必须清理整个进程树；公开投影使用 opt-in allowlist，不能从完整记录删几个秘密字段后直接发送。

## 7. ACP Agent 调用链

### `buzz-acp`：频道事件到 Agent session

- `crates/buzz-acp/src/main.rs`：进程入口；
- `relay.rs`：连接 relay、订阅频道事件与断线恢复；
- `filter.rs`：mention / channel / kind 过滤；
- `queue.rs`：按频道排队，保证同一频道不会并发处理多个 prompt；
- `pool.rs`、`pool_lifecycle.rs`：ACP Agent 进程池、并发与恢复；
- `acp.rs`：ACP JSON-RPC client；
- `observer.rs`：把 Agent 活动发布成 Desktop 可订阅事件；
- `base_prompt.md`：Agent 在 Buzz 工作区中的基础行为说明。

### `buzz-agent`：LLM 与工具循环

- `crates/buzz-agent/src/main.rs`：stdio 服务入口；
- `wire.rs`：ACP request / notification / update 协议；
- `agent.rs`：session、对话历史、轮次和 tool loop；
- `llm.rs`：Anthropic、OpenAI、OpenRouter、Databricks 请求与响应；
- `mcp.rs`：MCP server 生命周期和工具调用；
- `handoff.rs`：上下文接近上限时的总结与续跑；
- `auth.rs`、`config.rs`、`model_capabilities.rs`：认证、环境配置和模型能力。

### `buzz-dev-mcp`：编码工具

- `crates/buzz-dev-mcp/src/lib.rs`：MCP server 与工具注册；
- `shell.rs`：有界输出、超时和进程组清理的 shell；
- `read_file.rs`、`str_replace.rs`：读取和精确替换；
- `rg.rs`、`tree.rs`：代码检索；
- `view_image.rs`：图片查看；
- `paths.rs`：相对工作目录解析和路径边界。

### `buzz-cli`：Agent 与工作区交互

- `crates/buzz-cli/src/client.rs`：relay / REST client；
- `crates/buzz-cli/src/commands/messages.rs`：读写消息；
- `commands/channels.rs`、`dms.rs`、`reactions.rs`：频道、私信和回应；
- `commands/agents.rs`：Agent 管理命令；
- `commands/projects.rs`、`repos.rs`、`patches.rs`、`pr.rs`、`issues.rs`：代码协作；
- `commands/workflows.rs`：工作流。

## 8. Relay、事件与持久化

仅当任务需要理解 Buzz 为什么产生某个 UI 状态时阅读本节；不要把 Buzz 协议当作 Dao 的协议模板。

- `crates/buzz-core/src/kind.rs`：事件 kind 权威注册表；
- `crates/buzz-relay/src/handlers/event.rs`：认证、验签、成员校验、DB insert、Redis publish、fan-out、搜索、审计和工作流触发；
- `crates/buzz-relay/src/connection.rs`及相邻模块：WebSocket 连接生命周期；
- `crates/buzz-db/`：Postgres 事件与业务投影；
- `crates/buzz-pubsub/`：Redis pub/sub、presence 与 typing；
- `crates/buzz-search/`：全文搜索；
- `crates/buzz-sdk/`：类型化事件 builder；
- `migrations/`、`schema/schema.sql`：数据库结构。

## 9. 测试与验证入口

- React / TypeScript 单元测试通常与源文件相邻，命名为 `*.test.mjs`；先读相邻测试，它们往往比组件更准确地说明边界条件；
- `desktop/tests/e2e/`：Playwright Desktop 端到端场景；
- `crates/*/tests/`和各 Rust 模块内的 `#[cfg(test)]`：协议、生命周期、恢复和安全边界；
- `TESTING.md`：整个项目的测试策略；
- `desktop/playwright*.config.ts`：smoke、integration、performance 与 release smoke 配置。

参考一个 Buzz 行为时，至少形成“UI 入口 → 状态 / API → 原生层或 relay → 相邻测试”的闭合阅读链，不要只复制 JSX。

## 10. 常用最小阅读配方

### 做聊天时间线或消息样式

1. `MessageTimeline.tsx`
2. `TimelineMessageRow.tsx`
3. `MessageRow.tsx`
4. `MessageHeader.tsx`
5. `formatTimelineMessages.ts`
6. 相邻的 grouping、row equality 和 timeline tests

### 做 `@Agent` 与发送状态

1. `MessageComposer.tsx`
2. `MentionAutocomplete.tsx`
3. `useMentionSendFlow.ts`
4. `agentMentionRevalidation.ts`
5. `effectiveExplicitAgentPubkeys.ts`
6. `sendToChannelSemantics.ts`及相邻测试

### 做 Agent execution / activity UI

1. `AgentSessionThreadPanel.tsx`
2. `observerRelayStore.ts`
3. `activeAgentTurnsStore.ts`
4. `AgentSessionTranscriptList.tsx`
5. `agentSessionTranscriptGrouping.ts`
6. `activityRenderClasses/`
7. transcript、working signal、scroll 相关测试

### 做 Agent 配置和生命周期

1. `desktop/src/features/agents/AGENTS.md`
2. `AgentDialog.tsx`与目标对话框
3. `lib/agentConfigCore.ts`
4. `discovery/runtime_metadata.rs`
5. `commands/agents.rs`
6. `managed_agents/runtime.rs`、`readiness/`、`storage.rs`
7. 对应前端与 Rust tests

### 做 Agent 运行时或取消 / 恢复

1. `crates/buzz-acp/src/queue.rs`、`pool.rs`
2. `crates/buzz-acp/src/acp.rs`
3. `crates/buzz-agent/src/agent.rs`
4. `crates/buzz-agent/src/mcp.rs`
5. `desktop/src-tauri/src/managed_agents/runtime.rs`
6. `activeAgentTurnsStore.ts`与 `agentWorkingSignal.ts`
7. pool lifecycle、regression、cancel 和 restore tests
