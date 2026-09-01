# Stage 14 rebaseline：Notifications & Security-Operations Closeout

> 日期：2026-08-31  
> 状态：实施基线；不是交付、验收或 verified 声明  
> 基线：`origin/main@53f3fed8696293ee9644efa266c3585b66811267`，Authority schema immutable v27

## 1. 远端与工作区事实

- PR #77（FT-13 内容）已合并，merge SHA `551e9983f1ae4205c090387f371c139db4b16847`；required CI run `33388107739` 的 Node 22.13.1 与 Node 22.x jobs 均成功。
- PR #78（FT-13 evidence）已合并，merge SHA 与当前 `origin/main` 均为 `53f3fed8696293ee9644efa266c3585b66811267`；最终 required checks run `33393070675` 双 Node matrix 成功。
- 启动时无 open PR、无 Stage 13 临时 worktree。Stage 14 分支为 `codex/stage14-notifications-privacy-operations`，隔离 worktree 为 `/Users/leo/code/Dao-stage14`。
- 原始工作区 `/Users/leo/code/Dao` 保持在 `codex/ft02a-delivery-trace-fix@979863e7936962626b54a130d0260a4689a9bfb0`。四个 owner 未跟踪文件只读保护；启动 SHA-256 与任务给定值完全一致。
- 不手改 Blueprint HTML/JSON，不 force push，不改写 v1-v27 migration。

权威优先级固定为 PRD → approved protocol / feature spec → 正式 UI / 交互基线 → 生产代码与测试。本文只登记差距与本阶段实施边界，不用现有代码覆盖批准语义。

## 2. Stage 13 精确继承基线

- 全仓：270 files，267 passed / 3 safely skipped / 0 failed；2804 tests，2801 passed / 3 safely skipped / 0 failed。
- Core：13 files / 117 tests；Server：180 files / 2004 tests；Desktop：77 files / 683 tests。
- 三个 skip 是无显式 OpenAI secret 时安全跳过的 opt-in live smoke，不回退 production mock。
- 单一 closed repair registry 当前恰有 33 个 kind；materialized/streaming、canonical bytes、checksum、fixed watermark、Desktop staging generation 和 durable ledger 已由 FT-13 证明。
- Authority schema v27 为 immutable predecessor。Stage 14 只允许追加迁移；通知物理 authority 预留 v28。只有 FT-14 确有不含 secret 的持久 metadata/job/audit 需要时才追加 v29。

## 3. FT-12 Stage 14 启动时事实：完整、seam、prototype-only、缺失

### 3.1 已完整实现并复用

- FT-09 已有 Human reminder/boundary claim 与 `human_notification` dispatch seam；due 边界可跨重启稳定 claim。
- FT-13 已有单一 closed repair registry、recipient/principal outbox target、fixed-watermark repair、逐页权限复核、Desktop encrypted complete-generation cache 与 revoke purge。
- Message、Project、Invocation、Tool Safety 都已有 stable source ID、revision/boundary 或 terminal projection，可作为 notification producer 的权威来源。

### 3.2 只有 seam

- `human_notification` 是 dispatch seam，不是 durable recipient-scoped Notification fact。
- Room list、renderer shell 与各 feature runtime 有 badge/事件接入位置，但不存在同一 notification projection 驱动的权威 badge/center。
- J-07 正式设计稿完整定义 flat center、read/handled、多 session、deep link、offline/repair；Stage 14
  启动基线中的生产 Desktop 尚未接入该业务表面。本阶段当前实现状态见 work note 与 FT-12 delivery。

### 3.3 prototype-only

- 正式审阅稿中的演示 notification item、步进按钮、滚动与高亮只表达批准状态；没有 server command/ACK/event/projection 支撑前不得宣称业务成功。
- OS notification/toast、typing、Provider chunk 和 transient preview 均不是 notification authority，也不得写入 repair。

### 3.4 缺失，本阶段补齐

- 独立 closed Notification core/server/Desktop domain；八类 producer；server-derived recipient；canonical dedupe unique binding。
- notification fact + stable event + outbox + receipt 同一 AuthorityWorker transaction。
- recipient-scoped list/query、mark-read ACK/event、handled source projection、source resolution、closed error/retry/revoke 合同。
- repair kind `notification`、recipient filtering、多页 revoke preemption、Desktop event/cursor/cache 同事务。
- flat center、Room badge、read/handled 分离、多 session convergence、deep link/inaccessible-source 安全失败与 J-07 状态/a11y。

## 4. FT-14 Stage 14 启动时事实：完整、seam、缺失与阻塞

### 4.1 已完整实现并复用

- 单租户 SQLite authority、Tenant Administrator principal/Profile 管理与 Room ACL 分离。
- Provider/模型固定披露基础；OpenAI Responses adapter 已使用 `store:false`；无多 Provider、无自动 fallback。
- server-side `EnvironmentSecretProvider` 只读取 `OPENAI_API_KEY`；credential 缺失派生 `noauth`，服务仍可启动，invoke fail closed。
- context snapshot 已有 payload retention state/purge seam；Tool Safety 有 sealed side-effect payload expiry/review seam。
- FT-13 offline lease 已具 Ed25519 claims、server max policy、Desktop pinned verifier、encrypted cache 与 exact expiry mechanism，但 release default/hard maximum/rotation policy有意未冻结。
- Electron 已启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，拒绝新窗口、任意 navigation 和 permission request；preload 为 closed domain bridges。

### 4.2 只有 seam

- Tenant Administration 的 ordinary credential mutation 仍是 closed `unsupported` seam。
- outbox/idempotency/repair/runtime 等已有 bounded retry/dead-letter/alert primitives，但没有 Stage 14 closed worker inventory 与统一运维 runbook。
- context/tool payload 已有局部 retention 状态，但未形成跨数据类别、startup recovery、tail completion 的 retention policy/janitor 证明。

### 4.3 缺失，本阶段补齐

- offline lease threat model、release default/min/max、clock skew、issue horizon、key overlap/cutoff 与启动配置验证。
- closed Provider adapter no-retention inventory、request/error/corpus sentinels与 disclosure revision。
- diagnostics bundle allowlist 与 owner Room raw export 的两条独立权限/字节路径。
- export fixed watermark、streaming bound、manifest/checksum、recalled audit/content、ACL/revoke race。
- retention 分类、context/tool/notification/diagnostics/export janitor；closed worker/alert inventory与 runbook。
- Electron/IPC/attachment/external-link/CSP/path traversal 的全边界审计与恶意输入测试。

### 4.4 生产 credential rotation 的确认阻塞

仓库唯一生产 secret backend 是 `packages/server/src/agent-runtime/environment-secret-provider.ts`：接口只有同步 `getSecret("OPENAI_API_KEY")`，来源只有只读 `process.env`。仓库没有 Vault、KMS、Secrets Manager、系统 keychain/keytar 或其他可写、版本化、可恢复 backend；Tenant Administration 明确拒绝 credential mutation。

因此无法在不改变部署/安全架构的情况下实现生产配置/轮换。以下做法均禁止：把 secret 写入 Authority SQLite/WAL、普通配置/日志文件、`process.env` mutation、不可恢复内存变量或 production mock。Stage 14 可先完成 closed rotation state machine、backend port、audit metadata、crash matrix 与候选方案对比；真实 production composition 必须等待 owner 批准具体 secret backend。

## 5. 22 条 direct Requirement

### 5.1 FT-12（5）

| Requirement | Stage 14 证据目标 |
| --- | --- |
| `REQ-PRIM-017` | Ball/Blocker/due 的 bounded Notification 或 Agent escalation，source/holder/boundary 可追溯 |
| `REQ-PRJ-010` | deferred 与 cannot_answer 分义；cannot_answer 产生一次 recipient-scoped escalation |
| `REQ-PRJ-012` | due 立即一次、未闭合每 24h 一次；跨重启 canonical dedupe |
| `REQ-UX-003` | Room badge 与 flat center 同 projection；无旧五分区工作台 |
| `REQ-UX-008` | 八类 durable recipient-scoped notification、read/handled、deep link、repair、多 session；无 OS push |

### 5.2 FT-14（17）

| Requirement | Stage 14 证据目标 |
| --- | --- |
| `REQ-AGT-004` | noauth/ready 重启派生；部署管理与 Room ACL 分离 |
| `REQ-AGT-009` | 固定 Agent/provider/model/generation；有界 retry；无 fallback |
| `REQ-AGT-013` | outcome_unknown 数据保留到 review/compensation 后才清理 |
| `REQ-ID-004` | Tenant Administrator 管理 deployment metadata 但无隐式 Room read |
| `REQ-ID-005` | finite server lease、release policy与 revoke residual exposure |
| `REQ-MEM-010` | worker degraded/alert 合同；project authority 不可读时 due fail closed |
| `REQ-MEM-012` | 必要 frozen context + no-retention + no raw/secret/reasoning logs |
| `REQ-MSG-006` | recalled raw 只进授权 Human audit/export，不进 operational context/Provider |
| `REQ-MSG-010` | AI visibility disclosure；recall/tombstone exclusion |
| `REQ-NFR-001` | 单租户 SQLite authority；diagnostics/export/cache均非事实源 |
| `REQ-NFR-003` | bounded outbox/dead-letter/alerts 与恢复 runbook |
| `REQ-NFR-005` | closed worker inventory、queue/batch/timeout/retry/recovery/shutdown |
| `REQ-NFR-006` | 单 Provider/模型、一份 server credential、rotation/audit、无 BYOK/fallback |
| `REQ-NFR-008` | lease default/min/max、key overlap/cutoff、misconfiguration fail closed |
| `REQ-NFR-009` | closed diagnostics allowlist、secret/corpus sentinel、与 raw export 分离 |
| `REQ-NFR-012` | owner fixed-watermark Room export、retention、无永久删除 UI |
| `REQ-NFR-013` | Electron isolation、closed IPC、安全附件/链接/path/CSP |

跨 FT 的 Requirement 只作为 integration evidence，不增加直接范围。

## 6. 共享热点与串行接入

主集成 owner 独占：`schema.ts` 与 schema tests、AuthorityWorker/handler/protocol、authoritative server composition、WebSocket、repair registry assembly、Desktop main/preload、renderer app shell及最终 delivery 文档。FT-12/FT-14 私有模块先冻结 closed contracts/TDD，随后按 v28 → Authority transaction → protocol/repair → Desktop shell 的顺序串行接入。

## 7. 明确排除

无 OS push、Electron system notification 唯一入口、旧 M4 五分区、global search、Mobile/Web、BYOK、多 Provider、自动 fallback、永久删除 UI、跨租户、第二 Authority DB/event bus/repair snapshot、offline command queue、客户端伪造 read/handled、generic fs/shell/URL/binary IPC、hidden reasoning persistence、FT-15 pilot 或 FT-11 已完成声明。

## 8. 阶段门

只有 FT-12/FT-14 批准范围、文档、自动化证据、独立 reviewer、内容 PR/CI/merge、evidence-only PR/CI/merge 和 worktree 清理全部完成，且 credential backend 阻塞获得 owner 决策并完成真实 production composition 后，才能写“已达到交付条件，等待 owner 验收”。不得写 verified 或 owner 已验收。
