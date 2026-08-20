# FT-05 Room Memory Authority & Steward：Stage 7 实施计划

> 日期：2026-08-19
> 基线：`origin/main@65d92f56f6b7426d2c65c4a6f0e3def5b07b60fe`，authority schema v17，Test Files `133 passed / 2 skipped / 0 failed (135)`，Tests `1607 passed / 2 skipped / 0 failed (1609)`。
> integration：`/Users/leo/code/Dao-stage7-ft05-memory`，branch `codex/ft05-stage7-integration`。
> 方法：严格 RED→GREEN；每波独立 worktree/branch/所有权；integration owner 逐提交 review/cherry-pick；不复制整棵目录。

## 1. 合入切片与依赖顺序

1. 设计冻结 + Core closed contracts：source/memory/version/health/raw-delta/protocol/repair DTO guards 与 type-negative tests。
2. schema v18：唯一 migration、约束/trigger、v1～v17升级、逐 statement rollback、fingerprint/tamper。
3. corpus/source/watermark authority：FT-03/04 adapters、>64、revision/recall/revoke、checkpoint/raw delta。
4. steward/provider/worker/degraded：closed parser、OpenAI Responses+SecretProvider、FIFO scheduler、retry/dead-letter/recovery。
5. protocol/AuthorityWorker/WS/runtime gate：query/dispute/resolve/status/retry、idempotency、explicit/proactive behavior。
6. sync/repair/replica：feature-owned descriptor接入FT-13唯一registry、fixed watermark、cache purge、multi-client收敛。
7. Desktop Memory panel：closed main/preload/controller/live panel、source deep link、offline/repair/a11y。
8. race/security/restart/E2E hardening：archive/reopen/revoke/late generation/outbox replay/combined sentinel/production composition。
9. work note + delivery truth：精确计数、ready heads、CI URLs、squash SHAs、origin/main与worktree状态。

每个切片基于当时最新 `origin/main` 建 ready PR；Node 22.13.1 与 22.x required checks全绿后 squash merge，fetch确认远端 main包含 merge，再为下一切片rebase/cherry-pick。不得 force push main 或绕过失败检查。

## 2. 文件所有权矩阵

| slice owner | exclusive paths | shared integration-only files |
| --- | --- | --- |
| Core contracts | `packages/core/src/room-memory*.ts`及tests | `packages/core/src/index.ts`只由该slice owner一次接线 |
| schema v18 | `packages/server/src/persistence/schema.ts`、`schema-v18.test.ts`、必要既有schema version assertions | 无其他Agent并行触碰schema.ts |
| corpus authority | `packages/server/src/room-memory/corpus-*`及tests | `authority-database-handler.ts`由integration owner接线 |
| steward/provider | `packages/server/src/room-memory/steward-*`及tests | production server composition由integration owner接线 |
| protocol/runtime | `packages/server/src/room-memory/protocol-*`及tests | `worker-protocol.ts`、`authority-worker.ts`、`protocol.ts`、`websocket.ts`、`authoritative-server.ts`仅integration owner串行接线 |
| sync/repair | `packages/server/src/room-memory/repair-*`、`packages/desktop/src/sync/room-memory-*`及tests | `snapshot-worker.ts`中央registry仅integration owner接线 |
| Desktop | `packages/desktop/src/memory-authority/`、`renderer/memory-authority/`及tests | `main.ts`、`preload.ts`、`renderer/main.ts`仅integration owner串行接线 |
| docs/delivery | 本三文档与最终delivery | integration owner only |

任何新共享 API 先以消息报告，确认owner后再接线。所有 Agent 从指定 integration SHA 建独立 worktree，开始报告 status/base/ownership，先贴 RED，再 GREEN/commit/files/tests/risks；不自行merge、改Blueprint或任务状态。

## 3. RED→GREEN 测试顺序

### Wave 1：contracts/schema/parser foundations

- Core exact guards：五类kind、source identity、version state、health、raw delta、protocol frame、repair record；extra/symbol/non-enumerable/enum/length/cross-shape拒绝；type-negative证明client不能提交authority字段。
- schema v18：先令 `AUTHORITY_SCHEMA_VERSION` 期望18失败；fresh+v1..v17升级；meaningful statement fault loop；future/history checksum/physical tamper；restart；v17数据保持。
- provider parser：invalid JSON、duplicate key、extra key、oversize、UTF-8、unknown/cross-Room/non-frozen source、fake confirmer/project authority/path/URL/tool/secret字段均RED。
- Desktop DESIGN_CONTRACT/view model：正式所有状态、事实源、401..503、keyboard/focus/aria/zoom/reduced motion先RED，不接静态生产回调。

### Wave 2：durable authority/worker/protocol

- corpus：message/revision/tombstone/ready-bound extraction顺序/去重；65+历史首项source ID读取；restart backfill；revoked/malware/unbound零进入。
- watermark：contiguous batch、duplicate event/batch、multi-page tail、noauth/timeout/crash不前进、late generation CAS、reopen恢复。
- memory：Context auto-active、非Context proposal、dedupe/merge source union、multi-source失效规则、dispute exact replay/concurrency、resolve append chain。
- worker：Room内FIFO、跨Room≤4、batch32、queue/recovery有界、timeout/retry/backoff/dead-letter/manual retry、新attempt不复活旧attempt。
- protocol：exact frames、requestId ACK、server principal injection、400/401/403/404/409/410/429/503、body/secret/error sentinel。
- runtime gate：message ACK/provider调用未等待；explicit invocation不因memory failure取消；semantic proactive在catching-up/noauth/degraded/failed Adapter call 0。

### Wave 3：sync/Desktop/E2E

- repair：feature descriptor→FT-13 central registry、projection parity、fixed watermark、quota fallback、clear-cache、send-before-mark replay dedupe、source availability/raw exclusion。
- three-client loopback WS：两个Human+一个额外授权设备，query/dispute/resolve live收敛；restart delta/history/repair；membership/session revoke purge。
- Desktop：bridge/controller/replica/panel production chain；source deep link到message/tombstone/attachment；offline/repair/revoke/archived；old epoch result不能恢复权限。
- a11y：完整键盘遍历、Esc焦点返回、文字/图标非颜色、bounded aria-live、VoiceOver labels、840×560、1440×900、200%、reduced motion。
- combined sentinel：raw message/attachment只在原authority域；recalled raw在operational域零命中；Provider raw/prompt/secret/reasoning/header在全部durable/diagnostic域零命中；production没有fake/no-op/static fallback。

## 4. 验证矩阵

focused命令随实现文件落地后固定在work note；最终同一完整HEAD依次运行：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
corepack pnpm --filter @native-im/desktop smoke
git diff --check
```

额外门禁：schema v18 focused；Core memory；corpus >64；parser/provider/noauth；real SQLite/AuthorityWorker/restart；real three-client WebSocket；revision/recall/attachment matrix；degraded/proactive Adapter-call-zero；Desktop DOM/keyboard/a11y；raw/provider/secret combined sentinel；production fake/no-op sentinel；OpenAI Memory Steward opt-in live（有secret运行、无secret安全skip）。只有修改dependency才运行 full/prod audit与license检查。

最终必须记录 Test Files/Tests exact passed/skipped/failed、schema meaningful/rollback数、Core/Server/Desktop/real-process/Electron计数、lint warnings、live smoke、每个CI run和Node job状态。

## 5. 风险阻断与审阅点

- schema reviewer：连续 corpusSeq/watermark与append-only trigger，逐statement rollback及旧fingerprint不变。
- privacy/security reviewer：raw corpus不复制、recall立即排除、Provider closed parser、sentinel域定义。
- protocol/sync reviewer：idempotency/outbox、projection-at-send、repair registry单一、fixed watermark。
- runtime reviewer：explicit继续、semantic proactive call-zero、archive/reopen/late attempt。
- Desktop/a11y reviewer：正式右栏状态、source navigation、授权epoch purge、最小窗/缩放/VoiceOver。

Desktop 状态补充的 owner 批准来源是本 Stage 指令；它只补齐正式审阅稿未逐屏展示的 Memory 状态，不改变既有三栏/右栏视觉关系。feature `DESIGN_CONTRACT.md`、可到达 DOM tests 与 Electron production smoke 是强制替代验收证据，不能只写文档声明。

若仓库权威输入出现无法消解的产品冲突才暂停询问owner；migration表名、容量、batch、timeout、retry等已在设计中冻结，不作为等待owner的普通工程选择。
