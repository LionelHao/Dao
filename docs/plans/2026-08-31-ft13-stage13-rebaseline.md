# FT-13 Stage 13 rebaseline：同步与可靠性生产闭环

> 日期：2026-08-31  
> 状态：实施基线；不是交付、验收或 verified 声明  
> 基线：`origin/main@e19c1492e52cdf399b440c7dc959a5607c888e32`，Authority schema immutable v26

## 1. 远端、工作区与权威输入

启动核验结果：PR #75 与 evidence PR #76 均已合并，#75 merge SHA 为
`1913218519c1cdbc968e60e6e2a3db8e448dbbab`，#76 merge SHA 与当前
`origin/main` 均为 `e19c1492e52cdf399b440c7dc959a5607c888e32`；无未关闭 PR，亦无遗留临时
worktree。实施分支为 `codex/ft13-stage13-sync-reliability`，隔离 worktree 为
`/Users/leo/code/Dao-ft13-stage13`。

原始工作区 `/Users/leo/code/Dao` 保持在用户分支；四个未跟踪计划文件只读保护，其
SHA-256 在开始时与任务给定值完全一致。本阶段不修改 Blueprint HTML/JSON。

本 rebaseline 已按以下优先级完整审阅：PRD；`docs/protocols/`；正式设计 README、
自包含审阅稿与 Requirement 覆盖矩阵；旧 FT-13 设计/实施计划；FT-01～FT-10 当前交付
说明；最后才是 core/server/desktop 生产代码和测试。出现冲突时以前三者为准。

## 2. 旧设计与当前 main 的差异

| 主题 | 旧 FT-13 设计 | 当前 main@v26 | Stage 13 判断 |
| --- | --- | --- | --- |
| schema | 写作基线 v12，版本号留待 predecessor | immutable v26 | 如需物理字段/索引只追加 v27，不改 v1～v26 |
| Requirement | 前言是旧 19 条/交叉集合 | 批准实施映射为本文 §4 的 21 条 | 以 21 条为直接范围 |
| repair assembly | materialized/streaming 双份枚举 | `snapshot-worker.ts` 已以 closed registry 同时驱动两条路径；Stage 13 补齐 assignment 后 union 为 33 kind | 保留单一 registry；补启动 fail-closed、当前 union 清单、全 kind parity/容量/抢占证明 |
| offline lease | 当时没有实现 | 已有 Ed25519 issuer/verifier/invalidation 与持久化 seam | 不平行重写；接入生产 composition、RPC、Desktop verifier 与 cache gate |
| Desktop cache | 计划为 SQLite/AES-GCM generation store | 仍是 safeStorage 整体加密的单 JSON，内存 staging/去重 | 替换为 main-only、AES-256-GCM、wrapped data key、事务 generation/cursor/ledger store |
| cursor dedupe | 计划双唯一持久 ledger | `ClientSyncReplica` 仅持有进程内 `Set<eventId>` | eventId/seq 映射冲突、gap、backwards 进入 repair；apply/ledger/cursor 同事务 |
| idempotency | 30 天目标但旧审计认为 replay 永久 | 多 family 已有 30 天常量/expiry seam；tenant administration 仍有 24h 默认，清理分散 | 建立封闭 inventory、统一 exact-expiry 与 Worker janitor |
| outbox | 中央 row/peer 重试目标 | 多个 authoritative family，各自状态能力不一致 | 全 family inventory；统一 bounded policy/dead-letter/alert/peer isolation |
| UX | J-01/J-02/J-07 为批准表面 | view-model 覆盖部分状态，生产 wiring 不完整；Agent Settings 断线时伪造本地 +30s lease | 删除伪 lease；只用 server lease + 完整 cache generation；不实现 FT-12 通知中心 |
| 测试数 | 旧计划数字已过时 | Stage 12 基线 255 files / 2693 tests（3 个 live smoke 安全跳过） | 只作为前置基线；交付写实际最终精确计数 |

## 3. 当前完成度：完整、seam、缺失

### 3.1 已完整实现并复用

- AuthorityWorker 是唯一 SQLite writer；domain fact、stable event、receipt/outbox 的权威
  transaction 继续沿用，不增加第二数据库、writer、snapshot 或事件总线。
- `RoomRepairRecord` 是 closed union；中央 repair registry 已拒绝未知 kind、重复 kind/order、
  descriptor version 不匹配，并被 materialized 与 keyset streaming 共用。
- fixed watermark、分页 checksum/completion、repair lease 与逐页权限复核已有生产骨架。
- server offline lease issuer/verifier 已使用 Ed25519、closed claims，并绑定 tenant/account/
  human actor/session family/device/installation/server subject/room lifecycle/access/lease
  generation；expiry 受请求值、显式 max 与 refresh horizon 最早边界约束。
- Desktop preload 未暴露 cache key/path/ciphertext/DB handle；`basic_text` 和未知 Linux
  safeStorage backend 当前 fail closed。
- archive 的 Human 历史只读与业务写/runtime/timer 冻结、安全 revoke/expiry 继续执行，
  已有前序 feature 合同和测试，FT-13 只补横切抢占矩阵。

### 3.2 有 seam 但尚未形成生产闭环

- registry 结构存在，但缺少面向“当前全部 visible union”的固定 inventory 证据、生产启动
  completeness 断言、33 kind 逐项 materialized/streaming canonical parity 与 10k/100k 容量证据。
- repair/page authorization 存在，但仍需对 logout、family/account revoke、membership remove、
  archive/reopen/credential generation 在 page 与 complete 之间的抢占给出全矩阵证据。
- offline issuer/verifier 未进入 AuthorityWorker/WebSocket 生产签发路径，也没有 Desktop verifier、
  timer、lease persistence 或解密门禁。
- Desktop 内存 staging 的 checksum/complete 语义较强，但持久化 adapter 把 projection/cursor 作为
  单文件异步快照写入，不能证明 crash atomicity，且 event ledger 重启即丢失。
- outbox 与 idempotency 在各 feature 内各有部分 TTL/attempt/index helper，尚无封闭 inventory、
  统一 janitor/terminal policy 与全 family 参数化证明。
- offline/repair 的 headless view model 已覆盖部分 banner、focus 与 aria-live；生产 runtime 没有
  把 signed lease、cache generation、repair progress 连接成可达状态。

### 3.3 缺失或错误，必须修复

1. `agent-profile-routing/production-runtime.ts` 在 socket disconnect 时用本机时间生成
   `now + 30s` lease 并展示旧 snapshot；这是客户端伪造授权，必须删除并 fail closed。
2. `authority-worker.ts` 仍有 `maxOfflineReadLeaseMs ?? 24h`；生产 composition 缺失/0/负数/
   NaN/Infinity 必须失败，FT-13 不设置 FT-14 的 release 默认值。
3. 缺少 AES-256-GCM record encryption、safeStorage-wrapped random data key、active/staging
   generation、dual event ledger、lease/schema metadata、原子 active pointer 与 disk residual sentinel。
4. `ClientSyncReplica` 的 eventId 预去重可吞掉 same-event/different-seq 冲突；ledger、projection、
   room cursor 未处于同一 durable transaction。
5. encrypted cache decrypt/corrupt 错误当前会删除并退化为 `missing`；locked/corrupt/fatal 必须闭合，
   不得静默明文或静默忘记故障。
6. exact-expiry/30 天语义和 bounded cleanup 尚未覆盖当前所有 command receipt family；已知
   tenant administration 默认仍是 24h。
7. authoritative outbox family 尚未统一 250ms full-jitter exponential backoff、30s cap、8 attempts、
   batch 100、dead-letter、60s/5min alerts 与 process-local accepted peer ledger。
8. 缺少真实 AuthorityWorker + 文件 SQLite + Desktop main cache 的三客户端 restart/revoke/archive/
   repair/outbox 全链 E2E，以及 10k PR 容量证据。

## 4. 21 条直接 Requirement 的代码与测试计划

| Requirement | 实施证据目标 | 自动化证据目标 |
| --- | --- | --- |
| REQ-AGT-001 | execution/intent/current-attempt 等现有 Agent projection 进入唯一 registry 与加密 cache | 全 kind repair parity；三端 convergence |
| REQ-ID-005 | session/account/membership revoke 抢占 repair、锁定或清除相应 cache/lease | revoke-in-page、restart、disk purge sentinel |
| REQ-MEM-001 | memory authoritative record 由同一 fixed-W registry/cache 恢复 | memory descriptor parity、clear-cache repair |
| REQ-MSG-001 | accepted 仍只来自 durable ACK；离线不产生 local ACK/queue | ACK loss/idempotent replay；offline transport call=0 |
| REQ-MSG-002 | history/realtime/repair 共享 authority eventId/cursor | gap/backwards/dual-conflict、W+1 delta、三端一致 |
| REQ-NFR-001 | 保持单租户 worker-owned SQLite 单 writer | boundary test、真实 worker 文件 DB E2E |
| REQ-NFR-002 | fact/event/outbox/receipt 原子提交；receipt 30 天 | crash points、exact-expiry、all-family inventory |
| REQ-NFR-003 | at-least-once + durable client dedupe + bounded outbox | send-before-mark、restart duplicate、dead-letter |
| REQ-NFR-004 | closed registry、fixed W、旧完整 generation 直到原子 flip | materialized/streaming bytes、crash matrix |
| REQ-NFR-005 | repair/janitor/outbox 全部 batch/timeout/retry/terminal 有界 | 10k PR capacity、no spinner、bounded shutdown |
| REQ-NFR-007 | signed finite lease 下只读完整 encrypted cache；无离线命令 | lease expiry、all command adapters call=0 |
| REQ-NFR-008 | server lease 精确绑定并受 revoke；无客户端延长/24h fallback | invalid config、claim mismatch、revoke/purge |
| REQ-NFR-010 | 不重复、不倒退、不串 Room、不半 projection、不伪成功 | cursor conflict、atomic generation、Room isolation |
| REQ-NFR-011 | send/page/complete/retry 前重验 session/membership/generation | multi-page revoke、peer retry revalidation |
| REQ-NFR-014 | archived eligible Human 只读；业务冻结而安全 expiry 继续 | archive/reopen matrix、old terminal/grant/timer 不复活 |
| REQ-PRIM-002 | Human session family revoke 与本地 cache 生命周期联动 | logout/family/account revoke restart tests |
| REQ-PRIM-006 | durable ACK、history/realtime 同源、稳定 ID 去重 | receipt replay、event ledger、crash recovery |
| REQ-PRJ-004 | Request/OpenItem 等 project facts 可 repair，不靠 local state | project descriptor parity、clear-cache/restart |
| REQ-PRJ-012 | due/reminder authoritative projection 可靠恢复；archive 冻结业务触发 | registry parity、archive/reopen timer matrix |
| REQ-ROOM-004 | archive/reopen revision 参与 page/cache/lease eligibility | mid-repair archive/reopen、offline archived read |
| REQ-UX-006 | restore/login/catalog/offline/revoked/degraded/fatal 不闪现未授权 cache | headless state、renderer boundary、focus/aria tests |

交叉义务还覆盖 message revision/attachment/human-read/agent judgement、memory、agent runtime、
project、tool safety、membership 与 archive 的现有 authoritative records；这不会引入未批准的新产品能力。

## 5. 当前 repair record inventory

当前 `RoomRepairRecord` union 与 `ROOM_REPAIR_KIND_MAP` 的 33 个 kind 必须恰好一一对应：

`room`、`governance`、`membership`、`room-agent-assignment`、`message`（deprecated compatibility）、
`timeline-message`、`message-revision`、`attachment`、`human-read`、`agent-judgement`、
`open-item`、`open-item-agent-failure`、`light-task`、`agent-invocation-intent`、
`agent-execution`、`agent-execution-attempt`、`agent-execution-retry`、
`agent-scoped-cancellation`、`project-boundary-invocation`、`legacy-agent-execution`、
`route-job`、`route-judgment`、`calibration`、`legacy-unknown-calibration`、`memory`、
`project-loop`、`tool-call`、`tool-confirmation`、`tool-grant`、`tool-dispatch`、
`tool-review`、`tool-handoff`、`tool-compensation`。

Transient preview、typing、partial provider stream、secret、raw recalled body、outbox/idempotency
internal rows 不属于 operational repair snapshot。新增 future kind 必须同时扩 closed union、guard、
descriptor、Desktop reducer、revoke/clear-cache 和 parity test，不能绕过 registry。

## 6. 文件级切片与唯一 owner

| 切片 | 唯一写入 owner | 主要文件/目录 |
| --- | --- | --- |
| Repair registry/cursor | Repair Agent；中央集成由主 Agent | `core/src/sync*`、`server/src/persistence/repair-projection-registry*`、`snapshot-worker*`、focused tests |
| Idempotency/outbox | Persistence Agent；schema/worker/store 热点由主 Agent | feature authority/repository、`outbox-dispatcher*`、新 inventory/policy/alert 模块与 tests |
| Desktop cache/lease | Desktop Agent；main/preload/renderer 热点由主 Agent | `desktop/src/governance/*cache*`、`sync/client-sync-replica*`、新 lease/store/state 模块与 tests |
| Protocol/integration | 主 Agent | Authority worker protocol、server/WebSocket composition、real restart E2E、capacity/sentinel |
| 独立审查 | 实现完成后新 Sol reviewer，只读 | 全 diff、migration、security/revoke/archive/UI boundary |

主 Agent 独占最终合并以下共享热点：

- `packages/server/src/authority-worker.ts`
- `packages/server/src/authoritative-server.ts`
- `packages/server/src/websocket.ts`
- `packages/server/src/persistence/schema.ts`
- `packages/server/src/persistence/sqlite-authoritative-store.ts`
- `packages/desktop/src/main.ts`
- `packages/desktop/src/renderer/app.ts`
- package root exports
- `docs/deliveries/FT-13-Sync-Reliability-Stage13-交付说明.md`

## 7. UI / 交互映射

| 旅程/状态 | 可见状态 | 权威来源 | 失败/恢复 |
| --- | --- | --- | --- |
| J-01 | loading/login/restore/catalog/empty | loading 为 local transient；session/catalog 为 server ACK/stable projection | 401/session expired 清 account cache；locked/missing/lease expired 收敛到批准的 revoked/fatal 恢复表面 |
| J-02 | online、ACK、cursor catch-up、repair | ACK 为 server ACK；timeline 为 stable event/projection；repairing 为 local transient + server checkpoint | 409 refresh/repair；410 restart repair；429 按 retryAfter；503 仅在有效 signed lease 下进入 offline read-only |
| J-07 | offline read-only、repairing、repair failed、online | offline 为 verified lease + local derived complete active generation；repair status 为 local transient；新 projection 只在 completion 后可见 | repair failed 保留旧完整且仍授权 projection；retry/clear-cache 明确；无有效 lease 立即 locked |

Archived Room 是 stable governance projection，只读并以非颜色文字/图标表达；membership revoked 来自
stable access reduction/403；cache corruption、safeStorage/key failure 是 local derived locked/fatal，不能
伪装 server fact。401/403/409/410/429/503 都使用 closed error 与既有恢复分支。

可访问性合同：键盘可达、可见 focus、对话框 focus trap/return、Esc 不绕过安全确认；状态不能只靠
颜色；低频、合并的 `aria-live` 通告；`prefers-reduced-motion` 下无非必要动画；不实现 Agent typing
动画；在 1440×900、840 最小窗口和 100/125/150/200% 缩放边界验证。设计偏离：**无**。

`cache missing`、`lease expired` 与 `clear cache` 没有批准的新独立页面；实现只扩既有 J-01/J-07
locked/fatal/repair recovery 状态和 headless contract，不创造新信息架构。FT-12 notification center、
OS push、global inbox 不在本阶段实现。

## 8. 阶段门

Stage 13 只有在 schema/repair/cache/lease/idempotency/outbox/real-restart/capacity/sentinel 与全仓
门禁全部给出实际精确数字，独立 reviewer 的 blocker/high 已关闭，内容 PR 和 evidence PR 都合入
远端 main，并清理临时 worktree 后，才能写“已达到交付条件，等待 owner 验收”。执行者不得写
verified 或已验收。
