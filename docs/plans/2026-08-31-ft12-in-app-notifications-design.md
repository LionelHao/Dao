# FT-12 In-app Notifications：生产工程设计

> 日期：2026-08-31
> 状态：Stage 14A 独立实施设计；不是验收或 verified 声明
> 基线：产品 PRD、`docs/protocols/`、`docs/design/README.md` 当前正式审阅稿

## 1. 结果与直接范围

FT-12 在 FT-09 source boundary 与 FT-13 单一 repair/cache 机制之上实现一套服务端权威、recipient-scoped、durable、幂等的 Notification domain。直接覆盖 `REQ-PRIM-017`、`REQ-PRJ-010`、`REQ-PRJ-012`、`REQ-UX-003`、`REQ-UX-008`。

不建设 OS push、Electron system notification 唯一入口、旧 M4 五分区、global inbox、第二 snapshot 或 offline command queue。flat center 是基础通知表面，不是责任工作台。

## 2. Closed domain

### 2.1 Notification kind 与 source kind

```text
notificationKind:
  human_mention | human_request | tool_confirmation | project_due |
  tool_result | agent_execution_completed | agent_execution_failed |
  cannot_answer_escalation

sourceKind:
  message_mention | project_request | tool_confirmation | project_boundary |
  tool_call | agent_execution | project_obstacle
```

权威 fact 为 `notification.v1`：`notificationId`、`roomId`、`recipientActorId`、closed kind、source `{ kind,id,revision,boundaryId,ordinal }`、64-hex canonical `dedupeKey`、`createdAt`、`readAt/readRevision`、handled projection、closed deep link、最小 safe projection。不得包含 Provider request/response、headers、secret、hidden reasoning、arbitrary tool body、attachment bytes、无界正文、展示 HTML 或第二份 Room corpus。

### 2.2 Producer / recipient / source matrix

| Producer | Recipient authority | Source / canonical dedupe binding | Created condition | Handled condition | archive/revoke | deep link / inaccessible |
| --- | --- | --- | --- | --- | --- | --- |
| structured Human mention | mention entity 的 Human actorId | `(recipient,messageId,mentionRevision,ordinal,human_mention)` | accepted message transaction 内合法 Human target | 来源 Request/mention workflow终结；纯查看不处理 | archived 不新增；member revoke 清除披露 | message revision；无权/recall仅 tombstone 或清项，不泄正文 |
| Human Request | stable target Human；结果另通知 requester | `(recipient,requestId,revision,ordinal,human_request)` | Request proposal/pending durable commit | accepted/rejected/cancelled；transfer 使旧 recipient handled，新 target 新 boundary | archived 不新增；revoke 停止 | project Request；不可访问清项 |
| Tool confirmation | FT-10 exact confirmation principal | `(principal,confirmationId,version,ordinal,tool_confirmation)` | pending confirmation commit | confirmed/rejected/expired；handoff 旧 handled + 新 principal新 boundary | archive/cancel/recall 按 rejected reason收敛 | confirmation；403/410不泄 safe preview |
| Project due | 当前 Human Ball holder | `(recipient,sourceBoundaryId,project_due,ordinal)` | due boundary首次到达，之后每24h新 ordinal | resolved/deferred/transferred | archived 冻结；reopen 不重放旧 boundary | project fact/boundary |
| Tool result | execution时 confirmation principal + invocation requester去重 | `(recipient,toolCallId,dispatchVersion,ordinal,tool_result)` | known result、revoke-before-dispatch 或 outcome_unknown | known/revoked 需 recipient acknowledge；unknown 仅 review/compensation | revoke 停止披露 | tool review/result；无 raw body |
| Agent completed | direct requester；proactive source Human holder/requester，fallback owner/admin按 PRD | `(recipient,executionId,terminalVersion,ordinal,agent_execution_completed)` | committed terminal completed | explicit acknowledge或 source终结/恢复动作 | archived 不创造新业务通知 | execution/final source |
| Agent failed | 同 completed recipient | `(recipient,executionId,terminalVersion,ordinal,agent_execution_failed)` | committed failed/dead-letter/noauth | retry/cancel/repair/ack 或 source终结 | 同上 | execution recovery |
| cannot_answer escalation | current obstacle escalation principal | `(recipient,obstacleBoundaryId,revision,ordinal,cannot_answer_escalation)` | cannot_answer 新 boundary 一次 | resolved/transferred/explicit ignore | archived 冻结；reopen只处理新 boundary | Blocker/OpenQuestion |

所有 recipient 均由服务端 authority 计算；客户端 frame 不接受 recipient、actor、handled 或 arbitrary source metadata。

## 3. 事务、dedupe、read/handled

v28 `notifications` 表以 canonical `dedupe_key` unique，且对 `(recipient_actor_id, source_boundary_id, notification_kind, source_ordinal)` 建业务唯一约束。producer transaction 同时提交 notification fact、stable event、principal outbox 与 source command receipt；commit 前全回滚，commit 后 ACK loss/restart/at-least-once/repair 都只得到同一 notificationId。

read 与 handled 严格分离：

- `notification.read` 只能由当前 notification recipient 的有效 Human session 提交；服务端从 session 注入 actor。
- ACK 为 requestId-correlated，stable read event 包含新 `readRevision`；多 session 共享同一权威 read 状态。
- 打开 center 不标 read；点击并成功 ACK 只改变 read。
- handled 只由 source projection 或批准的显式 acknowledge/review动作产生；不存在任意 `mark-handled` 客户端旁路。
- handled 不反向伪造 read。`read=true, handled=false` 是第一等状态。

## 4. list/query、source resolution 与 closed errors

- list/query 只按 authenticated recipient，采用 stable `(createdAt,notificationId)` cursor、bounded page；不得查询其他 recipient。
- Room badge 与 flat center 使用同一 recipient projection/filter；badge 是 `unread` 计数，unhandled 另以文字/图标表达，不由 renderer local array 充当 authority。
- source resolution 每次重验 session、membership、Room lifecycle、access revision和 source eligibility。来源不可访问时返回 closed `source_inaccessible`，不得返回标题/正文/source metadata，并触发本地清项。
- 覆盖 401 unauthenticated、403 recipient/Room forbidden、409 revision/idempotency conflict、410 source/notification gone、429 bounded queue/rate limit（含 `retryAfterMs`）、503 authority/storage unavailable。拒绝路径写入、adapter、另一 recipient delivery均为0。

## 5. sync / repair

`RoomRepairRecord` 增加唯一 `kind: "notification"` descriptor，仍由 FT-13 closed registry 驱动 materialized/streaming canonical bytes、order、checksum和 fixed watermark。descriptor 额外接收 authenticated Human recipient scope，只返回该 actor 的 notification；同 Room 其他 Human、未入 Room Tenant Administrator均为零记录。

每页和 complete 前继续复核 session/family/device、membership、room lifecycle/access revision和 credential generation；revoke 可中途抢占。Desktop apply stable notification event、event ledger与 cursor同一 cache transaction，repair staging完整后再原子 generation flip；失败保留旧完整且仍有权 cache。preview/typing/chunk/toast不进入 repair。

## 6. Desktop / J-07 映射

设计权威：`docs/design/README.md`、Requirement coverage 与正式审阅稿 J-07。

| 状态/组件 | 权威来源 | 行为/恢复 |
| --- | --- | --- |
| center loading/open | local transient；records来自 projection | 打开本身不写 read；focus trap，Esc关闭并返回触发按钮 |
| empty | complete recipient projection | 明示“暂无通知”，不从 Room message猜测 |
| unread | notification stable projection | 文字“未读”+图标，不只靠颜色 |
| read but unhandled | read event + source nonterminal projection | 保留行动入口；不因 read清责任 |
| handled | source terminal projection | 文字“已处理”；read仍保持独立 |
| badge/overflow | 同 recipient projection count | Room badge与center同源；overflow如 `99+`，accessible label给精确有界描述 |
| deep link | source resolution ACK + local scroll/highlight | scroll/highlight仅local transient；不制造 source事实 |
| source recalled/inaccessible | tombstone或closed 403/410 | 不泄标题正文/metadata，清本地项并克制 aria-live通告 |
| offline | verified finite lease + complete cache | 严格只读；mark-read transport call=0，不自动旧 confirmation |
| repairing / repair failed | local transient + server repair checkpoint/error | staging不可见；失败保留旧完整且仍授权 cache，明确 retry |
| revoked | stable access reduction + purge completion | center/badge/Room cache立即移除 |
| archived | stable Room lifecycle | 已有有权项按 source access展示；不产生新业务 notification |
| 401/403/409/410/429/503 | closed ACK/error | 重登录、清理、refresh source、删除项、按 retryAfter、retry/离线只读 |

覆盖 840×560、100/125/150/200% zoom、键盘列表导航、可见 focus、dialog focus trap/return、Esc、非颜色标识、`aria-live=polite`、VoiceOver-friendly label、reduced motion。偏离：无。

## 7. 容量与运维

list/page/repair均 bounded；PR 级 10,000 notifications 证明 O(page) repair、flat multi-room
list、badge 一致与无半 cache。Notification 继续复用既有 AuthorityWorker、outbox 与 repair 的
有界队列、批次、重试、dead-letter 和 shutdown 合同；本阶段不引入 FT-14 worker operations、
retention janitor、diagnostics 或新的运维事实面。

## 8. 验收门

八类 producer exactly-once、cross-recipient zero leak、canonical dedupe/crash/restart、read/handled、多 session、repair/revoke/archive/reopen、due 24h、10k、J-07/a11y、offline zero transport、closed errors与真实 SQLite/Desktop restart全部通过后才可形成 FT-12 交付证据。
