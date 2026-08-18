# FT-08 Invocation Runtime：拆环实施计划

> 日期：2026-08-18
>
> 前置设计：[FT-08 Invocation Runtime 生产工程设计](./2026-08-18-ft08-invocation-runtime-design.md)。
>
> 边界：本计划安排未来代码与测试，不在本次文档任务中修改生产代码，不修改 Blueprint/任务状态，不声明 FT-08 或旧 T-0020 新合同 verified。

## 1. 实施原则与并行保护

实施顺序固定为：**FT-08A intent + scoped fence authority seam → FT-08B runtime state/retry/recovery → FT-08C memory/profile/tool/Desktop integration**。A 先给 FT-03 一个可原子调用、可故障恢复的最小 seam；B 才替换执行循环；C 最后接完整 snapshot、Profile/Assignment、tool和真实 Desktop。

开始每个 slice 前必须：

1. `git status --short --branch` 与 `git worktree list --porcelain`，记录并避开其他 Agent 的文件；
2. 读取届时已合入的 FT-02A、FT-03、FT-13 合同与 `AUTHORITY_SCHEMA_VERSION`；不预占“v13”等固定编号；
3. migration、`authority-database-handler.ts`、`authority-worker.ts`、`protocol.ts`、`snapshot-worker.ts` 同一时刻只设一个 merge owner；其他 slice 用 contract/type test 或 adapter branch并行；
4. 历史 migration statements/checksum/fingerprint不可改；旧 broad preemption facts保留只读；
5. 每个切片严格 red → minimal green → focused regression → real-worker evidence。

## 2. 全局 TDD 与质量门

测试层级依次为：closed core/type boundary → protocol/internal capability → schema/invariant → AuthorityWorker transaction/CAS → runtime fake/fault → sync/repair → real worker SQLite restart → Desktop reducer/DOM/a11y。

不得用直接 SQL happy-path fixture替代 command transaction证据；允许直接 SQL 只用于 corruption/migration/fault setup，并必须明确说明。preview 测试使用唯一 sentinel，扫描 SQLite/WAL、messages、events、outbox、snapshot page、client durable cache、memory input与diagnostic，结果必须零命中。

每片结束至少运行 focused tests、`corepack pnpm typecheck`、`corepack pnpm lint`；A/B/C 集成后运行 `corepack pnpm test`、`corepack pnpm build`、`corepack pnpm verify:core-boundary`、`git diff --check`。

## 3. FT-08A — intent + scoped fence authority seam

### 3.1 目标与开关

交付 FT-03 可依赖的 transaction API：

- `createMessageTargetIntent(...)` 在 message transaction内写 per-target intent/outcome；
- `claimInvocationIntent(...)` 只把一个 pending intent交给 execution创建；
- `commitScopedCancellation(...)` 按 intent/execution/source relation写 fence与terminal CAS；
- `commitAgentFinal(...)` 在 fence/current-attempt CAS后原子写 final + completed。

在 A 完成前，FT-03 recall feature gate保持关闭；现有 public `agent.invoke` 的 server-only kind必须先拒绝，旧 room-wide preemption producer必须关闭后才能启用 v2 structured invocation。

### 3.2 文件与 TDD 顺序

| 顺序 | 先写失败测试 | 再改生产文件 | 必须产出 |
| --- | --- | --- | --- |
| A1 Core | `packages/core/src/collaboration.test.ts`、`collaboration.type-test.ts`、必要的新 invocation type test | `packages/core/src/collaboration.ts` | turn-aware `AgentInvocationIntent`、target outcome、five-state execution、scoped fence/receipt closed guards；public/internal类型不可互赋。 |
| A2 sync union | `packages/core/src/sync.test.ts` | `packages/core/src/sync.ts` | intent/execution/cancel event与repair records；删除新 broad preemption event生产依赖，legacy record显式标记。 |
| A3 protocol | `packages/server/src/protocol.test.ts`、`websocket.test.ts` | `packages/server/src/protocol.ts`、`websocket.ts` | public不能提交 Agent identity/capability/kind；control command只引用有权对象；稳定 401/403/409/410/429/503。 |
| A4 migration | `packages/server/src/persistence/schema.test.ts` | `packages/server/src/persistence/schema.ts` | 从届时current追加immutable migration；turn-aware intent、fence、execution lineage/version；旧v1-current不漂移，fault rollback完整。 |
| A5 worker contracts | `persistence/contracts.test.ts`、`contracts.type-test.ts`、`worker-database-client.test.ts` | `contracts.ts`、`worker-protocol.ts`、`worker-database-client.ts`、`authority-worker.ts` | server-private origin/final capability；跨worker closed serialization；网络无法构造。 |
| A6 transactions | `sqlite-authoritative-store.test.ts`、新增/重组 runtime authority focused tests | `authority-database-handler.ts`、`sqlite-authoritative-store.ts` | message + N outcome/intent + event/outbox/idempotency单事务；claim/fence/final CAS；target独立。 |
| A7 orchestration | `agent-runtime-service.test.ts`、scoped cancellation tests | `agent-runtime/runtime-authority-protocol.ts`、`worker-runtime-authority.ts`、`agent-runtime-service.ts` | cancel commit-before-abort、queue移除、preview clear、late final零写。 |
| A8 composition | `authoritative-server`/WS integration tests | `authoritative-server.ts`、`human-preemption/` | message ACK不等待异步 runtime；停止 broad `handle(messageId)`；legacy runtime不再产生replacement。 |

`human-preemption/` 可选择删除 production wiring并保留只读 legacy parser/tests，或重命名为 scoped cancellation orchestrator；不能保留旧语义却只改文案。

### 3.3 migration 协调

- FT-02A/FT-13 若先合入，A 从新 current version追加；不得 cherry-pick 固定 version number。
- reader/migration先部署：新表与canonical projection可读，旧 public invoke仍feature-off。
- backfill旧 `agent_invocation_intents`：每行生成稳定 legacy intentId/lineageId/turnId，origin=`legacy_runtime`，executionOrdinal=1；不重放工作、不生成新 event。
- 旧 `(source_message_id,target_agent_id)` 唯一索引通过 table rebuild移除；新 `(message_transaction_id,target_id)` 与 `(lineage_id,turn_id,agent_id)` invariant落库。
- 旧 T-0020 tables/events不删除；标为 legacy audit且从新 pending scan、route replacement与UI current projection排除。
- rollback只关新 command/consumer；数据库不降级、不删除已写intent/fence，不恢复broad preemption。

### 3.4 A 的 CAS / 故障注入矩阵

| 编号 | 编排点 | 断言 |
| --- | --- | --- |
| A-CAS-1 | 一个 message含两个Agent target；第二个在transaction序列化前撤权 | message提交；target1 intent accepted；target2 durable rejected；互不连带。 |
| A-CAS-2 | domain message写后、第二个intent前throw | 整个 transaction零写；重试生成同 IDs/outcomes。 |
| A-CAS-3 | commit后ACK前断连 | replay返回同message/target outcomes；无第二intent/execution。 |
| A-CAS-4 | 同source/agent，不同turnId | 两轮均持久；旧永久unique不能吞第二轮；lineage顺序稳定。 |
| A-CAS-5 | claim与source recall并发 | 按writer顺序：claim先则execution随后被fence取消；recall先则claim零写。 |
| A-CAS-6 | final与recall停在CAS前后 | final先commit则保留；fence先commit则message/event/outbox/memory candidate零写。 |
| A-CAS-7 | cancel transaction在execution CAS后、event前故障 | transaction全回滚；AbortSignal未传播。commit成功才abort。 |
| A-CAS-8 | stale attempt、stale execution version、重复cancel | stale final/control 409；重复同key回放同receipt；terminal不复活。 |
| A-CAS-9 | 无关联Human新消息 | 旧execution/confirmation/grant/route均零变化；不产生replacement。 |
| A-CAS-10 | preview sentinel后cancel/crash/reconnect | 所有durable surface零命中；UI transient被清。 |

### 3.5 A 的 real-worker SQLite restart E2E

用 compiled `AuthorityWorker`、真实 SQLite WAL 与真实 WS：三个客户端提交双 Agent structured message；在 commit→ACK、intent→claim、cancel commit→abort、final CAS→outbox 四个窗口分别终止 child；重启后：

- target outcomes/intents不重不漏；
- fence winner决定final是否存在；
- cancelled execution不进入恢复队列；
- legacy broad preemption不触发；
- clear cache + fixed-watermark repair恢复相同 current projection；
- preview sentinel在数据库/WAL/repair/cache中为零。

### 3.6 A 退出条件

FT-03 可以在同一个 writer transaction调用 intent/outcome API；recall/final race有真实SQLite证据；public kind/identity伪造被拒；任意Human消息不再room-wide cancel；message ACK与post-commit runtime失败解耦。达到这些条件只表示 **FT-08A seam ready**。

## 4. FT-08B — runtime state、retry 与 recovery

### 4.1 目标

把execution投影统一为 accepted/running/completed/failed/cancelled；引入immutable snapshot binding、executionOrdinal/version/phase；修复timeout与restart尾部；区分crash retry与Human retry。

### 4.2 文件与 TDD 顺序

| 顺序 | tests first | 生产文件 | 重点 |
| --- | --- | --- | --- |
| B1 lifecycle | `collaboration.test.ts`、type tests、`agent-runtime-service.test.ts` | `core/collaboration.ts`、`agent-runtime/contracts.ts` | five-state + internal phase；queued/retrying/waiting不成为用户新状态。 |
| B2 snapshot binding | 新 compiler contract tests、`worker-runtime-authority.test.ts` | `runtime-authority-protocol.ts`、`worker-runtime-authority.ts`、persistence contracts | intent sourceRevision、shared roomFactsSnapshot、per-Agent envelope、hash/version不可变。 |
| B3 scheduler | `agent-runtime-service.test.ts` | `agent-runtime-service.ts` | room FIFO/global bound、availability reservation、timeout先持久化、abort cause区分、no fallback。 |
| B4 retry/CAS | authority focused tests | `authority-database-handler.ts` | transient attempt上限；stale result；Human retry新execution/ordinal；terminal不复活。 |
| B5 recovery | real-worker tests、`authority.e2e.test.ts` | authority/runtime recovery paths、`authoritative-server.ts` | keyset drain-until-empty、poison item隔离、queue-full rescan、shutdown drain。 |
| B6 projection | `sync.test.ts`、snapshot/replica tests | `snapshot-worker.ts`、`sync-service.ts`、`desktop/sync/client-sync-replica.ts` | intent/execution/attempt summary lineage可repair；fixed watermark；preview排除。 |

### 4.3 B 的状态与 retry 测试

1. accepted/queued claim前被paused/noauth/archived/revoked：Provider 0次、可见终态或稳定blocked reason，无spinner。
2. provider timeout：attempt1先写failed + attempt2 accepted/retry_scheduled，再abort/wait；第三次terminal failed；进程不重启也不留running。
3. crash retry：同execution、同snapshot/Agent/provider/model，attemptSeq单调；新Room消息不进入旧input。
4. Human retry：旧failed/cancelled保持terminal，新execution带`retryOfExecutionId`与同lineage新ordinal；相同command replay只生成一个child，第二个明确新retry command可再产生下一ordinal。
5. source revised：projection提示，但snapshot hash、provider input、attempt保持不变。
6. source recalled/disputed/revoked：旧snapshot Human retry返回410/403；要求新invocation，不把旧原文再发Provider。
7. stale attempt在新attempt完成后返回：checkpoint/final/tool prepare均零写。
8. 300+ recoverable rows（超过单batch）：循环最终全部accepted/running/terminal或review；尾部不永久遗留。
9. 单个corrupt/terminal-conflict candidate不阻断更大key的合法candidate；记录closed diagnostic/dead-letter，不记录raw content。
10. restart时 side-effect dispatch保持outcome_unknown，不调用adapter第二次。

### 4.4 B 的 real-worker SQLite restart E2E

至少覆盖：

- 在snapshot freeze后、attempt claim后、provider partial后、retry transaction后、final commit前分别kill child；
- 重启比较同execution全部attempt的snapshotId/context hash；
- 旧attempt late result通过另一测试端口返回并被拒；
- 257/513条queued work跨分页全部被扫描，模拟queue满后drain再scan；
- completed/failed/cancelled不进入新claim；
- repair清cache后五态、lineage、source-revised与retry action一致，无preview。

### 4.5 B 退出条件

所有execution都有终态或明确Human review；timeout不依赖restart修复；自动retry、Human retry与supersede三条lineage可区分；restart scan无batch尾部遗留；无自动换Agent/模型。

## 5. FT-08C — memory/profile/tool/Desktop 集成

### 5.1 前置

硬前置：FT-06 frozen context compiler、FT-07 Profile/Assignment/availability、FT-10 confirmation/grant/dispatch review；FT-13 repair/outbox接口至少冻结。FT-05 memory若未完整交付，C只能接versioned stub并保持memory-dependent proactive feature off，不能回退最近64条作为长期合同。

### 5.2 文件与 TDD 顺序

| 顺序 | tests first | 生产文件 | 重点 |
| --- | --- | --- | --- |
| C1 context/memory | FT-06 golden/property、recall/dispute tests | `agent-runtime/openai-responses-provider.ts`、`agent-runtime-service.ts`、compiler/persistence adapters | speaker identity、trigger、memory/project/source manifest；snapshot不漂移；store=false。 |
| C2 profile/routing | route decision/authority matrix | `route-runtime/`、runtime claim/context builder、Profile/Assignment authority | active/on-mention only；on-mention direct保留工具；paused/noauth/busy重验；trusted origin。 |
| C3 tool race | `tool-gateway.test.ts`、`worker-runtime-authority.test.ts` | `tool-gateway.ts`、`worker-runtime-authority.ts`、authority DB | pending reject、confirmed grant revoke、claimed dispatch保留、outcome_unknown review；adapter call-count断言。 |
| C4 Room lifecycle | archive/reopen/revoke/recall concurrency tests | FT-02/10 shared AuthorityWorker command handlers | archive原子收敛未dispatch；安全expiry继续；reopen不复活；revoke立即阻断。 |
| C5 preview transport | WS authorization/backpressure tests | `websocket.ts`、`authoritative-server.ts` | 每次publish复核session/membership/subscription generation；cancel/revoke reset；不持久。 |
| C6 Desktop | renderer reducer/DOM/keyboard tests | `desktop/src/sync/client-sync-replica.ts`、`renderer/app.ts`、`styles.css`，真transport由FT-11拥有 | J-03/J-05五态、逐target、source revised、retry/review、错误与a11y；不把route selected当final。 |
| C7 full E2E | `authority.e2e.test.ts`、compiled child、必要Electron E2E | composition seams only | 两Agent、confirmation race、archive/revoke/recall、repair/restart、real worker。 |

### 5.3 confirmation/grant/dispatch CAS 矩阵

| 场景 | Authority 断言 | Adapter/UI 断言 |
| --- | --- | --- |
| pending confirmation vs explicit cancel | confirmation rejected + grant revoked + parent cancelled同事务 | adapter 0；显示未执行/已取消。 |
| pending vs recall/archive/revoke | reason分别稳定为source_recalled/room_archived/principal_revoked等 | adapter 0；不统称失败。 |
| confirmed vs cancel，claim尚未commit | confirmation保持confirmed、grant revoked、parent cancelled | late claim 409/410；adapter 0。 |
| dispatch claim commit后cancel | dispatch保留；parent cancelled只阻止后续步骤 | 不显示“撤销写入”；settle/review继续。 |
| adapter timeout | dispatch→outcome_unknown；generic retry disabled | 原toolCall调用1次；焦点到Human review。 |
| known succeeded后source recall | result/final/confirmed fact保留，source标recalled | 不补偿、不自动逆操作。 |
| archive后reopen | revoked/expired grant保持terminal | 不复活confirmation或自动dispatch。 |

### 5.4 执行点权限故障注入

在 intent create、execution claim、snapshot read、model invoke、preview publish、tool prepare、confirmation consume、grant claim、adapter dispatch、final commit、recovery resume 每个点前插入 barrier，再分别执行 member remove、Assignment remove/pause、Profile disable/capability reduction、Room archive、memory dispute/source recall。每个测试断言服务端重验，而不是只看UI隐藏；claim前adapter/provider 0次，claim后保留dispatch事实并按known/unknown收敛。

### 5.5 Desktop / J-03 / J-05 验收

- 同一消息两个target独立卡：一个completed不覆盖另一个failed/cancelled。
- accepted明确为intent/execution已接受，不写“将必定回复”；running可显示waiting confirmation；retrying映射accepted action。
- cancelled与failed图形/文案/指标分开；source revised/recall、superseded lineage可到来源。
- preview独立且`aria-live=off`，cancel/revoke/reconnect消失；没有typing动画。
- 401/403/409/410/429/503、offline、repair_failed都有稳定恢复动作；offline不接受cancel/retry/confirm假成功。
- 键盘顺序、焦点恢复、status通告、非颜色识别、200% zoom、840px最小窗与reduced motion通过；偏离设计基线为“无”。

### 5.6 C 的 real-worker SQLite restart E2E

真实双Human session + 双Agent + SQLite/AuthorityWorker/WS，覆盖：

1. structured multi-target message同事务intent；一个on-mention Agent使用完整assignment工具，另一个provider transient retry；
2. source revision发生在运行中，两个snapshot输入不漂移；
3. pending confirmation时recall，验证reject/revoke/cancel与adapter 0；
4. dispatch claim后archive/revoke，验证outcome_unknown/known settle保留且不自动replay；
5. final/recall双顺序race；completed final与confirmed fact不回滚；
6. kill/restart、outbox replay、cursor gap、clear cache repair；所有可见投影一致且preview sentinel零泄漏；
7. 无关Human新消息不改变任何existing execution；无replacement/legacy preemption event；
8. Agent final不触发其他Agent自主调用。

## 6. 跨 FT 合入与 migration 批次

| 依赖 | FT-08所需输入 | 合入规则 |
| --- | --- | --- |
| FT-03 | message transaction、targetId/outcome、sourceRevision、recall producer、internal final capability | A先联合review；同writer API一次合入或feature-gate，禁止post-commit best-effort intent。 |
| FT-06 | snapshot/version/manifest与eligibility | B可先用interface+fake；生产claim在FT-06未交付前fail closed。 |
| FT-07 | Profile/Assignment revisions、participation、availability、trusted route capability | A允许message_target；route/project origin在producer提交前关闭。 |
| FT-10 | confirmation/grant states、claim/dispatch/review | B不改写side-effect事实；C与FT-10同一个Authority migration/CAS batch。 |
| FT-13 | idempotency TTL、outbox retry/dead-letter、repair union、restart supervisor、migration owner | feature records由FT-08定义，通用可靠性由FT-13实现；双方不得各建一套scan/outbox。 |

建议合入序列：schema readers/guards → A transaction/fence + legacy producer off → B scheduler/recovery → FT-06/07 production gates → FT-10 shared CAS → repair/replica → Desktop。每个阶段可回滚feature flag但不能删除新事实或恢复被否决语义。

## 7. 最终证据清单

交付说明必须逐项列出：

- 16条FT-08直接Requirement与横切Requirement的测试位置；
- public identity/kind/capability negative tests；
- multi-target独立、multi-turn same source/target、Human retry/crash retry lineage；
- source revision freeze、recall/final race两种winner；
- scoped cancel commit-before-abort与无关消息零影响；
- confirmation/grant/dispatch/archive/revoke/recall race及adapter调用次数；
- bounded attempts、timeout无zombie、stale result、>batch restart drain；
- fixed-watermark repair与preview sentinel零泄漏；
- real AuthorityWorker/SQLite/WS restart E2E；
- J-03/J-05/J-07状态、错误与可访问性；
- 未运行的live Provider smoke与任何外部依赖必须如实标注。

## 8. 完成措辞

本计划与配套设计完成后，只能表述为：**“FT-08 设计达到实施准备条件。”**

未来即使 A/B/C 代码与自动化完成，在 owner 验收前也只能表述“达到交付条件，等待 owner 验收”；不得自行宣布 FT-08 verified，更不得把旧 T-0020 的 room-wide 实现描述为已验证的新 scoped cancellation 合同。
