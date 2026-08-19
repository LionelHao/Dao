# FT-05 Room Memory Authority & Steward：生产工程设计与协议状态机

> 日期：2026-08-19
> 状态：Stage 7 编码前冻结；只有本文列出的 authority、迁移、故障恢复、Desktop 与真实组合证据全部通过后才可进入交付。
> 直接 Requirement：`REQ-MEM-001/002/005/006/007/010`、`REQ-MSG-005/006/010`、`REQ-PRIM-008/014`。
> 横切 Requirement：`REQ-NFR-001`～`005`、`007`～`012`、`014`、`REQ-UX-004/007/009`；FT-01/02/03/04/13/16。
> 权威 UI：`docs/design/README.md` 指向的正式自包含审阅稿，旅程 `J-04/J-06/J-07` 与右栏“重要记忆 · 5 类”。与正式设计稿偏离：**无**。

### 设计基线补充决策

正式审阅稿已经冻结右栏结构、active Context、DISPUTED、STEWARD watermark/lag、generic memory degraded、offline/repair、归档与 FT-16 可访问性，但没有把本阶段要求的每个 Memory health/source/error 状态画成独立可到达页面。本 Stage 的 owner 指令已逐项明确 loading/empty/catching-up/noauth/degraded/recovery-required、dispute/resolve/re-evaluate、source revised/recalled/unavailable、offline/repair 与 401/403/404/409/410/429/503 的状态、事实源、操作和恢复，因此这里将其作为正式基线的**补充设计决策**冻结，而不是由实现自由创造产品行为。

补充状态不改变既有三栏层级、右栏组件关系、文案语义、ACK/event/projection事实源或 FT-16视觉规则，故偏离仍为“无”。替代验收证据固定为 feature-owned `DESIGN_CONTRACT.md`、可到达的 DOM 状态测试、键盘/焦点/VoiceOver/缩放/reduced-motion 测试与 production Electron smoke。正式旅程编号以当前 Design README 为准：`J-04 @Human Request` 只提供责任接受不能由 message/memory ACK 推断的边界；`J-06 proposal → Human confirmation → project fact` 承担 proposal/confirmed/source revision；`J-07 notification/offline → fixed-watermark repair` 承担 offline/repair。PRD旧叙事中的同号旅程只作历史语义导航，不覆盖正式编号。

## 1. 交付边界与权威关系

FT-05 将每个 Room 的全量可授权来源编成可追溯的重要记忆，并交付单调 watermark 后的完整 raw-delta seam。它不把本地缓存、Provider 状态、最近消息窗口或 steward 输出变成事实源。

不可妥协的不变量：

1. SQLite 是 corpus index、memory、争议链、job/attempt、checkpoint、health 与 recovery 的唯一权威持久层；原始 message body、attachment object/extraction 继续由 FT-03/04 各自拥有，FT-05 不复制正文。
2. 一个 Room 恰有一个内置 steward authority row。steward 不是 actor、Human、Agent、membership 或 roster participant，不登录、不收发普通消息、不参与 route 抢占。
3. 五类固定为 `goal`、`decision`、`context`、`next_action`、`open_question_or_blocker`。只有 Context 可由 steward 自动进入 active；其余只能进入 proposal，或只读引用未来 FT-09 的 confirmed project fact。
4. 任一当前 Human member 可 dispute active Context。disputed 立即从 injectable snapshot 排除；resolve/re-evaluate 追加新 version/transition，保留原 version、source edge 与 dispute chain。
5. 每个 eligible source 在 Room 内获得严格递增 `corpusSeq`；checkpoint 的 `memoryWatermark` 只在冻结批次的全部结果与状态同一事务提交后前进到连续上界，永不回退、跳号或越过未决 source。
6. watermark 之后所有 source 必须能按 `(corpusSeq, sourceIdentity)` 返回有序、安全、授权的 raw-delta representation。该 seam 不做 token budget、digest 编排、trigger 拼接或最终 Provider manifest；这些属于 FT-06。
7. message ACK、attachment transaction 与 Room authority mutation 不等待 Provider/steward。corpus enqueue 是同事务的 metadata/index 写入；semantic work 异步且失败闭合。
8. recall/revoke 是同步 operational exclusion：不等待 steward。被排除 source 的 raw body/extraction 不得出现在 memory snapshot、raw delta、event、repair、runtime seam 或 Desktop DOM。
9. archive 冻结新 steward claim/result/retry；reopen 只从 durable contiguous watermark 继续，不重放已提交 memory version。
10. Provider raw response、prompt、secret、headers、hidden reasoning、adapter raw error、stack、SQL 与 raw source body 永不进入新的 durable、event/outbox、repair、diagnostic、log 或 Desktop 域。

## 2. 权威输入与已消解边界

权威顺序是 PRD → protocols/approved feature design → formal UI design → production code/tests。`docs/protocols/identity-room-lifecycle.md` 的旧 silent/archive 表述不覆盖 approved PRD 与 FT-02/FT-05：FT-05 不新增 silent 档位，archive 期间 steward 业务冻结但安全撤权继续。

现有 production gap 位于 `packages/server/src/persistence/authority-database-handler.ts` 的 `runtime.read-context`：active message envelopes 按时间倒序只取 `LIMIT 64`。该窗口保留为 FT-08 现有 invocation conversation 行为；FT-05 通过全量 corpus/source/watermark seam 消除“第 65 条后不可检索”的 memory 能力缺口，但不在本阶段替换 FT-06 的最终 invocation compiler。

FT-09 checkpoint participant 初始为 `disabled`，因此没有 project fact 被伪造成 confirmed。未来显式配置为 `enabled` 时若 participant/adapter 缺失，服务 readiness 必须 `degraded` 并以 503 暴露，不能生产 no-op。

## 3. Corpus source 模型

### 3.1 source kind 与稳定 identity

`RoomMemorySourceKind` 为闭集：

| kind | stable source ID | revision/generation | eligibility owner | authorized read reference |
| --- | --- | --- | --- | --- |
| `message` | `message:<messageId>` | current revision integer | FT-03 message envelope/lifecycle | message authority reader；current body 或 tombstone metadata |
| `message_revision` | `message-revision:<messageId>:<revision>` | revision integer | FT-03 immutable revision chain | revision audit reader，仅在 operational policy 允许时给 steward |
| `message_tombstone` | `message-tombstone:<messageId>:<recallSeq>` | recall event stream seq | FT-03 recall authority | body-free tombstone reader |
| `attachment_extraction` | `attachment-extraction:<attachmentId>:<generation>` | attachment/extraction generation | FT-04 ready+bound+active provenance | FT-04 server-private extraction reader |
| `project_fact_checkpoint` | `project-fact:<aggregateId>:<version>` | FT-09 aggregate version | future FT-09 confirmed fact adapter | disabled port；未来仅 confirmed projection reader |

稳定 identity 不包含 Room 名、正文、filename、object key、path、URL 或 token。所有 source row 必须带 `roomId`、`corpusSeq`、`sourceKind`、`sourceId`、`sourceRevision`、`serverStreamSeq`、`occurredAt`、`eligibility`、`availability` 与 safe speaker/provenance metadata。`UNIQUE(room_id, corpus_seq)` 与 `UNIQUE(room_id, source_kind, source_id, source_revision)` 同时成立。

`corpusSeq` 是 FT-05 内部连续序列，不等同于 event `streamSeq`：一个 stable event 可产生零个或多个 source change，而 source change 必须在对应 authority transaction 内或通过可重建的 durable indexer 精确一次登记。`serverStreamSeq` 仅用于 provenance/排序校验。restart recovery 扫描权威 FT-03/04 记录补齐缺失 index，但不得为已有 stable identity 分配新序列。

### 3.2 eligibility 与 availability

`eligibility = eligible | excluded_recalled | excluded_revised | excluded_revoked | excluded_unbound | excluded_unsafe | unavailable`。`availability = readable | tombstone | metadata_only | temporarily_unavailable`。进入 steward batch 必须同时满足 current Room authorization、active lifecycle、eligible 与 readable；query 可返回 safe tombstone/availability，但不泄露 raw。

message revision 追加新 revision source，并同步把旧 current source 标记 `excluded_revised`；recall 追加 tombstone source，并同步排除 message 与所有绑定附件 source。attachment 只有 ready、bound、active、current authorization 且 extraction provenance 匹配 current generation 才登记 eligible；malware、cancelled、unbound、recalled、revoked、nonretryable 均不进入 Agent-visible corpus。

### 3.3 raw-delta representation

FT-06 private seam 返回：`roomId`、`fromWatermarkExclusive`、`toCorpusSeqInclusive`、有序 entries；每项只有 stable identity/kind/revision、corpus/server order、safe speaker/source metadata、eligibility/availability 与 opaque authorized read reference。正文由调用方在同一 frozen read set 内经 feature reader、当前权限与 lifecycle 重验读取；不得写回 corpus/job/outbox。

分页固定最多 `64` source entries/页、最大序列化 metadata `256 KiB`、单项 safe derived metadata `4 KiB`。页 cursor 绑定 Room、watermark 与 authorization epoch；错 Room、过期 access 或 discontinuity 失败闭合。超过一页必须继续至冻结上界，不允许因单批上限遗留尾部。

## 4. Memory、version、source edge 与 proposal 状态机

### 4.1 durable identities

- `memoryRecordId`：Room 内稳定逻辑主题，由 server 生成；kind 永不改变。
- `memoryVersionId`：每次 validated steward replacement/merge、Human resolve 或 source invalidation 的 append-only identity。
- `memorySourceEdgeId`：`(memoryVersionId, sourceIdentity)`；append-only，不能改 source revision。
- `proposalId`：非 Context version 的 proposal projection；不等于 project fact。
- `disputeId`、`resolutionId`：server 生成，分别保存 operator、reason、time、expected version 与 replacement。

### 4.2 闭集状态

`MemoryVersionState = proposal | active | disputed | review_required | resolved | superseded | invalidated`。

```text
Context candidate --validated steward--> active
active --current Human dispute--> disputed --resolve/re-evaluate--> superseded
                                             \--> new active replacement
active --source revised/recalled/revoked--> review_required/invalidated
review_required --validated replacement--> superseded + new active

non-Context candidate --validated steward--> proposal
proposal --merge/replacement--> superseded + new proposal
proposal --future FT-09 exact confirmed ref--> superseded + readonly confirmed-project reference
```

非法转换包括 proposal→active、steward→resolved、disputed→active 原位修改、任何 version update/delete、任何 source edge update/delete、client 提交 confirmer/confirmed/watermark/provider metadata。Human resolve 必须使用 expectedVersion CAS；重复相同 requestId/canonical payload replay 原 ACK，changed payload 409。

### 4.3 multi-source 冻结规则

一个 version 的全部 source edges 构成其声明 support set。任一 edge 被 revised/recalled/revoked/unavailable 时，旧 version **立即**退出 injectable projection：

1. 若没有剩余 eligible source，状态为 `invalidated`；
2. 若仍有 eligible source，状态为 `review_required`，UI 展示来源变化；
3. steward 必须在新 frozen read set 中重新验证内容，并创建只引用剩余/新增 eligible source 的 replacement version，才可恢复 active/proposal；
4. 不以“至少一个来源仍在”自动维持 active，因为模型生成文本无法安全证明每个子句只由剩余来源支持。

这是一致、可审计且 fail-closed 的“剩余来源足够”定义：足够性由新 validated replacement 的完整 source set 表达，而不是旧 version 的数量阈值。旧 version 和 edge 永久保留。

## 5. Steward Provider closed contract

生产 composition 复用现有 OpenAI Responses endpoint、model 与 `SecretProvider.getSecret("OPENAI_API_KEY")`；`store:false`。新增 memory adapter 只复用 transport/config，不建立第二 secret/provider 配置，不回退 fixture、heuristic、static 或 no-op success。

### 5.1 frozen input

每批输入在 claim 事务中冻结 `roomId`、generation、`fromWatermarkExclusive`、`toCorpusSeqInclusive`、ordered source descriptors 与 authorized read revisions。worker 随后读取正文时每项重验 membership/lifecycle/eligibility/revision/generation；漂移则 attempt stale，不能提交 late result。

Provider input 上限：最多 `32` source entries、UTF-8 总正文 `256 KiB`、单 source `64 KiB`、request JSON `384 KiB`、timeout `60 s`。正文只存在于瞬时内存/request；prompt 不持久化或记录。

### 5.2 exact output

Response 必须是单个 JSON object，exact keys：

`{ schemaVersion: 1, candidates: [...] }`

每个 candidate exact keys：`operation`、`kind`、`derivedText`、`sourceRefs`、`dedupeKey`、`replacesMemoryRecordId`；其中 operation 为 `create | replace | merge | no_change`，kind 为五类闭集，derivedText `1..4096` UTF-8 bytes，sourceRefs `1..16` 且每项 exact `{ sourceId, sourceRevision }`，dedupeKey 为 server-safe `1..128` ASCII，replacement ID 可空。每批最多 `32` candidates，完整 output 最大 `64 KiB`。

closed parser 使用 `Reflect.ownKeys` 拒绝 extra/symbol/non-enumerable keys，拒绝 invalid JSON、truncation、duplicate keys/candidate、invalid UTF-8、跨 Room source、非 frozen source/revision、unknown memory/actor/Room/message/attachment/project ID、oversize 与 invalid enum。模型不能声明 Human confirmer、responsibility acceptance、deadline confirmation、project authority、command/tool/path/URL/secret/reasoning；任何命中整批失败，watermark 不前进。

去重键只在 Room/kind 内提示候选；最终 merge/replacement 由 database authority 校验：source union 不丢边、kind 不变、target current generation/version CAS、Context 才能 active、非 Context 固定 proposal。`no_change` 也必须验证 source set 并只在整批全部候选闭合后允许 checkpoint 前进。

## 6. Worker、attempt、recovery 与容量

冻结生产值：

| limit | value | 语义 |
| --- | ---: | --- |
| global active Rooms | 4 | 跨 Room 有界并发 |
| per-Room active | 1 | FIFO 串行，按 next contiguous corpusSeq |
| claim batch | 32 sources | 对齐 Provider input 与候选上限 |
| ready queue | 256 Rooms | 超限不丢 durable work，recovery scan 再发现 |
| recovery scan page | 128 Rooms | 从 durable checkpoint/health 扫描 |
| recovery passes/tick | 8 | 每 tick 最多 1024 Rooms，下一 tick 延续 cursor |
| timeout | 60 s | AbortController；late generation 零写 |
| attempts | 3 | initial + 2 retry；manual retry 创建新 recovery generation |
| backoff | 1 s, 4 s | persisted `availableAt`，无热循环 |
| dead-letter | after third retryable/first invariant-terminal | health degraded/recovery-required |
| shutdown grace | 10 s | stop claim，abort inflight，checkpoint 只认 committed |

`noauth` 不消耗 attempt、不前进 watermark，Room 保持 durable pending。timeout/429/unavailable 为 retryable；invalid output、cross-Room、oversize 为 terminal `degraded`；storage/checkpoint discontinuity 为 `failed/recovery_required`。manual retry 新建 attempt/recovery generation，不修改 terminal attempt。archive 与 access/lifecycle generation 在 claim 前、Provider 前、commit 前均 CAS；archive 后无 semantic result commit，reopen 继续未消费 contiguous seq。

## 7. Memory health 与 runtime gate

`MemoryHealth = healthy | catching_up | noauth | degraded | failed`，并带 closed reason、watermark、corpusHead、lag、lastAttemptAt、retryable、recoveryRequired。

- `healthy`：lag 0、无 terminal failure、checkpoint连续。
- `catching_up`：lag > 0 且 raw-delta seam 完整，worker 可推进。
- `noauth`：secret 缺失；服务启动、聊天/附件/read 继续，新 batch 不伪 processed。
- `degraded`：timeout exhausted、rate/dependency unavailable exhausted、invalid/oversized output或 dead-letter。
- `failed`：storage/checkpoint/source invariant 破坏，需要 recovery/人工处理。

server-private `MemoryRuntimeReadiness` 同时返回 current injectable snapshot 与 raw delta capability。explicit invocation 只消费/透传该 seam：memory 非 healthy 时也不得被 FT-05 整体拒绝；本阶段不把它编成最终 Provider input。semantic/risk/domain proactive gate 在 `noauth/degraded/failed` 时 Adapter 调用次数必须为 0；`catching_up` 仅在 route 明确使用 raw delta 的未来实现前保持暂停。FT-09 未启用时 deterministic due 不存在；未来 project authority healthy 且带 exact source 可单独允许，否则暂停并产生 Human-visible safe state。

## 8. Public closed protocol

冻结 v1 frames：

| request | ACK/projection | client 可提交 | server 注入/决定 |
| --- | --- | --- | --- |
| `room.memory.query.v1` | `room.memory.page.v1` | requestId, roomId, cursor?, limit≤50, kind/state filter? | principal/session/access、safe projection、watermark/health |
| `room.memory.source.query.v1` | `room.memory.source.v1` | requestId, roomId, sourceId | current authorization、availability、navigation target；无 raw attachment extraction |
| `room.memory.context.dispute.v1` | `room.memory.context.dispute.accepted.v1` | requestId, roomId, memoryRecordId, expectedVersion, reason≤2048 | Human actor/time/new version/event/outbox |
| `room.memory.context.resolve.v1` | `room.memory.context.resolve.accepted.v1` | requestId, roomId, memoryRecordId, expectedVersion, resolution, reason≤2048 | 原 dispute Human；或 steward 已重评并记录理由后的 owner/admin；operator/time/replacement/state transition |
| `room.memory.status.query.v1` | `room.memory.status.v1` | requestId, roomId | watermark/head/lag/closed health/recovery action |
| `room.memory.retry.v1` | `room.memory.retry.accepted.v1` | requestId, roomId, expectedRecoveryGeneration | current Human authorization/new generation/attempt |

所有 parser exact own keys，frame/body/buffer/timeout 有界，requestId-correlated ACK。client 不能提交 steward identity、kind authority、active/confirmed、watermark、eligibility、source revision override 或 Provider metadata。

错误闭集映射：400 invalid closed input；401 unauthenticated；403 current membership/role forbidden并 purge；404 Room/memory/source不可见；409 request replay mismatch/version/generation conflict；410 archived mutation/source gone/protocol obsolete；429 bounded capacity；503 memory/dependency/repair unavailable。错误只含 stable object ID、closed code、retryability/retryAfter；不含正文、extraction、secret、prompt、Provider body/header、stack、SQL/path。

## 9. Stable event、outbox、sync 与 repair

memory command/worker commit 将 domain rows、minimal stable event、outbox 与 idempotency receipt 放在同一 AuthorityWorker transaction。event/outbox只保存 record/version/dispute IDs、kind/state、source IDs、watermark/health classification；发送/repair 时按当前 authorization 重新投影，recall/revoke 后不能从旧 outbox 恢复 raw 或 operational eligibility。

FT-05 feature owner 提供 `memory` repair record/guard/mapper/sort key/descriptor；FT-13 继续拥有唯一中央 `RoomRepairSegmentDescriptor` registry、assembly、fixed watermark、checksum、pagination、quota fallback 与 purge。不得创建第二 registry。

repair projection 包含当前可见 memory record/version、proposal/active/disputed/review-required/resolved/superseded/invalidated、safe source refs/availability、dispute/resolution chain、steward watermark/head/lag/health；不含 raw body/extraction、Provider input/output、prompt/reasoning 或 recalled raw。固定 watermark 后并发事件继续由 delta 应用；eventId/version/generation 去重；新 repair generation 完整校验后原子替换旧 cache，失败保留旧完整授权 cache。

## 10. Desktop Memory Authority panel

feature-owned `packages/desktop/src/renderer/memory-authority/` 承担正式右栏，不用 review-only route 或 fake callback。事实源映射：

| visible state | authority source | action/recovery |
| --- | --- | --- |
| loading/empty | local query transient / matching page ACK | cancel/重试；不显示伪空成功 |
| healthy/catching up + watermark/lag | projection/stable event/repair | lag 文案+raw delta可用；低频 aria-live |
| active Context | projection | source deep link；current Human 可 dispute |
| disputed/resolving/re-evaluating | stable version + local matching request | disputed 不 injectable；失败保留输入 |
| resolved/superseded/review required | stable projection/repair | 显示版本、operator/reason/source变化 |
| non-Context proposal | stable projection | 明写 PROPOSAL，无确认按钮/confirmed暗示 |
| confirmed project reference | future FT-09 projection | 当前显示“项目事实接入未启用”，不 fake confirmed |
| source active/revised/recalled/unavailable | source projection | 深链消息/tombstone/attachment；无 raw recalled |
| noauth/degraded/recovery-required | health projection | chat/explicit提示继续；semantic proactive暂停；safe retry |
| offline/repairing/repair failed | connection + last complete authorized cache | writes disabled；repair失败保留旧完整 cache |
| archived read-only | Room lifecycle projection | 浏览/来源导航；dispute/resolve/retry禁用 |
| 401/403/404/409/410/429/503 | matching closed error | reauth/purge/reload/reconcile/backoff/retry |

键盘顺序覆盖 filter→memory card→source→dispute/resolve/retry；drawer/dialog `Esc` 关闭后焦点回触发器。active/proposal/disputed/degraded 用文本、图标和结构而非颜色。只对 accepted dispute/resolve、health 低频变化和 repair 完成做 bounded polite announcement，worker progress 不逐 source 刷屏。VoiceOver label/description、1440×900、840×560、200% zoom 与 reduced motion 必须由 DOM/contract/Electron smoke覆盖。

renderer 只提交意图；success 来自 matching ACK，memory/version/watermark/health 来自 stable event/projection/repair。403/revoke 或 access epoch变化立即 purge Room memory cache；旧 epoch async result不能恢复权限。

## 11. 数据域与泄露 sentinel

| domain | allowed | forbidden |
| --- | --- | --- |
| FT-03 message authority | raw current/revision/audit body，按既有授权 | Provider secret/raw response |
| FT-04 object/extraction | raw attachment bytes/extracted text，按既有受限 reader | corpus index/job/outbox复制 |
| FT-05 corpus index/jobs | stable IDs、revision、order、eligibility、safe metadata、attempt classification | raw message/extraction、path/token/URL/prompt/provider body |
| FT-05 memory authority | validated derived text≤4 KiB、version/source provenance/state | raw source副本、hidden reasoning、Human fake confirmer |
| event/sync/repair/Desktop cache | current-authorized safe projection | recalled raw、secret、prompt、Provider headers/body |
| diagnostics/log/stdout/stderr | IDs、counts、latency、closed error/reason | corpus raw、derived text默认也不记录、secret、stack/SQL/raw adapter error |

combined sentinel 必须扫描 SQLite 全表/列与 WAL/SHM、snapshot/cache、event/outbox、live/delta/history/repair、runtime seam、Desktop bridge/DOM、diagnostics/log/stdout/stderr；各 canary 仅允许在其明确 authority domain。Provider raw/prompt/secret/headers/reasoning 在所有 durable/diagnostic域零命中；recalled raw 在所有 operational域零命中。

## 12. Schema v18 冻结

唯一追加 migration 名为 `room-memory-authority-steward`，不得改 v1～v17 statement/checksum/fingerprint。表族：

- `room_memory_stewards`：Room 唯一 steward、watermark/head、health/reason/recovery generation；
- `room_memory_sources`：append identity + mutable eligibility projection，连续 corpusSeq；
- `room_memory_source_transitions`：append-only eligibility/availability审计；
- `room_memory_jobs` / `room_memory_attempts`：frozen batch、generation、status、availableAt、closed classification；
- `room_memory_records` / `room_memory_versions` / `room_memory_source_edges`：record稳定、version/edge append-only；
- `room_memory_disputes` / `room_memory_resolutions`：immutable Human chain；
- `room_memory_idempotency`：30日 replay receipt；
- `room_memory_project_checkpoint`：future port mode/cursor，不存 legacy project事实。

CHECK/FK/UNIQUE/trigger 关闭：one steward/Room、continuous positive seq、watermark≤head、closed kind/state/health、non-Context active、version/edge/dispute/resolution update/delete、cross-Room edge、invalid operator kind、attempt generation/status regression、late result覆盖新 generation、project port enabled-without checkpoint、legacy OpenItem/LightTask/Ball/calibration导入。

测试必须证明 fresh 与每个 v1～v17→v18、restart idempotent、future refusal、history checksum/physical fingerprint tamper refusal、每条 meaningful v18 statement fault rollback同时还原 `user_version`/schema/history/data、v17 message/attachment兼容。meaningful statement 精确数在 migration 完成后由导出常量和逐 statement test 锁定，不在编码前虚报。

## 13. Requirement / 设计 / 代码 / 测试映射

| Requirement / journey | production slice | 必须的关键证据 |
| --- | --- | --- |
| MEM-001 / PRIM-014 | corpus index、authorized readers、>64 lookup、restart | 第1/65/尾 source按ID可取；全量不重不漏；raw域隔离 |
| MEM-002 | one steward、async FIFO、source edges | ACK不等Provider；重复batch幂等；不进roster/route |
| MEM-005 / UX-004 / J-04 | Context active；其他 proposal；FT-09 readonly port | fake confirmer拒绝；proposal/confirmed UI非混淆 |
| MEM-006 / J-04 | dispute/resolve/re-evaluate chain | 任一当前Human、exact replay、CAS、disputed不injectable |
| MEM-007 / PRIM-014 | monotonic watermark + raw delta seam | 多批/重启/lag不跳过不重复；FT-06边界type tests |
| MEM-010 / J-06 | health/readiness + explicit/proactive gates | noauth/degraded聊天继续；semantic adapter call 0 |
| MSG-005 / PRIM-008 | revision source transition/review-required | immutable old version、new source、running snapshot不漂移 |
| MSG-006 / PRIM-008 | recall/tombstone immediate exclusion | derived/source/attachment operational零raw；audit identity保留 |
| MSG-010 / J-01 disclosure seam | all eligible Room history + current auth | pre-join历史可source检索；cross-Room/revoke拒绝 |
| NFR-001～005 | SQLite、atomic event/outbox/receipt、bounded recovery | statement rollback、send-before-mark、tail > batch最终处理 |
| NFR-007～012/014 / J-07 | offline/repair/purge/archive/read-only | fixed watermark、cache clear/revoke、archive/reopen race |
| UX-007/009 / FT-16 | request-correlated UI、a11y/zoom/motion | 401..503、keyboard/focus/VoiceOver/840×560/200% |

## 14. 明确延期与非目标

本阶段只交付可消费的 memory snapshot/watermark/raw-delta/source seam；不实现 FT-06 token budget、digest策略、trigger/source最终manifest或Provider participant context。不开 FT-07 profile/assignment、FT-08 scheduler、FT-09 project aggregate/commands、FT-10 public tool、FT-11完整shell、FT-12 notification center、FT-14 export/retention UI、跨Room搜索或任意shell/binary/URL/cwd/renderer文件能力。

任何测试 fixture/mock/no-op 只可位于深层 test seam，production composition sentinel 必须证明没有 static/no-op/fake steward fallback。
