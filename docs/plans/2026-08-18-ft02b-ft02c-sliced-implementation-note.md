# FT-02B / FT-02C Room Governance 分片实施说明

> 日期：2026-08-18
> 状态：owner 批准的分片与依赖编排说明；本文件不实现生产代码、不修改任务状态，也不声明完整 FT-02、M2 或任务 verified。
> 已交付基础：FT-02A，main squash-merge commit `fb37f7aca58665b5aad0aeda80fa3a685d45e74b`。
> 产品与设计权威：[批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)、[FT-02 工程设计](./2026-08-18-ft02-room-governance-design.md)、[设计基线](../design/README.md)。

## 1. 分片决定与不变量

FT-02A 保持已合入状态，不回退。后续工作不再等待完整 FT-07、FT-09、FT-10 或 FT-13 作为单一串行前置，也不得在当前 FT-02 分支复制这些 feature 的 SQL、状态机、runtime 或 cache authority。

- **FT-02B — departure governance**：只实现 Human self-leave、受权限约束的 Human remove、闭合责任冲突投影，以及同一 AuthorityWorker transaction 内的 final recheck。
- **FT-02C — lifecycle settlement and Desktop**：实现 archive/reopen 的 Room lifecycle coordinator，并只消费已注册的 server-private participants；同时实现对应 Desktop 治理、归档只读与恢复状态。
- participant 未注册，或 deployment manifest 标记 feature 已启用但实现缺失时，命令返回 503 `dependency_unavailable` 且零写；空数组、no-op callback、成功占位 ACK 或 post-commit 补偿均不是合法实现。
- production participant 合入前，`room.archive` / `room.reopen` 继续保持 503；不得恢复旧 permissive archive 路径。
- AuthorityWorker 仍是唯一 writer；renderer、WebSocket、participant、runtime、timer、repair worker 和 cache 都不能建立第二权威写路径。

## 2. 前置 commit 与 closed contract

执行者必须在各分片开始时从实际合并队列记录完整 commit SHA；`TBD` 是阻止启用生产路径的占位符，不得写入交付结论。

| 标识 | 当前/所需 commit | 必须提供的合同 | 启用规则 |
| --- | --- | --- | --- |
| `FT02A_BASE` | `fb37f7aca58665b5aad0aeda80fa3a685d45e74b` | v13 canonical owner、governance revision、ownership transfer、role matrix、基础 governance event/repair projection | 已满足，不回退或重写 v13。 |
| `SHARED_CONTRACT_SPINE` | `TBD`，执行时记录实际 merged SHA | server-private branded `AuthorityTransactionView`；exact-key `ParticipantRegistration`；feature enablement manifest；closed `DepartureConflict`/`DepartureConflictList`；下列八个 archive participant interface；统一 503/409 safe error envelope | FT-02B 与 FT-02C 都必须先通过 compile/type/registration contract tests；spine 不含 SQL、业务 reducer 或空实现。 |
| `FT09A_DEPARTURE_PORT` | `TBD`，执行时记录实际 merged SHA | transaction-local aggregate `DepartureResponsibilityPort.listInTransaction(tx, { roomId, targetHumanActorId })`；汇总已启用的 Request、NextAction、Blocker/OpenQuestion、pending acceptance/verification contributors；稳定 conflict ID、revision、safe summary、allowed resolutions | **FT-02B 唯一直接 feature 前置**。aggregate port 未注册、内部 enabled contributor缺失或输出非法时 503；不等待完整 FT-09。 |
| `FT10_PENDING_CONFIRMATION_CONTRIBUTOR` | 条件性 `TBD`；FT-10 capability enabled时记录实际 merged SHA | server-private `PendingConfirmationDepartureContributor`，只读同 transaction 内当前 principal 的 pending confirmation；由 FT-09A aggregate port汇总 | FT-10 capability未启用时不伪装空实现；已启用但 contributor 未注册时 FT-02B 返回503/零写；FT-02B不直接读取FT-10 persistence。 |
| `FT02C_DEPENDENCY_SET` | 每个 dependency 分别记录 merged SHA | §4 八个 server-private lifecycle dependency；transaction participant、repair descriptor、cache/lease port分别使用其 owning registry/composition contract | FT-02C 可按依赖独立集成和测试，但 archive/reopen 只有在本次 command所需集合全部 ready时才开放；不等待其所属完整FT，也不创建统一泛型插件registry。 |

### 2.1 Shared spine 的最小合同

Shared spine 的独占文件固定为 `packages/server/src/room-governance/private-participant-contracts.ts`、`private-participant-contracts.type-test.ts`、`private-participant-registry.ts` 与 `private-participant-registry.test.ts`。这些文件只容纳 closed interface、brand、registration/manifest validation 和测试，不容纳任何 feature SQL、状态机、默认 participant 或 production composition。FT-02B 独占的 coordinator 不得重新声明这些类型。

```ts
interface DepartureResponsibilityPort {
  listInTransaction(
    tx: AuthorityTransactionView,
    input: { readonly roomId: string; readonly targetHumanActorId: string },
  ): readonly DepartureConflict[];
}

interface ParticipantRegistration<TParticipant> {
  readonly registrationId: string;
  readonly version: 1;
  readonly feature: string;
  readonly enabled: boolean;
  readonly participant?: TParticipant;
}
```

`DepartureResponsibilityPort` 是 FT-02B 唯一直接调用面；FT-09A 负责把自身 domain contributors 与 FT-10 `PendingConfirmationDepartureContributor` 聚合到这个端口。Registry validation必须在 composition/startup 与每个 command transaction 中再次验证：`enabled === true` 且 contributor/participant 缺失、版本不匹配、重复 registration ID、或返回 malformed/cross-Room summary，均为 503 并零写。`enabled === false` 只表示该 feature 没有进入本 deployment，不得由 FT-02 自行注册返回空结果的替身。

## 3. FT-02B 精确文件所有权

### 3.1 FT-02B 独占实现面

| 文件/区域 | FT-02B 所有权 | 禁止事项 |
| --- | --- | --- |
| `packages/server/src/room-governance/departure-governance.ts`（新增） | contributor registry 聚合、closed conflict canonicalization、同 transaction 两次 collect、leave/remove coordinator | 不读取 FT-09 表；不执行责任 complete/transfer/escalate/reject；不接受 transaction 外 snapshot。 |
| `packages/server/src/room-governance/departure-governance.test.ts`（新增） | contributor 503、closed list、final recheck、权限/CAS/idempotency/race 的主测试 | 不用空 contributor 证明成功路径。成功测试必须注册真实 contract fixture 或 FT-09A contributor。 |
| `packages/server/src/persistence/room-governance-foundation.test.ts` | 把 FT-02A 的 leave/remove 503 基线扩展为 FT-02B 可启用行为与禁用时 fail-closed 回归 | 不弱化 owner transfer、peer-admin、零写断言。 |

### 3.2 共享集成窗口

以下文件不是 FT-02B 永久独占；合并窗口由 shared spine/AuthorityWorker/protocol owner 串行管理。FT-02B 只修改列出的 command/query family。

| 文件 | FT-02B 可修改范围 |
| --- | --- |
| `packages/core/src/index.ts`、`packages/core/src/sync.ts` 及 type/guard tests | 仅补齐 departure conflict/list exact-key guard 和 membership-left/removed projection；不加入 FT-09 状态机。 |
| `packages/server/src/persistence/contracts.ts` | `room.member.leave`、`room.member.remove`、`room.departure.conflicts` 的 closed DTO/error/result；不定义 contributor SQL。 |
| `packages/server/src/persistence/worker-protocol.ts`、`worker-database-client.ts` | transaction-host registration/query/command envelope；不暴露 branded transaction capability。 |
| `packages/server/src/persistence/authority-database-handler.ts` | 仅 leave/remove transaction orchestration：reauth → role/CAS → collect → final collect → membership mutation → audit/event/outbox/idempotency。 |
| `packages/server/src/persistence/sqlite-authoritative-store.ts` | 只暴露 public store 的 departure query/commands；不直接写 DB。 |
| `packages/server/src/protocol.ts`、`websocket.ts` | closed preflight/leave/remove frame、409 `departure_blocked` 与 503 mapping；客户端不得提交 actor/role/conflict-as-grant。 |
| `packages/server/src/persistence/snapshot-worker.ts`、`packages/core/src/sync.ts` | 只在 membership change 已提交后投影 access reduction；不把 preflight conflict list持久化为权威 current state。 |

### 3.3 FT-02B 明确不拥有

- FT-09 的 Request/NextAction/Blocker/OpenQuestion/acceptance SQL、reducer、transition、audit 或 repair descriptor；
- FT-10 confirmation/grant SQL；若 shared registry 标记该 contributor 已启用而未注册，leave/remove 必须 503；
- Desktop archive/reopen、timer、runtime、cache、offline lease；这些属于 FT-02C 或其 participants。

## 4. FT-02C server-private participants 与文件所有权

FT-02C coordinator 只编排以下 participant，不反向 import其 persistence internals：

| Participant | 提供方拥有的事实/文件 | FT-02C 只消费的 closed 结果 | 缺失行为 |
| --- | --- | --- | --- |
| `ArchivedMessageGate` | FT-03 的 message/intents mutation gate | 本 transaction 已阻断新 business write 的 generation/revision proof | 503；不得只改 `rooms.status`。 |
| `BusinessTimerSuspensionParticipant` | 各 owning FT 的 due/review/boundary storage 与 freeze/resume SQL | frozen/resumed count、timer descriptor IDs、generation | 503；FT-02 不建各 feature timer SQL。 |
| `ArchiveSettlementParticipant` registration slot | FT-10 已冻结的 `ArchiveToolSafetyParticipant.settleUndispatched` provider | rejected/revoked/fenced counts 与 dispatched-preserved count | 503；不得调用 adapter或把 dispatched 写 revoked；不得创建第二套 tool settlement合同。 |
| `RuntimeArchiveFenceParticipant` | FT-08 route/invocation/steward recovery与claim gate | fenced queued/waiting count、preserved dispatched/outcome-review count | 503；不得用内存 pause flag。 |
| `AssignmentSecurityReductionParticipant` | FT-07 Room Assignment/capability reduction authority | archived-safe reduction policy/version；零业务 wake-up proof | 503；FT-02 不复制 assignment reducer。 |
| `LifecycleRepairDescriptor` | FT-02C拥有 lifecycle record语义与 mapper，并实现 FT-13 `RoomRepairSegmentDescriptor`；FT-13只拥有中央 registry/assembly/checksum | governance/lifecycle/frozen summary mapper、sort key、guard/version | 503；不得由 FT-02 建第二 repair registry，也不得由 FT-13复制 lifecycle语义。 |
| `RoomCacheInvalidationPort` | FT-13 Desktop/main-process cache authority | transaction内写 durable access-reduction invalidation intent；commit后才产生可重放 purge result，不含 cache key/secret | 503 for access-reducing command；不得让 renderer直接删权威 cache。 |
| `OfflineLeaseInvalidationPort` | FT-13/14 server-signed lease authority | lease generation/revocation result与有限 policy proof | 503；不得签发 unlimited/客户端可扩展 lease。 |

### 4.1 提供方独占实现文件

以下是合并队列使用的精确 integration unit。路径尚不存在时由表中提供方创建；FT-02B/FT-02C 只能 import shared contract 与注册实例，不能修改这些实现文件。每个实现测试与生产文件同目录、同 basename 加 `.test.ts`。

| Contract / contributor | 提供方独占生产文件 | 合并责任 |
| --- | --- | --- |
| `DepartureResponsibilityPort` aggregate | `packages/server/src/project-loop/departure-responsibility-port.ts` | FT-09A owner；聚合FT-09 domain contributors与所有enabled外部contributors，只读当前Authority transaction内责任事实。 |
| `PendingConfirmationDepartureContributor` | `packages/server/src/tool-safety/pending-confirmation-departure-contributor.ts` | FT-10 owner；只读 pending confirmation，不接受、拒绝、撤销或settle。 |
| `ArchivedMessageGate` | `packages/server/src/message-authority/archived-message-gate.ts` | FT-03 owner；拥有 message/intent mutation gate，不拥有 Room lifecycle。 |
| `BusinessTimerSuspensionParticipant` | `packages/server/src/business-timers/business-timer-suspension-participant.ts` | shared timer integration owner；聚合 feature-owned timer descriptors，各 feature 仍独占自己的 timer SQL/reducer。 |
| `ArchiveSettlementParticipant` registration | `packages/server/src/tool-safety/archive-tool-safety-participant.ts` | FT-10 owner；精确实现已发布设计的 `ArchiveToolSafetyParticipant.settleUndispatched`，再注册到 shared slot；不另建状态机。 |
| `RuntimeArchiveFenceParticipant` | `packages/server/src/agent-runtime/runtime-archive-fence-participant.ts` | FT-08 owner；内部可协调 route/runtime authority，但 FT-02 只见一个 closed participant。 |
| `AssignmentSecurityReductionParticipant` | `packages/server/src/room-assignment/assignment-security-reduction-participant.ts` | FT-07 owner；拥有 Assignment/capability reduction reducer。 |
| `LifecycleRepairDescriptor` | `packages/server/src/room-governance/lifecycle-repair-descriptor.ts` | FT-02C owner；拥有 lifecycle record语义、guard、mapper与descriptor tests，并实现FT-13 `RoomRepairSegmentDescriptor`合同；FT-13只拥有中央assembly/parity/checksum。 |
| `RoomCacheInvalidationPort` | `packages/server/src/access/room-cache-invalidation-port.ts` | FT-13 cache authority owner；只提交 transaction-bound invalidation intent，不在 transaction 内执行外部 purge。 |
| `OfflineLeaseInvalidationPort` | `packages/server/src/access/offline-lease-invalidation-port.ts` | FT-13/14 lease authority owner；拥有 generation/revocation policy。 |

Production composition 的唯一共享入口是 `packages/server/src/authoritative-server.ts`；该文件由 integration owner 在串行窗口接线。FT-02C 不创建 fallback registry。Authority transaction host 的唯一共享入口仍是 `packages/server/src/persistence/authority-database-handler.ts`，participant 若需 durable 写入必须使用传入的 branded transaction capability，不能开启嵌套 connection 或 post-commit 数据补偿。

FT-02C 独占新增 `packages/server/src/room-governance/archive-coordinator.ts` 与对应测试；它只拥有 Room lifecycle CAS、participant 顺序、FT-02 governance audit/event/outbox/idempotency envelope。`rooms` v13 lifecycle columns已存在，不预占下一 schema version。participant 需要的 schema/migration 由各提供方所有，并由中央 migration owner 串行合入。

共享集成文件与范围：

- `packages/server/src/persistence/authority-database-handler.ts`：archive/reopen coordinator 的单 transaction host；
- `packages/server/src/authoritative-server.ts`：真实 participant registration，禁止 production fake/default no-op；
- `packages/server/src/protocol.ts`、`websocket.ts`：archive/reopen ACK、already-state、closed settlement summary 与 503；
- `packages/core/src/sync.ts`：FT-02C拥有 lifecycle closed record/guard；`packages/server/src/persistence/snapshot-worker.ts`、`packages/desktop/src/sync/client-sync-replica.ts`：由FT-13中央 registry/replica owner串行组装和消费已注册的 `LifecycleRepairDescriptor`；
- `packages/desktop/src/renderer/app.ts`、`app.test.ts`、`styles.css`：FT-02C 在单一合并窗口拥有 Governance/Departure/Archived UI 分区；不建立 renderer authority 或 raw participant API。

## 5. TDD 顺序

### 5.1 FT-02B

1. **B0 — contract spine RED/GREEN**：type tests 拒绝公开/可序列化 transaction capability、重复 registration、extra keys、cross-Room conflict、空/重复 resolution；registry 对 enabled-but-missing 返回 503。
2. **B1 — read-only preflight**：`room.departure.conflicts` 只对当前有权 Human 开放；稳定 conflict ID/revision、safe summary、同 Room source ref；query 不产生 audit/event/outbox/idempotency写入。
3. **B2 — final recheck transaction**：先 collect、紧邻 membership mutation 再 collect；任一非空返回最新 409 list 且 membership/audit/event/outbox/idempotency 全零写。
4. **B3 — Human leave/remove matrix**：self-leave；owner prior transfer；owner 对 admin/member；admin 仅 member；peer admin/owner 403；Agent removal不在本分片成功路径。
5. **B4 — CAS/idempotency/restart**：stale governance revision 409；exact replay稳定；changed payload冲突；worker restart后同 ACK；两个合法并发 remove只有一个线性化结果。
6. **B5 — access reduction integration**：成功 commit 后沿 FT-02A 已有 membership projection、stable event、outbox 与 repair 路径使当前 session/subscription 失权，并验证失败事务零副作用。`RoomCacheInvalidationPort` 与 `OfflineLeaseInvalidationPort` 属于 FT-02C archive/reopen settlement，不作为 FT-02B 启动或完成前置；FT-02B 不得因此宣称离线 cache/lease settlement 已完成。
7. **B6 — protocol/process proof**：strict WS 401/403/404/409/503、无 caller actor/role；crash-before-commit零写、commit-before-ACK重放稳定 event ID。

### 5.2 FT-02C

1. **C0 — 八 dependency registration/assembly matrix**：transaction participants在shared spine registry，`LifecycleRepairDescriptor`在FT-13中央repair registry，cache/lease ports在各自composition gate；分别制造 absent/disabled/enabled-missing/version mismatch/duplicate/throw/malformed/cross-Room RED，并在§4.1对应provider test证明真实装配。只有完整且合法的本command dependency set进入lifecycle CAS；不得用一个泛型registry替代三类closed owner边界。
2. **C1 — archive transaction**：固定顺序为 lifecycle CAS → message gate → timer suspension → tool settlement → runtime fence → assignment security policy → lifecycle repair descriptor → cache/lease invalidation intent → audit/event/outbox/idempotency；任一点失败整笔回滚。cache/lease participant 在 transaction 内只写 durable invalidation intent；外部 cache purge由 commit后投递执行，失败可重放但不能撤销已提交的 lifecycle事实。
3. **C2 — archived allow/deny matrix**：history/fact/audit只读允许当前 Human；message/project/memory/new invocation/assignment expansion 409且零 work；session revoke、member/Agent removal、capability/grant reduction仍可执行但零业务 wake-up。
4. **C3 — reopen/timer continuity**：只恢复 participant确认仍合法的业务 timer；按剩余时长顺延；不复活 expired/rejected/revoked/done/outcome-review；after-commit bounded rescan。
5. **C4 — lifecycle CAS/idempotency**：concurrent archive/reopen、fresh repeat `already_archived`/`already_active`、exact replay、changed payload、generation monotonic、重启稳定。
6. **C5 — repair/cache/lease**：archived materialized/streaming repair等价；archive/remove preempt barrier；cache atomic commit/purge；lease issuance/revocation race；participant缺失始终503。
7. **C6 — runtime/tool/timer races**：claim/dispatch、timer claim、route resume与archive线性化；adapter调用次数在未 dispatch拒绝路径为0；已 dispatch只保留真实状态。
8. **C7 — Desktop**：permission matrix、conflict sheet、archive确认、persistent read-only banner、reopen、requestId loading、ACK+event/projection后成功、401/403/409/410/429/503/offline/repair/retry、focus/keyboard/non-colour/`aria-live`/reduced motion。
9. **C8 — real process crash/restart**：每个 durable boundary、三客户端、归档重启不唤醒业务、reopen只恢复仍合法 timer、重复 outbox单次 replica apply。

## 6. 必测并发 race

### 6.1 FT-02B race matrix

| Race | 线性化要求 | 零写/结果 |
| --- | --- | --- |
| preflight empty vs 新 responsibility commit | final recheck看到新 revision并阻止 remove | 409最新 conflict list；membership/audit/event/outbox/idempotency零写。 |
| ownership transfer vs owner leave | 按 governance revision只有一个先成功 | 未 transfer 的 owner leave 409；transfer 后旧 owner按责任 gate处理。 |
| 两个 distinct-key remove同一 Human | 一个 membership mutation成功，另一个404/409安全终态 | 不重复 identity event/cache invalidation。 |
| admin remove member vs owner promote target admin | CAS/transaction顺序决定；admin不得在目标成为admin后继续remove | stale 409或 role_forbidden，绝不移除 peer admin。 |
| session revoke vs leave/remove | transaction内 reauth；revoked caller不能提交治理结果 | 401/403，零 membership写。 |
| contributor enablement/registration mismatch | startup与command内都检查一致 manifest | 503，不能解释为空冲突。 |
| ACK丢失/worker restart vs exact replay | idempotency receipt返回同一 ACK/event IDs | 不重复 membership/audit/outbox。 |

### 6.2 FT-02C race matrix

| Race | 线性化要求 | 必要证据 |
| --- | --- | --- |
| message/intent commit vs archive | `ArchivedMessageGate` 与 lifecycle CAS同 transaction serialization | archive后无新business fact/event/outbox；先提交的历史事实可读但不触发新work。 |
| timer claim/fire vs archive | timer participant在同 connection冻结或承认已claim边界 | 不重复fire；remaining duration非负且generation绑定。 |
| confirmation/grant claim/dispatch vs archive | settlement与claim CAS线性化 | unclaimed拒绝/撤销且adapter 0次；claimed/dispatched不伪称revoked。 |
| runtime route/resume/recovery vs archive | runtime participant recheck generation | archived restart不requeue；旧generation结果不能提交新business mutation。 |
| assignment expand/reduce vs archive | expansion需active；security reduction独立允许 | expansion 409；reduction审计且零runtime wake-up。 |
| streaming repair vs archive/remove | access/lifecycle事件preempt barrier | fixed-view后续页stale/forbidden；无归档前active UI泄漏。 |
| lease issue/read vs archive/remove | lease generation与access revision共同CAS | removed principal拿不到新lease；非法/缺policy 503；客户端不能延长。 |
| archive vs reopen / 双archive / 双reopen | governance revision + lifecycle generation CAS | 一个transition；其余stale或already-state；单audit/event/outbox。 |
| participant failure/crash at任一步 | 整个AuthorityWorker transaction回滚 | Room status、timer、settlement、runtime fence、audit/event/outbox/idempotency全零或全有。 |
| lifecycle outbox重复 vs replica/cache apply | stable eventId + generation dedupe | Desktop只应用一次；不重复banner、purge或timer恢复。 |

## 7. 退出条件

### 7.1 FT-02B 达到交付证据

- shared spine 与 FT-09A departure contributor 的实际 merged commit SHA 已记录；不存在 empty/no-op contributor；
- Human leave/remove 权限矩阵、责任 preflight + final recheck、CAS、幂等、restart、crash、WS 与 access reduction tests 全绿；
- contributor enabled-but-missing、throw、malformed、cross-Room 均503且副作用0；
- 没有 FT-09/10 SQL或状态机复制进 FT-02；Agent remove、archive/reopen仍按各自未启用合同失败关闭；
- 交付说明只声明 FT-02B，不声明完整 FT-02、M2 或任务 verified。

### 7.2 FT-02C 达到交付证据

- 八个 participant 的实际 merged commit、registration ID/version、feature enablement 与责任 owner 全部记录；生产 composition无fake/no-op；
- archive/reopen transaction、timer连续性、confirmation/runtime/cache/lease settlement、archived读写矩阵、repair与Desktop全部测试通过；
- 所有 race 都证明单 writer、CAS、幂等、event/outbox原子与adapter副作用边界；
- participant缺失路径仍503，且未复制相邻FT的SQL/reducer/cache authority；
- 精确全量测试/文件数、migration predecessor/version、checksum/fingerprint和Git证据写入交付说明；
- 只可声明 FT-02C 达到交付证据。完整 FT-02、M2 与任务 verified 仍由owner另行验收。

## 8. 当前生产行为

在 FT-02B/FT-02C 对应 prerequisite commit 与 production registration 合入前：

- 保留 FT-02A 的 owner/role/transfer/CAS/governance projection；
- Human leave/remove按当前未满足依赖返回闭合错误，不恢复旧 permissive路径；
- archive/reopen继续返回503 `dependency_unavailable`；
- 不通过文档、UI或空participant把未生效能力显示为成功。
