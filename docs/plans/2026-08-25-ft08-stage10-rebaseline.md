# FT-08 Invocation Runtime · Stage 10 rebaseline

> 日期：2026-08-25（Asia/Shanghai）  
> 状态：生产实施基线；不代表 FT-08 已完成、已验收或 verified  
> 实际 predecessor：`origin/main@82ef2231c86559ed8ad7941f8abe32d6cd32a68a`  
> Authority schema：v21；开始时 GitHub 无 open PR

## 1. 权威、范围与设计基线

优先级固定为 PRD → 协议/批准 feature spec → 正式 UI 设计 → 生产代码与测试。FT-08 直接或共同负责 `REQ-AGT-001/002/004/006/008/009/010/012`、`REQ-MEM-008/010`、`REQ-MSG-001/008`、`REQ-NFR-005`、`REQ-PRIM-011/012/013`；同时遵守 `REQ-AGT-013`、`REQ-MSG-005/006`、`REQ-ROOM-004`、`REQ-NFR-004/011/014`。

正式设计映射：J-03 的双 Agent 独立 execution card、五态/retry/scoped cancel/preview；J-05 的 waiting confirmation、grant claim 前撤销、claim 后证据保留与 outcome review；J-07 的 offline、固定水位 repair、repair-failed 与多 session 收敛。权威来源为：preview/焦点/command submitting 属于 local transient；control ACK 只证明 Authority commit；execution terminal、confirmation/grant/dispatch 来自 stable event；availability、source revised/recalled 与 repair view 来自 projection。设计偏离：**无**。

## 2. rebaseline 事实

- FT-03 已交付 structured target、逐 target outcome、`message_target` durable intent、source revision/recall fence；message commit 不再依赖 public `agent.invoke`。
- FT-06 已交付 immutable context snapshot/body/manifest/binding、compiled-only Provider、retry/crash snapshot reuse、source invalidation与 citation final transaction。
- FT-07 已交付 stable Actor、Profile/Assignment revisions、availability/trusted direct+routed origin、direct authority binding、routed handoff；public `agent.invoke` handler 固定 410。
- v16 已经把旧 intent/execution 一对一扩展为 `agent_execution_intent_links` 一对多、`executionOrdinal` 与 `retryOfExecutionId`；v19 已绑定 immutable snapshot；v21 已绑定 direct Profile/Assignment/access revisions。Stage 10 不重复建设这些事实。
- 当前 public Core/repair/Desktop 仍把 execution `queued` 当用户状态；runtime scheduler 仍按 Room 单 active；timeout abort 可早退；recovery 仍为一次有界读取；旧 room-wide human preemption 仍装配在 production；legacy interrupt/retry payload不符合 vNext。

## 3. 历史机制的取舍

- 旧 T-0041 可复用：单 writer、execution/attempt CAS、三次 attempt、1s/4s backoff、Provider/Adapter closed seams、commit-before-abort、partial preview 非权威、confirmation/grant/dispatch与 outcome_unknown 的物理机制。
- 旧 T-0020 只可复用：候选读取、CAS、事务提交后 abort/queue removal、late attempt zero-write 的并发手法。
- 必须退出：任意 Human message 扫描整个 Room、`room.human_preemption.applied` 新 producer、replacement/reroute 产品行为、public free-text cancellation reason。旧 tables/events仅保留 `legacy_room_wide_preemption` 审计读取，不解释成 scoped fence。

## 4. canonical aggregate 与 schema v22

权威链冻结为：`message target / route decision / project boundary → AgentInvocationIntent → AgentExecution 1..N → AgentExecutionAttempt 1..N → optional confirmation/grant/dispatch → final message 0..1`。

v22 从 v21 追加 immutable reader-first合同，不修改 v1-v21：canonical execution five-state + closed phase/version/generation、intent lineage与 ordinal/retry reference、snapshot binding引用、attempt terminal/CAS摘要、scoped cancellation fence/targets/receipt、stable closed reason、recovery keyset/lease/dead-letter/review、server-private project-boundary producer receipt以及 legacy broad-preemption marker。历史 queued row通过 v22 canonical projection映射为 `accepted/queued`；历史事实本身不重写。

fresh 与 v1…v21→v22、future refusal、历史 checksum/fingerprint tamper、逐 statement rollback、fresh/migrated equivalence、WAL reopen与 startup invariants必须分别证明。如果实际 reader部署顺序要求 v23，只能记录机械原因并保持 v22不可变；当前无此需求。

## 5. scheduler、retry、recovery 与 cancellation

- admission 按 Room 内 turn/intent authority顺序；同 turn 多 Agent可并发；后 turn不得越过尚未 admission 的前 turn；waiting confirmation不阻塞 sibling target。
- global active上限8；每 Room durable admission上限32；capacity不足返回429 + `retryAfterMs`，durable candidate不因内存queue满丢失，释放capacity后继续scan。
- automatic retry保持同 execution/snapshot/Agent/Profile/Assignment/Provider/model，最多3 attempts、1s/4s；timeout先持久化 retry-scheduled或 terminal failed，再传播 timeout abort。
- Human retry仅对 eligible failed/cancelled，创建新 execution并保留旧 terminal；同 requestId replay同 child，新的 requestId可创建下一个 ordinal；source recalled、Context disputed、access/Profile/Assignment失效或 unresolved side-effect review时拒绝旧snapshot。
- recovery使用稳定keyset、bounded page、claim lease并 drain-until-empty；queue-full保留 durable candidate；poison item闭合为 failed/dead-letter/review并推进cursor；257/513/1025尾部必须收敛。
- `commitScopedCancellation(scope, expectedVersion, reason)` 是唯一新取消线性化点：同事务验证 principal/internal capability与 relation，写 fence，CAS intent/execution/attempt，reject pending confirmation，revoke unclaimed grant，保留 confirmed/claimed dispatch，写 event/outbox/receipt。COMMIT 后才 abort、移 queue、清 preview并发 `preview.reset`。

## 6. Requirement → 生产闭环矩阵

| Requirement | intent/execution/fence与责任 | 生产落点 | 证明 |
| --- | --- | --- | --- |
| REQ-AGT-001 | per-target durable intent；共享room facts、独立Agent envelope与终态 | Core lineage、v22、scheduler、target events/repair | 双target并发、partial reject、sibling isolation、crash replay |
| REQ-AGT-002 | public只表达direct对象控制；route/project为server-private | protocol 410/closed vNext、trusted origin capability | forged identity/kind/provider zero-call |
| REQ-AGT-004 | route/claim/model/tool/final逐点重验，busy durable reservation | FT-07 revision gates + runtime reservation | paused/noauth/revoke/restart矩阵 |
| REQ-AGT-006 | stable project boundary exactly-once producer | v22 boundary receipt + fail-closed private port | FT-09 unavailable时Provider/execution零调用 |
| REQ-AGT-008 | only accepted/running/completed/failed/cancelled | Core guard、canonical projection、Desktop card | five-state/phase/aria与无spinner |
| REQ-AGT-009 | auto retry同execution；Human retry新execution | v22 lineage/attempt CAS、runtime retry/recovery | 1s/4s/3 attempts、snapshot eligibility、idempotency |
| REQ-AGT-010 | scoped fence；无关消息零影响；claim后不伪装回滚 | AuthorityWorker cancel transaction + orchestrator | cancel/final/recall双winner与confirmation矩阵 |
| REQ-AGT-012 | parent cancel与既有confirmation/grant/dispatch原子协作 | shared Authority transaction；不建第二tool库 | pending/confirmed-unclaimed/claimed三分支 |
| REQ-MEM-008 | execution所有auto/crash attempt绑定同snapshot | v19 binding + v22 lineage/eligibility | source revise不漂移、recall/dispute拒绝retry |
| REQ-MEM-010 | direct memory degraded继续；semantic proactive暂停 | FT-05/06 health gate + runtime producer policy | confirmed memory+raw delta；project不可读suppressed |
| REQ-MSG-001 | message+N target outcomes同事务；execution异步 | FT-03 transaction + v22 claim | ACK-loss/replay/partial target race |
| REQ-MSG-008 | preview transient；final唯一权威消息 | preview transport/reset + final CAS | sentinel扫描全部durable surfaces零命中 |
| REQ-NFR-005 | queue/timeout/retry/recovery/shutdown有界 | scheduler、keyset lease、dead-letter | 32/8、257/513/1025、poison、bounded close |
| REQ-PRIM-011 | @Agent产生真实intent/execution | direct binding + async claim | accepted→running→terminal real worker/WS |
| REQ-PRIM-012 | five-state在场；queued/retrying/waiting为phase/action | Core/sync/repair/Desktop统一projection | cancelled与failed分离、preview非权威 |
| REQ-PRIM-013 | active/on-mention；availability分离 | FT-07 gate + claim/model/tool recheck | on-mention direct完整工具；paused零Provider |

共同责任边界：FT-08闭合parent runtime/fence/abort/preview/lineage；FT-09最终闭合真实Goal/checkpoint/due/Blocker authority；FT-10最终闭合confirmation principal/grant/review/compensation；FT-13最终闭合通用repair/outbox/cache/lease；FT-14最终闭合运营、retention与credential policy。当前 seam均 server-private、closed、versioned、fail-closed，不冒充后续能力完成。

## 7. 文件所有权与合入顺序

- Core agent：仅 `packages/core/src/` closed types/guards/type tests。
- Scoped cancellation agent：仅新/现有 cancellation模块与fake-port tests；AuthorityWorker接线由集成owner。
- Runtime recovery agent：仅 `agent-runtime/` scheduler/retry/recovery；DB ports由集成owner。
- 集成owner独占 `schema.ts`、Authority handler/worker、`authoritative-server.ts`、protocol/WS、sync/snapshot、Desktop runtime/root与package exports。

顺序：rebaseline/Core → v22 readers/migration → scoped fence transaction + broad producer off → scheduler/retry/recovery → FT-06/07/tool parent gates → protocol/sync/repair/preview → Desktop/a11y → real-worker/race/adversarial → delivery evidence。

