# FT-08 Invocation Runtime · Stage 10 交付说明

状态：FT-08 的 Stage 10 生产实现已通过受保护分支合入远端 `main`，等待 owner 验收；本说明不把 Agent 自测、独立审阅或 CI 写成 owner 验收，也不标记 verified。

## 1. 一句话结果与远端事实

- 一句话结果：权威 intent/execution/attempt 生命周期、五态 projection、同 turn 多 Agent 并发、scoped cancellation、automatic/Human retry、keyset recovery、transient preview、fixed-watermark repair 与 Desktop execution presence 已进入 production composition；FT-09/10/13/14 的共享边界保持 server-private、closed、versioned、fail-closed。
- 起始 `origin/main`：`82ef2231c86559ed8ad7941f8abe32d6cd32a68a`（FT-07 Stage 9 evidence，Authority schema v21，开始时无 open PR）。
- FT-08 最终实现 `main` SHA：`eedd2d59d9a7a5659671d8573ba08ea6f7906ebe`（PR #71 squash merge，Authority schema v22）。
- 本交付记录：[PR #72 — docs(ft08): record Stage 10 delivery evidence](https://github.com/LionelHao/Dao/pull/72)；其 squash merge 将成为 Stage 10 证据 tip。

| PR | 范围 | merge SHA | 必需 CI |
| --- | --- | --- | --- |
| [#71](https://github.com/LionelHao/Dao/pull/71) | FT-08 rebaseline、Core、schema v22、Authority/runtime、protocol/sync/repair、Desktop 与对抗加固 | `eedd2d59d9a7a5659671d8573ba08ea6f7906ebe` | [quality 32847791058](https://github.com/LionelHao/Dao/actions/runs/32847791058)：[Node 22.13.1](https://github.com/LionelHao/Dao/actions/runs/32847791058/job/97801436292)、[Node 22.x](https://github.com/LionelHao/Dao/actions/runs/32847791058/job/97801436634) 均 success |
| [#72](https://github.com/LionelHao/Dao/pull/72) | Stage 10 delivery evidence（本文件） | 本PR的squash merge由GitHub记录为最终证据tip | 本PR页面保留最终双Node required checks |

没有 force push、没有绕过 branch protection、没有弱化或 skip 失败测试。实现涉及 103 个文件、15195 行新增、699 行删除；Blueprint HTML/JSON 与 renderer 不在变更清单中。

## 2. 16 条 Requirement 的代码与测试映射

| Requirement | FT-08 生产代码/合同 | 测试与交付证据 | 后续边界 |
| --- | --- | --- | --- |
| `REQ-AGT-001` | Core 的 per-target intent、lineage、execution ordinal 与 v22 runtime state；scheduler 对同 turn 各 Agent 独立 admission/terminal | `collaboration.test` 14项、`durable-trusted-intent-authority` 18项、runtime service与real-process multi-target | 已闭合 FT-08 parent/runtime；项目事实仍属 FT-09 |
| `REQ-AGT-002` | public 只接受 versioned `invocation.cancel/retry` 对象控制；route/project origin 仅 server-private capability；legacy invoke固定410 | protocol exact guards、WebSocket 三种 legacy origin 410、真实进程重启前后 runtime/Provider 零调用 | 后续 public 命令仍不得开放 origin/Agent/provider字段 |
| `REQ-AGT-004` | claim/model/tool/final 复核 Profile、Assignment、membership/access、Room 与 durable Agent busy reservation | frozen authority gate 15项、runtime/SQLite跨Room busy、revoke/restart矩阵 | FT-14最终 credential operations |
| `REQ-AGT-006` | stable project boundary ID、exactly-once receipt、durable linkage的私有 producer seam | project-boundary 2项、production E2E dependency-unavailable | FT-09提供真实Goal/checkpoint/due/Blocker；当前Provider/execution均0 |
| `REQ-AGT-008` | 用户状态闭集仅 accepted/running/completed/failed/cancelled；phase独立且closed | Core guards/negative type tests、sync guards、Desktop controller/surface | 已闭合 |
| `REQ-AGT-009` | automatic retry保持同execution/snapshot/envelope；Human retry创建新execution/ordinal并持久化不可变receipt | runtime service 39项、SQLite authority 25项、real Worker 4项；1s/4s/3 attempts、eligibility、idempotency | 已闭合 FT-08 retry authority |
| `REQ-AGT-010` | `commitScopedCancellation` 是唯一取消线性化点；无关消息零影响；claimed dispatch不伪装回滚 | scoped orchestrator 8项、SQLite cancellation/recovery 25项、final/recall双winner | 已闭合 parent cancellation |
| `REQ-AGT-012` | parent cancel与现有 confirmation/grant/dispatch 在同一Authority事务协作；不建第二套tool状态机 | pending、confirmed-unclaimed、claimed三分支及rollback/post-commit abort测试 | FT-10最终闭合principal、review与compensation |
| `REQ-MEM-008` | v19 frozen snapshot binding沿用；v22执行、attempt、retry receipt绑定snapshot；auto/crash不漂移 | source revise保持frozen input，recall/dispute/memory/access变化拒绝旧retry且零child | 已闭合 runtime复用边界 |
| `REQ-MEM-010` | memory degraded时direct仍用confirmed memory+post-watermark delta+trigger；semantic proactive route暂停 | memory health/context/runtime gate与project suppressed测试 | FT-09补真实project facts；FT-14补运营策略 |
| `REQ-MSG-001` | FT-03 message+N target outcomes同事务，FT-08异步claim并各自产生execution | ACK loss/replay、partial target、sibling isolation、真实WS/Worker/SQLite | 已闭合FT-08消费端 |
| `REQ-MSG-008` | preview仅走非持久transport/reset；final message与completed同事务 | 唯一sentinel真实进程、renderer reset、durable/diagnostic全表面零命中 | 已闭合 |
| `REQ-NFR-005` | global active=8、Room durable admission=32、preview/continuation/recovery有界、bounded shutdown | 32/8、429+retryAfterMs、257/513/1025、poison、queue-full rescan、close tests | 已闭合 FT-08 runtime边界 |
| `REQ-PRIM-011` | structured `@Agent` 的direct binding产生真实intent→execution→attempt | real AuthorityWorker/WS accepted→running→terminal与restart recovery | 已闭合 |
| `REQ-PRIM-012` | five-state与safe phase由event/repair统一投影，preview不是message | Core/sync/Desktop五态、failed/cancelled非颜色区分、terminal-before-ACK | 已闭合 |
| `REQ-PRIM-013` | active/on-mention与ready/busy/paused/noauth分离；on-mention direct仍用有效tool集 | FT-07 gate复用、durable busy、paused/noauth/provider zero-call | 已闭合 FT-08 claim点；FT-14延续credential边界 |

横切安全要求 `REQ-AGT-013`、`REQ-MSG-005/006`、`REQ-ROOM-004`、`REQ-NFR-004/011/014` 由 closed principal/capability、source revision/recall、Room lifecycle/access、单writer/有界队列、secret/raw-body exclusion 与 stable repair共同保持。

## 3. Intent、execution、attempt 聚合与五态

权威链冻结为：

```text
message target / route decision / project boundary
  → AgentInvocationIntent
  → AgentExecution 1..N
  → AgentExecutionAttempt 1..N
  → optional confirmation / grant / dispatch
  → final message 0..1
```

- intent与execution不再一对一；v16的一对多link由v22 runtime state正式消费。初始execution为ordinal 1，Human retry为ordinal 2+；旧terminal保留且永不复活。
- automatic/crash retry留在同execution并单调增加attemptSeq；Human retry创建新execution；带纠正或新上下文的动作必须创建新intent/turn/snapshot并显式supersede。
- final message、citation、execution completed、event/outbox在同一Authority事务；stale attempt不能写checkpoint、confirmation、tool result、continuation或final。
- public五态严格为 `accepted/running/completed/failed/cancelled`。`queued/retry_scheduled/recovery_queued/awaiting_capacity`是accepted phase；`claiming/snapshot_frozen/model_generation/read_tool/waiting_confirmation/side_effect_claimed/final_committing`是running phase；terminal phase与状态同名。
- `selected/will_respond`只代表acceptance chain，不保证最终回复；`outcome_unknown`是needs_review，不是completed；每个非终态都有capacity scan、retry/recovery或明确Human action，不保留永久spinner。

## 4. Scheduler 与同 turn 多 Agent 并发

- Room内按turn/intent authority顺序admission；同一turn的不同Agent可并发，后turn不能越过尚未admission的前turn，waiting confirmation只阻塞自己的target。
- global active硬上限8；每Room durable queued/admission硬上限32；超限闭合返回429与`retryAfterMs`。
- durable Agent lane跨Room互斥，避免同一Agent竞态重复claim；当前execution自己的busy reservation不拒绝自己，capacity释放后继续扫描。
- 内存queue满不会删除durable candidate；一个target失败、取消或等待确认不会取消或阻塞sibling Agent。

## 5. Scoped cancellation、broad preemption退场与线性化

`commitScopedCancellation(scope, expectedVersion, reason)` 在单一AuthorityWorker事务内验证principal/internal capability、Room/source/lineage与version，写immutable fence，CAS intent/execution/attempt，reject pending confirmation，revoke active且unclaimed grant，保留confirmed confirmation与claimed dispatch，并写stable event/outbox/idempotency receipt。只有COMMIT后，orchestrator才移除内存queue、传播closed AbortSignal cause、清理preview并发`preview.reset`；rollback时四者均不发生。

取消来源只允许显式有权Human控制、关联correction/supersede、source recall、Room archive以及membership/Assignment/Profile/capability撤权。无关Human消息、普通reply、Agent消息/final、history/sync、preview、displayName命中、route diagnostic与memory refresh均无取消效果。

production不再装配legacy room-wide `HumanPreemptionRuntime`，Human message route改为独立`runtime.create-route-for-human-message`原子入队。旧`room.human_preemption.applied`、fence与replacement只读保留为`legacy_room_wide_preemption`审计，不再产生新事实，也不解释成scoped fence。

线性化证据覆盖两种合法winner：

- final先提交：final与completed保留；后续source recall只写tombstone/fence，不回滚final或confirmed fact；preview清除。
- recall/cancel先提交：execution/attempt cancelled；迟到final/checkpoint/tool prepare/continuation CAS失败；Agent final、final event/outbox、memory candidate与project extraction零写。

## 6. Automatic retry、Human retry与frozen snapshot

- automatic retry最多3 attempts，固定1秒/4秒退避；仅closed transient timeout/rate-limit/temporary unavailable可进入。它保持同execution、snapshot、Agent、Profile/Assignment envelope、Provider/model；不换Agent/model/provider、不fallback mock。
- timeout先通过current attempt CAS持久化`retry_scheduled`或terminal failed，再传播`provider_timeout` AbortSignal；`signal.aborted`不再绕过收敛，因此不留下running zombie。
- dispatch claim后异常不走generic retry，不重放原toolCall；known result继续记录，不确定结果进入`outcome_unknown/needs_review`。
- Human retry只针对eligible failed/cancelled，创建新execution与单调ordinal，写`retryOfExecutionId`、snapshot lineage和immutable receipt。相同principal/request/payload replay同child；不同request可创建下一个ordinal；旧attempt budget不复用。
- ACK前会独立重读durable `invocation_human_retry_receipts.response_json`，对request/source/child/intent/lineage/Room/ordinal/snapshot/status/createdAt做完整canonical equality；缺失、损坏或漂移均fail closed。
- 同execution的automatic/crash attempts复用同一v19 snapshot。Human retry在source未recall、context未disputed/invalidated、access/Profile/Assignment/Room仍有效且无unresolved side-effect review时复制冻结内容到新的child snapshot；source revised不改变正在执行的frozen input，recall/dispute/memory advance/access revoke会在ACK前拒绝旧snapshot并产生零child/receipt/lineage。

## 7. Recovery、shutdown与confirmation/grant/dispatch边界

recovery使用稳定keyset cursor、每页256、durable claim lease并drain-until-empty。257/513/1025候选均收敛；queue-full保留candidate并在capacity释放后重扫；poison candidate闭合进入failed/dead-letter/needs_review并推进cursor；并发worker claim不重复，expired lease可安全回收，terminal/fenced item不复活。

shutdown先停止新claim/admission，有界等待active controller；超时controller先权威持久化再abort，释放lease、清transient preview并保留durable queued work，close存在硬截止。

FT-08只拥有parent execution/fence/cancel/abort/preview reset与“claim后不伪装回滚”；FT-10拥有confirmation principal、grant、dispatch、outcome review与compensation。二者复用同一Authority事务：pending confirmation随parent reject且Adapter 0；confirmed但unclaimed保持confirmed、grant revoke且late claim失败；claimed dispatch事实保留，后续known result或outcome_unknown继续记录，不显示“副作用已撤销”且不自动replay。

## 8. Memory degraded 与 project-boundary seam

Memory steward故障时Human聊天继续；direct invocation仍使用confirmed memory、post-watermark raw delta与trigger/source，不回退最近64条；semantic proactive route暂停，Desktop显示degraded。

project-boundary producer只接受stable boundary ID、revisioned source fact并写exactly-once durable receipt。FT-09真实Goal/checkpoint/due/Blocker尚未交付，因此production固定`dependency_unavailable/suppressed`，Provider 0、execution 0；旧OpenItem、LightTask、Ball或普通消息不会冒充新Project fact，legacy `open-item.propose`已退出production新工作入口。

## 9. Preview transient、sentinel与buffer边界

preview是可丢弃的local/transient transport，不是message。每次publish复核current execution/attempt、fence、session、membership、subscription generation、publish/authority epoch与backpressure；stale authority结果、credential refresh、subscription替换、disconnect/reconnect、repair、revoke、attempt rollover、recall/archive/cancel/runtime close均由generation fence或`preview.reset`清除。

WebSocket preview队列为32个normal+32个reset slot，总字节严格256 KiB，normal preview另有128 KiB上限；已pop但authority await中的reset计入`drainingResetBytes/drainingResetCount`。idle oversized visible delta会启动serialized repair reset；reset coalesce使用最新publication cutoff，且不会越过真实queued preview。

唯一sentinel `FT08-PREVIEW-TRANSIENT-ONLY-7F41C9D2` 经真实AuthorityWorker→WebSocket→Desktop runtime/renderer后reset消失，并扫描以下11类强制表面零命中：SQLite、WAL/SHM、event、outbox、snapshot cache、repair payload、Desktop durable cache、memory input、diagnostics、stdout、stderr；另对Authority所有可疑文本列和最终message做全量检查。preview在renderer为独立点线层、`aria-live=off`、无typing animation且不逐token通告。

## 10. Protocol、sync/repair与Desktop J-03/J-05/J-07

- public vNext命令为`invocation.cancel`与`invocation.retry`，payload只含requestId、executionId/intentId、expectedVersion及必要closed input；客户端不能提交reason、Agent、origin、provider/model、snapshot、attempt、grant、role或内部capability。
- legacy `agent.invoke/interrupt/retry`保持strict decoder但handler固定410/upgrade-required，decoder后runtime/DB/Provider/Adapter调用0。ACK/error均requestId correlated并闭合覆盖400/401/403/404/409/410/429/503。
- fixed-watermark repair包含intent outcome/status、execution五态+safe phase、lineage/retryOf/current attempt、source revised/recalled、confirmation/grant/dispatch/review、final reference、safe fence reason与project unavailable/suppressed；排除preview、prompt、tool/raw provider body、headers、reasoning、secret与capability token。
- duplicate/out-of-order、cursor gap、512+ buffer、clear-cache、reconnect、repair中revoke、旧snapshot晚于live terminal、旧cancel event晚于retry child、removed Room access、terminal先于ACK与multi-client convergence均按canonical projection收敛。
- J-03：同消息多个Agent独立execution card；一个failed不覆盖另一个completed；retry child与旧terminal并存；selected/will_respond不显示为保证回复。
- J-05：waiting confirmation显示在running内，retrying显示在accepted内；outcome_unknown只给review，claimed dispatch不显示“已撤销”。
- J-07：offline不接受cancel/retry假成功；ACK只表示Authority commit，terminal只来自stable event/repair；409刷新事实并保留安全上下文，401/403/410/429/503均有恢复动作。
- execution card的keyboard/focus、非颜色状态、ARIA error/terminal通告、200% zoom、840×560与reduced motion按正式设计矩阵实现；preview `aria-live=off`。pending command不改变stable card，reset立即移除preview。正式设计偏离：**无**。

## 11. Schema v22与v1-v21兼容

- v22在v21之后reader-first追加50条immutable statements；没有修改v1-v21 migration、checksum或fingerprint，也没有第二数据库/第二writer。
- v22包含27条trigger invariants与7条startup invariants（合计34），50条逐statement rollback assertions，4项migration tests；fingerprint为`cbf4ccb27b52c3b88d61667f94811501d36a54795391e0044bbb0b2f41d3c7ce`。
- 覆盖fresh与每个v1…v21升级、future/unknown refusal、history/checksum/fingerprint/physical tamper、每条statement中途失败整笔rollback、fresh/migrated equivalence、queued→accepted projection、intent→execution一对多、manual retry lineage、legacy broad history只读、v19 snapshot、v21 direct/routed binding、WAL reopen、startup invariant与repair equivalence。
- 历史queued事实不改写；v22 canonical reader将当前非终态安全投影为`accepted/queued`。最终schema保持v22，无机械原因需要v23。

## 12. 精确验证与CI证据

最终候选`c3b8594`在合入前依次通过：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:core-boundary
pnpm verify:desktop-boundary
pnpm --filter @native-im/desktop smoke
git diff --check
```

- 全量Vitest：208 files（205 passed / 3 skipped / 0 failed）；2284 tests（2281 passed / 3 skipped / 0 failed）；295.33s。`pnpm test`内Core I/O boundary与Desktop renderer boundary（24 production sources）通过。
- 分包：Core 9 files / 99 passed；Desktop 66 files / 507 passed；Server 130 passed + 3 skipped files / 1675 passed + 3 skipped tests。
- Core negative type、queued public refusal与five-state guard由`collaboration.type-test`/`sync.type-test`及Core 29项runtime/sync tests覆盖。
- lifecycle/CAS focused clusters：runtime service 39、durable trusted intent 18、SQLite cancellation/recovery 25、real Worker runtime 4，共86项文件级精确计数；其中语义可交叉覆盖，不以相加值冒充互斥case分类。
- cancellation race clusters：scoped orchestrator 8 + SQLite authority 25，共33项；覆盖commit/rollback后abort、cancel/final/recall双winner、pending/confirmed-unclaimed/claimed dispatch、unrelated Human zero-effect。
- retry/recovery clusters：runtime service 39 + SQLite authority 25 + real Worker 4，共68项；覆盖1s/4s/3 attempts、timeout-before-abort、Human retry、257/513/1025、poison、lease、queue-full rescan、bounded close。
- permission/zero-call：legacy invoke三种origin 3项、tool gateway rejected authority 11项、project dependency-unavailable 1项、real-process legacy closure 1项，共16个明确零runtime/Provider/Adapter/execution分支；另有5个manual-retry ineligibility零child分支。
- real path：WebSocket 135项、real-process Authority E2E 29项、real Worker runtime 4项，共168项文件级精确计数，覆盖SQLite/WAL、restart、multi-client sync/repair、public 410与真实Desktop runtime。
- preview：WebSocket 135项全套与真实sentinel路径连续3轮通过；强制sentinel表面11类；real Worker runtime 4项也连续3轮通过，未观察到flake。
- Desktop：66 files / 507 tests；FT-08专属controller/IPC/preload/renderer surface为17项，另由message production/WS/renderer与app/root tests覆盖真实ACK/event/repair、preview reset、错误恢复与a11y；Electron smoke通过。
- schema v22：50 statements、27 trigger + 7 startup invariants、50 rollback assertions、4 migration tests，v1-v21全部兼容。
- CI：[quality 32847791058](https://github.com/LionelHao/Dao/actions/runs/32847791058) 的Node 22.13.1（8m47s）与Node 22.x（8m28s）均success。

因没有显式 live flag 和/或 OpenAI secret，Agent、Router与Memory共3个live suites安全跳过；CI fake、SSE parser、Router closed output、Provider timeout/cancel、noauth、错误与secret sentinel覆盖未降低。未读取、打印或记录secret内容、长度、前后缀、hash、Authorization header或可比对派生值。

## 13. 独立审阅、已知风险与后续seam

两名独立只读reviewer围绕scoped cancellation、broad preemption、manual retry、preview/reset race、subscription/credential generation、buffer/draining bytes、real Worker ACK与durable receipt重读进行多轮对抗审阅。最终对象为`8414513`及其后仅更新验证记录的`c3b8594`，两人均结论：**无剩余P0/P1、无交付blocker**。独立focused验证分别达到209/209与239/239通过。

当前没有已知FT-08生产blocker。已知但非阻塞的证据边界：durable retry receipt的伪造snapshot回归通过Worker fake execute路径证明完整canonical mismatch会fail closed；真实DB validate operation没有单独的故障注入case，但DB handler、v22 insert/immutable trigger、startup invariant、真实retry SQLite/Worker链共同覆盖该行为。

未冒充完成的后续seam：

- FT-09：真实Goal/Ball/checkpoint/due/Blocker Project Loop；当前project-boundary只能suppressed/dependency unavailable。
- FT-10：完整tool confirmation principal、grant/dispatch review、outcome reconciliation与compensation；FT-08只闭合parent race并复用现有authority。
- FT-13：通用sync/repair/outbox/cache/lease的最终横切闭合；FT-08已注册自己的canonical records并保持fixed-watermark合同。
- FT-14：credential rotation、retention、privacy operations与诊断政策；当前secret/raw body继续排除。
- 本阶段未提前实现FT-11/12/15、BYOK、多Provider、模型fallback、Agent login、任意shell/binary/URL/cwd/file能力、外部事件总线、第二数据库/第二writer或客户端authority。

## 14. Git、保护文件、Blueprint与worktree清理

- 实现与交付说明均来自隔离worktree；原工作区`/Users/leo/code/Dao`仍在`codex/ft02a-delivery-trace-fix`，本阶段未改写其tracked状态。
- 从起始SHA到实现SHA的103文件清单没有Blueprint HTML/JSON、Grand Blueprint数据或renderer路径；未手改Blueprint。
- 原工作区四个用户untracked文件从未stage、commit、stash、reset、移动、覆盖、格式化或顺手修订；最终清理后再次核验SHA-256：
  - FT-09 design：`88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122`
  - FT-09 implementation：`8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c`
  - FT-10 design：`8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578`
  - FT-10 implementation：`8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd`
- PR #71合入、`git fetch --prune`与远端main真实merge确认后，逐个检查并删除16个实现worktree：`cancel`、`cancel-fix`、`core`、`desktop-fix`、`desktop-p1`、`desktop-reset`、`manual-retry-p1`、`preview-final`、`preview-race`、`recovery`、`runtime`、`runtime-fix`、`runtime-lease`、`scoped-postcommit`、`scoped-producers`、`timeout-gate`；均以非强制`git worktree remove`成功，目录与注册项已消失。
- `preview-race`曾留有一个已被最终main后续测试替代的未提交测试删除中间态；对照远端实现确认无未交付价值后先`git restore`恢复旧分支文件，再非强制删除，没有丢弃独有实现。
- 本交付记录worktree是唯一剩余Stage 10临时worktree；证据PR合入、再次确认远端merge与clean状态后将删除并`git worktree prune`。最终只保留阶段开始前的`/Users/leo/code/Dao`。

## 15. 交付结论

以上证据只说明FT-08已达到交付条件并进入远端main；最终产品验收仍由owner执行，本阶段没有自行标记verified。
