# FT-14 Privacy & Operations · Stage 14 交付说明

> 状态：**阻塞，尚未交付**。除 production credential secret backend 外，FT-14 代码、文档、测试
> 和独立终审已形成冻结的本地候选；仓库没有 owner 批准的 durable/versioned/restart-recoverable
> secret backend，因此 rotation production composition 正确保持 `configuration_unsupported`。尚无
> commit、内容 PR、required CI、merge 或 evidence-only PR；本文不标记 verified，也不宣称
> 交付门已经满足。

## 1. 一句话结果

FT-14 已完成 Provider no-retention、finite offline lease、Diagnostics/Room export 强隔离、fixed-W
owner export、retention、worker operations 与 Electron/IPC 安全收口，并冻结 credential rotation
状态机和恢复合同；真实 credential 配置/轮换仍等待 owner 选择 production secret backend。

## 2. 权威输入与直接范围

- 生产设计：[`2026-08-31-ft14-privacy-operations-design.md`](../plans/2026-08-31-ft14-privacy-operations-design.md)。
- 实施计划：[`2026-08-31-ft14-privacy-operations-implementation-plan.md`](../plans/2026-08-31-ft14-privacy-operations-implementation-plan.md)。
- 协议：[`privacy-operations.md`](../protocols/privacy-operations.md)。
- Threat model：[`2026-08-31-ft14-offline-read-lease-threat-model.md`](../security/2026-08-31-ft14-offline-read-lease-threat-model.md)。
- Operations：[`provider-credential-rotation-runbook.md`](../operations/provider-credential-rotation-runbook.md)、
  [`provider-no-retention-inventory.md`](../operations/provider-no-retention-inventory.md)、
  [`diagnostics-room-export-separation-runbook.md`](../operations/diagnostics-room-export-separation-runbook.md)、
  [`room-data-export-runbook.md`](../operations/room-data-export-runbook.md)、
  [`retention-policy.md`](../operations/retention-policy.md)、
  [`worker-dead-letter-recovery-runbook.md`](../operations/worker-dead-letter-recovery-runbook.md)。
- 设计偏离：**无**。

## 3. 17 条 direct Requirement 状态

| Requirement | 当前证据与状态 |
| --- | --- |
| `REQ-AGT-004` | noauth/ready 从固定 Provider/model 与 credential availability 派生；部署管理与 Room ACL 分离。真实在线 rotate 受 backend 阻塞 |
| `REQ-AGT-009` | execution 冻结 provider/model/generation metadata；bounded retry；无第二 Provider/model fallback |
| `REQ-AGT-013` | `outcome_unknown` 恢复/review/compensation 所需 sealed data 不被 retention 过早清理 |
| `REQ-ID-004` | Tenant Administrator 只能管理 deployment metadata；非 Room owner/member 的 Room export/读取为 403/零字节 |
| `REQ-ID-005` | finite signed lease、revoke residual threat model、restart/key cutoff 已闭合 |
| `REQ-MEM-010` | worker degraded/backlog/dead-letter closed alert；authority 不可用时 fail closed |
| `REQ-MEM-012` | Provider 只接收 frozen context 必要内容；无 raw body/header/reasoning persistence/log |
| `REQ-MSG-006` | recalled raw 从 operational context/Provider 排除；仅授权 Human audit/owner export 可见 |
| `REQ-MSG-010` | provider/model/readiness/no-retention disclosure；recall/tombstone 不进入 Provider corpus |
| `REQ-NFR-001` | AuthorityWorker/SQLite 单 writer；diagnostics/export/cache/artifact 都不是第二事实源 |
| `REQ-NFR-003` | 复用 FT-13 bounded outbox/retry/dead-letter/alert，不建第二 event bus |
| `REQ-NFR-005` | closed worker inventory、queue/active/batch/timeout/retry/recovery/shutdown/age alert |
| `REQ-NFR-006` | 单 Provider/模型、无 BYOK/fallback、rotation contract/audit metadata 已冻结；**production backend 与真实 rotate 尚未完成，是当前 blocker** |
| `REQ-NFR-008` | 5m minimum、8h release default、24h hard maximum、0 skew、previous-key 24h cutoff；非法配置 fail closed |
| `REQ-NFR-009` | deterministic bounded diagnostics allowlist、secret/corpus sentinel，与 raw Room export 完全分离 |
| `REQ-NFR-012` | current owner fixed-watermark streaming export、retention 分类、archive/recall 非 delete、无永久删除 UI |
| `REQ-NFR-013` | Electron isolation、closed main/preload IPC、native save、attachment/link/path/CSP 和 renderer boundary |

除 `REQ-NFR-006` 的真实 backend/rotation composition 外，独立 reviewer 未发现其他 Requirement
代码缺口。

## 4. Credential rotation 合同与确认阻塞

已实现 `packages/server/src/privacy-operations/credential-rotation-contract.ts` 的 closed metadata、
state machine、restart reconciliation、frozen execution binding 与 crash-window pure tests。Authority
允许的 metadata 只有 actor/time/provider/model/generation/keyVersion/readiness transition/result
classification；credential 值、长度、前后缀、hash 或可识别派生值均被禁止。

production 必须提供 server-private：

1. durable versioned `observe/stage/activate/discard`；
2. restart 后可对账 candidate、active 与 previous generation；
3. 有界 overlap、rollback/forward recovery 与 zeroization；
4. Tenant Administrator 专用 closed management transport、认证、rate/payload limits；
5. secret 不进入 SQLite/WAL/event/outbox/audit/log/wire/renderer/diagnostics/export/repair。

当前仓库只有只读 `EnvironmentSecretProvider.getSecret("OPENAI_API_KEY")`，没有 Vault/KMS/Secrets
Manager、系统 credential store 或具有外部 root-of-trust 的 sealed backend。使用 Authority SQLite、
普通文件、`process.env` mutation、不可恢复内存变量或 production mock 都会改变/削弱安全架构，明确
禁止。owner 候选与恢复流程见 credential rotation runbook。

## 5. Provider no-retention 与用户披露

三条生产 Provider adapter 都使用 `store:false`，只接受当前 frozen context 的必要 closed payload；
recalled/disputed/revoked source、无关 Room corpus、raw request/response、HTTP headers、hidden reasoning
和 provider error body 不持久化、不进入错误。body/SSE/error/shutdown 有界，无 provider/model fallback。

Room 用户披露只包含 `providerId`、`modelId`、`readiness`、`retentionDisabled:true`、
`selectionPolicy:server-managed-single`、disclosure revision/time；不包含 credential generation、key
version、endpoint token 或部署路径。

## 6. Offline lease threat model 结论

| 参数 | 冻结值 |
| --- | ---: |
| hard minimum | 5 分钟 |
| release default | 8 小时，必须由发布配置显式提供 |
| hard maximum | 24 小时 |
| clock skew tolerance | 0 ms |
| previous-key overlap | 24 小时，只允许一个 previous |
| previous issuance cutoff | 新 key activation 时刻 |
| previous verification cutoff | activation + 24 小时，精确截止拒绝 |

server production composition 强制显式 active signing key、activation time、tenant/server subject 与
至多一个 previous cutoff；missing、0、负数、NaN、Infinity、小数、超上限、未知/重复 key 均 fail
closed。lease 只允许读取仍获授权的 complete active cache generation，客户端不能上调 policy，所有
offline mutation zero transport。纯离线 revoke 的残余暴露受已签 lease 剩余时间限制，默认不超过
8h、绝对不超过24h。

## 7. Diagnostics 与 Room export 强隔离

### 7.1 Diagnostics

- closed allowlist、deterministic manifest/checksum、安全文件名；≤10,000 entries、artifact ≤1MiB、
  chunk ≤48KiB。
- 只允许 opaque ID、closed state/error classification、size/duration/queue/attempt、schema/version、
  worker/config-presence capability。
- 禁止 message/revision/recalled body、attachment content/extracted text、prompt、Provider/tool raw
  body、headers、secret/token/password、reasoning、DB/cache path/key 与敏感 stack。
- server 与 Desktop 走同一 authenticated WS 的 connection-private stream、abort fast lane 与 native
  save，不复用 Room owner authority。

### 7.2 Owner Room export

- 只有当前 active Human Room owner 可显式发起；authorize/begin/page/complete 复核 session、membership、
  owner role、lifecycle、access revision 与 policy。Tenant Administrator 无隐式 Room 权限。
- begin 冻结 authority watermark；每页≤256，BINARY keyset、streaming NDJSON、bounded memory、manifest
  与 checksums。disconnect/abort/timeout 释放 limiter，WS 对不协作 iterator 做本地 abort race。
- 内容包括 current/history message/revision、recall audit、project facts、memory/provenance、attachment
  inventory、governance audit、execution/tool metadata 与 source links；不含 secret/session/header/key/
  hidden reasoning/unrelated Room。
- v1→v29 与正式 legacy importer 的 pre-event revision 1 使用 eventless immutable fallback；一旦存在
  stable lineage，现代事实严格按 `seq <= W`。真实 backdated W+1 与 future client `sentAt` tests
  证明不越界也不漏 event-backed 数据。
- renderer 不能提交 filesystem path；Electron main native save 决定目标，server temp artifact 最长1h。

## 8. Retention 与 worker operations

Room message/project/memory/audit/archive chain 与 notification authority 随 Room lifecycle 保留；archive
不是 delete，recall 不是物理删除。Provider raw 永不持久化。context snapshot 与 sealed tool payload
按 recovery/review 状态有界清理；`outcome_unknown` 未闭合前保留必要数据。diagnostics 最长24h，server
export temp 最长1h。

schema v29 只保存 corpus-safe `privacy_retention_attempts` retry/dead-letter metadata，不含 secret、raw
corpus 或 export bytes。janitor 由 AuthorityWorker 单 writer 驱动，100/batch、startup+periodic、yield、
timeout、bounded backoff、8 attempts、terminal dead-letter/alert；malformed/poison item 不阻塞 batch tail。

closed worker inventory覆盖 agent runtime、route、memory steward、project reminder、notification、outbox、
idempotency janitor、retention janitor、Room export、diagnostics、repair/snapshot，并记录 max queue/active/
batch、timeout、recovery、shutdown、oldest age、60s warning/5m critical 与 corpus-safe metrics。

## 9. Electron / IPC / external-content 安全

- `contextIsolation:true`、`nodeIntegration:false`；navigation/new-window 默认拒绝。
- preload 只暴露 closed diagnostics/export/notification domain API；无 generic channel/fs/shell/URL/path/
  binary、token、cache key/path/DB handle。
- diagnostics/export 保存只在 trusted main frame、native dialog 与 bounded stream 中发生；renderer 无
  arbitrary path。
- attachment preview 继续执行 authorization、MIME、size、malware、sandbox 与 external-link allowlist。
- `verify:desktop-boundary` 已验证 33 个 renderer production source 无 Node/Electron authority。
- 真实 Electron smoke：app bridge、native selection、secure preview 均通过。

## 10. Schema 与迁移证据

- v28：FT-12 notification domain。
- v29：仅 `privacy_retention_attempts` closed metadata；没有 credential/secret/export body 表。
- v1-v27 migration SQL/checksum/fingerprint 保持不变；fresh/history、v28→v29、future/unknown、statement
  fault rollback、reopen、legacy importer 与 physical invariant suites 全部纳入最终全仓测试。
- 历史 export 兼容通过 read-side immutable event-lineage boundary实现，没有改写历史 migration 或伪造
  stable event。

## 11. 自动化与本地门禁

| 验证 | 结果 |
| --- | --- |
| 全仓 `corepack pnpm test` | 337 files：334 passed / 3 safely skipped / 0 failed；3186 tests：3183 passed / 3 safely skipped / 0 failed；834.68s |
| Core / Server / Desktop | Core 16 files / 136 tests PASS；Server 217 files、2247 tests，其中3 files/3 tests安全跳过；Desktop 104 files / 803 tests PASS |
| FT-14 Room export/legacy/Worker/WS/Desktop | independent reviewer 9 files / 214 tests PASS |
| Room export implementation focused | 16 files / 64 tests PASS |
| Retention/lease/composition reviewer matrix | 7 files / 38 tests PASS |
| Provider/migration reviewer matrix | 11 files / 106 tests PASS |
| TypeScript / lint / build | `pnpm typecheck`、`pnpm lint`、`pnpm build` PASS |
| Boundary / diff | Core、Desktop boundary 与 `git diff --check` PASS |
| Electron smoke | PASS |

3 个 skip 是没有显式 OpenAI secret 时的 opt-in live smoke，记录为“安全跳过”；未读取、打印或
探测 secret 值，也没有回退 production mock。focused 分类有重叠，不能相加为全仓总计。

## 12. Independent security/correctness reviewer

最终 reviewer 覆盖 secret ingress、Tenant Administrator越权、lease hard max/old key、diagnostics/raw
export混淆、owner ACL、fixed-W concurrent/backdate/future-time、historical migration/import、recall、
generic IPC、retention poison tail、non-cooperative stream abort 与 Provider no-retention。最终结论：

- 代码 P0：0；
- 代码 P1：0；
- 明确安全/正确性 P2：0；
- 除 production credential backend 外的 Requirement 代码缺口：0。

## 13. PR、CI、merge 与 Git 状态

| 证据 | 当前事实 |
| --- | --- |
| 内容 PR | 未创建；`REQ-NFR-006` production backend 尚未完成 |
| Required CI / Node matrix | 未发生；不得用本地结果替代 |
| Content merge SHA | 未发生 |
| Evidence-only PR / merge | 未发生 |
| 分支 / worktree | `codex/stage14-notifications-privacy-operations`；`/Users/leo/code/Dao-stage14` |
| 当前 base/head | `53f3fed8696293ee9644efa266c3585b66811267`，工作树变更未提交 |

原工作区 `/Users/leo/code/Dao` 仍为 `codex/ft02a-delivery-trace-fix@979863e`，四个 owner 未跟踪
计划的 SHA-256 与任务输入一致。临时 Stage 14 worktree 必须保留，直到真实内容/evidence PR 均合并
且确认没有未交付价值修改后才能按全局约定清理。

## 14. 已知风险、owner 决策与交付门

唯一外部架构 blocker：owner 必须批准并提供以下一种 production secret backend 及其部署认证、HA/
备份、root-of-trust 与 restart recovery 约束：

- Vault 或等价私有 secret service；
- 指定云平台 Secret Manager/KMS；
- OS credential store/HSM；
- sealed encrypted file，但 wrapping key 必须来自独立批准的外部 root-of-trust。

批准后仍需完成真实 backend adapter、management transport、rotation crash/restart matrix、secret
sentinel、重新终审和全仓门禁，再执行内容 PR/CI/merge、evidence-only PR/CI/merge 与 worktree 清理。
在这些证据真实存在前，本文件保持阻塞态，不代表 owner 验收或完整交付。
