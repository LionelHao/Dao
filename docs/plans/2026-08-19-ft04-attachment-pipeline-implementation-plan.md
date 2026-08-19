# FT-04 Attachment Authority & Pipeline：Stage 6 TDD 实施计划

> 日期：2026-08-19
> 配套设计：[`2026-08-19-ft04-attachment-pipeline-design.md`](./2026-08-19-ft04-attachment-pipeline-design.md)
> 方式：integration owner + 独立 worktree 子 Agent；每个切片先 RED、再最小 GREEN、focused suite、提交、owner cherry-pick/review。
> 禁止：共享 worktree、修改 Blueprint、覆盖原工作树四个 FT-09/10 未跟踪文档、fake production adapter、越权 merge、把静态 UI/单测冒充真实组合证据。

## 1. 开工门与权威映射

| 门 | 必须证据 |
| --- | --- |
| baseline | `origin/main` SHA、clean integration worktree、无 open PR、全量测试与边界检查计数 |
| product | `REQ-PRIM-009`、`REQ-MSG-009`；cross-cutting Requirement/FT 清单已映射 |
| UI | J-02 十态、四轴事实源、错误/离线/repair/archive/revoke、键盘/焦点/非颜色/aria-live/zoom/reduced-motion；偏离“无” |
| security | Electron runtime advisory 清零；scanner/extractor/OCR 是真实 dependency；missing dependency fail closed |
| migration | schema v17 唯一追加；v1～v16 checksum/statement 不变；fresh/upgrade/future/tamper/rollback/restart evidence |
| integration | Core → Worker → Server/WS → sync/repair/outbox → Desktop closed bridge 顺序；后层不能用 mock 绕过前层 |

预先登记的 Stage 5 recovery debt 也是门：Core 已声明 `message-revision` repair variant，但 Room repair runtime registry、snapshot descriptor 和 Desktop staged replica 未闭合实现。FT-04 增加 attachment record 前先补 active revision chain；recalled 只输出 tombstone，绝不 repair raw revision。

## 2. TDD 矩阵

### 2.1 Core / protocol

| ID | 先写 RED | GREEN 判据 |
| --- | --- | --- |
| C01 | 所有 attachment/upload/event/repair/error guard 的 unknown key、空 ID、非 canonical SHA/time、非法 enum | exact closed guard；type tests 拒绝 path/URL/token/author 注入 |
| C02 | 四轴→十 UI 状态映射，尤其 archive/revoke/recall 正交 | 单一确定性优先级；无“一个 durable enum”污染 |
| P01 | begin/chunk/finalize/cancel/retry/status/access frame 最长 envelope | closed parser；raw chunk ≤32 KiB；encoded frame <64 KiB |
| P02 | changed uploadKey metadata/hash、duplicate ordinal changed bytes、cross Room/family | exact replay 原 receipt；changed payload 409；handler 零越权调用 |
| P03 | 413/415/422/429/503、401/403/409/410 映射 | stable status/code；错误无 path/raw tool/secret/stack |

### 2.2 Schema v17 / AuthorityWorker

| ID | 先写 RED | GREEN 判据 |
| --- | --- | --- |
| D01 | fresh v17、v1～v16逐版升级、future/tamper | version=17；历史 checksum/statement 不变；未知/篡改拒绝 |
| D02 | 对每个 meaningful v17 statement 注入失败 | 全部 rollback 到 v16；无半表/trigger/user_version |
| D03 | FK/UNIQUE/CHECK/trigger 手工 corruption | forged link/source、换绑、跨 Room、非 ready bind、非法状态边失败 |
| D04 | restart/replay/orphan metadata | 无 duplicate upload/attachment/attempt/source/event/outbox |
| A01 | begin + 1600 chunks checkpoint、exact replay、offset/hash mismatch | bounded rows/files；same replay；mismatch 409 |
| A02 | finalize size/hash/type mismatch、archive/revoke/repair barrier race | 接受前零 artifact；先安全 reduction 则零 business result |
| A03 | scanner clean/malware/unavailable、extract/OCR success/error/timeout/cancel | fail closed；malware terminal；retry generation CAS；late result zero write |
| A04 | source bind two messages/recall/archive/revoke races | one transaction one winner；message/link/source/event/outbox/receipt 全有或全无 |
| A05 | preview/download/context auth denied | object adapter/file read 调用计数 0；授权时每请求恰一次 authority check |

### 2.3 Store / process hardening

| ID | 先写 RED | GREEN 判据 |
| --- | --- | --- |
| F01 | part/rename/fsync/DB CAS 每个 crash window | 按设计 truth table恢复；不可见 orphan 有界清理 |
| F02 | symlink/traversal/TOCTOU/permission/oversized filename | root private；opaque keys；no-follow/exclusive；无 client path |
| F03 | zip traversal、10k+ entry、>200MiB展开、>100:1；PDF>500页；image>40MP | 422；外部工具不启动或在 budget 前终止 |
| F04 | stdout/stderr/output/timeout/concurrency/queue overflow | caps 生效、进程 kill、normalized error、日志 sentinel 零命中 |
| F05 | clamscan/tesseract/pdf tools 缺失 | capability degraded；job retryable；绝无 fake-ready/no-op fallback |

### 2.4 Sync / repair / privacy

| ID | 先写 RED | GREEN 判据 |
| --- | --- | --- |
| S01 | unbound private event + Room subscriber | 仅 principal target；Room event/repair 零 metadata |
| S02 | bind/recall/replay/late outbox | bind 后当前授权 Room可见；recall后 excluded；重放重新投影不泄露 |
| S03 | runtime union 与 registry kind 不完整 | 编译期 exhaustive helper + runtime missing-kind test |
| S04 | active message revisions + bound attachments streaming/materialized repair | 两模式同 checksum/records；recalled raw 0；watermark/access变化 fail closed |
| S05 | raw bytes/OCR/path/tool output/token sentinel scan | DB/WAL/event/outbox/snapshot/repair/cache/log/diagnostic 零命中 |

### 2.5 Desktop / live

| ID | 先写 RED | GREEN 判据 |
| --- | --- | --- |
| U01 | native selection result包含 path、generic channel、过期 handle | renderer DTO 无 path/token/url；closed IPC exact channels；TTL/cap |
| U02 | real byte ACK progress/cancel/retry/revoke purge | 不按 timer 伪造；fd/socket/action 取消；重试稳定业务 key |
| U03 | J-02 十态组件、error/offline/repair/archive | 可见文案与 authority source一致；malware/revoke不可 preview/send |
| U04 | keyboard/focus/aria/non-color/zoom/reduced motion | 单 bounded live region；preview live=off；核心动作不裁切 |
| U05 | preview PDF/image/text/Office，navigation/network/window open | 每次 reauth；sandbox；0 arbitrary URL/node/fs/path |
| E01 | compiled Worker/SQLite/WS/Desktop main，多客户端、restart、repair、revoke | 真相最终一致；无 mock transport/fake adapter冒充；计数可复核 |

## 3. 实施切片与文件所有权

每轮 agent 开工先报告独立 worktree、branch、base SHA、`git status` 和唯一文件所有权；结束报告 RED 命令/失败摘要、GREEN 命令/计数、commit SHA、剩余风险。owner 只 cherry-pick 并审查已提交 commit。

### Wave 0 — 只读审计（已派发）

- adversarial reviewer：权威/状态机/race/privacy 反例；无文件所有权。
- code seam auditor：Core/Worker/WS/sync/Desktop 接缝与最小切片；无文件所有权。
- dependency/security auditor：Electron、ClamAV、PDF/OCR/ZIP 真实组合与 license/advisory；无文件所有权。

### Wave 1 — 可并行基础

| Agent | 独占文件 | 交付 |
| --- | --- | --- |
| Core contracts | `packages/core/src/attachment-authority.ts`、对应 test/type-test、`packages/core/src/index.ts` 必要 export | C01/C02；closed types/guards/UI view mapping |
| schema v17 | `packages/server/src/persistence/schema.ts`、新增 `schema-v17.test.ts`、必要 schema tests | D01～D04；statement/rollback counts |
| Desktop renderer contract | 新 `packages/desktop/src/renderer/attachment-authority/**` | U03/U04；不碰 preload/main/transport |

owner 同时完成设计评审修正、dependency version 决策、protocol/worker接口草图，不触碰 Agent 独占文件。

### Wave 2 — Server authority / store / process / recovery

依次基于 Wave 1 集成 SHA 建新 worktree：

1. object store + magic/bomb/process adapters（F01～F05）；
2. AuthorityWorker contracts + DB handlers + v17 commands（A01～A05）；
3. protocol/WS/authoritative-server composition + limits（P01～P03）；
4. message source bind 单事务和 FT-03 non-empty attachment gate；
5. revision/attachment repair registry、snapshot reference hydration、private principal outbox（S01～S04）。

同一文件面较宽的 `authority-database-handler.ts`、`worker-protocol.ts`、`snapshot-worker.ts` 绝不并行分给两个 Agent；owner 按提交序列集成，冲突处重跑 focused suite。

### Wave 3 — Desktop closed native integration

1. main selection registry、native dialog、bounded reader、download writer；
2. closed IPC/preload contracts；
3. attachment WebSocket authority client/progress/cancel/retry；
4. renderer surface 接入消息 composer/bound projection；
5. sandbox preview policy与 Electron smoke。

任何 renderer-visible API 都以 contract test 证明没有 path、Node handle、session token、URL 或 generic invoke/send。

### Wave 4 — adversarial hardening / final evidence

- 原 reviewer 复审完整 diff 和 authoritative design mapping；
- dependency auditor 重跑 audit/license/capability probes；
- crash/restart/outbox/repair/revoke/agent-context race；
- full suite、typecheck、lint、build、boundary、Electron live smoke、`git diff --check`。

## 4. 真实 adapter 组合与依赖变更规则

- Electron 升级采用官方 advisory 已覆盖的精确版本，不保留 `^` 漂移；实际 binary smoke 必须可运行。
- ZIP 库若新增，必须精确锁版本、记录 MIT/兼容 license、只在 DOCX/XLSX bounded parser 内使用，不把 arbitrary unzip 导出到 package root。
- ClamAV、Tesseract、Poppler 是 external runtime capability；启动探针记录 executable/version/availability（不记录环境路径），未安装不影响非附件启动，但 Stage 6 live attachment smoke 可据实 skip，不能伪造 pass。
- CI 增 capability-independent deterministic process fixture 测真实 `spawn`/timeout/cap/exit mapping；只有 malware signature/OCR/PDF end-to-end 依赖主机程序。

## 5. PR 与 merge 拓扑

每个 PR 都从当时最新 `origin/main` 创建，ready（非 draft），描述 Requirement、设计映射、RED/GREEN、风险与未验证项。计划顺序：

1. Core contracts + schema v17；
2. server authority/store/process/protocol/sync；
3. Desktop closed bridge + renderer + Electron security；
4. hardening/evidence/delivery docs（若前三个 PR 后仍有独立修正）。

每个 PR：push → CI 全绿 → owner review → squash merge → 回读 merge SHA/remote main → 删除远端 feature branch → 下一 PR rebase/重建于最新 main。禁止 force-push main；失败 CI 必须修复并重新等待，不降门禁。

## 6. 最终质量命令与计数

至少运行并记录：

```text
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
corepack pnpm audit --json
corepack pnpm --filter @native-im/desktop smoke:electron
git diff --check
```

交付说明必须给：文件列表；Test Files/Tests passed/skipped/failed；schema v17 meaningful statements 与逐 statement rollback 数；Core/Server/Desktop/process/Electron focused 计数；lint warning；live smoke pass/skip 及 skip 原因；PR/commit/squash merge/remote main；未满足依赖不得写成 pass。
