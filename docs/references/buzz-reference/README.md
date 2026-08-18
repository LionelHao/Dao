# Buzz 参考项目介绍

## 一句话定位

[Buzz](../../../buzz/) 是 Block 开源的、可自托管的人与 AI Agent 协作工作区。它把频道、消息、线程、回应、Agent 调用、工作流、代码协作和审计记录放在同一套事件系统中；用户看到的是团队聊天与协作界面，底层由自有 relay 维护权威事件日志。

本地参考副本当前固定在 Buzz Desktop `0.5.16` 对应的提交 `978e585`（`chore(release): release Buzz Desktop version 0.5.16 (#6191)`），使用浅克隆。本文和 [代码地图](CODE_MAP.md)均以该版本为准。

## 它解决什么问题

Buzz 的核心观点是：Agent 不只是聊天窗口外的后台机器人，而是工作区中的一等成员。人和 Agent 可以处在同一频道，接受点名、参与线程、运行工具、发布结果，并留下可查询、可审计的活动轨迹。

对本项目最有参考价值的能力包括：

| 能力 | Buzz 中的表现 | 本项目可借鉴的重点 |
| --- | --- | --- |
| 频道聊天 | 时间线、线程、富文本编辑器、回应、草稿、附件、未读状态 | 页面与组件拆分、长列表锚定、发送状态和恢复体验 |
| Agent 点名 | Composer 中选择 Agent，发送前进行成员和运行状态校验 | Human / Agent 寻址分离、发送前校验、失败闭合 |
| Agent 活动可视化 | 侧栏展示思考、计划、工具调用、消息发布和运行状态 | 权威事件到可读活动的投影、工具详情渐进披露、停止操作 |
| Agent 管理 | 创建、配置、启动、停止、重启、共享、模型与权限设置 | 配置事实源、前后端边界、进程树生命周期、错误呈现 |
| Agent 运行桥接 | `buzz-acp` 把频道事件交给 ACP Agent；Agent 再通过 MCP / CLI 工作 | 调用链分层、并发与取消、恢复、工具执行可观测性 |

## 技术结构

Buzz 是 Rust 与 TypeScript 组成的 monorepo：

- `desktop/`：Tauri 2 + React 19 桌面客户端；React Query 管理服务端状态，Tiptap 负责消息编辑，Virtua 负责时间线虚拟化，Motion 负责可降级动画；
- `desktop/src-tauri/`：桌面原生层，负责 IPC、身份与密钥、媒体、受管 Agent 的发现、配置、启动、停止和运行时状态；
- `crates/buzz-relay/`：Axum WebSocket / REST relay，是 Buzz 的服务端协调入口；
- `crates/buzz-core/`、`buzz-sdk/`：事件类型、kind 注册表、签名与事件构造；
- `crates/buzz-acp/`：把 relay 中的消息和点名转成 ACP session prompt，并处理排队、并发、取消、重连与恢复；
- `crates/buzz-agent/`：最小 ACP Agent，完成 LLM → tool call → MCP tool result 的循环；
- `crates/buzz-dev-mcp/`：为编码 Agent 提供 shell、文件读取/替换、搜索、树、图片查看和 todo 工具；
- `crates/buzz-cli/`：面向 Agent 的 JSON 输入 / 输出 CLI，用于读写频道、消息、回应、项目和工作流。

整体调用链可简化为：

```text
React Desktop UI
  ↕ Tauri IPC / WebSocket
Tauri managed-agent runtime + Buzz relay
  ↕ channel events / ACP JSON-RPC
buzz-acp → ACP Agent（buzz-agent、Codex、Claude Code、Goose 等）
  ↕ MCP / buzz-cli
文件、Shell、频道消息与其他工作区能力
```

## 在本项目中如何使用 Buzz

Buzz 是实现参考，不是需求来源。正确顺序是：

1. 先阅读根目录 [AGENTS.md](../../../AGENTS.md)以及 [本项目 UI / 交互设计基线](../../design/README.md)；
2. 明确当前任务对应的 PRD Requirement、协议事实、设计旅程与组件状态；
3. 在 [Buzz 代码地图](CODE_MAP.md)中按任务选择最小入口；
4. 同时阅读入口文件、它直接依赖的状态层 / API 层和相邻测试，确认真实调用链；
5. 提炼可复用的模式，再按本项目的类型、权威状态和错误合同实现；
6. 在交付说明中写明借鉴了什么，以及哪些 Buzz 语义被明确排除。

优先借鉴“结构和边界”，例如：时间线如何分层、Agent 活动如何由事件投影、停止按钮如何只在可中断状态出现、配置能力如何保持单一事实源。不要直接照搬 Buzz 的颜色、布局细节、文案、Nostr tag、事件 kind 或 community / relay 假设。

## 明确不应照搬的内容

- **视觉与交互规范**：本项目权威设计稿优先；即使 Buzz 的交互更完整，也不能越权补产品行为；
- **领域模型**：Buzz 的 community、channel、Nostr 身份和签名事件并不等同于本项目的 Identity、Session、Room 和权威 Worker；
- **同步架构**：Buzz 以 relay 事件日志为单一事实源，本项目必须继续遵守自己的命令、ACK、stable event、projection、repair 与 SQLite writer 边界；
- **权限判断**：不能从 Buzz 的 UI 隐藏逻辑推导本项目权限，权限必须由本项目服务端协议强制执行；
- **依赖与实现规模**：不要为了复用一个界面模式而整体引入 Tauri、Nostr、React Query、Tiptap 或某个 Buzz 子系统。

## 许可证与来源

Buzz 仓库使用 Apache License 2.0，详情见 [Buzz LICENSE](../../../buzz/LICENSE)。只阅读并借鉴架构模式通常不需要复制代码；若直接复制或制作实质派生代码，应保留适用的版权与许可证声明，并在本项目变更说明中记录来源文件与参考提交。

## 上游文档入口

- [Buzz README](../../../buzz/README.md)：产品定位、能力和快速开始；
- [Buzz Architecture](../../../buzz/ARCHITECTURE.md)：协议、relay、crate 边界和事件处理管线；
- [Buzz Agent Vision](../../../buzz/VISION_AGENT.md)：ACP Agent 与 MCP 工具的设计原则；
- [Buzz Testing](../../../buzz/TESTING.md)：集成与端到端测试方式；
- [Buzz contributor rules](../../../buzz/AGENTS.md)：查阅源码时需要遵守的项目级规则；
- [Agent feature rules](../../../buzz/desktop/src/features/agents/AGENTS.md)：查阅 Agent 配置实现前必须先读的局部事实源规则。
