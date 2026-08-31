# FT-13 Sync & Reliability：Stage 13 production addendum

> 日期：2026-08-31  
> 依赖：[Stage 13 rebaseline](./2026-08-31-ft13-stage13-rebaseline.md)  
> 本文收敛旧设计在 schema v26/current feature surface 上的生产机械，不改变 PRD、protocol 或正式 UI 设计。

## 1. 不变量与边界

1. AuthorityWorker/SQLite 是唯一 writer；snapshot、stream、Desktop cache、lease 和 peer ledger 均为
   authority 的派生物或授权证明，不能产生业务事实。
2. Desktop offline 严格只读，没有 offline command queue、local ACK、自动重放或客户端延长 lease。
3. repair 不掩盖 authority stream 物理洞、重复 seq 或损坏；这些返回 closed
   `storage_unavailable` 并产生不含正文/secret 的结构化告警。
4. materialized/streaming 共用一套 closed registry、canonical encoder、固定 watermark W、分页顺序和
   checksum。W 后事件仅从 W+1 delta 进入。
5. 旧完整 cache generation 在新 staging 完整、checksum/completion 验证并原子 flip 之前持续可见；
   若读取授权已失效则锁定/清理，而不是继续展示。
6. outbox 是 at-least-once；send-before-mark 或进程重启允许同 eventId 的有限重复，不宣称物理
   exactly-once。客户端 durable ledger 吸收 exact replay。
7. archive 只冻结业务写/runtime/timer/new business notification；session/member/grant/confirmation/
   lease 等 security revoke/expiry 继续运行。reopen 不复活旧 terminal execution、grant、confirmation、
   timer attempt 或 connection credential。
8. 不实现 FT-12 通知中心，也不冻结 FT-14 release 默认、retention、rotation 或运维 runbook。

## 2. 连续 cursor、repair registry 与授权抢占

每个 room durable generation 持有唯一 `eventId → streamSeq` 和 `(roomId, streamSeq) → eventId`
映射。应用 batch 前在一个 cache transaction 内验证：

- exact eventId/seq replay 是 no-op；
- same eventId/different seq、same seq/different eventId、gap 或 backwards 终止 batch 并 repair；
- 新连续事件才 reduce projection、写两类 ledger 并推进 cursor；
- 安装 checkpoint W 时，`seq <= W` 的 ledger 可按 generation 边界有界裁剪，迟到的 checkpoint 前
  frame 只能作为 stale no-op，不能改变 projection。

registry assembly 在生产启动时将 runtime descriptor 集合与 closed current kind inventory 比较；缺失、
多余、重复 kind/order、descriptor version 或 stable-key 冲突全部拒绝启动。每一页读取与 complete
前重验 session、membership、room lifecycle/access revision 与 credential generation。logout/session
family/account revoke、membership removal/permission downgrade 可在多页 repair 中途抢占；提交之后
不得再返回后续页或 complete。

## 3. Desktop encrypted generation store

生产 store 仅由 Electron main process 打开：

- 首次创建 256-bit random data key；只把 safeStorage-wrapped key 保存到磁盘；正文以
  AES-256-GCM 加密，nonce 唯一，AAD 绑定 cache schema/account/room/generation/record identity；
- 持久化 active/staging metadata、authority records、per-room cursor、双 event ledger、repair
  checkpoint、offline lease metadata 与 cache schema/version；
- snapshot page 仅写 staging；finish 在单一 transaction 中复核 expected count/checksum/completion，
  然后 flip active pointer；旧 generation 之后有界 GC；
- event reduce + 双 ledger + cursor 在同一 transaction；所有 read/write/batch/buffer/transaction/
  shutdown 有明确上限；
- crash-before/during-flip 看到旧完整 generation，crash-after-flip 看到新完整 generation；不能拼接；
- safeStorage unavailable、`basic_text`、unwrap/decrypt/tag/AAD/schema/integrity failure均 locked/fatal，
  不回退 plaintext，也不把 corruption 静默当普通 cache miss；
- logout 锁定并 best-effort zeroize data key；session/account revoke 清账户 store；membership revoke 只清
  目标 Room；clear-cache 清 active/staging/cursor/ledger/wrapped key/lease/temp residual；
- preload/renderer 只接收 closed projection/status/action，不接收 key、path、ciphertext、DB handle、
  authority credential 或 generic filesystem/crypto IPC。

真实磁盘 sentinel 扫描 cache 文件、临时文件、journal/WAL/SHM、备份和 crash leftovers；raw corpus、
key canary 与 secret 必须零命中。测试不得仅检查 API return value。

## 4. Offline read lease production composition

复用现有 Ed25519 issuer/verifier/invalidation port。生产启动必须显式提供有限正整数
`maxOfflineReadLeaseMs`；缺失、0、负数、NaN、Infinity 拒绝启动，不存在 24h 或任何隐藏 fallback。
FT-13 不选择 release 默认值。

签发/验证 claims 必须 closed 并精确绑定 tenant、account、human actor、session family、device、
installation、server subject、room、membership/lifecycle/access/lease generation、keyId、issued/notBefore/
expiresAt。最终 expiry 不晚于显式 max、credential/session refresh horizon 和其他更早授权边界。

Desktop 只有在签名、绑定、时钟和 generation 均有效，且存在完整 active generation 时才解密并展示
offline read-only。lease 到期立即锁定；它永不进入业务 command authorization。logout、session/account
revoke、membership revoke、clear-cache 删除或失效相应 lease。archived Room 对仍有资格 Human 可在
lease 内离线只读；archive 不延长 security expiry。

## 5. 30 天 idempotency inventory 与 janitor

Stage 13 建立唯一、closed、测试可枚举的当前 receipt store inventory。每个 entry 声明表、scope/key、
payload fingerprint、result decoder、expiry column/index、稳定业务 ID/unique constraint 与 cleanup adapter；
feature 不得绕过 inventory 建立永久 receipt。

统一语义是 `now < expiresAt` 才命中；同 canonical payload 返回原结果，不同 payload 返回 closed 409；
`now == expiresAt` 已过期，旧 row 在同一 AuthorityWorker transaction 删除后按窗口外新命令处理。
receipt 过期不能绕过 messageId/execution/toolCall/project boundary 等稳定业务唯一约束制造第二事实。

Worker 启动时以及每小时运行 janitor；每个 write transaction 最多删除 500 行，每批后 yield，直到本轮
expired set 为空。SQL 参数、内存、日志和总 promise 数有界；错误 closed 且日志不含 payload/hash原文、
secret 或 corpus。所有删除仍由 AuthorityWorker 执行。

## 6. 所有 authoritative outbox family 的统一投递合同

closed inventory 枚举中央与 feature-specific outbox。每个 family 必须支持：batch ≤100；base 250ms；
exponential full jitter；单次 cap 30s；最多 8 attempts；第八次失败进入 durable terminal dead-letter；
60s backlog warning 与 5min critical；结构化 alert 只含 closed identifiers/code/age/count。

dispatcher 的 process-local accepted ledger 绑定 `(deliveryId, connectionId, credentialGeneration)`。
同一进程中成功 peer 不随坏 peer 每轮重收；发送前始终重验 connection/session/membership eligibility，
generation/re-auth/close/revoke 使旧 accepted entry 失效。无 eligible local connection 时可完成 local dispatch，
离线客户端以后由 authority cursor 补齐。进程 crash 丢 ledger 或 send-success-before-mark 允许有限重复，
client durable ledger 保证一次可见应用。loop/storage error 不得被空 catch 静默吞掉，shutdown 有界。

## 7. Schema v27 compatibility

若上述 idempotency scan 或 outbox terminal lifecycle 需要物理 index/column，只在 v26 之后追加一份 immutable
v27 migration。v1～v26 SQL、checksum、fingerprint 原样保留。验证 fresh v1→v27、每个支持历史版本→v27、
future/unknown refusal、checksum/fingerprint tamper、v27 每条 statement fault injection/整笔 rollback、
reopen/restart/invariants 与 compatibility reader。没有 reader-first 机械证据时不创建 v28。

## 8. 验收矩阵与边界说明

PR 级证明包括：10k repair/3 clients、50k receipt cleanup、10k outbox/10% failures、10k encrypted
cache records 与真实文件 sentinel；nightly seam 使用 100k repair/16 clients、1M receipts、100k outbox/
cache，但不把超出 PR 门禁的 release 运维参数冒充本阶段完成。

真实 E2E 使用 AuthorityWorker、文件 SQLite、Desktop main-process cache 与三个持久客户端，覆盖 server/
snapshot/Desktop restart、gap、fixed-W、mid-repair revoke、archive/offline/expiry/reopen/clear-cache、cursor
catch-up、outbox retry/dead-letter 和最终收敛。OpenAI smoke 只在显式 secret 下运行；无 secret 必须安全跳过，
绝不启用 production mock fallback。

设计偏离：**无**。最终状态仍只能是“已达到交付条件，等待 owner 验收”。
