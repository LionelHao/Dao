# Stage 14 work note：Notifications & Security-Operations Closeout

> 日期：2026-08-31  
> 状态：进行中；只记录真实进展，不是交付、验收或 verified 声明

## 1. 启动事实

- `origin/main@53f3fed8696293ee9644efa266c3585b66811267`；PR #77/#78 合并与 required CI 双 Node matrix已复核。
- 隔离分支/worktree：`codex/stage14-notifications-privacy-operations` / `/Users/leo/code/Dao-stage14`。
- 原工作区HEAD、分支、四个owner未跟踪计划和SHA-256均与任务给定值一致；不在原工作区写入。
- schema predecessor immutable v27；repair registry 33 kinds；Stage 13 baseline 270 files/2804 tests（3 opt-in live safely skipped）。

## 2. 并行 ownership

| 轨道 | Agent | 私有范围 | 禁止热点 |
| --- | --- | --- | --- |
| FT-12 domain/producers | Sol high Agent A | Core notification、server producer/domain/SQLite helper/tests | schema/Authority/composition/repair assembly/Desktop shell/delivery |
| FT-12 Desktop/J-07 | Sol high Agent B | notification replica/view-model/surface/a11y/tests | main/preload/app shell/shared sync assembly |
| FT-14 secrets/lease | Sol high Agent C | lease/keyring/rotation/provider inventory/no-retention/tests/threat/runbook | shared schema/Authority/composition/Desktop shell/delivery |
| FT-14 privacy operations | 主Agent | diagnostics/export/retention/worker inventory与后续shared接入 | 单一shared owner |

主Agent独占schema v28/v29、AuthorityWorker/handler、protocol/WebSocket、repair registry assembly、server/Desktop composition、main/preload/app shell、delivery、review/PR/evidence/cleanup。

## 3. 已冻结工程决策

- Notification closed kinds/source kinds、recipient-from-authority、canonical unique binding、read/handled分离、source-inaccessible minimal revoke、repair kind `notification`。
- offline lease：release配置模板显式写8h，production缺失/非法拒绝启动；hard min 5m、hard max 24h、clock skew grace 0、previous-key overlap 24h；客户端不可上调。
- diagnostics：closed allowlist、deterministic/checksummed、安全文件名、≤10k entries/1MiB，无raw corpus/secret/path/stack。
- owner Room export：fixed watermark、≤256/page、streaming NDJSON、manifest/digest、owner/session/membership/revision每页复核、diagnostics严格分离。
- retention：Provider raw never persist；Room/notification authority随Room lifecycle；diagnostics≤24h；server export temp≤1h；outcome_unknown/recovery data不提前清。
- closed worker inventory复用FT-13 bounded retry/dead-letter/alerts，不建第二scheduler/event bus。

## 4. 当前阻塞

生产 credential backend不存在：只有只读environment provider与`getSecret`，没有可写/版本化/restart-recoverable secret backend。Owner必须批准实际 Vault/KMS/Secrets Manager或系统credential store架构；禁止SQLite、普通文件、process.env mutation、in-memory或mock替代。其余工作继续。

## 5. 最终非阻塞验证账本

以下结果来自当前未提交工作树；它们证明非 credential-backend 范围的本地候选，不是 PR、CI、merge
或 owner 验收证据：

| 范围 | 结果 |
| --- | --- |
| 全仓 `corepack pnpm test` | 337 files：334 passed / 3 safely skipped / 0 failed；3186 tests：3183 passed / 3 safely skipped / 0 failed；834.68s |
| Core | 16 files / 136 tests，全部 PASS |
| Server | 217 files：214 passed / 3 safely skipped；2247 tests：2244 passed / 3 safely skipped |
| Desktop | 104 files / 803 tests，全部 PASS |
| TypeScript | `corepack pnpm typecheck` PASS |
| ESLint | `corepack pnpm lint` PASS，`--max-warnings=0` |
| Workspace build | `corepack pnpm build` PASS：Core、Server、Desktop |
| Boundary | Core boundary PASS；Desktop renderer 33 production sources 无 Node/Electron authority |
| Electron smoke | app bridge、native selection 与 secure preview PASS |
| Diff | `git diff --check` PASS；无 Blueprint HTML/JSON 修改 |
| FT-12 高扇出 recall/outbox | broader 11 files / 77 tests PASS；真实 320-row recovery integration 5 files / 38 tests PASS |
| FT-14 Room export 与历史兼容 | 实现 Agent 16 files / 64 tests PASS；独立 reviewer 9 files / 214 tests PASS |
| 独立终审 | 当前工作树代码 P0/P1/明确安全正确性 P2 = 0/0/0 |

3 个 skip 仍是没有显式 OpenAI secret 时安全跳过的 opt-in live smoke；未读取、打印或探测 secret
值，也没有回退 production mock。focused 分类互相重叠，不可与全仓总数相加。

## 6. 当前状态与下一步

1. FT-12 与 FT-14 非 credential-backend 代码、schema v28/v29、协议、UI、runbook、本地验证与独立审阅已冻结；
2. production credential rotation 继续保持 `configuration_unsupported`，等待 owner 批准 Vault/KMS/
   Secrets Manager/系统 credential store 或具有外部 root-of-trust 的 sealed backend；
3. backend 决策落地后接通真实 `observe/stage/activate/discard`、Tenant Administrator 管理 transport、
   restart reconciliation、rotation crash matrix 与 secret sentinel；
4. 重新运行独立终审和全仓门禁；
5. 内容 PR/required CI/merge → evidence-only PR/required CI/merge → 核验真实远端 merge → 清理临时 worktree。

在第 2 项解除前不得提交一个声称 Stage 14 完成的内容 PR，也不得宣称交付门已经满足。
