# FT-04 Attachment Authority & Pipeline · 第六阶段总交付说明

> 日期：2026-08-19
> 状态：代码已经受保护 CI 交付远程 `main`；本文是交付事实记录，不表示 owner 已验收，不改变 Blueprint 状态。
> predecessor：`origin/main@e3075fa4f7f031d7db3757fd0d0039dc30e8fb69`，authority schema v16
> FT-04 可执行代码交付基线：`origin/main@2cee92a322569235d08a6af0b28e5964f503073d`，authority schema v17

## 1. 一句话结果

FT-04 已形成从 Desktop native 选择、32 KiB 有界上传、服务端 quarantine/扫描/提取/OCR、AuthorityWorker 权威状态与消息 source 单事务绑定，到逐次授权预览/下载、跨设备 sync/repair 与 J-02 十态界面的生产闭环，并以真实 SQLite、WebSocket、restart、三认证客户端、Electron sandbox 和联合 sentinel 自动化证明其权威、边界与不泄露性。

## 2. Requirement、FT 与设计旅程

- 直接主责：`REQ-PRIM-009`、`REQ-MSG-009`、FT-04。
- 消息横切：`REQ-MSG-001`、`002`、`005`、`006`、`010`；ready-only source bind、revision 不改 attachment link、recall operational exclusion。
- 非功能横切：`REQ-NFR-001`～`005`、`007`～`011`、`013`、`014`；唯一 writer、事务权威、有界资源、安全失败、幂等、重启、可观测不泄露、跨设备收敛。
- UX 横切：`REQ-UX-007`、`REQ-UX-009`；J-02 composer/timeline attachment card、offline/repair/revoked、键盘/焦点/非颜色/VoiceOver/zoom/reduced motion。
- 共享权威边界：FT-01 session family/membership 重授权；FT-02 archive 只读；FT-03 message/source/revision/recall 事务；FT-13 event/outbox/sync/repair/cache；FT-16 正式 J-02 设计合同。
- 设计旅程：J-02 上传、处理、ready、绑定、失败恢复、预览/下载；J-07 offline、repair、archive/revoke 收敛。
- 权威输入映射保存于 `docs/plans/2026-08-19-ft04-attachment-pipeline-design.md`、`docs/plans/2026-08-19-ft04-attachment-pipeline-implementation-plan.md`、`docs/plans/2026-08-19-ft04-stage6-work-note.md` 和 `packages/desktop/src/renderer/attachment-authority/DESIGN_CONTRACT.md`。设计偏离：**无**。

## 3. J-02 十个附件状态

十态不是一个可被 recall/revoke 污染的 durable enum，而是 `local/transport`、`durable processing`、`source eligibility`、`access projection` 四轴的确定性投影。具体代码与可访问性证据为 `packages/core/src/attachment-authority.ts`、`packages/desktop/src/renderer/attachment-authority/view-model.ts`、`surface.ts`、`composer-bridge.ts` 及同名 tests。

| J-02 状态 | 权威来源 | 可用操作/恢复 | 代码与自动化证据 |
| --- | --- | --- | --- |
| LOCAL SELECTED | native dialog 与 renderer local transient；尚无服务端事实 | 移除、开始上传；尺寸/类型预检先于正文读取 | `native-file-selection.ts/.test.ts`、`view-model.test.ts` |
| UPLOADING | 仅 matching server chunk ACK 推进真实 byte progress；未 ACK 不伪造进度 | cancel/retry；offline 保留 opaque handle 但不宣称 durable success | `controller.ts/.test.ts`、`websocket-authority.ts/.test.ts` |
| PROCESSING / OCR | finalize ACK 后的 uploader-principal private stable status/projection | accepted 后可 cancel processing；取消保留 durable truth并由 generation CAS 阻断晚结果 | Core transition tests、`processing-pipeline.test.ts`、`database-authority.test.ts` |
| READY | scanner、validator、extractor/OCR provenance 全部提交后的 stable status/projection | 未绑定时可随消息发送；绑定且当前授权时可 preview/download | `authority-service.test.ts`、`database-authority.test.ts`、Desktop surface tests |
| RETRYABLE FAILURE | server stable processing failure，携带 closed retry class | 当前 session/membership/lifecycle 重验后 retry；429/503 不伪造 ready | Core error/recovery matrix、`processing-pipeline.test.ts`、`view-model.test.ts` |
| NONRETRYABLE FAILURE | server stable terminal validation/extraction failure | 移除或重新选文件；422 不伪造文本/页面 | `content-validator.test.ts`、`office-inspector.test.ts`、surface tests |
| CANCELLED | server cancel ACK/stable status；不等于删除 durable attachment/attempt | 可移除；不允许 late worker 恢复 operational eligibility | DB authority race tests、controller begin/cancel tests |
| SIZE / TYPE REJECTED | local preflight，或 server 413/415 stable error；server 仍重验 magic/MIME/size | 重新选择；不进 processing/history | Core 50 MiB/七格式 tests、`content-validator.test.ts`、native selection tests |
| MALWARE REJECTED | 仅 server stable scanner result；scanner raw/signature 不进 DTO | 不可 preview/download/bind/Agent read；只能移除 | `clamd-scanner.test.ts`、pipeline malware tests、combined sentinel E2E |
| PERMISSION REVOKED | membership/session access projection/event，不改写 artifact lifecycle | 立即中断 upload/read/preview/download，purge handle/cache/card actions；重新授权前无恢复 | `read-grant-registry.test.ts`、Desktop IPC/controller/composer/history tests |

401/403/409/410/413/415/422/429/503、offline、repair、archive、recall 和 revoke 都有 closed recovery mapping。列表、文案、非颜色标识、bounded `aria-live`、preview `aria-live=off`、焦点返回、VoiceOver contract、840×560 与 1440×900 重排、200% zoom 以及 reduced motion 由 `surface.test.ts`、`view-model.test.ts` 和真实 Electron sandbox smoke 共同覆盖。

## 4. Core closed contract 与权威模型

- attachmentId 是 server-generated durable artifact identity；uploadId 是上传流程 identity；uploadKey 是 principal/Room/session-family 范围的幂等 business key，三者不混用。
- metadata 闭集包含 original filename、declared/detected MIME、format、byte size、SHA-256、uploader、Room、time、source message、processing/generation、scanner/extraction/OCR provenance；不含 path、URL、token、raw bytes、extracted body 或 adapter raw output。
- guards 用 `Reflect.ownKeys` 拒绝 extra、symbol 和 non-enumerable 注入；type-negative tests 阻断 renderer/server 越界 DTO。
- unbound status 只进 principal-private outbox/stream；ready 绑定后才进 Room event/history/repair。跨设备 uploader 可收敛私有 draft status，其他 Room 成员看不到未发送文件名、MIME 和状态。
- 只有 ready、same-Room、current-uploader、current-access、unoccupied 的 artifact 可 source bind；source pointer 不可变，recall 只把 operational eligibility 变为 excluded/tombstone。

## 5. Schema v17 与历史兼容

- 唯一追加 migration：v17 `attachment-authority-pipeline`，31 条 meaningful statements。
- migration checksum：`50907bb81053de72986f3ee0dda5bd822066d22a9b006fac885cb4add06bdc87`。
- v17 physical fingerprint：`cc4b260ec841765f0349040a238a44281aa3ed9a792623ebd6540fd3e9f6b0b0`。
- v16 predecessor checksum/fingerprint 保持 `51e5b5114b90bc8407d7eec86a559da0170cec1ec0bfc1c5587d828a5765f1a7` / `86a3512dcb625bc3e0f3d79e5a5d6542819523bee8ac851990148bcad8e38737`；v1～v16 statement、checksum、fingerprint 未修改。
- 真实 SQLite 证据覆盖 fresh、每个 v1～v16 历史版本逐一升级、close/reopen restart、future v18 refusal、migration history checksum tamper、physical schema tamper。
- 31/31 逐 statement fault injection 都回滚到完全相同的 v16 tables/history/data/`user_version`，不留半迁移。
- FK/UNIQUE/CHECK/trigger 关闭 same-Room、single source、access/lifecycle/generation、malware terminal、ready provenance、recall exclusion 和 legacy orphan link；附件表仅存 metadata/provenance，没有 body/text/bytes/raw/path/url 列。

## 6. Object storage、hash、MIME 与处理边界

- 服务端控制的根目录分隔 temporary parts、quarantine、`objects/object_<sha256>` 与 `extractions/extraction_<sha256>`；客户端不能提供路径/object key。
- native/open/store 使用 `lstat`/no-follow open/`fstat`、read-before/after stat、bounded buffer、fsync、atomic rename 和 directory fsync。FS+SQLite 不伪称一个 ACID 事务；finalize CAS 与有界 reconciler 按 crash truth table 清理 orphan/parts。
- 大小上限 50 MiB；格式闭集 PDF/PNG/JPEG/DOCX/XLSX/TXT/CSV；客户端提前检查后，server 重新交叉校验 extension、declared MIME、`file-type@22.0.2` magic 与实际 SHA-256。
- PNG/JPEG 结构、维度/像素，PDF EOF/startxref/页/对象/流/压缩/加密/主动内容，TXT/CSV UTF-8/文本量，OOXML central/local directory、CRC、traversal、symlink、ZIP64、宏/OLE、external relationship、entry/展开率/XML 都 fail closed 且有界。
- ClamD adapter 仅允许 Unix socket/回环 endpoint，真实 `zVERSION`/`zINSTREAM`，最大 1 MiB frame、50 MiB body、120 s、64 KiB response；malware/raw banner/signature/path 只映射为 closed result。
- Poppler/Tesseract 通过 `runBoundedProcess`：absolute executable、fixed argv、minimal env、`shell:false`、独立 process group、TERM→KILL、超时和 stdout/stderr cap。PDF 先 `pdfinfo`，逐页 `pdftotext`，只对空白页 `pdftoppm`→Tesseract；Office 只提取已验证 XML，不读公式。
- processing scheduler 最多 2 active/64 queued；队列仅保存 lazy byte loader。scan→validate→extract→ready 每个边界都重验 cancel/generation/lifecycle/access；缺任一生产 capability 时 degraded/fail closed，没有 fake/no-op/“总是安全”fallback。

## 7. Upload、取消、重试与 source bind

- raw chunk 固定 32 KiB，适配既有 64 KiB WebSocket `maxPayload`；client/main 最多 32 pending frames，server 全局 32 active uploads、principal+Room 4 active。
- begin 以 authenticated principal/Room/session family/upload key/metadata 为业务范围；exact replay 返回原事实，metadata/hash 变化、cross-Room/principal/family/reuse 返回 409。
- chunks 必须 contiguous；duplicate exact replay 不重写，out-of-order/missing/oversized/hash mismatch 失败闭合。checkpoint 和 durable ACK 先于 UI progress。
- pre-finalize cancel 中止 upload；accepted/quarantined 后 cancel 终结当前 processing generation，不删除已存在的 durable fact。late chunk/finalize/worker result 因 generation/access/lifecycle CAS 零写。
- ready bind 直接嵌入 `submitHumanMessageDatabaseCommand` 的既有 `BEGIN IMMEDIATE`；session、membership、Room active、uploader、same-Room、ready、source-null 全部重验。message envelope、attachment link/source pointer、stable events、outbox 和 idempotency result 同事务，注入失败整笔回滚。
- public `message.send.v2` 已正式接受 closed `AttachmentReference`；不存在 direct Worker 或 test-only bind 旁路。revision 不改已绑定 attachment；需变更时发新消息。

## 8. Recall、archive、revoke、restart 与 Agent read seam

- recall 保留 immutable source/audit lineage，link 变 `excluded_recalled`；普通 history、preview/download、Agent read、sync/repair 只得 body-free tombstone/exclusion，不返回 attachment bytes/extracted text。晚到处理 attempt 无法恢复 ready/eligibility。
- archive 后禁止新 begin/chunk/finalize/retry/bind 和新处理业务结果；已 ready+bound 且仍有权 Human 保持每次重授权的只读 preview/download。reopen 不自动恢复旧 generation。
- membership/session revoke 后 begin/chunk/finalize/processing/bind/read 均失败闭合；Desktop 中断读取、关闭 preview、删除 download temp、清 opaque handle/metadata/action/cache，旧 session family 不能续传。
- AuthorityWorker/server restart 后从 durable attempt/checkpoint/object truth 恢复；crash 边界覆盖 finalize/rename/DB CAS/outbox send-before-mark。重复 delivery 用 event ID/dedupe 收敛。
- 为 FT-05/06/10 提供 server-private extraction/read port：只允许 current running execution/attempt/assignment 和 active source，每个 range 读前后重验 source revision、membership/access/lifecycle/generation，只返回 bounded UTF-8 与 attachment/source/page/range/tool provenance，不返回 path/object key/token。这不是完整 context compiler、memory steward 或 tool product。

## 9. Preview/download 与 Desktop IPC 安全边界

- renderer 只看到 frozen business DTO 与 opaque local handle；没有 absolute path、Node/fs、session/access token、object key、bearer URL、raw bytes、通用 IPC/shell/network 能力。
- preload 仅暴露 8 个 exact attachment methods 与 closed event subscription；main IPC 同时校验 trusted sender 和 `mainFrame`，错误清洗为 closed `AttachmentError`。
- native selection 单文件、七格式、50 MiB，选择时不读正文；opaque handle cap 16/TTL 15 min，每个 32 KiB read 都进行 TOCTOU stat 校验。
- preview/download 每次 open 以及每次 stream range 都向 server reauthorize，授权绑定 session family、lifecycle generation、access revision、attachment generation。未通过授权时 adapter call count 为 0。
- preview 使用每次新建的 non-persistent Electron partition，`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`；在任何 bytes/show 前拒绝 navigation、window.open、permission、download、external/network load。
- download 先重授权、再 native dialog/写盘；32 KiB bounded stream 写 temporary file、fsync/close、atomic rename 与 directory fsync。revoke/abort 删除 temp，不把长期 URL/token 写入 DOM/event/cache。

## 10. Stable event、sync/repair 与跨设备收敛

- processing/ready/rejected/cancelled 未绑定时仅向 uploader principal 投递；bind transaction 后才写 metadata-rich Room event/outbox/projection。event 保存 safe IDs/metadata，发送前按当前授权投影，recall/revoke 后不重放旧 filename/status。
- `message-revision` 与 `attachment` 都进入穷举 Room repair registry/descriptor。active Human revision chain 可重建；recalled 只输出 tombstone，无 raw revision/attachment body。
- Room delta/history、fixed-watermark materialized repair 和 quota fallback streaming repair 共用 canonical projection/checksum；event ID、stream sequence、attachment generation 去重，staged generation 完整后才原子切换。
- uploader 在第二设备可从 principal-private full safe metadata 新建/更新 composer item；历史 bound card 每个初载/重连 epoch 都重新 `attachment.status.query`，校验 attachment/Room/source/ready/bound-active 后才恢复操作。过期异步结果不能跨 epoch 恢复权限。
- offline/repair 可保留上一个完整安全 metadata 卡，但清空操作；403/410/503 显示无操作占位；recall/revoke 清卡并 purge hydration cache。

## 11. 真实全链 E2E 与联合 sentinel

重型 E2E 使用三个独立密码登录的 WebSocket client、真实 AuthorityWorker/SQLite/object store/temp filesystem 以及 Desktop native/controller/IPC/preload/renderer 合同，经过：

1. native no-follow 选择 PDF，两个 32 KiB chunk 取得服务端 ACK；
2. 真实 loopback ClamD `VERSION`/`INSTREAM` wire fixture 看到 raw/signature/path/token canary，production scanner 映射为 clean closed result；
3. `runBoundedProcess` 真实 child/temp sandbox 执行 pdfinfo/pdftotext 固定合同，提交 provenance 后进入 READY；
4. renderer 经 public WebSocket `message.send.v2` 发送 ready reference，AuthorityWorker 原子 bind，三客户端收到同一 live message/bound event；
5. server restart 后三端分别用 delta/history/materialized repair 收敛，另一 quota-fallback client 走 streaming repair。

联合 sentinel 规则是：attachment raw 只能出现在 object-store parts/raw/object body 域，extracted text 只能出现在 extraction artifact 域。对 SQLite 全表/全列、运行中 main/WAL/SHM、停服 main/snapshot/cache、event/outbox、live frames、delta/history、materialized/streaming repair、Desktop bridge input、error/log、child stdout/stderr 逐一扫描，raw、extracted body、scanner banner/signature、path 和 token 禁区命中均为 0。

## 12. 依赖、供应链与 production capability

- Electron 从存在 context isolation/contextBridge/openExternal 附件边界 advisory 的 37.x 精确升级并锁定为 `43.4.1`；`fflate@0.8.3`、`file-type@22.0.2`、`saxes@6.0.0` 精确锁定，pnpm override 放在 `pnpm-workspace.yaml`。
- `pnpm audit --json`：0 info/low/moderate/high/critical，266 dependencies；`pnpm audit --prod --json`：0 advisory，18 dependencies。Electron 虽在 dev dependency 中，仍被当作生产 attack surface 纳入 full audit。
- 依赖 license 仅出现 MIT、MIT-0、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0、BlueOak-1.0.0、Python-2.0；没有 copyleft blocker。发行 Desktop artifact 时仍应确认 Electron/Chromium third-party notices 随包交付。
- 生产探针冻结为 ClamAV 1.5.3 或 1.4.5 + fresh signature DB/exact daemon policy、Poppler 26.07.0、Tesseract 5.5.3。缺失、版本不支持、DB 过期或 policy 不匹配均只能 degraded/503，不进 READY。

## 13. 验证命令与精确计数

最终 integration 在同一完整 HEAD 上运行：

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

| Evidence | Result |
| --- | --- |
| 全仓 Test Files | 133 passed / 2 skipped / 0 failed（135） |
| 全仓 Tests | 1607 passed / 2 skipped / 0 failed（1609） |
| Core attachment focused | 1 file / 11 tests passed；negative type tests 通过 |
| Server attachment focused | 15 files / 77 tests passed |
| real process/ClamD/pipeline focused | 5 files / 22 tests passed，已包含在 Server focused 计数内 |
| Desktop attachment focused | 14 files / 71 tests passed |
| schema v17 | 1 file / 8 tests passed；31 meaningful statements / 31 rollback |
| real AuthorityWorker/WebSocket/restart E2E | 1 file / 24 tests passed；其中 FT-04 全链目标场景 1 passed / 23 filtered |
| Electron | 1 production smoke command passed；`Electron attachmentAuthority smoke passed: app bridge, native selection, and secure preview loaded.` |
| typecheck/lint/build/boundaries/diff | 全部通过；lint 0 warnings；Desktop boundary 扫描 13 production renderer sources |

两个 skipped 是既有 opt-in OpenAI provider/router live suites，不是 FT-04 规避项。每个 PR 的受保护 workflow 都在 pnpm 10.14 frozen install 后于 Node `22.13.1` 和 Node `22.x` 分别运行 boundary、typecheck、lint 和 full test。

## 14. PR、ready head、CI 与 squash merge

| PR | 范围 | Ready head | 受保护 CI | Squash merge |
| --- | --- | --- | --- | --- |
| [#49](https://github.com/LionelHao/Dao/pull/49) | contracts/schema/dependency/design foundation | `5abfca2b1d9f6c5d10199ece7fb996d1ebda64a3` | [32257757171](https://github.com/LionelHao/Dao/actions/runs/32257757171)，Node 22.13.1 / 22.x success | `b16953d527c994d0176bc6cd34b66f9dcee4bddc` |
| [#50](https://github.com/LionelHao/Dao/pull/50) | bounded store/protocol/process/read/repair mechanics | `286e7655a7967c5ea586f1b1edac2b3d1b3d4d72` | [32259589824](https://github.com/LionelHao/Dao/actions/runs/32259589824)，Node 22.13.1 / 22.x success | `7689cdac1aa8eac442e46209dc0cebe5e139862e` |
| [#51](https://github.com/LionelHao/Dao/pull/51) | durable DB/service/pipeline/WS/recovery composition | `ea3ea7e8da55677dceeb5d57ef1ed69e4ba33e26` | [32260219549](https://github.com/LionelHao/Dao/actions/runs/32260219549)，Node 22.13.1 / 22.x success | `bdc478230b261190f2582740ef8220265bb80e9f` |
| [#52](https://github.com/LionelHao/Dao/pull/52) | Desktop J-02、metadata convergence、public bind、E2E | `0ea5de1b0d34a02dee7a382010f5ce3b84b6aab6` | [32261725250](https://github.com/LionelHao/Dao/actions/runs/32261725250)，Node 22.13.1 / 22.x success | `2cee92a322569235d08a6af0b28e5964f503073d` |

PR #50 首轮 Node 22.x 只有一个 heavy mixed repair test 超过默认 15 s；在不删断言的前提下将该 heavy test 明确为 30 s，重跑全绿。PR #52 首轮 Node 22.x 暴露 test fixture 在 restart 后不等 repair/outbox 静稳的两个竞态；加入有界只读 quiescence helper，保留全部生产断言后重跑全绿。没有绕过失败 check、force push `main` 或将 draft PR 当交付。

`2cee92a322569235d08a6af0b28e5964f503073d` 是包含全部 FT-04 可执行行为的最终代码交付 `origin/main` SHA。本文会通过后续 documentation-only squash PR 交付；Git commit 无法自行包含它尚未产生的未来 merge SHA，因此文档载体 PR/最终文档 `main` SHA 以 GitHub PR 和本任务最终回读为准；这不改变上述代码基线。

## 15. Production/live smoke 状态

- 通过：真实 Electron app bridge、native selection 与独立 sandbox preview smoke；真实 Node child process/temp filesystem/object store/SQLite/AuthorityWorker/loopback WebSocket/ClamD wire protocol。
- 安全跳过：本机没有 `clamd`/`clamscan`、Tesseract、`pdftotext`；可见 `pdfinfo`/`pdftoppm 26.05.0` 低于冻结 Poppler 26.07.0。因此不宣称真实外部恶意样本、OCR 或 pinned PDF binary live smoke 通过。
- 安全行为：缺失/旧版 capability 不影响非附件服务启动，但 attachment authority 返回 degraded/503，上传不会伪装 READY。部署验收应提供冻结版本/策略/新鲜 signature DB 并重跑 malware、OCR、PDF live smoke。

## 16. 已知风险与建议 reviewer

- schema/persistence reviewer：复核 v17 不可变 migration、31/31 rollback、source/access/lifecycle triggers、single AuthorityWorker writer 和 FS+SQLite crash reconciliation。
- attachment security reviewer：复核 parser bomb budgets、ClamD policy attestation/signature freshness、process argv/env/caps、raw/extracted domain separation 与 combined sentinel。
- protocol/sync reviewer：复核 unbound principal privacy、public bind transaction、outbox projection-at-send、message-revision+attachment repair 穷举、fixed-watermark/quota fallback。
- Desktop/Electron reviewer：复核 closed preload/main IPC、session invalidation、preview partition/CSP/navigation/network guards、atomic download 和跨设备 metadata epoch reauth。
- accessibility reviewer：用 VoiceOver 和实际 840×560/1440×900/200% 窗口再做人工视觉验收；自动化已覆盖 DOM/contract，但不把 CSS-string 断言当作 owner 的最终主观验收。
- release reviewer：部署环境必须安装冻结外部工具、新鲜 ClamAV DB/策略，确认 Electron/Chromium notices，并将 full audit、build、Electron/external-tool smoke 作为 release evidence；GitHub 当前 required workflow 本身不运行后三者。

## 17. Worktree、远程与边界声明

- 原始用户 worktree `/Users/leo/code/Dao` 保持原分支；四份未跟踪 FT-09/FT-10 文档未被 clean、stash、reset、移动、覆盖、暂存或提交。
- integration worktree `/Users/leo/code/Dao-stage6-ft04-attachment`、branch `codex/ft04-stage6-integration` 在最终设计/工作记录 commit 后 clean；它保留集成历史供审计，不将其多提交历史直接推向 squash-only `main`。
- 每个子 Agent 使用独立 worktree/branch/文件所有权，先报 RED，再报 GREEN 与 commit SHA；integration owner 逐提交审阅/cherry-pick，没有复制整棵目录覆盖。
- 未创建第二数据库、writer、event bus 或 renderer 事实源；没有向 renderer 暴露 path/fs/token/URL；fake scanner/storage/extractor/secret 只在 deep tests 中通过未公开 seam 注入。
- 未修改 Blueprint HTML/JSON，未自行修改 FT/Blueprint 状态，未使用 `verified` 或声称 owner 已验收。

## 18. 明确非目标

- FT-05 Room Memory steward、五类 memory/dispute 没有被本阶段宣称完成。
- FT-06 完整 context compiler、token budgeting、全量 Provider context 没有被本阶段宣称完成。
- FT-10 通用 Tool Safety、任意 shell/binary/URL/path 能力没有被本阶段宣称完成。
- FT-08 scheduler、FT-11 全产品 Desktop shell、FT-14 retention/export/release operations、跨 Room 搜索、永久删除 UI、逐消息 AI-visible 开关同样不属于本交付。

**第六阶段 FT-04 已达到交付条件并交付远程 main，等待 owner 验收。**
