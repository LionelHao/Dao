# FT-03 Message Authority vNext · 第五阶段总交付说明

> 日期：2026-08-19
> 状态：交付条件已满足，等待 owner 验收；本文不宣布 FT-03、第五阶段或 Blueprint verified。
> predecessor：`origin/main@7659690b748dd651d43fbdb5f0980e21e1c3e81b`，authority schema v15
> 代码交付基线：`origin/main@326f72d082b4e008946989d13380deb923dc70a3`，authority schema v16

## 1. 一句话结果

FT-03 已形成从 Core closed contract、`message.send.v2` 单事务 authority、逐 target durable outcome/intent、Human revision/recall、source-scoped runtime fence、Agent final/correction，到 canonical sync/repair 与 Desktop J-02/J-03/J-04/J-07 的完整生产闭环，并由真实 SQLite、AuthorityWorker、WebSocket、restart、三客户端和 sentinel 自动化证明。

## 2. Requirement、FT 与设计旅程

- 直接主责：`REQ-ID-001`、`REQ-PRIM-006`～`REQ-PRIM-012`、`REQ-MSG-001`～`REQ-MSG-008`、`REQ-UX-007`。
- 横切：`REQ-PRIM-001/003`、`REQ-MEM-001/008/011`、`REQ-AGT-001/002/008/010`、`REQ-NFR-002`～`005`、`007`、`010`～`012`、`014`、`REQ-UX-009`。
- 旅程：J-02 composer/ACK/retry；J-03 Agent intent/execution/final 分层；J-04 Human Request intent 与责任接受分离；J-07 offline/repair/revoked/clear-cache/multi-session 收敛。
- 设计分区：Room header/status、timeline、structured composer、mention picker、reply context、target outcome/activity、revision/recall controls、offline/repair banner、accessibility live region。
- 设计偏离：**无**。非空附件继续按 FT-04 未开放能力 fail closed；preview 只作为 transient activity，不进入稳定 timeline。

## 3. Core Message vNext closed contract

- 导出 `Utf16Range`、`MentionTarget`、`AttachmentReference`、`HumanMessageSubmit`、`MessageTargetOutcome`、`MessageRevision`、`ActiveHumanMessage`、`AgentFinalMessage`、`MessageTombstone`、`TimelineMessage` 及 message event/repair variants。
- strict guards 使用 exact own keys（包含 symbol/non-enumerable 检查）、canonical `.sssZ` UTC timestamp、UTF-16 surrogate boundary、唯一且有序无重叠 target/range、唯一 attachment、outcome↔target 1:1。
- public Human submit 不含 author/actor/principal/session/capability/runtime/provider/model；Agent final 不含 public author choice、mention、attachment 或 reply。
- reply/source/correction 的 same-Room/same-Agent 关系由 transaction 查询 authority row 后传入 closed link context；DB FK/trigger 是最终约束。
- Human、Agent final/correction 与 tombstone 保持不同 discriminant 和视觉合同；tombstone 无 body、mention、reply、attachment。

## 4. `message.send.v2` transaction 与 ACK

同一个 AuthorityWorker `BEGIN IMMEDIATE` transaction 内完成：

1. session reauth、active Room/current membership；
2. closed message/body/entity/range/reply/attachment shape；
3. session-derived Human author；
4. message、revision 1、active envelope；
5. 每个 target 的 current actor/membership/assignment recheck；
6. 每个 target 恰好一个 durable outcome；
7. accepted HumanRequestIntent 或 AgentInvocationIntent；
8. stable event、outbox、idempotency receipt、durable ACK result。

任一系统失败整笔 rollback。单个 target 不可用时，消息与其他合法 target 继续提交；该 target 只生成一个 closed rejected outcome，绝不生成 orphan intent。Room archived、author无权、shape非法、storage unavailable 仍是整条 command 零写错误。

`message.accepted` 只证明 message/outcomes/accepted intents 已提交；不证明设备送达、Human接受责任、Agent execution 已创建或完成、tool/memory/final 已发生。

## 5. Target outcome 与 intent/execution 分离

- rejection 闭集：`target_not_member`、`target_kind_mismatch`、`target_assignment_inactive`、`target_room_archived`。
- mention entity 使用 stable actorId 寻址，range 仅用于 UTF-16 编辑/渲染；不从 displayName、正文 regex、邮箱、代码或 `@agent-id` 推断 target。
- HumanRequestIntent 绑定 Room/message/target/source revision/requester/target Human，初始 pending；不表示责任已接受，recall 后 pending intent 变为 cancelled。
- AgentInvocationIntent 绑定同一 source lineage 与 target Agent，但不伪造 executionId；execution 通过独立 link 表在后续 claim/create 时生成并再次重验 membership、assignment、source fence 与 generation。
- public client 不能声明 `direct_mention`、`structured_help`、`routed_candidate` 等 server-only authority kind；v2 target 不经过旧 public `agent.invoke` 或 `open-item.create` 捷径。

## 6. 幂等、ACK loss 与 reply

- business scope 是 `(authenticated principal, message.send.v2, roomId, messageId)`，不是 requestId。
- ACK 丢失后可用新 requestId exact replay；返回原 message/outcomes/event ID，并回显本次 requestId。
- same messageId 改 body、target、range、reply 或 attachment 返回 409 `idempotency_conflict`，且不产生第二 message/revision/outcome/intent/event/outbox。
- reply 只引用同 Room 稳定 messageId，可指向 active Human、Agent final 或 tombstone；不存在/cross-Room fail closed，tombstone reply 仅显示占位，不建立 Thread。
- 当前 attachment seam 只允许 `[]`；非空值在 FT-04 validator 合入前返回 closed validation error，不接受 path/blob URL/filename/MIME/hash/URL/OCR/bytes。

## 7. Human revision 与 recall

- `message.revise` 仅原 Human author、active Human message、current revision CAS；append-only revision，只改变 body。
- targets、reply、attachments、target outcomes 与 intent lineage 永久冻结；Agent final 不可 revise；并发 two-device revise 恰好一个 winner。
- `message.recall` 仅原 Human author、active/current revision CAS；保留 envelope/revision/intent/audit/source lineage，operational projection 变为 body-free tombstone。
- recall transaction 取消 pending Human/Agent intents，写 exact source/revision/execution/attempt/generation durable fence；commit resolve 后才 reset preview/传播 AbortSignal。
- authority rollback 不 abort；post-commit abort fault 不回滚 durable recall并进入 recovery-required；late final/correction 由 fence/CAS 零写拒绝。
- completed final 与 confirmed fact 保留；dispatched/outcome_unknown side effect 保留真实状态，不伪装撤销；不触发旧 room-wide Human preemption。

## 8. Agent final / correction authority

- 只有 server-internal opaque capability 可调用 final/correction commit；public Core command和WebSocket没有 Agent final/correction frame。
- transaction 重验 Room、Agent、invocation intent、execution、attempt/generation、source message/revision/fence 与 terminal/final CAS。
- Agent final 是 append-only timeline record；correction 是新 Agent message，只能由同一 Agent 修正自己的 final；原 final 不 update、recall 或 delete。
- late attempt、wrong Agent/execution、cross-Room、stale generation、recalled-fenced source 均零写。

## 9. Schema v16、backfill 与 legacy compatibility

- predecessor：v15 `truthful-room-lifecycle-audit-vocabulary`；checksum `41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9`；fingerprint `e8010dc3c03c71d51f20ef4054a815d3580abdcbd0762791508226a68918b426`。
- new migration：v16 `message-authority-vnext`，82 meaningful statements；checksum `51e5b5114b90bc8407d7eec86a559da0170cec1ec0bfc1c5587d828a5765f1a7`；fingerprint `86a3512dcb625bc3e0f3d79e5a5d6542819523bee8ac851990148bcad8e38737`。
- 新表/关系覆盖 envelope、revision、mention、target outcome、Human/Agent intent、execution link、reply/attachment、recall fence、Agent source/correction；revision append-only、message identity immutable、same-Room/fence/final CAS 由 CHECK/FK/UNIQUE/trigger 闭合。
- v1～v15 statement bytes/checksum/fingerprint 未改；fresh/all historical upgrades、future/tamper refusal、82/82 statement fault rollback、schema/data/user_version/history rollback、restart/no duplicate 均有真实 SQLite 证据。
- legacy message backfill只生成 revision 1 + kind-matched active envelope；不解析正文 `@`，不建历史 target/outcome/intent/event/outbox。旧 `message.send` 只映射 no-target/no-reply/no-attachment；unsafe revision/tombstone reader 返回 410 `protocol_upgrade_required`。

## 10. Closed protocol、event 与错误

- strict public frames：`message.send.v2`、`message.revise`、`message.recall`、`room.history.v2`、`message.revisions.query` 及 requestId-correlated ACK；message stable events进入 canonical Room stream。
- missing/extra/wrong/oversized 和 author/actor/role/principal/session family/grant/provider/model/capability 注入都在 parser/service/persistence 分层 fail closed。
- command errors覆盖 400/401/403/404/409/410/429/503；target rejection 是 ACK 内 durable outcome，不升级为 command error。
- error frame 不回显 raw body、secret、token、provider body/header、hidden reasoning、tool params、filesystem path、SQL 或 stack。
- queue、target、body、revision/history/repair page、frame/buffer、timeout、retry、shutdown 全部有界。

## 11. History、event、sync、repair 与 outbox

- server canonical projector 输出 active Human current revision + frozen structure、immutable Agent final/correction lineage、body-free tombstone；history/event/repair 共用该 seam。
- 新 message event 的 durable payload只存稳定 ID，再按当前 authority投影；旧 full-payload event在 recall 后被强制 repair/authorization 收敛，不能重放 raw。
- Room delta遇到已变化的 historical message projection返回 `operational_projection_changed` repair signal；Desktop以 fixed watermark 重订阅、先缓存 live events、再原子换 generation。
- materialized cache只存 message reference，不存 raw body；hydrate时重验 fixed watermark。recall invalidates pre-recall snapshot，secure deletion/checkpoint处理 cache DB/WAL physical sentinel。
- eventId/streamSeq dedupe、message revision monotonic、fixed checksum、staging atomic swap、repair failure保留或锁定旧完整 projection；member/session revoke 中断 page并清目标 Room。
- outbox send-before-mark 重放同一 event ID；accepted/revised旧 pending delivery在 recall 后不再泄露或伪装当前 projection。

## 12. Desktop 状态、权威来源与 accessibility

| 可见状态 | 权威来源 |
| --- | --- |
| draft/reply/mention picker/submitting/preview | local transient；preview明确 non-authoritative，`aria-live=off` |
| message commit / mutation correlation | matching requestId ACK 或 same-message stable event |
| target request/invocation/rejected | durable ACK + stable event/projection；不等于 Human接受或 Agent完成 |
| active/revised/tombstone/final/correction | stable event + operational projection |
| offline | connection state + last complete projection；mutation fail closed |
| repairing | server watermark + staged complete generation；成功后原子切换 |
| repair-failed/revoked | 保留有权旧完整 projection，否则锁定并 purge |

- mention picker使用 stable actorId；相同 displayName 可区分；不做正文 regex。
- event-before-ACK、ACK-before-event、ACK-loss same messageId、duplicate event均收敛；winning revise/recall event先到时，后到的 local 409/503 仍按 requestId 显示 loser 与 refresh。
- closed bridge只暴露五个 message operation + subscription；session/token/raw socket/idempotency secret/Node/SQLite/generic IPC 永不进入 renderer。
- loading/empty、400/401/403/404/409/410/429/503、archived、offline、repair/retry都具有显式状态与文案。
- keyboard/focus return、non-colour label、bounded `aria-live`、VoiceOver contract、840×560/1440×900/200% zoom wrapping、reduced motion 全覆盖。

## 13. Race、crash、restart 与三客户端

- real SQLite：target member removal/Agent assignment reduction vs send 两种序列；target/domain/outcome fault；same-message replay/change conflict；two-device revise；revise vs recall；recall vs claim/create/final；route source active/current/fence。
- runtime：recall commit-before-abort、rollback-zero-abort、post-commit abort recovery、source-exact cancellation、pending/late receipt fail closed、completed/dispatched facts retained、no broad preemption。
- real child process：三个 authenticated WebSocket client、同 author 两个 device、Human+Agent targets；sender收到 stable event后丢失ACK，新socket/新requestId exact replay，字段变更409，restart后仍唯一 aggregate。
- real Desktop runtimes：expired cursor→repair_required→watermark subscribe→history；一端离线错过 revise后 reconnect；clear-and-restore；recall tombstone；server restart后三端收敛且不含 raw sentinel。
- crash boundaries覆盖 after-domain/before-commit 零写、commit-before-outbox replay、send-before-dispatch-mark duplicate delivery、AuthorityWorker/server restart。

## 14. Recalled raw、preview、secret 与 renderer sentinel

- recalled raw：允许保留于受限 authority revision/audit；普通 history、revision query、event/outbox、sync、repair、runtime context、route/calibration topics、snapshot cache、Desktop input/DOM 均不可见。
- preview：deep fake provider发出唯一 sentinel；recall、abort、SIGKILL、restart、reconnect 后，SQLite operational rows、DB/WAL/cache bytes、event/outbox/history/repair/runtime context均零命中，且 late final 零写。
- secret：credential/token/provider response body/header/hidden reasoning/tool params/SQL/stack 的 closed error与durability sentinel继续通过；renderer只得到业务 DTO，不得到 authority capability。
- fake provider/capability/intent consumer只存在于 deep test fixture，未从 package root 暴露，production composition没有 fake fallback。

## 15. 验证命令与精确计数

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
git diff --check
```

| Evidence | Result |
| --- | --- |
| 全仓 Test Files | 101 passed / 2 skipped / 0 failed（103） |
| 全仓 Tests | 1430 passed / 2 skipped / 0 failed（1432） |
| Core message/sync | 4 files / 51 tests；negative type tests由 `tsc --noEmit` 通过 |
| protocol/message protocol/WebSocket | 3 files / 210 tests |
| schema v15/v16/general | 3 files / 69 tests；v16 rollback 82/82 |
| SQLite authoritative store | 84/84 |
| runtime scoped fence/Human preemption | 17/17 |
| snapshot worker | 70/70 |
| real Authority/process | 23/23 |
| Desktop | 33 files / 308 tests |
| typecheck/lint/build/boundaries/diff | 全部通过；lint 0 warnings |

两个 skipped 是既有 opt-in OpenAI live smoke，不是本阶段回避项。

## 16. PR、ready head、merge 与 CI

| PR | Ready head | Squash merge | GitHub quality |
| --- | --- | --- | --- |
| [#42 · Core closed contracts](https://github.com/LionelHao/Dao/pull/42) | `c63e685300172c13328e47a4312e573bcd197429` | `f768accac1266fc891e3f09a4f46daa7464e4bd9` | [32224440190](https://github.com/LionelHao/Dao/actions/runs/32224440190)，Node 22.13.1 / 22.x success |
| [#43 · schema v16](https://github.com/LionelHao/Dao/pull/43) | `28f990c7b6a410f90e057a1cffe333a426270c94` | `2b775156adcfaf06bbb6fe33bcc71fd58023154d` | [32231268177](https://github.com/LionelHao/Dao/actions/runs/32231268177)，Node 22.13.1 / 22.x success |
| [#44 · closed protocol](https://github.com/LionelHao/Dao/pull/44) | `499f6bdc6eede7b7221a91e26126e2b5f1d013a9` | `d7b64d1d5dff84bb16340805e08305fb0f36b555` | [32235419770](https://github.com/LionelHao/Dao/actions/runs/32235419770)，Node 22.13.1 / 22.x success |
| [#45 · Authority lifecycle](https://github.com/LionelHao/Dao/pull/45) | `f4ed9bc8f6340fc8586fb983474f10b92686adde` | `ec3bb653e803064cd62f2b6f6fae8ed47705140b` | [32237011304](https://github.com/LionelHao/Dao/actions/runs/32237011304)，Node 22.13.1 / 22.x success |
| [#46 · Desktop loop](https://github.com/LionelHao/Dao/pull/46) | `069e1f72affeddc598d0c84f21c4bc6c57fec6d1` | `4ca050a22422814a42600813ead006a708d62721` | [32237833927](https://github.com/LionelHao/Dao/actions/runs/32237833927)，Node 22.13.1 / 22.x success |
| [#47 · race/leakage/E2E](https://github.com/LionelHao/Dao/pull/47) | `299a3d795c80c98b647eef4917e1529a8a6a9193` | `326f72d082b4e008946989d13380deb923dc70a3` | [32239461206](https://github.com/LionelHao/Dao/actions/runs/32239461206)，Node 22.13.1 / 22.x success |

## 17. 已知风险与建议 reviewer

- persistence/schema：复核 v16 immutable DDL、82 statement rollback、legacy backfill、message identity/fence/final triggers、snapshot secure deletion与Node 22 `node:sqlite` 单 writer。
- runtime/tool：复核 source exact tuple、commit-before-abort、restart recovery、dispatched/outcome_unknown truthfulness；不要把 recall 描述为撤销外部副作用。
- protocol/security：复核 exact own-key parser、author/capability injection、error redaction、bounded frames与public Agent intent/final refusal。
- sync/Desktop：复核 message ID pointer hydration、fixed-watermark bounded retry、revoke中断、atomic generation、renderer credential/Node boundary与accessibility。
- FT-04/05/08/09/11/14 的完整产品仍由相应 owner 后续交付；本阶段 closed seam 不冒充其完整 lifecycle。

## 18. 边界声明

- AuthorityWorker 仍是唯一 writer；没有新增第二 DB、writer、message authority、event bus 或 client-side business fact source。
- 未修改 Blueprint HTML/JSON，未自行修改 FT/Blueprint 状态。
- 用户原始工作区的四份未跟踪 FT-09/FT-10 文档未 clean、stash、reset、移动、覆盖或纳入提交。
- 本交付结论等待 owner 独立验收；执行者不使用 verified 表述。

**第五阶段已达到交付条件，等待 owner 验收。**
