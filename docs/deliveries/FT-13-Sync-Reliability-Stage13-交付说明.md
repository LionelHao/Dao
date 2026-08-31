# FT-13 Sync & Reliability · Stage 13 交付说明

> 状态：实现候选已收口；内容 PR、required CI、远程合并与 evidence PR 尚未发生，本文用
> `PENDING` 明确标识待回填事实。本文只记录可复核证据，不把 Agent 自测、CI 或审阅等同于
> owner 验收，不标记 verified。

## 1. 一句话结果

FT-13 已在当前内容分支上把单一 AuthorityWorker/SQLite writer、封闭 repair registry、连续
cursor/fixed-watermark repair、Desktop main-process AES-256-GCM generation cache、服务端签名的有限
offline read lease、30 天 command receipt 和有界 at-least-once outbox 收敛为同一生产候选链路；
最终测试计数、独立 reviewer 结论与远程 PR/CI/merge 事实仍待最终门禁及 evidence PR
如实回填。

## 2. 权威基线与 rebaseline

- 权威顺序为 PRD → protocol/approved feature spec → 正式 UI 设计基线 → 生产代码与测试。
- Stage 13 起点是 `origin/main@e19c1492e52cdf399b440c7dc959a5607c888e32`，Authority schema
  immutable v26，Stage 12 基线为 255 files / 2693 tests，其中 3 个 OpenAI live smoke 安全跳过。
- 旧 FT-13 设计基于 schema v12 附近且前言使用过时的 19 条集合；本阶段以当前批准的
  21 条 direct Requirement 为准，只在 v26 之后追加 immutable v27。
- main 已有 Authority 单 writer、fixed-watermark/snapshot-worker、repair lease、Ed25519 issuer/verifier、
  safeStorage 和 archive security seam；它们不足以证明持久 event ledger、原子 generation flip、生产
  lease composition、全 family TTL/janitor 和有界 outbox terminal lifecycle。
- Stage 13 完成的差额为：33-kind closed registry 及 descriptor 补齐、Desktop 持久双 ledger/
  generation store、服务端签发到 Desktop pinned verifier 的生产连线、v27 receipt/outbox lifecycle，
  以及 PR 级 10k/50k 容量证据。
- 准确差异、旧 seam/缺口和文件 ownership 见
  [`2026-08-31-ft13-stage13-rebaseline.md`](../plans/2026-08-31-ft13-stage13-rebaseline.md)；
  生产机械见
  [`2026-08-31-ft13-sync-reliability-production-addendum.md`](../plans/2026-08-31-ft13-sync-reliability-production-addendum.md)；
  执行账本见
  [`2026-08-31-ft13-stage13-work-note.md`](../plans/2026-08-31-ft13-stage13-work-note.md)。
- 设计偏离：**无**。

## 3. 21 条 direct Requirement 逐条证据

| Requirement | 已收口语义 | 代码证据 | 自动化证据 |
| --- | --- | --- | --- |
| `REQ-AGT-001` | invocation intent/execution/attempt/retry/cancellation 与 assignment 进入同一 repair/cache 记录集，不用 local state 替代 durable handoff | `packages/server/src/persistence/snapshot-worker.ts`；`packages/server/src/agent-settings/room-assignment-repair-descriptor.ts` | `snapshot-worker-client.test.ts`；`room-assignment-repair-descriptor.test.ts`；`authority.e2e.test.ts` |
| `REQ-ID-005` | logout/session-family/account/membership/access reduction 抢占 repair，清理 Room/account cache 并失效 lease；离线授权有限且不可由客户端延长 | `packages/server/src/access/offline-lease-invalidation-port.ts`；`packages/desktop/src/governance/authority-cache.ts` | `offline-lease-invalidation-port.test.ts`；`authority-cache.test.ts`；`production-runtime.contract.test.ts` |
| `REQ-MEM-001` | memory 与 message/revision/attachment/project facts 都是 Authority projection，可经 fixed-W repair 重建 | `packages/server/src/room-memory/repair-descriptor.ts`；`packages/server/src/persistence/snapshot-worker.ts` | `room-memory/repair-descriptor.test.ts`；`snapshot-worker-client.test.ts` |
| `REQ-MSG-001` | `message.accepted` 仍只表示 domain/event/receipt/outbox 事务已 durable commit；离线不生成 local ACK/queue | `packages/server/src/persistence/authority-worker.ts`；`packages/server/src/authoritative-server.ts` | `authority.e2e.test.ts` 的 commit/ACK fault windows；Desktop offline zero-transport tests |
| `REQ-MSG-002` | history/realtime/sync/repair 同源；eventId 和 `(roomId, seq)` 持久双 ledger 处理重放，冲突/gap/backwards 进 repair | `packages/core/src/sync.ts`；`packages/desktop/src/governance/encrypted-generation-store.ts`；`packages/desktop/src/sync/client-sync-replica.ts` | `sync-ft07.test.ts`；`client-sync-replica.test.ts`；`encrypted-generation-store.test.ts` |
| `REQ-NFR-001` | AuthorityWorker 仍是唯一 SQLite writer；snapshot/stream/cache/lease/accepted-peer ledger 都不是第二 authority | `packages/server/src/persistence/authority-worker.ts`；`packages/server/src/persistence/authority-database-handler.ts` | `worker-database-client.test.ts`；`authority.e2e.test.ts`；`verify:core-boundary` |
| `REQ-NFR-002` | fact/event/outbox/receipt 原子提交；command receipt 30 天且 exact expiry 不绕过 stable business ID | `packages/server/src/persistence/idempotency-lifecycle.ts`；`reliability-inventory.ts`；`authority-worker.ts` | `idempotency-lifecycle.test.ts`；`idempotency-capacity.test.ts`；`authority.e2e.test.ts` |
| `REQ-NFR-003` | outbox 是有界 at-least-once，不宣称物理 exactly-once；send-before-mark 重复由客户端 ledger 吸收 | `packages/server/src/outbox-dispatcher.ts`；`packages/server/src/outbox-retry-policy.ts` | `outbox-dispatcher.test.ts`；`outbox-capacity.test.ts`；`authority.e2e.test.ts` |
| `REQ-NFR-004` | 单一 closed registry、fixed W 和 canonical checksum 保证可重放；旧 complete generation 在新 staging 完整验证前唯一可见 | `packages/server/src/persistence/repair-projection-registry.ts`；`snapshot-worker.ts`；`packages/desktop/src/governance/encrypted-generation-store.ts` | `repair-projection-registry.test.ts`；`snapshot-worker-client.test.ts`；`encrypted-generation-store.test.ts` |
| `REQ-NFR-005` | repair page/janitor/outbox/cache batch、buffer、attempt、timeout 和 shutdown 均有界，失败进 closed terminal/recovery | `snapshot-worker-client.ts`；`idempotency-lifecycle.ts`；`outbox-dispatcher.ts`；`encrypted-generation-store.ts` | 10k repair/cache/outbox、50k receipt capacity suites；dispatcher bounded-shutdown tests |
| `REQ-NFR-007` | 只有 valid signed lease + complete active generation 可离线展示；governance/project/tool/invocation 写操作在 transport 前闭合拒绝 | `packages/desktop/src/governance/production-runtime.ts`；`project-loop/production-runtime.ts`；`tool-safety/production-runtime.ts`；`invocation-runtime/controller.ts` | 四类 Desktop runtime offline/authority tests，验证 `409 room_read_only`/zero transport |
| `REQ-NFR-008` | Ed25519 closed claims 精确绑定 tenant/account/actor/family/device/room/revisions/time/keyId；production 必须显式有限正数 policy | `packages/server/src/access/offline-lease-invalidation-port.ts`；`packages/server/src/authoritative-server.ts`；`packages/desktop/src/governance/offline-read-lease.ts` | `offline-lease-invalidation-port.test.ts`；`authoritative-server-recovery.test.ts`；`offline-read-lease.test.ts` |
| `REQ-NFR-010` | 重复、倒退、串 Room、半 generation 和伪成功 fail closed；repair failed 保留旧完整且仍授权的 projection | `packages/desktop/src/governance/authority-cache.ts`；`encrypted-generation-store.ts`；`renderer/governance/view-model.ts` | cursor conflict/gap、crash-before/during/after flip、Room isolation 与 UI closed-state tests |
| `REQ-NFR-011` | repair page/complete、outbox send/retry、cache reopen 前重验 session/membership/lifecycle/access/credential generation | `packages/server/src/persistence/snapshot-worker-client.ts`；`outbox-dispatcher.ts`；`packages/server/src/sync-service.ts` | multi-page family revoke/refresh/permission tests；accepted-peer revalidation tests |
| `REQ-NFR-014` | archived Room 对仍有资格 Human 保持历史只读；业务 write/runtime/timer/new business notification 冻结，security expiry/revoke 继续 | `packages/server/src/room-governance/`；`agent-runtime/runtime-archive-fence-participant.ts`；`business-timers/` | archive-read repair、runtime fence、timer suspension、tool settlement、reopen 不复活 tests |
| `REQ-PRIM-002` | Human 多设备 session family 可独立撤销，并驱动对应 account/Room cache 锁定或清理 | `packages/server/src/auth.ts`；`packages/desktop/src/identity/controller.ts`；`governance/authority-cache.ts` | auth/session revoke E2E；identity/controller 与 cache purge/reopen tests |
| `REQ-PRIM-006` | 服务端注入作者、durable ACK、稳定 ID/顺序，history/realtime/repair 以同一 authority event 收敛 | `packages/server/src/protocol.ts`；`authoritative-server.ts`；`packages/core/src/sync.ts` | `authority.e2e.test.ts`；`sync-service.test.ts`；`client-sync-replica.test.ts` |
| `REQ-PRJ-004` | Request/OpenItem 等 project facts 以 Authority descriptor/cache 恢复，不从本地 UI 反推状态 | `packages/server/src/project-loop/repair-descriptor.ts`；`packages/desktop/src/project-loop/production-runtime.ts` | project-loop descriptor/parity/runtime restart tests |
| `REQ-PRJ-012` | Ball/due/reminder 仍是服务端权威投影；archive 冻结业务 trigger，repair/reopen 不制造第二份状态 | `packages/server/src/project-loop/`；`business-timers/`；`persistence/snapshot-worker.ts` | project-loop repair、archive/reopen timer、restart boundary tests |
| `REQ-ROOM-004` | archive/reopen lifecycle generation 参与 repair/cache/lease eligibility；归档时可继续降权且不唤醒业务 runtime | `packages/server/src/room-governance/`；`access/offline-lease-invalidation-port.ts` | `archive-read-repair-access.test.ts`；archive/reopen transaction/E2E tests |
| `REQ-UX-006` | 启动区分 loading/session restore/login/catalog/empty/atomic Room restore/offline/revoked/fatal，无权 cache 不先闪现 | `packages/desktop/src/main.ts`；`governance/production-runtime.ts`；`renderer/governance/view-model.ts` | governance runtime/controller/view-model/renderer tests；corrupt/missing/expired lease tests |

## 4. 单一 repair registry 与可见记录清单

`ROOM_REPAIR_KIND_MAP` 与 `ROOM_REPAIR_DESCRIPTORS` 由
`packages/server/src/persistence/snapshot-worker.ts` 组装，并通过
`createGuardedClosedRepairProjectionRegistry` 与 production record guard 启动。注册表与当前
`RoomRepairRecord` closed union 的 **33 个 kind** 一一对应：

1. `room`
2. `governance`
3. `membership`
4. `room-agent-assignment`
5. `message`（deprecated compatibility）
6. `timeline-message`
7. `message-revision`
8. `attachment`
9. `human-read`
10. `agent-judgement`
11. `open-item`
12. `open-item-agent-failure`
13. `light-task`
14. `agent-invocation-intent`
15. `agent-execution`
16. `agent-execution-attempt`
17. `agent-execution-retry`
18. `agent-scoped-cancellation`
19. `project-boundary-invocation`
20. `legacy-agent-execution`
21. `route-job`
22. `route-judgment`
23. `calibration`
24. `legacy-unknown-calibration`
25. `memory`
26. `project-loop`
27. `tool-call`
28. `tool-confirmation`
29. `tool-grant`
30. `tool-dispatch`
31. `tool-review`
32. `tool-handoff`
33. `tool-compensation`

registry 拒绝空/duplicate known kind、missing/unknown/duplicate descriptor、duplicate order/descriptorId、
version 不是 1、stable key 倒退、cross-kind 与 guard 失败。materialized 与 streaming 都遍历这
一个 registry，没有第二套字符串 kind 枚举。transient preview、typing、provider partial stream、
secret、raw recalled body、receipt/outbox internal row 明确不进 operational repair snapshot。

主要证据：`repair-projection-registry.test.ts` 验证 completeness/重复/顺序/guard；
`snapshot-worker-client.test.ts` 验证当前全 record union 的稳定顺序、materialized 文件 cache、
streaming fallback、分页与抢占。

## 5. Cursor、fixed watermark 与 parity

- `RoomCursor { version: 1, roomId, afterSeq }` 以服务端 `streamSeq` 为连续边界。same eventId/
  different seq、same seq/different eventId、gap 和 backwards 全部进 repair，不猜测丢失事件。
- snapshot 使用固定 W；新 event 只从 W+1 delta 进入。page 的 ordering、canonical bytes、checksum、
  completion/snapshotId/mode/watermark 一致后才可 commit。
- streaming 与 materialized 共用 registry/encoder/checksum；streaming 必须再收到匹配
  `snapshot.completed` 才可翻转。
- 每一页与 complete 前都重验 session、membership、archive/lifecycle/access revision 与
  credential generation。Authority stream 物理损坏返回 closed `503 storage_unavailable` 并产生
  结构化安全告警，不伪装成客户端 repair。
- Desktop 在同一 SQLite transaction 内完成 reduce、eventId ledger、room-seq ledger 与 cursor
  推进；exact replay 是 no-op，冲突整批回滚。

协议真实说明与 10,000 mixed-record/三客户端 fixture 分布见
[`authoritative-sync.md`](../protocols/authoritative-sync.md)。该 fixture 证明 finite snapshot 的分页、fallback、
原子切换和三端收敛；它不被写成 10,000 次 production command。

## 6. Desktop encrypted cache 与 atomic generation

| 生产边界 | 实现证据 | 失败/崩溃证据 |
| --- | --- | --- |
| main-process 专属 SQLite store | `packages/desktop/src/governance/encrypted-generation-store.ts`；`packages/desktop/src/main.ts` | preload/renderer 只得 closed projection/status/action，不得 key/path/ciphertext/DB handle |
| AES-256-GCM + wrapped random 256-bit data key | record 独立 nonce，AAD 绑定 schema/account/room/generation/record identity，safeStorage 只包裹 data key | safeStorage unavailable、`basic_text`、unwrap/tag/AAD/schema/checksum 错误 locked/fatal，无明文降级 |
| active/staging 分离 | page 只写 staging，finish 从磁盘解密并重算 count/checksum，在 transaction 内 flip | crash before/during flip 仍见旧 complete；after flip 只见新 complete；损坏 staging 不能 flip |
| 持久 sync state | authority records、per-room cursor、eventId ledger、room-seq ledger、generation metadata、lease、schema/version | restart 后 dedupe/cursor/active head 持续；apply/ledger/cursor 整批原子 |
| 撤权与清理 | membership 只清目标 Room；account/session/logout 锁定或销毁 account store；clear-cache 清 active/staging/cursor/ledger/key/lease/temp | logout best-effort zeroize 内存 key；Room/account 重开均验证不残留授权内容 |
| 容量与泄漏边界 | 10,000-record 真实文件 stage/commit/reopen/checksum suite | disk/WAL/journal/tmp/backup/crash leftovers 扫描 account/Room/event/corpus/key/secret canary 零命中 |

`encrypted-generation-store.test.ts` 覆盖原子 flip、磁盘 staging 重验、旧 generation 保留、无
legacy catalog 重启发现、双 ledger/cursor transaction、lease-generation 绑定、清理与磁盘
sentinel；`encrypted-generation-store.capacity.test.ts` 覆盖 PR 级 10k 记录。

## 7. Offline read lease

- server 复用唯一 Ed25519 issuer/verifier/invalidation port，不并行实现第二套 token。closed
  claims 精确绑定 tenant、account、Human actor、session family、device/installation、server subject、
  room、membership/lifecycle/access/lease generation、issued/notBefore/expiresAt 和 keyId。
- production server 必须显式提供稳定 Ed25519 private key/keyId/tenant/server subject 与有限正数
  `maxOfflineReadLeaseMs`；missing、0、负数、NaN、Infinity 启动失败。没有生产 24h fallback，
  FT-13 不选择 FT-14 release 默认值。
- expiry 不晚于显式 max、session/credential refresh horizon 和更早的授权边界。Desktop 必须
  pinned 匹配的 SPKI public key 和 authority binding；没有 verifier 时只允许在线 repair，离线
  cache 保持 locked。
- lease 只授权有限时间内解密当前 complete active generation，永不进 command authorization。
  `production-runtime.ts` 在 exact expiry 定时器边界主动锁定已显示 Room，不等待下一次查询。
- 离线写在 transport 之前返回 closed `409 room_read_only`，调用数为 0；governance、Project
  Loop、Tool Safety 和 Invocation 的 cache-backed offline 读取都查询同一 process-local
  `isOfflineReadAuthorized(roomId)` capability。
- logout/session/account revoke、membership revoke、clear-cache 失效/删除 lease。archived Room 只对仍有
  资格 Human 开放 lease 内历史只读；archive 不延长 security expiry。

主要证据：`packages/server/src/access/offline-lease-invalidation-port.test.ts`、
`packages/server/src/authoritative-server-recovery.test.ts`、
`packages/desktop/src/governance/offline-read-lease.test.ts`、
`packages/desktop/src/governance/production-runtime.contract.test.ts`，以及 project/tool/invocation runtime 的
unauthorized-offline tests。

## 8. 30 天 idempotency lifecycle 与 janitor

`IDEMPOTENCY_RECEIPT_FAMILIES` 是当前封闭的 9-family inventory：

| Family | 表/分类 | 生命周期 |
| --- | --- | --- |
| `generic-command` | `idempotency_records` | 30-day command |
| `deployment-command` | `deployment_idempotency_records` | 30-day command |
| `room-memory-command` | `room_memory_idempotency` | 30-day command |
| `tool-safety-command` | `tool_safety_command_receipts_v2` | 30-day command |
| `project-command` | `project_command_receipts` | v27 补齐 30-day command |
| `human-cancellation-command` | `invocation_cancellation_receipts` | Human command 30 天，internal producer fact 永久 |
| `human-retry-command` | `invocation_human_retry_receipts` | v27 补齐 30-day command |
| `project-boundary-domain-receipt` | `project_boundary_invocation_receipts` | 永久领域事实，不清理 |
| `read-and-source-facts` | `human_read_receipts` + `context_source_read_receipts` | 永久来源事实，不清理 |

统一语义是 `now < expiresAt` 才命中：相同 canonical payload 返回原结果，同 key 不同
payload 返回 closed 409；`now == expiresAt` 已过期，在同一 AuthorityWorker transaction 删除后按
窗口外新请求处理。稳定业务 ID/unique constraint 仍阻止第二份事实。

janitor 在 AuthorityWorker 打开实际 DB 后启动，之后每小时运行；每 transaction 最多 500
行，每批 yield，直到本轮 expired set 为空。错误只输出 closed family/code/count，不输出
payload、secret 或正文。`idempotency-capacity.test.ts` 用 50,000 mixed receipts 验证
`<=500` 批次、yield 与 reopen 继续清理。

## 9. Outbox retry、dead-letter 与 peer isolation

`AUTHORITATIVE_OUTBOX_FAMILIES` 封闭登记 4 类 durable post-commit ledger，并不伪称它们都有
同一 socket send 机械：

| Family | 分类/消费者 | 交付合同 |
| --- | --- | --- |
| `central` / `outbox_deliveries` | central transport dispatcher | batch ≤100；250ms 基础指数 full jitter；30s cap；8 attempts；dead-letter |
| `room-cache-invalidation` | security post-commit intent dispatcher | 同样的 bounded at-least-once/dead-letter；只清理已提交目标 |
| `project-shadow` | central terminal mirror | 只原子镜像 central delivered/dead-letter 终态，不二次 send/retry |
| `deployment-profile` | authority cursor marker settler | 本地结算 committed marker，客户端 cursor catch-up；不宣称存在的 socket failure seam |

独立 delivery 在 60s/5min backlog 产生 warning/critical，第 8 次失败进 durable
`dead_letter`；alert/log 只含 closed identifier/family/code/age/count。dispatcher 的 process-local accepted ledger
绑定 `(deliveryId, connectionId, credentialGeneration)`：同进程中坏 peer 不使已成功 peer 重收，
每次 retry 前仍重验当前 connection/session/membership/generation。无 eligible local connection 可标记
local dispatch complete，之后由 authority cursor 补齐。

crash 丢失 process ledger 和 send-success-before-mark 可导致有界重复，这是 at-least-once 合同的明示
部分；下游 durable event ledger 保证一次可见 apply。`outbox-capacity.test.ts` 以 10,000
deliveries/10% deterministic failures 证明批次上限和终态；`outbox-dispatcher.test.ts` 证明
peer isolation、revalidation、dead-letter、告警脱敏、无连接、send-before-mark 重放和有界 shutdown。

## 10. Archive/revoke/崩溃抢占矩阵

| 事件 | repair/stream | cache generation/ledger | offline read | business write/runtime/tool/timer | idempotency/outbox/security |
| --- | --- | --- | --- | --- | --- |
| session logout | 终止后续 page/complete/subscription | 锁定 account store，清 lease，best-effort zeroize key | 立即禁止 | 禁止 | receipt 不作授权；security revoke 继续 |
| session family revoke | streaming lease 被抢占，后续页不泄漏 | family/account scope 锁定，旧 credential generation 失效 | 禁止 | 禁止旧 session 操作 | terminal family frame 仍可安全投递 |
| account disable/revoke | query/page/complete fail closed | account cache 清理 | 禁止 | 禁止 | 不删 Authority fact；revoke 优先 |
| Room membership removal | 页与 complete 重验后 403/抢占 | 只清目标 Room active/staging/ledger/lease | 禁止 | 读、写、Agent/tool/project 都禁止 | cache-invalidation intent 有界重试 |
| permission downgrade | old access revision 失效，后续页拒绝 | 授权 capability 失效，按 scope 清理 | 禁止受保护投影 | 依新权限重验 | accepted peer 不越过新 generation |
| Room archive | eligible Human 仍可读历史，repair 绑 lifecycle generation | 保留完整历史，新租约绑 archive generation | lease 内只读 | 冻结业务 write/Agent/steward/timer/new business notification；settle pending tool | security expiry/revoke 不停；archive ACK 幂等 |
| Room reopen | 新 lifecycle generation 重验/catch-up | 使用新 complete generation | 必须新绑定 lease | 只启动新合法工作 | 不复活旧 terminal execution/confirmation/grant/timer/credential |
| offline lease expiry | 不改 Authority fact | 立即清 Room 可见授权，active 内容不再发布 | exact boundary 锁定 | 所有 mutation zero transport | expiry 不因 archive 延长 |
| credential generation rotation | old page/send/lease binding 失效 | old process capability 失效 | 重验或锁定 | old credential 不能操作 | accepted peer ledger 绑 generation，成功 peer 不越权 |
| Desktop clear-cache | server repair 不受伪本地 fact 影响 | 清 active/staging/cursor/双 ledger/key/lease/temp | 禁止，直到重新授权且 repair 完整 | zero offline write | 不删服务端 receipt/outbox |
| server restart | file SQLite 恢复 barrier/snapshot/cursor contract | Desktop 保留旧 complete 直到 catch-up | 仅有效 lease 内可读 | 重连后重验 | startup janitor/drain 处理 pending work |
| Desktop restart | 从持久 cursor 选 delta/repair | 重开 active head、双 ledger、lease metadata | 签名/绑定/时间重验 | 无 lease 不展示也不写 | 客户端去重吸收 outbox replay |
| snapshot/repair 中途 crash | incomplete staging 不 complete | 只见旧 complete，staging 不可见/可清理 | 旧 generation 也必须尚在 lease 内 | 不从半 snapshot 执行 | fixed W 后从 cursor 重启 |
| outbox send-before-mark crash | 重启可重发同 eventId | durable ledger exact replay no-op | 不改 lease | 不伪称 exactly-once | pending row 重试，有界重复，第 8 次失败 dead-letter |

## 11. Schema v27 与 v1-v26 兼容

- `AUTHORITY_SCHEMA_VERSION = 27`；v27 migration 名称是 `sync-reliability-lifecycle`。
- v27 是 **69 条** immutable migration statements；每一 statement 都有 fault injection 与整笔回滚位置。
- v27 migration checksum：`a93246f68af7470a6df35ea55b0987ecacbbcf27b1334e018a05e2946b17b2eb`。
- v27 physical fingerprint：`a7c507632ae5bd86f0e76df7be00f40d9872c4d7ff45e009fe51a166ec76717d`。
- v1-v26 migration SQL/checksum/fingerprint 保持原样，不改历史；新增 v27 为 outbox terminal
  lifecycle、receipt expiry scan/index 与必要补列。没有 v28。
- `schema-v27.test.ts` 验证 fresh 和每个受支持的历史版本升级、v27 物理列/索引/
  状态约束和 v1-v26 checksum 未变；三个 `schema-v27-rollback-*.test.ts` 分段覆盖 69 个
  rollback position。`schema-foundations.test.ts`、`schema-integrity.test.ts`、`schema-recent.test.ts`
  与 legacy importer 继续覆盖 future/unknown/history/checksum/fingerprint/physical tamper、reopen 和 invariants。

> 注：migration checksum 取自当前代码的实际 `AUTHORITY_V27_MIGRATION_CHECKSUM_FOR_TEST`计算结果；
> evidence PR 回填前仍须由最终 schema suite 输出再确认。

## 12. UI J-01/J-02/J-07 状态与权威来源

| Journey/状态 | 可见行为 | 权威来源 | 失败/恢复/无障碍 |
| --- | --- | --- | --- |
| J-01 loading/session restore/login | 启动期不闪现 Room cache | loading 是 local transient；session/catalog 是 server ACK/stable projection | 401/session expired 先锁定/清理，再回登录 |
| J-01 empty/catalog | 无 Room 显示批准 empty surface | catalog complete projection | 分页/checksum 完成前不显示半 catalog |
| J-01 cache locked/missing | 只显示 closed locked/fatal recovery，不显示 Room 名/内容 | local derived cache status | safeStorage/basic_text/key/AAD/tag/schema/corruption fail closed；clear-cache 是明示动作 |
| J-02 online/ACK | 只有匹配 requestId 的 ACK/stable event 显示成功 | server ACK + stable event | callback 返回不代替 durable ACK |
| J-02 cursor catch-up | 旧 complete projection 保持稳定，delta 原子应用 | stable event + local derived durable ledger/cursor | conflict/gap/backwards 进 repair，不局部推测 |
| J-02 repairing | 显示正在修复，staging 不可见 | local transient + server checkpoint/page/completion | retry 明示；无终态 spinner 禁止 |
| J-02 repair failed | 保留旧 complete 且仍获授权的 projection | local derived cache projection + closed server error | 410 重开 repair；429 使用 retryAfter；503 仅在有效 lease 下离线只读 |
| J-07 offline read-only | 显示 `asOf`/lease expiry，所有 mutation disabled | 密码学验签通过的 server-signed lease + local complete active generation | zero transport；非颜色文字/图标标明“离线只读” |
| J-07 lease expired | exact boundary 主动锁定已显示内容 | local clock 对 signed `expiresAt` 的验证结果 | `offline_lease_expired`；不等待用户下一次查询 |
| J-07 membership/session revoked | purge complete 后才发布 locked/revoked | stable access/session reduction + local purge completion | 403/session revoked 不得保留 Room 内容表面 |
| J-07 archived Room | eligible Human 历史只读，业务动作禁用 | stable governance projection | security revoke/expiry 继续；reopen 从新 lifecycle generation 恢复 |

closed 401/403/409/410/429/503 分支分别对应重登录、权限刷新/清理、冲突后权威刷新、
snapshot 重建、按 `retryAfter` 重试、有效 lease 下的离线只读或明示不可用。loading/
empty/retry/clear-cache 全部保持在 J-01/J-02/J-07 批准表面内，没有创造新信息架构。

可访问性保持原生键盘顺序、可见 `:focus-visible`、dialog focus trap/return、Esc 不绕过
安全确认、非颜色状态、单一克制 `aria-live=polite`、高频 preview `aria-live=off`、
`prefers-reduced-motion`、840×560 最小窗口与 100/125/150/200% 缩放合同。没有 Agent
typing animation，也不把 partial projection 写成 authority history。

## 13. 验证命令与精确计数

最终候选必须按顺序运行：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
git diff --check
```

还必须单独记录 schema migration/invariant/fault injection、FT-13 focused、repair/receipt/outbox/cache
capacity、encrypted disk sentinel、real worker/SQLite/Desktop restart E2E、Electron smoke、secret sentinel 和
opt-in live smoke。

### 13.1 命令账本

| 命令/门禁 | 状态 | 精确输出/证据 |
| --- | --- | --- |
| `corepack pnpm typecheck` | `PENDING_FINAL_GATE` | 最终内容 head 回填 |
| `corepack pnpm lint` | `PENDING_FINAL_GATE` | 最终内容 head 回填 |
| `corepack pnpm test` | `PENDING_FINAL_GATE` | 用 Vitest 最终 summary 回填，不沿用中间运行数 |
| `corepack pnpm build` | `PENDING_FINAL_GATE` | 最终内容 head 回填 |
| `corepack pnpm verify:core-boundary` | `PENDING_FINAL_GATE` | 最终内容 head 回填 |
| `git diff --check` | `PENDING_FINAL_GATE` | 最终文档提交后回填 |
| Electron smoke | `PENDING_FINAL_GATE` | 记录实际命令/结果 |
| repository/runtime secret sentinel | `PENDING_FINAL_GATE` | 记录实际 suite 与 count |
| encrypted-cache plaintext sentinel | `PENDING_FINAL_GATE` | 记录实际 suite 与 count |

### 13.2 精确分类计数表

| 分类 | Test files | Passed files | Skipped files | Failed files | Tests | Passed | Skipped | Failed | 状态 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 全仓总计 | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 以最终 `pnpm test` 回填 |
| Core | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 最终 package summary |
| Server | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 最终 package summary |
| Desktop | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 最终 package summary |
| FT-13 focused | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 以显式文件清单运行回填 |
| schema | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | v1–v27 + rollback/invariant/fingerprint |
| repair/cursor | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | registry/parity/fixed-W/capacity |
| idempotency | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | lifecycle/inventory/50k capacity |
| outbox | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | policy/dispatcher/10k capacity |
| Desktop cache/offline lease | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | generation/sentinel/runtime gates |
| real restart E2E | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | real Worker + file SQLite + Desktop main cache |
| capacity suites | 3 current dedicated files + repair E2E fixture | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | 50k receipts、10k outbox、10k encrypted cache、10k repair |

起点基线 255 files / 2693 tests 只用于 rebaseline，不得冒充本阶段最终结果。上表
`PENDING` 只能用最终内容 head 上的机器输出回填；如分类文件重叠，须在回填时同时给出
去重口径，不得用分类之和伪装全仓总数。

## 14. Real restart E2E、capacity 与 sentinel

- `packages/server/src/authority.e2e.test.ts` 的 compiled child 使用真实 AuthorityWorker、真实文件
  SQLite 和 WebSocket，已覆盖持久三客户端、server restart、gap/retained/expired repair、
  fixed-W 10k mixed records、archive/reopen、clear-cache/cursor catch-up、send-before-mark 重放和最终
  replica convergence。
- `encrypted-generation-store.test.ts` 和 capacity suite 对真实 Desktop main-process file cache 执行
  staging/flip/reopen/lease/clear/purge/sentinel。组合的 real-worker + file-SQLite + Desktop-cache 端到端
  命令与精确计数为 `PENDING_FINAL_GATE`，evidence 回填不得仅用内存 fake 代替。
- PR 级容量：repair 10k/3 clients，receipts 50k，outbox 10k 且 10% failures，encrypted cache
  10k。100k repair/cache、1M receipts、100k outbox 是 nightly seam，不冒充 PR 门禁或 release 策略。
- Desktop disk sentinel 扫描 DB/WAL/SHM/journal/tmp/backup/crash residual，对 raw corpus、account/room/event ID、
  data-key canary 和 secret 要求零命中。服务端 sentinel 继续覆盖 event/outbox/error/log/stdout/
  stderr 不携带 raw body、tool payload、headers、credential 或 hidden reasoning。

## 15. Live smoke 与 secret 边界

- OpenAI secret 只由 server-side `SecretProvider` 进入 Provider Adapter；offline lease private signing key 只在
  server；cache encryption key 只在 Desktop main process。
- 不读取、打印、hash、比较或记录 secret 值、长度、前后缀、Authorization header 或可识别
  派生值。本文也不嵌入 raw message/tool payload/test corpus。
- 真实 OpenAI suites 仍是 opt-in；无显式 flag + secret 时必须记录“安全跳过”，不回退
  production mock。
- 本次最终 live smoke 结果：`PENDING_FINAL_GATE`。evidence PR 只能回填实际 pass 或“因无
  secret 安全跳过”以及精确 skip 数，不得把 skip 写成 pass。

## 16. 独立审阅、已知风险与建议 reviewer

### 16.1 独立审阅

- 已派出独立 Sol high reviewer；最终 P0/P1/P2 计数、每个发现与修复提交：
  `PENDING_REVIEW_FINAL`。
- 中间审阅重点暴露了租约过期需主动定时锁定、offline capability 需覆盖所有
  cache-backed Desktop surface、generation restore 不得被 legacy snapshot 逆向作废，以及 flip 前必须从
  磁盘解密/重算 staging checksum/count。当前候选分别在 `e7c9c38` 与 `8f525fe` 收口；
  这只是修复账本，不代替 reviewer 最终复审。
- 建议 reviewer 在内容 PR 最终 head 上重点复审：单 writer/无第二 authority；33-kind
  completeness、page/complete 抢占；租约 exact-expiry 与全 Desktop surface gate；磁盘密文残留；
  v1-v26 未改写；receipt exact expiry；peer accepted ledger/revoke；send-before-mark；archive 不冻结
  security expiry；UI 无伪 server fact。

### 16.2 已知边界/风险

1. Outbox 是 at-least-once；进程 crash 丢失 accepted-peer ledger 或 send-before-mark 可产生有界重复。
   这由客户端 durable event ledger 吸收，不宣称物理 exactly-once。
2. 离线设备无法在断网期间被服务端瞬时遥控擦除；风险上限由 server-signed finite
   lease 给出，到期必锁定。release 默认值/上限属于 FT-14。
3. safeStorage availability/backend 受 OS 能力影响；不安全时选择 locked/fatal，不用明文可用性
   换取保密性。
4. 100k/1M 规模是 nightly seam；当前 PR 门禁为 10k repair/cache/outbox 和 50k receipt。
   这不冻结 FT-14 运维阈值、retention、credential rotation 或 release policy。
5. 最终全仓计数、Electron/live smoke、独立复审和远程 required CI 仍是交付门；在
   `PENDING` 回填前，本文不宣称远程交付闭环已完成。

## 17. Git、PR、CI 与 evidence 回填

### 17.1 当前 Git 事实

- 内容分支：`codex/ft13-stage13-sync-reliability`。
- 内容 worktree：`/Users/leo/code/Dao-ft13-stage13`。
- 起点：`origin/main@e19c1492e52cdf399b440c7dc959a5607c888e32`。
- 本文初建时内容 head：`e7c9c38`；最终内容 head 需在 PR 创建前回填。
- 原始工作区 `/Users/leo/code/Dao` 及四个 owner 未跟踪文件不在本 worktree 的写入/
  提交范围内；最终 SHA-256 复核与 worktree 清理事实为 `PENDING_FINAL_DELIVERY`。
- 没有修改 Blueprint HTML/JSON，没有 force push，没有改写 v1-v26 migration。

### 17.2 远程事实表

| 事实 | 值 | 回填规则 |
| --- | --- | --- |
| 内容 PR URL / number | `PENDING_CONTENT_PR` | 只在 GitHub 实际创建后回填 |
| 内容 PR final head | `PENDING_CONTENT_HEAD` | 只记录实际 remote head SHA |
| 内容 PR CI run | `PENDING_CONTENT_CI` | 回填 run URL 和 Node 22.13.1/22.x 每个 job 结果 |
| 内容 PR merge SHA | `PENDING_CONTENT_MERGE` | 只在 required CI 绿且 GitHub 合并后回填 |
| evidence PR URL / number | `PENDING_EVIDENCE_PR` | 从内容合并后的新 `origin/main` 创建 evidence-only worktree 后回填 |
| evidence PR CI run | `PENDING_EVIDENCE_CI` | 只回填实际 run/job URL 和结果 |
| evidence PR merge SHA | `PENDING_EVIDENCE_MERGE` | 只在 evidence PR 实际合并后回填 |
| 最终 `origin/main` | `PENDING_FINAL_MAIN` | `git fetch origin --prune` 后回填 |
| 临时 worktree 清理 | `PENDING_WORKTREE_CLEANUP` | 检查 clean/真实合并后 remove + prune，再回填 |

evidence PR 只允许更新本文中的真实内容 PR/CI/merge SHA、最终计数、reviewer 结论、
live smoke、worktree 清理和原始工作区保护事实。它不得伪造链接，也不得在 evidence-only
变更中偷添生产代码。

## 18. 范围排除

- 没有实现 FT-12 完整 notification center、OS push 或 global inbox；本阶段只交付
  offline/repair 状态与必要壳层，不用假数据伪装 notification 业务完成。
- 没有冻结 FT-14 所属的 `maxOfflineReadLease` release 默认/上限、credential/key
  rotation、retention policy、多节点撤销分发或运维 runbook。
- 没有 offline command queue、恢复在线后自动重放草稿/历史操作、第二 authority DB/writer/
  event bus/snapshot，也没有把 lease/cache/prototype UI 当作服务端事实。

## 19. 交付结论

已达到交付条件，等待 owner 验收。
