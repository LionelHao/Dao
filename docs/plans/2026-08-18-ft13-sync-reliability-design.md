# FT-13 Sync & Reliability：生产工程设计

> 日期：2026-08-18
>
> 状态：**实施准备设计；不是实现、交付、验收或 verified 声明**
>
> 产品权威：[批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
>
> 证据索引：[agent-im-evidence-map.md](../reconstruction/agent-im-evidence-map.md)
>
> UI / 交互权威：[Design README](../design/README.md) 与 [Requirement 覆盖矩阵](../design/design-requirement-coverage.md)
>
> 实施拆环：[FT-13 implementation plan](./2026-08-18-ft13-sync-reliability-implementation-plan.md)

## 1. 结论、基线与边界

FT-13 不重建数据库、writer、事件总线或通用 transport。它在现有 **worker-owned SQLite authority + stable event + transactional outbox + cursor/repair + `ClientSyncReplica`** 上闭合四个缺口：

1. 连续 cursor、fixed-watermark repair、所有批准可见事实的单一 repair 注册表，以及客户端 staging 原子替换；
2. 真实执行的 30 天 idempotency 生命周期与有界 outbox delivery；
3. session / membership / Room lifecycle 对 sync、snapshot 与 cache 的抢占；
4. 主进程持有的加密 Desktop cache、严格 offline read-only，以及 service-signed finite offline read lease seam。

本设计直接覆盖 `REQ-ID-005`、`REQ-PRIM-002`、`REQ-PRIM-006`、`REQ-MSG-002`、`REQ-UX-002`～`REQ-UX-003`、`REQ-UX-006`～`REQ-UX-007`、`REQ-NFR-001`～`REQ-NFR-005`、`REQ-NFR-007`～`REQ-NFR-011`、`REQ-NFR-014`；联动 `REQ-MSG-005`～`REQ-MSG-008`、`REQ-AGT-008`～`REQ-AGT-013` 和未来 FT-04/05/09/10/12 的可见 projection。

### 1.1 审计基线

- 当前生产基线是 schema v12：[`schema.ts`](../../packages/server/src/persistence/schema.ts)；FT-01 已交付 session-family 切片及相应迁移：[FT-01 交付说明](../deliveries/FT-01-Identity-Session-交付说明.md)。
- 本 worktree 最终已前移到 `origin/main@097a41e`；该提交包含 PRD、evidence map、设计基线和覆盖矩阵。分支 `codex/ft13-sync-reliability-plan` 在文档产出前没有生产代码提交。
- FT-02A 可能先把实际 predecessor 升为 v13。本文只使用 `actual merged predecessor`，**不预占任何 migration 版本号**。
- 另一个 Agent 在本批拥有 FT-02A 所有生产代码修改权。本任务只新增本文和配套 implementation plan；没有修改 `packages/**`、schema、migration、protocol、WebSocket、Desktop、测试、Blueprint 或任务状态。

### 1.2 非目标

- 不引入 PostgreSQL、Redis、Kafka、第二个 writer、第二套 snapshot、完整 Event Sourcing 或泛型消息总线。
- 不建设 OS push、Mobile/Web、global search、full Blueprint、跨 Room 五分区 inbox、多租户或多 Provider。
- 不把 renderer/local cache/preview/未完成 staging 当事实源，不接受离线业务写入，也不自动重放离线草稿。
- 不在 FT-13 冻结 `maxOfflineReadLease` 的发布默认值或允许上限；这两个安全值由 FT-14 threat model 决定，但它们必须是有限正值，缺失即 fail closed。

## 2. T-0040 证明了什么、没有证明什么

权威历史合同是 [T-0040 design](./2026-08-10-t0040-authoritative-persistence-design.md)、[implementation plan](./2026-08-10-t0040-authoritative-persistence-implementation.md)、[authoritative-sync protocol](../protocols/authoritative-sync.md) 和 [delivery](../deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md)。其证据必须按当时范围读取，不能外推到新 PRD。

### 2.1 已证明

| 证明项 | 精确边界 |
| --- | --- |
| SQLite authority / single writer | 一份 authority DB、一个 `AuthorityWorker` 独占 read-write connection；领域表是事实源，snapshot/cache 可删。没有证明多进程或多主 writer。 |
| command 原子提交 | 当时 closed command 的 domain fact、stable event、idempotency receipt、outbox 在同一 `BEGIN IMMEDIATE` 中提交；四个真实 child crash point证明 commit 前回滚、commit 后可恢复。 |
| at-least-once seam | send-before-mark crash 可重复发送同一 `eventId`；replica 可见应用去重。它从未承诺物理 exactly-once。 |
| retained / expired cursor | retained cursor 返回连续 delta；`afterSeq < retainedFromSeq - 1` 明确进入 repair；三客户端覆盖 live、断线补齐、clear-cache/expired repair。 |
| fixed view 与原子替换 | materialized snapshot 使用固定只读视图；streaming fallback 使用 scoped mutation barrier；最后一页/checksum/必要 completion ACK 之前 live cache 保持空或旧完整版本。 |
| 有限状态可 repair | 10,000 mixed-record fixture 证明 materialized fallback、O(page) streaming、分页 checksum 与三副本一致；它不冒充 10,000 次 production command/event/outbox。 |
| 权限复核 seam | history/sync/page/complete/subscribe 重验当前 session/membership；session-family revoke、成员移除、降权与旧 archive 语义可抢占 streaming lease。 |
| migration discipline | 不可变 migration checksum/fingerprint、fresh/历史升级、future refusal、中途 rollback 和 derived snapshot-cache 独立版本。 |

### 2.2 没有证明

| 未证明项 | 当前审计事实 / FT-13 责任 |
| --- | --- |
| 新 PRD 的完整 repair | 当前 `RoomRepairRecord` 只含 room、membership、legacy message、read/judgement、OpenItem/LightTask、execution/route/calibration；没有 revision/tombstone、Ball/reminder、confirmation/grant/dispatch/outcome、memory/project、notification 等完整批准表面。 |
| 单一扩展机制 | [`snapshot-worker.ts`](../../packages/server/src/persistence/snapshot-worker.ts) 的 materialized `roomRecords()` 与 streaming `keysetRoomPage()` 各维护一套 table/mapper 顺序，新增 FT 容易只补一边。 |
| 30 天 TTL 被执行 | [`authority-database-handler.ts`](../../packages/server/src/persistence/authority-database-handler.ts) 写 `expires_at = now + 30d`，但 replay 查询不检查 expiry，也没有清理 worker；当前是永久 receipt，而不是 30 天 window。 |
| 有界 outbox | [`outbox-dispatcher.ts`](../../packages/server/src/outbox-dispatcher.ts) 轮询失败后立即再取；DB 只增加 attempts，不更新 `available_at`，无 max retry、dead-letter 或 alert。 |
| peer 隔离 | 一个 room delivery 对所有本地 candidates 共用一行；任一 peer 失败会保留整行，已成功 peer 下一轮再次收到。当前测试明确接受这种重复。 |
| persistent encrypted Desktop cache | [`client-sync-replica.ts`](../../packages/desktop/src/sync/client-sync-replica.ts) 只定义 cache port；生产没有持久 adapter，E2E 使用内存 adapter。 |
| offline lease | FT-01 只留下 `AuthorizedStateInvalidator` port；没有 service-signed lease、client verifier、有限 policy 或 room key 锁定。 |
| 新 archive/reopen | T-0040 的 active-only snapshot/catalog 与“archive 失去访问”属于旧合同；新 PRD 要求合法成员归档后只读、reopen、业务 timer freeze，而安全 expiry/revoke 继续。 |
| 所有 worker 的容量闭环 | T-0040 证明 snapshot 路径有界，不代表 runtime、notification、idempotency janitor 或 outbox backlog 已有界。 |

因此，T-0040 是 FT-13 的可靠底座和回归资产，不是 FT-13 已完成或 verified 的证据。

## 3. 核心不变量

1. **Authority 唯一。** SQLite authority 决定身份、权限、事实、stream sequence、idempotency receipt 和 outbox state。cache、staging、preview、socket accepted、alert 与 offline lease 均不能制造业务事实。
2. **连续才前进。** 每个 room replica 只从 `cursor.afterSeq + 1` 应用下一事件。缺口、倒退、同 seq 异 event 或同 eventId 异 seq 都不猜测，终止 delta 并进入 repair。
3. **repair 固定水位。** snapshot 绑定 begin 时的 `watermark = W`，只含不晚于该固定视图的当前 projection；commit 后从 `W` 继续连续 delta。并发事件 `W+1...` 不进入旧 snapshot，也不能丢失。
4. **完整旧 projection 优先。** repair staging 未完成、checksum 错误、权限变化、进程崩溃或 lease 失效时，旧的完整且仍有读取授权的 generation 保持可见；永不展示半个新 generation。
5. **权限降低可抢占。** session revoke、member/Agent remove、capability/grant reduction 可打断 page、complete、subscribe、worker resume 和 Desktop unlock。archive 只冻结业务写/runtime，不冻结这些安全动作。
6. **at-least-once + eventId dedupe。** 发送可重复，应用不可重复。事件与 cursor 的本地写入必须同一 cache transaction。
7. **retry 必须终结。** outbox、repair 和 janitor 都有 batch、timeout、退避、最大尝试或明确人工恢复态；不能永久 spinner 或热循环。
8. **30 天只约束 receipt。** 窗口外不保证保留原 key/hash/ACK；稳定 aggregate ID、CAS 与唯一约束继续保护可识别业务事实。
9. **离线只读。** 离线模式没有 message/project/confirmation/tool command queue，没有 local accepted，也没有自动重放；恢复在线后先鉴权和 sync/repair，再由 Human 显式重试。
10. **两种 lease 不混用。** server-internal `StreamingRepairLease` 保护 fixed snapshot；service-signed `OfflineReadLease` 授权本机在断网时临时解密。二者的主体、期限和撤销路径完全不同。

## 4. Cursor、eventId 与 fixed-watermark 收敛

### 4.1 服务端连续 cursor

保留 `RoomCursor v1`，不创建第二种 cursor。一次 delta query 在同一 authority read transaction 中固定 `head = H`；首个请求把 `watermark=H` 固定在后续页 cursor，之后每页必须保持 H。

服务端判定顺序：

1. 无 cursor → `repair_required/cursor_absent`；
2. room 不同、`afterSeq > head`、cursor watermark 超 head → `invalid_request`；
3. `afterSeq < retainedFromSeq - 1` → `repair_required/cursor_expired`；
4. 在 retained window 内，SQL 必须返回从 `afterSeq+1` 起严格连续的 seq；检测到 authority stream 内洞、重复 seq 或 corrupt event 时返回 `storage_unavailable` 并告警，不能用 repair 掩盖服务端损坏；
5. 页内 `nextCursor` 只前进到实际返回的最后事件；空页只允许 `afterSeq === watermark`。

Compaction 只能在 cutoff 前所有 outbox 已 `dispatched` 或 `dead_letter` 且相应 alert 已耐久记录后推进 `retained_from_seq`。Dead-letter 不阻塞 stream 永久增长；客户端仍可通过 cursor/repair 收敛，运维保留可定位 delivery/event 的告警。

### 4.2 客户端 eventId 去重

加密 cache 内每个 room generation 保存：

- 当前 cursor；
- 当前 authority projection；
- retained epoch 内的 `(eventId, streamSeq)` ledger，`eventId` 与 `(roomId, streamSeq)` 均唯一。

应用一个 batch 的单一事务规则：

- `streamSeq === cursor+1` 且 eventId 未见：reduce projection、写 ledger、推进 cursor；
- exact eventId/seq 已见：no-op；
- `streamSeq <= cursor` 的旧帧只有 ledger 能证明 exact replay 时 no-op；无法证明或映射冲突时进入 repair；
- `streamSeq > cursor+1`、same eventId/different seq、same seq/different eventId：丢弃 batch 并 repair；
- 安装完整 repair generation 后，可原子截断 `seq <= W` 的旧 ledger，并记录 checkpoint W；随后迟到的 `seq <= W` 一律作为 checkpoint 前 stale frame 丢弃，不再改变 projection。

这让 send-before-mark crash、ACK/event 乱序、subscription gate overlap 和进程重启都只有一次可见应用，同时避免永久无界 event ledger。

### 4.3 fixed-watermark repair 与 staging swap

Materialized 和 streaming 必须共用同一 record registry、排序、mapper 和 canonical checksum；差别只在读取/屏障策略：

```text
begin(W, auth revision)
  → stage registry segments in canonical order
  → verify page envelope + full checksum
  → streaming only: snapshot.complete(W, checksum)
  → one local DB transaction flips active_generation = staged_generation
  → sync from W to fixed H
  → subscribe at final cursor
```

本地 generation flip 同时写 projection、cursor W、checkpoint、lease binding 和 active pointer。旧 generation 仅在 flip commit 后异步 GC。crash before flip 保留旧 generation；crash after flip/before GC 使用新 active pointer，旧 generation 只是可回收垃圾。

## 5. 所有批准可见事实的单一 repair 扩展机制

### 5.1 Closed `RepairProjectionRegistry`

FT-13 在现有 snapshot worker 内引入 **server-internal、closed、非插件式** registry；它不是第二套 snapshot，也不是泛型 transport/event bus。每个 descriptor 只描述一个已批准 Room projection segment：

```ts
interface RoomRepairSegmentDescriptor<K extends RoomRepairRecord["kind"]> {
  readonly kind: K;
  readonly order: number;
  readonly stableKey: (record: Extract<RoomRepairRecord, { kind: K }>) => string;
  readKeysetPage(/* worker-owned readonly DB, roomId, afterKey, limit */): readonly unknown[];
  mapRow(row: unknown): Extract<RoomRepairRecord, { kind: K }>;
}
```

- Descriptor 集合在 `SnapshotWorker` 启动时冻结；kind/order 重复、缺 guard、非稳定 key 或 registry 与 closed union 不相等时拒绝启动。
- Materialized build 与 streaming page 都遍历同一 registry；删除当前 `roomRecords()` / `keysetRoomPage()` 的双份枚举。
- feature FT 拥有自己的 record 语义、event 和 mapper 测试；FT-13 拥有 registry API、唯一 assembly、分页/checksum、授权/抢占和跨 kind completeness test。
- 新可见事实若没有 `RoomRepairRecord` variant、guard、descriptor、Desktop reducer、revoke policy 和 clear-cache E2E，不能合入为“已接入产品表面”。
- ephemeral preview、secret、raw recalled body、Provider hidden reasoning、outbox internals、idempotency hash 和 audit-only raw corpus 永不注册为 operational repair record。

### 5.2 Approved visible record inventory

| Projection family | owning FT | repair 要求 | 当前状态 |
| --- | --- | --- | --- |
| Room lifecycle/governance/membership/assignment | FT-02A / FT-07 | archive/reopen generation、当前 membership/role/assignment、只读状态；撤权后不得返回旧 record。 | legacy room/membership 已有；新 governance 待 FT-02A。 |
| Message timeline | FT-03 | active current revision、不可变 revision chain、tombstone、reply/mention/target outcome、Agent correction；operational repair 不含 recalled raw。 | legacy message only。 |
| Attachment visible state | FT-04 | metadata、processing/failed/ready、source、AI-visible extraction status；不内联任意 bytes。 | 未实现。 |
| Memory | FT-05/06 | proposal/confirmed/disputed/superseded、source、memory watermark/context manifest metadata。 | 未实现。 |
| Invocation/runtime | FT-08 | intent/execution/current attempt、accepted/running/retrying/terminal、scoped cancel、source revision。 | 部分 execution/route 已有。 |
| Confirmation/grant/tool outcome | FT-10 | pending/rejected/expired、grant claimed/revoked、dispatch/outcome_unknown/review；不含 secret/token/raw parameter。 | authority 表部分已有，repair 缺失。 |
| Goal/Decision/Request/NextAction/Blocker/Ball | FT-09 | 全部当前 project facts、确认/source、Ball boundary/reminder projection。 | legacy OpenItem/LightTask 已有；Ball/reminder 缺失。 |
| Notifications | FT-12 | recipient-scoped current read/handled projection、source/deep-link safety。 | 未实现。 |

FT-13 首次实现必须把**届时已经合入 authority 且批准为用户可见**的上述记录全部登记。尚未实现的 FT 通过同一 extension checklist 后接入，不为自己创建 `snapshot-v2`、旁路 export 或 client-local truth。

## 6. Outbox 有界交付设计

### 6.1 Durable state

在 actual merged predecessor 后的一次协调 migration 中，把 outbox lifecycle 扩为：

```text
pending → dispatched
pending → pending(next available_at, attempts+1)
pending → dead_letter(attempts=max, dead_lettered_at, last_error_code)
dead_letter → pending  // 仅未来受审计的运维 requeue seam；本 FT 不暴露通用 public command
```

只保存 closed error code、次数和时间；不保存 frame/body/secret 到 alert 文本。建议初始工程 policy（可由容量测试向更保守方向调整，不是产品门禁）：base 250 ms、exponential full jitter、cap 30 s、max 8 attempts、batch 100。配置必须有硬上限，`0`、负数、NaN 或 infinite 均拒绝启动。

### 6.2 Peer 隔离

Dispatcher 为当前进程维护 `(deliveryId, connectionId, credentialGeneration)` accepted ledger：

- 已成功 candidate 在该 delivery 后续 retry 中不再发送；
- failed candidate 按 durable row 的下一次 `available_at` 重试；
- candidate close/re-auth/generation change 使旧 ledger entry失效；
- 进程在 send 后 ledger/mark 前崩溃仍允许重发，这是 at-least-once；max attempts 使重复总是有界；
- 达到 max 后 dead-letter 并告警，失败 peer 下次通过 cursor sync/repair 收敛，不能让成功 peer 无限重复。

不建立永久 per-socket outbox 表；connection 是 ephemeral transport 状态，不是新权威业务事实。

### 6.3 Alert 与恢复

使用窄 `OutboxAlertSink`（结构化日志/metric adapter），不是通用事件总线。至少发出：

- 首次 dead-letter：deliveryId、eventId、targetKind、attempts、age、closed error code；
- backlog oldest age 超过 60 秒 warning、超过 5 分钟 critical；
- dispatcher loop/authority storage error；
- dead-letter count 与 requeue outcome。

alert/diagnostics 禁止 raw payload、Room corpus、token、DB path 或 stack 对外泄漏。FT-14 负责把 sink 接到发布运维和最终阈值审阅；FT-13 必须提供默认本地结构化告警和自动化 test sink，不能因 FT-14 尚未落地而静默。

### 6.4 Crash truth table

| 故障点 | durable 结果 | 恢复 |
| --- | --- | --- |
| domain write 后、commit 前 | domain/event/outbox/idempotency 全回滚 | retry 可重新执行。 |
| commit 后、ACK/outbox 前 | 全部权威事实存在，无伪 ACK | receipt replay、pending outbox、cursor 均可找回同 eventId。 |
| send 前 | row pending | backoff retry。 |
| 一个 peer success、一个 fail | row pending + attempts/backoff；成功 peer ledger | 只 retry 失败 peer；crash 后可有界重复。 |
| send success、mark 前 crash | row pending | 同 eventId 可再发；Desktop dedupe。 |
| max attempt | row dead_letter + alert | 不热循环；peer 以后 sync/repair。 |

## 7. 30 天 idempotency replay

### 7.1 精确语义

- `expiresAt = acceptedAt + 30 × 24h`，比较使用 server clock；`now < expiresAt` 才可 replay。`now === expiresAt` 已过期。
- 同 scope/key、未过期、同 canonical hash：返回原 aggregate/event/result，transport 使用当前 requestId；不同 hash：`409 idempotency_conflict`。
- exact row 已过期：在同一 AuthorityWorker transaction 删除旧 receipt 后按“窗口外新请求”处理；不得 replay 旧 ACK。
- bounded janitor 在启动时及每小时删除 `expires_at <= now`，每 transaction 最多 500 行，若仍有尾部立即让出 worker 后续批次；不得一次长事务饿死业务 command。
- 为 expiry scan 添加必要 index 时，必须进入 actual predecessor 后唯一新 migration；历史 migration 不改写。

### 7.2 过期后的 business-key 规则

30 天 receipt 到期不等于允许复制业务事实：

1. 客户端 timeout/未知 outcome 超过窗口后，必须先 history/sync/query reconcile；不得盲重放旧 command。
2. `messageId`、invocation intent ID、notification source boundary、tool dispatch ID 等稳定业务 ID 继续受唯一约束。找到现有 aggregate 就显示/查询其结果；不是 replay 原 ACK。
3. 要表达一个新的业务意图，客户端生成新的 business ID 和 idempotency key。
4. 没有稳定业务 ID 的可重复命令在 window 外可被当作新 command；因此每个 non-commutative feature command 必须由 owning FT 提供 aggregate ID、CAS revision 或 domain unique boundary。FT-13 不用永久保存 idempotency hash伪造无限 replay 保证。
5. 若旧 key 已清理但旧稳定 business ID 冲突，返回 closed `business_identity_conflict`/对应 domain conflict，并要求 reconcile；不能把 SQLite UNIQUE 文本直接暴露。

## 8. Revoke、archive 与 lease 抢占

### 8.1 服务端执行点

每个 command、history、sync、repair begin/page/complete、subscribe activate、outbox candidate、context/tool claim 和 worker resume 都重验当前 authority。FT-13 负责的 recovery 执行点规则：

| 变化 | sync / subscribe | materialized snapshot | streaming repair | Desktop cache |
| --- | --- | --- | --- | --- |
| session family revoke | 终止该 family 全连接；后续请求 403 | page/complete revalidation失败并 invalid snapshot | 立即 preempt family lease | 在线立即清全部 account Room cache/keys；离线最晚 lease expiry 锁定。 |
| Human member remove | 该 Room 403；principal identity event更新 catalog | 当前 principal 的 snapshot invalid | preempt该 principal/room lease | 在线立即清该 Room active/staging/ledger/lease。 |
| Agent assignment/capability remove | Agent sync/context/runtime claim失败；Human Room read按其 membership保留 | 含 assignment 的新 view失效 | preempt受影响 runtime snapshot/claim | Human cache用新 event/repair去除 Agent 表面。 |
| archive | current Human member仍可 sync/repair只读；业务 writes 409 | archived projection可 materialize | 不再以 `room_archived` 当读取撤权；重开/安全 reduction使 view stale | 保留可读旧 projection，显示 archived，只允许在线/离线 read。 |
| reopen | 从 stable event/delta更新；新业务 write按 FT-02 gate恢复 | 旧 archived snapshot可由 delta/re-repair收敛 | fixed view后事件从 W+1应用 | cache仍非权威；不能本地改 active。 |

Materialized cache 即便已建好，也必须在每一页及 commit 前 revalidate session family、membership access revision、Room lifecycle generation。抢占后 snapshot manifest invalid；旧固定页不能继续泄漏。

### 8.2 与 FT-02A / FT-10 的串行 seam

- FT-02A archive transaction 负责 freeze business timers、拒绝 pending confirmation、撤销 undispatched grant 与 event/outbox；FT-13 只保证这些 current projections 可 repair、outbox有界、cache原子收敛。
- FT-10 决定 dispatched/outcome_unknown 的业务状态；FT-13 不撤销外部 side effect，也不自动重试 unknown outcome。
- session revoke 在 archived Room 外独立执行；archive 不延长 session、confirmation、grant 或 offline lease 的绝对 expiry。

## 9. Desktop 加密 cache 与 offline read-only

### 9.1 物理边界

新增的 production cache adapter 位于 Electron main process；renderer 只通过 closed read projection/状态 API 访问，不能取得 DB path、data key、ciphertext、raw IPC、fs 或 WebSocket capability。

建议 derived cache schema 独立版本化，至少包含：active generation pointers、encrypted catalog/Room records、staging pages、room cursors/checkpoints、event ledger、signed lease envelope 和 GC queue。每条 corpus-bearing value 在写 SQLite 前以 AES-256-GCM 加密：随机唯一 nonce；AAD 绑定 tenant/account/room/generation/record kind/stable key。data key 由 OS `safeStorage` 包装；磁盘、WAL、journal、temporary staging 都只能出现 ciphertext 和非敏感结构元数据。

cache corruption、未知 schema、GCM tag/AAD 错误、unsafe storage backend、key unwrap失败均 fail closed：不显示部分内容，不回退 plaintext/localStorage；保留可清理诊断分类，不记录 corpus。

### 9.2 原子 generation

- `beginRoom/beginCatalog` 创建 staging generation；旧 active generation不动。
- 所有 page、record guard、canonical checksum、fixed watermark、签名 lease binding通过后，在一个本地 SQLite transaction flip active pointer。
- 新 generation 只有 flip commit 后可见；旧 generation随后 GC。进程在 flip 任一侧崩溃都有唯一可解释 active generation。
- user clear-cache 删除 active/staging/ledger/wrapped key/lease；之后只能在线 bootstrap/repair恢复。

### 9.3 Offline policy

| 状态 | 可读 | 可写 / 确认 / tool command | 恢复规则 |
| --- | --- | --- | --- |
| online authenticated + synced | authority projection可读 | 仅发在线 command并等待 ACK/event | 正常。 |
| network lost + lease valid + complete cache | 最后完整旧 projection，只读且明确“离线，数据截至…” | 全部拒绝；不进入 outbox，不显示 accepted，不自动 replay | 重连先鉴权→revoke/catalog check→sync/repair。 |
| repair 中 | 旧完整 projection若授权仍有效可读；新 staging不可见 | 拒绝 offline writes；在线业务按钮由 FT-11按 repair状态控制 | 成功 flip后切换。 |
| lease expired / bad signature | 锁定，正文不可解密 | 全部拒绝 | 必须联网重新认证并取得新 lease。 |
| logout | 立即锁定、zeroize内存 key、清 credential；允许保留不可在未认证状态解密的 ciphertext | 全部拒绝 | 新 login + server auth + lease 后才可 unwrap。 |
| session revoke terminal | 清 credential，并立即物理清除该 account cache/key/lease | 全部拒绝 | 新 session全量恢复。 |
| Room membership revoke | 立即清除该 Room active/staging/ledger/lease slice | 全部拒绝 | 再次合法加入后全量 repair。 |

本地 draft 可作为非权威 UI 暂态单独存在，但不得显示“已发送”、进入 authority cache、自动提交或携带旧 confirmation/grant；是否保留 draft 由 FT-11 设计，不属于 FT-13 事实。

## 10. Service-signed finite offline read lease seam

### 10.1 Closed claims

`OfflineReadLease v1` 使用 service 非对称签名（建议 Ed25519）并由 Desktop pin/rotate public verification key。claims 至少包含：

```ts
type OfflineReadLeaseClaims = {
  version: 1;
  keyId: string;
  tenantId: string;
  accountId: string;
  actorId: string;
  sessionFamilyId: string;
  deviceId: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  rooms: readonly {
    roomId: string;
    accessRevision: number;
    lifecycleGeneration: number;
  }[];
};
```

签名覆盖 canonical claims bytes。lease 只授权“在该设备、该 family、该 Room revision 下解密最后完整 cache”，不授权 server query、command、membership、tool grant 或数据新鲜性。

### 10.2 签发与验证

- 只在在线 authenticated bootstrap/repair 成功、当前 membership重验后签发；client不能自报更长 expiry或新增 room。
- `expiresAt <= min(issuedAt + configured maxOfflineReadLease, session-family refresh horizon, any stricter server policy)`。
- `maxOfflineReadLease` 必须存在、有限且 `>0`。FT-13 提供配置/schema/拒绝路径；FT-14 在发布前冻结默认值与允许上限。不得提供 unlimited/never/client override。
- Desktop 每次 unlock 和周期边界都验证 signature、keyId、tenant/account/actor/family/device、clock interval、room accessRevision/lifecycleGeneration 与 cache metadata；任一不符锁定。
- online reconnect 在展示任何旧 Room 内容前先认证、拉 catalog/revoke changes。已撤权则 purge；仍有权才 sync/repair并换发 lease。
- signing private key 只在 server secret provider；事件、日志、cache、renderer和诊断包不出现。public key rotation使用有界 overlap；过期 key不能无限延长既有 lease。具体 rotation/runbook 属于 FT-14。

## 11. UI / 交互设计映射

| Requirement / journey | 可见状态 | 权威来源 |
| --- | --- | --- |
| J-01 / `REQ-UX-006` | starting、auth restore、catalog loading、empty、offline locked、offline read-only、revoked、fatal | local transient + auth ACK + signed lease + catalog projection。 |
| J-02 / `REQ-MSG-002`、`REQ-NFR-007` | sending、accepted、retryable/nonretryable、offline disabled、duplicate-free timeline | local transient；durable ACK；stable room event；repair projection。 |
| J-07 / `REQ-NFR-003`～`004` | reconnecting、syncing、repairing、repair failed/retry、old complete view、atomic new view | cursor response、snapshot pages/completion ACK、local generation commit。 |
| `REQ-ID-005` / `REQ-NFR-008` | Room removed、session revoked、lease expired、cache cleared | stable identity event / terminal event / verified local clock / purge completion。 |
| J-07 archive/reopen | archived read-only、reopening、active | stable governance event / projection；绝不由本地 toggle。 |

适用失败分支：401 回到 auth且不闪旧内容；403 purge/lock对应 scope；409 snapshot stale自动有界重启，domain conflict交给用户；410 snapshot expired重开repair；429按服务端 hint有界重试；503保留旧完整视图并给明确 retry；offline只读；corrupt cache/fatal fail closed。

键盘、焦点、非颜色识别、可访问通告、缩放和 reduced motion遵循设计基线：repair/revoke状态以文本和结构表达，焦点移到错误摘要/重试动作；`aria-live`只通告阶段/终态，不逐页、逐 event轰炸；原子 swap不做强制大幅动效。FT-13提供状态合同和 headless测试，FT-11/16负责最终 renderer实现与视觉验收。

**与设计稿偏离：无。** 设计稿中的演示按钮和假数据若没有本文所列 ACK/event/projection 支撑，仍为 `prototype-only`。

## 12. 可观测性、容量与安全

- 指标只记录 stable ID hash/closed kind/count/bytes/latency/attempt/age/error code，不记录消息、附件、prompt、token、lease签名或 key。
- snapshot：build/fallback/page/checksum/stale/preempt/commit/GC；outbox：pending age/attempt/dead-letter/dispatch latency；idempotency：replay/conflict/expired/cleanup batch；cache：cipher bytes/generation/lock/purge/corrupt；sync：cursor gap/repair reason/dedupe。
- capacity policy 通过测试校准，不改变 PRD 产品边界。任何 threshold 失败必须有限退出、fallback、backoff、dead-letter或明确 alert；不能 OOM、热循环、永久写屏障或半 projection。
- secret/corpus sentinel 覆盖 server logs/errors/alerts/diagnostics，以及 Desktop cache DB、WAL/SHM、temp、staging、renderer state 和捕获日志。只有显式 owner Room export可含 corpus；它不走 FT-13 diagnostics。

## 13. 架构决策摘要

| 决策 | 采用 | 拒绝 |
| --- | --- | --- |
| Authority | 现有 worker-owned SQLite | 新 DB、renderer truth、第二 writer。 |
| Recovery | 一个 registry驱动的现有 snapshot engine + cursor delta | 每 FT 私建 snapshot/export。 |
| Delivery | transactional outbox + bounded retry/dead-letter + eventId dedupe | physical exactly-once、无限热重试、generic bus。 |
| Offline | encrypted complete cache + finite signed read lease | 离线写队列、无限租约、plaintext/localStorage。 |
| Future records | owning FT定义 closed record，FT-13 assembly强制 completeness | runtime反射插件、跨 FT 环依赖、prototype-only success。 |

达到本文合同只表示 FT-13 可以进入切片实施；所有自动化、集成、故障与安全证据完成前，不能声称 FT-13 delivered 或 verified。
