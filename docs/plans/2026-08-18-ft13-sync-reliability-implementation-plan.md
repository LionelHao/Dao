# FT-13 Sync & Reliability：拆环实施计划

> 日期：2026-08-18
>
> 状态：**实施准备计划；当前没有实施、交付、验收或 verified FT-13**
>
> 设计合同：[FT-13 production design](./2026-08-18-ft13-sync-reliability-design.md)
>
> 产品 / UI 权威：[批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)、[Design README](../design/README.md)、[覆盖矩阵](../design/design-requirement-coverage.md)

## 1. 实施前置与工作树纪律

未来实施者在写第一行测试/生产代码前必须：

1. 从届时包含 PRD、evidence map、设计基线和已合入 FT-02A/FT-03 predecessor 的最新 `main` 创建新的独立 worktree；先运行 `git status --short --branch`。
2. 保留所有他人改动；不得 `reset`、`clean`、`stash` 或覆盖另一个 worktree。当前 FT-02A Agent 未交还生产代码所有权前，FT-13 **不得修改任何生产文件或测试**。
3. 读取实际 `AUTHORITY_SCHEMA_VERSION`、最后 migration checksum/fingerprint、FT-02A/FT-03 合入 diff 和 FT-01 cache invalidation seam。v12 与可能先合入的 v13 都只是 predecessor 候选，不能在计划中硬编码 next version。
4. 记录 `REQ-*`、J-01/J-02/J-07、每个 UI 状态的 local/ACK/event/projection source、401/403/409/410/429/503/offline/repair分支、键盘/焦点/非颜色/通告/缩放/reduced-motion要求；偏离默认“无”。
5. 不改 Blueprint、任务/里程碑状态；不引入 OS push、Mobile/Web、global search、full Blueprint、多 Provider、第二 DB/writer/event bus 或 generic transport。

## 2. 文件所有权与 migration 协调

“owner”指未来实施批次的唯一文件 owner，不代表本次文档任务已授权修改。

| 共享面 | 唯一 owner | 现有文件 / 计划新增文件 | 协调规则 |
| --- | --- | --- | --- |
| Authority migration queue | **FT-13 migration coordinator**（同一人） | 现有 `packages/server/src/persistence/schema.ts`、`schema.test.ts` | 等 FT-02A 实际合入；一次只追加一个 immutable migration batch。历史 checksum/fingerprint不改。FT-03若先占 next version，重新读取后再编号。 |
| Authority transaction / worker RPC | **FT-13 persistence owner** | 现有 `authority-database-handler.ts`、`authority-worker.ts`、`worker-protocol.ts`、`worker-database-client.ts`及相邻 tests | idempotency/outbox command family串行合入；不新增 connection owner。 |
| Repair registry / snapshot | **FT-13 recovery owner** | 现有 `packages/core/src/sync.ts`、`snapshot-worker.ts`、`snapshot-worker-client.ts`、`sync-service.ts`、`fallback-repair-coordinator.ts`及 tests；计划新增 `persistence/repair-projection-registry.ts` | FT-02/03/04/05/08/09/10/12拥有 record语义与 mapper；FT-13拥有唯一 assembly/checksum/page/preemption。 |
| Outbox lifecycle | **FT-13 delivery owner** | 现有 `outbox-dispatcher.ts`、`authoritative-server.ts`、persistence contracts/RPC及 tests | schema列由 migration coordinator一次加入；dispatcher代码只由 delivery owner改。 |
| Desktop replica/cache | **FT-13 Desktop cache owner** | 现有 `packages/desktop/src/sync/client-sync-replica.ts`及 test；计划新增 `encrypted-authority-cache.ts`、`offline-read-lease.ts`及 tests | renderer不持key/DB/WS。与 FT-11 的 main/preload/controller接线最后串行。 |
| Closed public protocol | **FT-13 recovery protocol owner**，与 FT-03 message owner排队 | 现有 `packages/server/src/protocol.ts`、`websocket.ts`及 tests | offline lease/repair frame一次合并；不得与 FT-02A/FT-03同时编辑。 |
| Cross-process evidence | **FT-13 integration owner** | 现有 `authority.e2e.test.ts`、`fixtures/authority-child.ts`、Desktop identity/controller tests | 只使用 deep test seam；生产 package root不暴露 fault/config bypass。 |

### 2.1 唯一 authority migration batch

FT-13 authority schema需要的最小物理变更预计只有：

- outbox `dead_letter` lifecycle、`next/available_at` query index、dead-letter timestamps/closed reason；
- idempotency `expires_at` cleanup index；
- 如最终设计评审证明必须持久化 alert/requeue audit，再加入 closed operation row；否则优先结构化 metric/log，不扩业务 schema。

它们必须在 Slice 2 前由 migration coordinator收集为**一次** actual-predecessor→next migration。FT-13 derived Desktop cache有独立 schema version，不消耗 authority migration号。repair registry本身是代码合同，不要求 table/plugin registry。

### 2.2 可并行 / 必须串行

| 工作 | 与当前 FT-02A / 后续 FT-03 的关系 |
| --- | --- |
| 设计审阅、测试向量、cache crypto prototype（独立临时测试，不改共享文件）、alert sink contract | 可与 FT-02A并行。 |
| feature owner编写“可见 record inventory + mapper test data” | 可并行，但不能合到 registry前声称 repair完成。 |
| `schema.ts`、AuthorityWorker/handler、`core/sync.ts`、snapshot worker、protocol/WebSocket、Desktop replica/main/preload | 必须在 FT-02A交权并合入后串行；与 FT-03修改同文件时按 migration/protocol队列串行。 |
| FT-13 Slice 1 无 schema部分与 Slice 4 crypto模块 | 两个独立 owner可并行开发；最终 replica/lease integration串行。 |
| Slice 2 migration | 必须先于 Slice 3 outbox production启用。 |
| Slice 5 integration | 必须在 Slice 1～4全绿且 FT-02A archive event/seam实际存在后串行。 |

## 3. 五个可实施切片

每个切片严格执行 RED → 最小 GREEN → focused regression → refactor。测试和生产实现同批；不得用 fixture直写、静态 DOM或文档替代 authority transaction/真实进程证据。

### Slice 1 — 单一 repair registry、连续 cursor 与 durable event dedupe

**目标：** 用一个 closed registry驱动 materialized/streaming；补强 cursor gap和 Desktop event ledger/atomic generation，不碰 authority migration。

**文件 owner：FT-13 recovery owner / Desktop cache owner（不同文件可并行）**

先写 RED：

1. `packages/core/src/sync.test.ts`：每个 `RoomRepairRecord.kind`都有唯一 guard；same seq/different eventId、same eventId/different seq、gap/backward/unknown variant拒绝。
2. 新 registry test：registry kind集合与 closed union的 runtime test inventory相等；order/stable key唯一；materialized与streaming对每个 registered kind生成完全相同 canonical bytes/checksum。
3. `snapshot-worker-client.test.ts`：begin固定 W，W 后并发写只在后续 delta；page/revalidate/complete中途 revoke、member remove、archive/reopen generation变化使 staging失效；合法 archived Human read按新 FT-02A合同通过。
4. `sync-service.test.ts`：retained连续、expired cursor、authority内部洞/重复、固定 watermark跨多页、compaction cutoff与pending/dead-letter规则。
5. `client-sync-replica.test.ts`：eventId replay、mixed stale+new batch、gap、冲突映射、进程重启后的dedupe ledger；repair flip前旧完整可见，flip后唯一新 generation，crash两侧都可恢复。

最小 GREEN：

- 在计划新增的 `repair-projection-registry.ts` 定义 server-internal descriptor；`snapshot-worker.ts` 的 materialized/streaming共享它，删除双份 segment枚举。
- `RoomRepairRecord`仍是 closed union，不加 arbitrary `{kind:string,value:unknown}`。
- replica cache port增加 generation/checkpoint/event-ledger的原子方法；apply event + cursor同事务。
- 对已合入的 FT-02A/FT-03 record完成首批登记；未来记录按本文§5 checklist扩展。

完成门：当前批准且已落 authority 的 visible record没有registry缺口；legacy OpenItem/LightTask等兼容记录仍可恢复；preview/secret/audit-only raw无记录。

### Slice 2 — 30 天 idempotency lifecycle 与唯一 migration batch

**目标：** 让 `expires_at`真正控制 replay，并建立有界清理与窗口外business-key语义。

**文件 owner：FT-13 migration coordinator + persistence owner；本切片期间其他人不改 schema/handler。**

先写 RED：

1. fresh actual predecessor→next、所有支持历史→next、future refusal、checksum/fingerprint tamper、每条新statement fault rollback。
2. `now = expiry-1ms`同 payload replay、different payload 409；`now = expiry`不 replay；exact expired row在同 transaction移除。
3. ACK loss跨重启且仍在30天内返回同 aggregate/event/result；窗口外客户端先reconcile的服务测试。
4. messageId/domain boundary在receipt清理后仍不产生第二事实；新业务意图使用新ID成功；没有domain identity的可重复command按新command处理。
5. janitor启动扫描、每批500、尾部让出worker、并发command、重启、百万级合成receipt索引计划（nightly）均有限完成；日志无hash/payload/corpus。

最小 GREEN：

- replay query显式检查 `expires_at > now`；expired exact key删除后执行。
- 新增AuthorityWorker内部 `cleanupExpiredIdempotency(now, limit)` RPC/operation，仅内部composition调用；启动+每小时bounded schedule，close时有序停止。
- append actual next migration，包含 idempotency expiry index以及已冻结的outbox lifecycle物理变更；不改v1～predecessor。
- domain unique错误映射为closed conflict，不回显SQL。

完成门：30天语义覆盖全command family的参数化测试，迁移从v12和“FT-02A先合入的实际版本”fixture均可证明，但文档/代码不写死哪个是 predecessor。

### Slice 3 — 有界 outbox、dead-letter、alert 与 peer 隔离

**目标：** 失败不热循环、最终终结；send-before-mark保持at-least-once；坏connection不让成功peer无限重收。

**文件 owner：FT-13 delivery owner；schema只消费Slice 2已落合同。**

先写 RED：

1. deterministic clock/jitter下断言 250ms base、指数增长、30s cap、8次终结；非法/无限配置拒绝。
2. `closed/backpressure/send_rejected`分别更新 attempts/availableAt；到期前不被list；max后dead-letter且不再poll。
3. A/B成功、C失败：下一轮只send C；C恢复后mark dispatched；进程重启可重发A/B但总量受max约束。
4. send-before-mark crash：相同eventId重复；replica只应用一次；outbox行最终dispatched。
5. 无eligible local connection仍可mark dispatched，由cursor承担离线恢复；当前授权复核继续区分room/principal/session-family。
6. dead-letter、oldest backlog warning/critical、dispatcher storage error触发test alert sink；sentinel payload/token不在alert/log。
7. compaction看到dead-letter不会永久阻塞，但必须能从alert定位event/delivery；retained cursor/repair仍完整。

最小 GREEN：

- DB failure mark原子计算attempt/next available/dead-letter；dispatcher不自行相信旧attempt。
- process-local accepted-peer ledger绑定delivery+connection+credentialGeneration；candidate lifecycle清理ledger。
- `OutboxAlertSink`只接受closed metadata；默认本地结构化sink和test sink。
- shutdown先停poll、await active flush，再关闭registry/socket/worker；错误不被空catch永久吞掉。

完成门：fault point、restart、bad-peer、dead-letter、alert和capacity backlog全部有证据；不宣称physical exactly-once。

### Slice 4 — Desktop encrypted cache 与 finite offline read lease

**目标：** 实现生产 cache adapter、加密/atomic generation、严格offline read-only和server-signed finite lease；不在本切片决定FT-14的默认小时数/上限。

**文件 owner：FT-13 Desktop cache owner；server lease protocol owner只在协议队列窗口编辑。**

先写 RED：

1. cache DB/WAL/SHM/temp/staging磁盘扫描无raw corpus/key canary；GCM wrong tag/AAD、nonce duplicate guard、corrupt schema、safeStorage unavailable均fail closed。
2. page N crash、finalize crash、pointer flip前/后、old generation GC前/后重启，各只有旧或新完整 projection。
3. signed claims exact-key/canonical-byte、bad signature/keyId/tenant/account/actor/family/device、notBefore/future、exact expiry、room revision mismatch拒绝。
4. server缺 `maxOfflineReadLease`、0/negative/infinite、client请求超限均fail closed；签发expiry不越配置/refresh horizon。测试使用显式短policy，不定义发布默认。
5. offline有效lease只读；message/project/confirmation/tool API call-count=0且无local ACK/queue；重连不自动提交旧输入。
6. logout锁定/zeroize但允许保留sealed ciphertext；lease expiry锁定；session terminal revoke清account cache；member revoke只清Room；clear-cache清active/staging/ledger/key/lease。
7. online reconnect在任何旧内容unlock前先auth+catalog/revoke check；未撤权再sync/repair换lease，已撤权purge。

最小 GREEN：

- 计划新增 `encrypted-authority-cache.ts`：main-process SQLite derived store、AES-256-GCM、safeStorage-wrapped data key、transactional generation pointer。
- 计划新增 Desktop/server `offline-read-lease.ts`：closed claims、Ed25519 sign/verify、public key pin/rotation seam。
- 扩 `ClientAuthorityCache`、identity `AuthorizedStateInvalidator` 和closed preload read/status API；renderer永不拿key/path/ciphertext/generic channel。
- offline command gate放在main-process controller与transport之前，renderer disabled只是第二层UX，不是授权。

完成门：真实Electron main-process adapter在macOS safeStorage可用环境通过；Linux/basic_text或无keyring明确fatal/locked；FT-14仍拥有threat model、发布默认/上限和key rotation runbook。

### Slice 5 — Preemption、三客户端、archive/reopen 与全链收口

**目标：** 把1～4接入真实composition，证明restart/multi-client/clear-cache/revoke/archive全链；不增加产品范围。

**文件 owner：FT-13 integration owner；共享composition/protocol只能在FT-02A/FT-03 owner交接后串行。**

先写 RED：

1. A live、B retained reconnect、C clear-cache/expired repair；三份加密persistent cache最终projection/checksum/watermark等于authority。
2. repair page 0后分别注入 session revoke、member remove、archive、reopen、capability reduction；验证server lease抢占、staging discard、旧完整cache的lock/purge/read-only差异。
3. archived合法Human restart/repair可读；业务write/Agent/steward/timer/新通知拒绝；session/member/grant reduction仍执行；reopen从stable event收敛而非local toggle。
4. ACK loss、commit-before-outbox、send-before-mark、bad peer、dead-letter后各客户端通过event/cursor/repair最终一致。
5. idempotency 29d/30d时间跳跃跨server restart；receipt cleanup后stable business key不重复。
6. offline lease有效→断网只读→expiry锁定→联网时已撤权purge；仍有权时repair换lease。
7. J-01/J-02/J-07 headless state与最终renderer contract：401/403/409/410/429/503、offline、repair-failed/retry、focus/aria/non-colour/reduced-motion。

最小 GREEN：

- `authoritative-server.ts`仅组装现有AuthorityWorker、SnapshotWorker、SyncService、OutboxDispatcher、janitor、lease signer；没有第二writer或test-only production branch。
- identity room-access event真正连接per-Room cache purge；session terminal event连接account purge；unknown/malformed reduction frame fail closed。
- FT-11/16 renderer只消费closed cache/sync state；无事实由DOM callback制造。

完成门：本计划§4全部矩阵通过、全仓门禁通过、交付说明准确列出未闭合的FT-14参数与未来record owner。此时才可说“FT-13达到交付证据”；owner另行验收前仍不能verified。

## 4. 完整 TDD 与故障/容量矩阵

### 4.1 Authority、cursor、repair

| ID | 场景 | 注入 | 必须断言 |
| --- | --- | --- | --- |
| R-01 | retained cursor多页 | W后持续写event | 页watermark固定；seq连续；W+事件后续补齐。 |
| R-02 | expired cursor | 推进retained boundary | 明确repair_required；无“空delta=成功”。 |
| R-03 | stream hole/corrupt | 删除中间event test fixture | storage_unavailable+alert；不以repair掩盖authority损坏。 |
| R-04 | materialized完整性 | 最后一页前暂停 | live仍旧完整/空；checksum后一次flip。 |
| R-05 | streaming完整性 | completion ACK前断线/ACK loss | 未ACK不flip；tombstone窗口exact completion replay。 |
| R-06 | fixed watermark | snapshot W后并发N events | snapshot只到W；delta恰W+1...H。 |
| R-07 | registry completeness | 为union加kind但不注册/只补一种路径 | build/test失败；materialized/streaming bytes相等。 |
| R-08 | approved inventory | confirmation/Ball/revision/notification fixtures | 清cache后每个当前可见状态等同authority。 |
| R-09 | snapshot capacity | 10k PR、100k nightly mixed records | O(page) replica；materialized失败自动streaming；无永久503。 |

### 4.2 Outbox、idempotency 与 crash

| ID | 场景 | 注入 | 必须断言 |
| --- | --- | --- | --- |
| D-01 | before commit | domain后/before COMMIT exit | domain/event/outbox/receipt全零。 |
| D-02 | after commit before ACK/dispatch | child exit | 同receipt/event恢复；无伪ACK。 |
| D-03 | send before mark | frame accepted后exit | 同eventId可重发；replica可见一次。 |
| D-04 | bad peer | 2 success + 1持续backpressure | success peer不在每轮重收；8次后dead-letter/alert；坏peer后sync。 |
| D-05 | jitter/backoff | fake clock/random | availableAt单调、有cap、不热循环。 |
| D-06 | dead-letter/restart | max前后重启 | state耐久；不自动复活；compaction规则可解释。 |
| I-01 | receipt replay | 29d23:59:59.999 | same replay / different conflict。 |
| I-02 | exact expiry | exactly30d | 不回放旧ACK；exact row清理。 |
| I-03 | cleanup tail | >1 batch | 每批≤500、让出worker、最终清空。 |
| I-04 | expired business key | 清receipt后重用messageId/boundary | 不产生第二事实；closed reconcile conflict。 |
| I-05 | new post-window intent | 新business ID/key | 可提交一次，旧事实不变。 |

### 4.3 Revoke、lease、cache 与 offline

| ID | 场景 | 必须断言 |
| --- | --- |
| C-01 | corrupt ciphertext/tag/AAD | 不展示；不plaintext fallback；旧完整generation若独立有效则保留。 |
| C-02 | crash around generation flip | 重启只选择一个committed active pointer；无半projection。 |
| C-03 | logout | credential清、key zeroize、UI锁；sealed ciphertext可保留但未认证不可解密。 |
| C-04 | session revoke online | 先锁状态，再清account active/staging/ledger/key/lease；兄弟session按authority继续。 |
| C-05 | member revoke online | 只清目标Room全部slice；catalog原子更新；其他Room不受影响。 |
| C-06 | offline lease expiry | exact expiry立即锁；不会因本机修改配置延长。 |
| C-07 | reconnect revoked | auth/catalog check先于旧内容；purge后403表面。 |
| C-08 | reconnect authorized | 旧完整cache保持明确stale/read-only直到sync/repair flip；新lease后unlock。 |
| C-09 | archived offline | lease有效时只读；业务/confirmation/tool call-count=0；security expiry继续。 |
| C-10 | clear-cache | DB active/staging/WAL/temp/key/lease均不可恢复；在线全repair。 |

### 4.4 Multi-client、restart 与 lifecycle race

| ID | Race | 线性化结果 |
| --- | --- | --- |
| M-01 | edit/recall vs repair W | W前进入snapshot，W后进入delta；最终同revision/tombstone。 |
| M-02 | confirmation expiry/revoke vs snapshot | current authority winner进入projection；过期grant不复活。 |
| M-03 | archive vs pending repair | 合法member转archived read-only或snapshot stale重开；不当作membership revoke。 |
| M-04 | member remove vs page/complete | remove commit后无剩余固定页泄漏；Desktop purge。 |
| M-05 | session revoke vs refresh/lease issue | 一个AuthorityWorker顺序；revoke winner后无valid token/lease。 |
| M-06 | reopen vs delayed archive event | streamSeq决定；客户端不倒退；最终active projection。 |
| M-07 | 3 clients + server restart | A/B/C独立persistent caches最终facts/checksum/cursor一致。 |
| M-08 | snapshot worker/authority/desktop分别重启 | authority不变；derived cache可删；staging可回收；无伪成功。 |

### 4.5 Secret / corpus sentinel

每次 focused E2E生成独特 canary：password、access/refresh token、offline signing private key、wrapped data key、raw message、recalled raw、attachment extraction、confirmation参数、Provider secret。扫描：

- authority/public event/outbox只按各自合同允许字段；
- server stdout/stderr、structured alert、error frame、diagnostic fixture；
- Desktop public state/DOM/IPC response；
- credential/cache DB、`-wal`、`-shm`、journal、temp、staging、crash leftovers；
- build artifact/source map与测试快照。

预期：cache磁盘对raw corpus零命中；日志/alert/diagnostics对全部secret/corpus零命中；operational repair对recalled raw零命中。测试本身的明确input fixture可在隔离源变量中包含canary，但不得把它写入失败快照/交付文档。

### 4.6 容量与资源预算

| 面 | PR级 | nightly/release级 | 失败要求 |
| --- | ---: | ---: | --- |
| repair records | 10,000 mixed / 3 clients | 100,000 mixed / 50 Rooms / 3 persistent clients | O(page) replica；fallback有界；无半swap。 |
| outbox backlog | 10,000 rows，10%失败 | 100,000 rows，坏peer持续到dead-letter | batch/backoff公平；heartbeat/command不饥饿；alert准确。 |
| idempotency receipts | 50,000含过期/未过期 | 1,000,000合成rows | index命中；500/batch；worker让出；磁盘回收可观测。 |
| event duplicate/gap | 1,000 replay/mixed batches | 100,000 replay frames | ledger/checkpoint有界；一次可见；冲突repair。 |
| encrypted cache | 10,000 records + crash矩阵 | 100,000 records + WAL/GC/restart | 无plaintext、generation flip短事务、旧generation最终GC。 |
| concurrent repair | 3 clients同Room | 16等待边界/多Room | single-flight或scoped busy；无全局barrier。 |

数值是工程测试档位，不是MVP产品成功门禁。若真实环境不能通过，实施者必须记录CPU/RSS/DB/WAL/latency并调整batch/page/backoff；不得删数据、关加密、放宽连续性或把cache升级为事实源。

## 5. Future FT 接入 checklist（阻断循环依赖）

archive/reopen、message revision/tombstone、confirmation/grant、notification及后续批准record必须由owning FT完成下列同一批变更：

1. 在 `packages/core` 定义closed projection/event/guard与type tests；不依赖server/desktop。
2. 在owning feature transaction内提交domain + stable event + outbox + idempotency；不调用snapshot。
3. 在server projection adapter实现registry descriptor；adapter只依赖closed registry interface和worker-owned readonly DB。
4. 中央 registry assembly显式import descriptor；feature command/runtime不反向import assembly，避免环。
5. Desktop reducer/cache schema支持record；event和repair得到相同projection。
6. 声明archive、membership/session revoke、recall、lease expiry、clear-cache行为。
7. 通过materialized/streaming parity、clear-cache、3-client、restart、sentinel测试。

任何一个步骤缺失，该feature可提交authority内部事实，但不得在UI宣称其可可靠恢复，也不得私建旁路snapshot。

## 6. 最终验证顺序与交付口径

实施完成后从实际integrated worktree依次运行并记录精确版本、命令、文件/测试数、耗时和skip：

1. Core guards/type tests、repair registry parity；
2. schema fresh/all-history/actual-predecessor/future/fault rollback；
3. idempotency/outbox/persistence worker focused suites；
4. sync/snapshot/fallback/replica/cache/lease focused suites；
5. Desktop identity invalidation、IPC/preload/security与offline command call-count-zero；
6. compiled child crash/restart、三客户端、clear-cache、archive/revoke races；
7. secret/corpus sentinel与PR级capacity；
8. `corepack pnpm typecheck`；
9. `corepack pnpm lint`；
10. `corepack pnpm verify:core-boundary` 与 `corepack pnpm verify:desktop-boundary`（若届时脚本仍存在）；
11. `corepack pnpm test`；
12. `corepack pnpm build` 与真实Electron smoke；
13. `git diff --check`、链接/路径检查、`git status --short --branch`。

交付说明必须明确：实际 predecessor和分配到的migration版本、registry inventory、30天TTL、outbox policy/dead-letter/alert、lease policy仍由FT-14冻结的值、故障/容量/sentinel结果、所有未合入future FT record。它最多说明“FT-13达到交付证据并等待owner验收”；不得自行宣布 FT-13 verified、修改Blueprint、commit/push/建PR或扩展产品范围。
