# FT-06 Stage 8 工作笔记

状态：执行中。此文件记录可复核事实，不把计划写成完成证据。

## 1. 基线

- 日期/时区：2026-08-21 / Asia-Shanghai。
- `git fetch origin --prune` 后 `origin/main=c0dc4421b3b5d5c00c4676e86bd205c482aa332c`。
- schema v18；Stage 7基线为158 passed/3 skipped files、1796 passed/3 skipped tests。
- GitHub无open PR；Stage 7最新merge为#59。
- 原工作区`/Users/leo/code/Dao`位于`codex/ft02a-delivery-trace-fix`，四个用户未跟踪FT-09/FT-10计划文件已列入保护清单。

## 2. Worktree台账

| 用途 | branch | path | 基线 | 状态 |
| --- | --- | --- | --- | --- |
| 集成 | `codex/ft06-stage8-integration` | `/Users/leo/code/Dao-stage8-ft06-context` | c0dc442 | active |
| contract/compiler | `codex/ft06-contract-compiler` | `/Users/leo/code/Dao-stage8-ft06-contract` | c0dc442 | active |
| persistence/recovery | `codex/ft06-persistence-recovery` | `/Users/leo/code/Dao-stage8-ft06-persistence` | c0dc442 | active |
| provider/source tool | `codex/ft06-provider-source-tool` | `/Users/leo/code/Dao-stage8-ft06-provider` | c0dc442 | active |

## 3. 已读权威资料与现状证据

已读根`AGENTS.md`；未发现更深层`AGENTS.md`。已读PRD、design README与Requirement coverage、批准FT implementation map、authoritative sync/identity/message ACK协议、FT-01～05正式spec/计划/交付材料、T-0041 runtime材料，以及当前core/server/runtime/persistence/room-memory/provider实现。未查阅Buzz，因此无需引入其模式或许可证内容。

确认现状缺口：`AgentRuntimeProviderInput.visibleConversation`仅messageId/authorId/body；OpenAI把其全部映为`user`；`runtime.read-context` SQL为按时间倒序`LIMIT 64`后重排；`runAttempt`每次递归/自动retry再次调用`buildProviderInput`；无snapshot/manifest/budget/read receipt/final citation authority。

FT-09尚未正式交付；production project adapter必须disabled/unavailable。FT-07 persona未交付；只使用真实Agent id/kind/membership/tool permission，responsibility明确unavailable。

## 4. 设计裁决

- pure compiler与runtime metadata分离，时钟/随机snapshot id不进入canonical manifest hash。
- deterministic estimator使用保守UTF-8 byte accounting +固定结构overhead，不在线猜模型窗口。
- snapshot restricted body可持久化canonical envelope以确保crash byte identity，但绝不投影到event/outbox/repair/WebSocket/log。
- Provider dispatch前重验snapshot及当前授权；recall/dispute/revoke不允许旧snapshot继续发送，也不静默换context。
- `room-memory.read`只能接受当前manifest label与opaque cursor；无任意source id、SQL、URL/path/regex。
- citation自然语言不解析；只验证closed declaration是manifest/read receipt子集，并与final transaction原子提交。
- 不扩大Desktop shell。J-03/J-06/J-07既有状态作为交互边界；服务端citation projection是唯一显示前提。
- owner本阶段明确要求manual retry新snapshot，取代旧J-03审阅稿“复用同一snapshot”的一行描述；自动retry/crash仍复用。

## 5. 验证日志

待实现后填写每条命令、精确files/tests计数、schema migration/invariant/rollback、worker/restart/WebSocket、property seed/runs、Electron与live skip/pass。

## 6. Review与PR日志

待实现后填写子分支commit、adversarial reviewer发现、修复、集成PR、CI、merge SHA与worktree清理结果。任何“通过”必须链接到实际命令或GitHub状态；本文不使用`verified`作为项目状态。

