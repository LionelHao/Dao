# T-0020 人来让位硬规则实施计划

日期：2026-08-17
状态：实施完成，等待 owner 验收
基线：`main` / `origin/main` at `d1a0655`；工作区基线干净。
权威来源：`docs/plans/2026-08-12-t0021-expand-m3.md` 的 T-0020；复用 T-0016、T-0041 已批准的 route/runtime seams，不修改 Blueprint。

## 六条验收标准（逐条原文复制）

1. Agent 发言队列复用 T-0041 的 execution queued / running / completed / failed / cancelled 权威生命周期，不建立第二张状态表；`generating` 是 running 下的动作类别，`requeued` 是旧 attempt 进入 cancelled 后创建新单调 attempt 的持久 transition / event。调度器按 room 串行、跨 room 可并行，首版每 room 容量 32、全进程 active 8，超限返回闭合 429 + retryAfterMs；不使用无界 Promise / 数组。
2. 冻结顺序为 `durable human message accepted → cancel same-room old queued attempts，以及 state=running 但 actionCategory=waiting_upstream / tool_not_started 的可取消 attempts → 以该新消息及事务提交后的最新 room 状态创建 RouteJob → enqueue replacement attempts`；只有 `state=running && actionCategory=model_generation` 的 attempt 可把已经开始生成的这一条说完。旧上下文不得先重路由，replacement 也不得在新消息可见前入队。该规则不可配置，不受 agent participation 影响。
3. 被取消的旧 attempt 即使迟到返回也不能写 message、execution completed 或覆盖新 attempt；取消 / 重排原因和 source human messageId 持久化，服务重启后仍可查询。
4. Agent message、系统事件、历史重放和同一 human message 的幂等重试都不会重复触发让位；一次 human message 对每个旧可取消 attempt 最多产生一次 cancelled 和一次 replacement。
5. 在队列满、provider 超时、worker crash、重启恢复和连续 human 插话下，不丢 durable human message，不永久保留 queued / running 僵尸；取消与恢复有真实 worker / provider fake 的确定性并发测试。
6. 客户端显示“检测到人类发言，N 个排队 Agent 已取消并重新判定”；每个 agent 显示 cancelled / requeued，不把它表现成 human 撤回或 agent 失败。DOM / class 与事件类型均不同。

## 文件级切片与 TDD 顺序

1. Core closed types：先补 `AgentExecution.supersedesExecutionIds`、`HumanPreemptionNotice`、closed sync event 和 type/guard 反例，再实现最小类型与解析。
2. schema v11：先补 fresh/历史 v1-v10→v11、future/unknown refusal、migration fault rollback、message fence/replacement invariant，再追加 immutable migration；不改 v1-v10 statement/checksum/fingerprint。
3. Authority fence transactions：先用真实 SQLite 写 eligibility matrix、迟到 CAS、幂等 replay、零取消 receipt、连续 human message、route-before-replacement 拒绝，再实现 cancel、create-route、enqueue-replacements 与 recovery scan。
4. Runtime orchestration：先用 provider fake 验证 cancellation commit 后才 abort、queued 移除、model generation 不 abort、replacement 使用新 execution/attempt，再接入 bounded HumanPreemptionRuntime。
5. Production composition：human `message.send` 只先提交 message；post-commit orchestrator 依次 cancel、create RouteJob、notify route。Agent message/系统 event/replay 不触发；启动恢复 pending human fences。
6. Sync/Desktop：持久 `room.human_preemption.applied` 与 execution changed/lifecycle 进入现有 event/outbox/repair；桌面 notice、cancelled、requeued 使用独立 DOM/class。
7. E2E/交付：真实 AuthorityWorker/SQLite/WebSocket restart、连续插话、cache-clear 与 stale completion；协议文档、交付说明、全量门禁、commit/PR/CI/merge。

## 验收映射

| 标准 | 生产切片 | 自动化证据 |
| --- | --- | --- |
| 1 | 复用 AgentRuntime scheduler/lifecycle；replacement 为新 execution | queue 32 / active 8 既有回归 + replacement identity tests |
| 2 | post-commit HumanPreemptionRuntime 与三个 AuthorityWorker transaction | 顺序 probe、eligibility matrix、model generation 反例 |
| 3 | attempt CAS、human fence/replacement trace、supersedes IDs | late completion、restart query/repair tests |
| 4 | human-only message receipt、unique fence/replacement keys | agent/event/replay/duplicate/continuous-message tests |
| 5 | bounded recovery scan、queue-full rescan、provider/worker crash | real-worker/provider fake/restart E2E |
| 6 | closed notice event、desktop preemption/requeued cards | sync guard + DOM/class negative assertions |

## 明确边界

- 不把 model generation、已 dispatched tool 或 terminal attempt 伪装成可取消。
- 不复活旧 execution，不继承 provider partial/context，不消耗旧 execution 的自动 retry budget。
- 不建立第二套 scheduler、writer、消息管线或 Agent 身份旁路。
- 不实现跨 room inbox/通知、GBP 写入或可配置的“人来让位”开关。
- 不修改 Blueprint HTML/JSON，不自行将 T-0020 标为 verified。
