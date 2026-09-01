# FT-12 In-app Notifications · Stage 14 交付说明

> 状态：**本地内容候选完成，Stage 14 交付门尚未满足**。FT-12 代码、文档、测试和独立终审已冻结，
> 但共享 Stage 14 仍被 FT-14 production credential secret backend 的 owner 架构决策阻塞；尚无
> commit、内容 PR、required CI、merge 或 evidence-only PR。本文只记录当前可复核事实，不标记
> verified，也不宣称交付门已经满足。

## 1. 一句话结果

FT-12 已把八类业务来源收敛为服务端权威、recipient-scoped、durable、幂等的 Notification domain，
并通过同一 projection 驱动 flat center、Room badge、read/handled 双轴、source resolution、FT-13
repair 与 J-07 Desktop；当前代码终审没有剩余 P0/P1/明确安全正确性 P2。

## 2. 权威输入与设计映射

- 直接 Requirement：`REQ-PRIM-017`、`REQ-PRJ-010`、`REQ-PRJ-012`、`REQ-UX-003`、
  `REQ-UX-008`。
- UI 权威：`docs/design/README.md` 当前正式审阅稿的 J-07；loading/empty/offline/repair/revoke
  也复用 J-01/J-02 已批准状态。
- 生产设计：[`2026-08-31-ft12-in-app-notifications-design.md`](../plans/2026-08-31-ft12-in-app-notifications-design.md)。
- 实施计划：[`2026-08-31-ft12-in-app-notifications-implementation-plan.md`](../plans/2026-08-31-ft12-in-app-notifications-implementation-plan.md)。
- 协议：[`in-app-notifications.md`](../protocols/in-app-notifications.md)。
- 设计偏离：**无**。

## 3. 五条 direct Requirement 证据

| Requirement | 当前收口语义 | 主要代码/测试证据 |
| --- | --- | --- |
| `REQ-PRIM-017` | Human mention、Request、confirmation、due、tool result、execution terminal 与 escalation 产生 recipient-scoped durable notification；recipient 只由服务端 authority 推导 | `packages/server/src/notifications/`；`source-transaction-adapter.test.ts`；`sqlite-authority.test.ts` |
| `REQ-PRJ-010` | Request/transfer/defer/cannot_answer 的新 boundary、旧 recipient handled 与新 target notification 均有稳定 source lineage | `packages/server/src/project-loop/database-authority.ts`；notification producer/terminal projection tests |
| `REQ-PRJ-012` | 当前 Human Ball holder 的 due 第一次立即、之后每 24 小时按 ordinal 去重；archive 冻结，reopen 不重放旧 boundary | `packages/server/src/project-loop/reminder-worker-operation.test.ts`；notification due producer tests |
| `REQ-UX-003` | flat center 与 Room badge 同源；打开 center 不写 read，source deep link 只产生 local scroll/highlight | `packages/desktop/src/renderer/notification-center/`；surface/view-model/app tests |
| `REQ-UX-008` | unread、read-but-unhandled、handled、offline、repair、revoked、archived 与 inaccessible 都有非颜色、键盘、焦点和 live-region 合同 | renderer notification center CSS/surface tests；Desktop runtime/cache tests |

## 4. Producer / recipient / source matrix

| Producer | Recipient authority | 稳定绑定 | handled authority | archive/revoke/source access |
| --- | --- | --- | --- | --- |
| structured Human mention | mention entity 的 Human actorId | messageId + mention revision + ordinal | 来源 workflow 终结；查看不处理 | archive 不新增；recall/revoke 不泄正文 |
| Human Request | stable target Human；结果通知 requester | requestId + revision + ordinal | accepted/rejected/cancelled；transfer 旧 handled、新 boundary | 不可访问时清项 |
| Tool confirmation | FT-10 exact confirmation principal | confirmationId + version + ordinal | confirmed/rejected/expired；handoff 新 principal 新 boundary | 无权只返回 closed 403/410 |
| Project due | 当前 Human Ball holder | sourceBoundaryId + 24h ordinal | resolved/deferred/transferred | archive 冻结；reopen 不重放 |
| Tool result | frozen confirmation principal / requester 去重 | toolCallId + dispatch version | exact recipient acknowledge 或 review/compensation | 无 raw tool body |
| Agent completed | direct requester；批准的 proactive holder/requester | executionId + terminal version | acknowledge 或 source terminal/recovery | archive 后不新建 |
| Agent failed | 与 completed 相同 | executionId + terminal version | retry/cancel/repair/ack | noauth/dead-letter 同一 closed source |
| cannot_answer escalation | current obstacle escalation principal | obstacle boundary + revision | resolved/transferred/explicit ignore | 只链接批准的 Blocker/OpenQuestion |

`dedupe_key` 与 `(recipient, source boundary, kind, ordinal)` 都由数据库约束；客户端 frame 不接受
recipient、actor、handled 或 arbitrary source metadata。notification fact、stable event、principal outbox
和 receipt 在同一 AuthorityWorker transaction 提交。

## 5. Read / handled 与 badge/center

| 轴/状态 | 权威来源 | 不变量 |
| --- | --- | --- |
| unread/read | recipient 的 `notification.mark-read` ACK + stable read event | 只有当前 recipient 的有效 Human session 可写；打开 center、scroll、highlight 不写 read |
| unhandled/handled | source terminal projection或批准的 tool/execution result acknowledge | 没有任意 `mark-handled`；handled 不反向伪造 read |
| badge | 与 center 相同的 recipient projection/count | renderer local array 不是 authority；repair/reconnect/另一 session 后收敛 |
| source action | source resolve ACK | 403/410、recall 或撤权不返回标题、正文或 source metadata |

`read=true, handled=false` 是第一等状态。tool-result 与 execution-result 使用各自 source-specific ACK；
重复 acknowledge 返回 `already_acknowledged`，不制造第二个 handled event。

## 6. Repair、撤权与高扇出恢复

- schema v28 追加 notification fact/read/handled/revoke 与唯一约束；未修改 v1-v27。
- `RoomRepairRecord` 只新增一个 `kind: "notification"` descriptor，继续使用 FT-13 唯一 closed
  registry、canonical bytes/order/checksum、fixed watermark 和 active/staging atomic flip。
- repair 由 authenticated Human recipient scope 过滤；同 Room 其他 Human及非成员 Tenant
  Administrator 为零记录。page/complete 前复核 session、membership、lifecycle、access revision 与
  credential generation。
- membership removal 在同一 transaction set-based 撤销该成员全部旧 notification；前 256 项产生
  stable revoke event/outbox，尾部由 bounded recovery 补齐。
- message recall 高扇出使用 pending `room.message.recalled` outbox 作为 restart-safe barrier：320 项
  全部先 durable revoked，256+64 分批补 stable event/outbox，clean tail 后才发送/mark 原 recall；
  recovery failure/dispatcher restart 不增加 delivery attempt，也不进入 dead-letter。
- Desktop notification apply、event ledger、cursor 在同一 encrypted cache transaction；撤权完成后
  center、badge 与 Room cache 同步清理。

## 7. J-07 可见状态与无障碍

覆盖 loading、empty、unread、read-but-unhandled、handled、offline、repairing、repair failed、
revoked、archived、recalled、source inaccessible、401/403/409/410/429/503、retry、badge overflow 与
bounded page。840×560、100/125/150/200% zoom、键盘列表、可见 focus、dialog focus trap/return、
Esc、非颜色文字/图标、`aria-live=polite`、VoiceOver label 与 reduced motion 均由正式设计合同和
renderer tests 固化。

离线只允许读取仍在 finite signed lease 内的 complete cache；mark-read、source action、旧
confirmation 均不会排入本地 command queue，transport 调用数为 0。

## 8. Schema、协议与范围排除

- 当前 Authority schema 为 immutable v29；FT-12 只拥有 append-only v28，v29 属于 FT-14 retention
  metadata。v1-v27 migration/checksum/fingerprint 不变。
- closed WS 包括 list/query、mark-read、source resolve、tool-result acknowledge、execution-result
  acknowledge、requestId ACK、stable events、positive retry-after 与 closed error mapping。
- 明确排除：OS push、Electron system notification 作为唯一入口、旧 M4 五分区、全局搜索、
  offline command queue、客户端伪造 read/handled、第二 snapshot/event bus/Authority DB。

## 9. 自动化与本地门禁

当前最终本地候选：

| 验证 | 结果 |
| --- | --- |
| 全仓 `corepack pnpm test` | 337 files：334 passed / 3 safely skipped / 0 failed；3186 tests：3183 passed / 3 safely skipped / 0 failed；834.68s |
| Core / Server / Desktop | Core 16 files / 136 tests PASS；Server 217 files、2247 tests，其中3 files/3 tests安全跳过；Desktop 104 files / 803 tests PASS |
| Notification/repair 独立矩阵 | reviewer 全量 notification center/repair 24 files / 215 tests PASS |
| 高扇出 recall/outbox | broader 11 files / 77 tests PASS；真实恢复 integration 5 files / 38 tests PASS |
| 10k capacity | `sqlite-authority.test.ts` 10k recipient keyset，无 gap/duplicate |
| TypeScript / lint / build | `pnpm typecheck`、`pnpm lint`、`pnpm build` PASS |
| Boundary / diff | Core、Desktop boundary 与 `git diff --check` PASS |
| Electron smoke | app bridge、native selection、secure preview PASS |

3 个 skip 是没有显式 OpenAI secret 时的 opt-in live smoke，记录为“安全跳过”；未读取或打印
secret，也未回退 production mock。focused 分类互相重叠，不能与全仓总数相加。

## 10. Independent reviewer

最终冻结工作树经独立 reviewer 检查 recipient 泄漏、read/handled 混淆、source inaccessible、
archive/reopen、repair/badge、高扇出 recall/outbox restart、真实 WS/Desktop 路径。结论：代码
`P0/P1/明确安全正确性 P2 = 0/0/0`。

## 11. PR、CI、merge 与 Git 状态

| 证据 | 当前事实 |
| --- | --- |
| 内容 PR | 未创建；production credential backend 尚未批准，Stage 14 内容不完整 |
| Required CI / Node matrix | 未发生；不得用本地结果替代 |
| Content merge SHA | 未发生 |
| Evidence-only PR / merge | 未发生 |
| 分支 / worktree | `codex/stage14-notifications-privacy-operations`；`/Users/leo/code/Dao-stage14` |
| 当前 base/head | `53f3fed8696293ee9644efa266c3585b66811267`，工作树变更未提交 |

原工作区 `/Users/leo/code/Dao` 仍为 `codex/ft02a-delivery-trace-fix@979863e`，四个 owner 未跟踪
计划的 SHA-256 与任务输入一致。

## 12. 已知风险与交付门

- FT-12 当前没有独立代码 blocker；共享 Stage 14 的唯一外部 blocker 是 FT-14 缺少 owner 批准的
  durable/versioned/restart-recoverable production credential secret backend。
- 在 backend production composition、rotation crash matrix、重新终审、内容 PR/CI/merge、evidence
  PR/CI/merge 与 worktree 清理真实完成前，本文件保持阻塞态，不得解释为 owner 验收或完整交付。
