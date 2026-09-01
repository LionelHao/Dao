# FT-12 In-app Notifications · Stage 14 交付说明

> 状态：**Stage 14A 独立内容候选**。本文只记录 FT-12 可复核事实；不把 FT-14 的 blocked
> 候选带入本分支，不标记 verified，也不代替 owner 验收。

## 1. 一句话结果

FT-12 把八类业务来源收敛为服务端权威、recipient-scoped、durable、幂等的 Notification domain，
并通过同一 projection 驱动 flat center、Room badge、read/handled 双轴、source resolution、FT-13
repair 与 J-07 Desktop；FT-14 继续作为独立 Stage 14B blocked，不构成 FT-12 的交付依赖。

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

- 当前 Authority schema 只有 append-only immutable v28；v1-v27 migration、checksum 与 fingerprint
  不变。本分支没有 schema v29 或 retention metadata。
- closed WS 包括 list/query、mark-read、source resolve、tool-result acknowledge、execution-result
  acknowledge、requestId ACK、stable events、positive retry-after 与 closed error mapping。
- 明确排除：OS push、Electron system notification 作为唯一入口、旧 M4 五分区、全局搜索、
  offline command queue、客户端伪造 read/handled、第二 snapshot/event bus/Authority DB。

## 9. 自动化与本地门禁

以下账本来自 Stage 14A 独立分支，不沿用组合 Stage 14 的计数：

| 验证 | 结果 |
| --- | --- |
| 全仓 `corepack pnpm test` | 290 files passed、3 skipped；2942 tests passed、3 skipped；0 failed；809.51s |
| 10k capacity | `sqlite-authority.test.ts` 覆盖 recipient keyset、无 gap/duplicate |
| `corepack pnpm typecheck` | passed |
| `corepack pnpm lint` | passed，0 warnings |
| `corepack pnpm build` | passed，Core / Server / Desktop build 完成 |
| `corepack pnpm verify:core-boundary` | passed，无 I/O dependency/import |
| `corepack pnpm verify:desktop-boundary` | passed，33 个 production renderer sources 无 Node/Electron authority |
| `git diff --check` | passed |

skip 只能按最终实际运行结果记录；focused 分类互相重叠，不能与全仓总数相加。

## 10. Independent reviewer

独立 Sol high reviewer 对首个内容 head 发现 1 个 materialized Room repair snapshot 未绑定
recipient identity revision 的 P1，以及 1 个 Markdown trailing-whitespace P2。修复把 identity
head 纳入 snapshot reuse key，并增加跨 Worker restart 的 notification revision 防回退测试。
同一 reviewer 对修复 head `eeb8033775110a2e99e5af575926dc57b70e4364` 完成闭环复审：
`0 P0 / 0 P1 / 0 P2`；同时确认 FT-14 零泄漏、schema 仅 append-only v28、v1-v27 不变，且
recipient filter、read/handled、multi-session/restart、archive/revoke/recall、closed WS/outbox、
Desktop J-07、无 OS push/五分区和 offline mutation transport=0 均保持。

## 11. PR、CI、merge 与 Git 状态

| 证据 | 当前事实 |
| --- | --- |
| 内容 PR | 待创建 |
| Required CI / Node matrix | 待远端真实结果；不得用本地结果替代 |
| Content merge SHA | 待内容 PR 合入后回填 |
| Evidence-only PR / merge | 待真实证据回填并独立合入 |
| 分支 / worktree | `codex/ft12-stage14a-notifications`；`/Users/leo/code/Dao-ft12-stage14a` |
| 当前 base | `53f3fed8696293ee9644efa266c3585b66811267`（创建分支时的最新 `origin/main`） |

原工作区与四个 owner 文件保持只读；最终清理前再次核对 HEAD、status 与 SHA-256。

## 12. 已知风险与交付门

- FT-12 不选择、替代或模拟 production credential secret backend，也不放宽 `REQ-NFR-006`。
- Stage 14B / FT-14 保持 blocked：缺少owner批准的durable/versioned/restart-recoverable production credential secret backend，需@owner明确服务端生产部署平台并选择backend。
- FT-12 只有在独立全量验证、Sol high 终审、内容 PR required CI/merge、evidence-only PR
  required CI/merge 与临时 worktree 清理完成后才达到交付条件；本文始终不标记 verified。
