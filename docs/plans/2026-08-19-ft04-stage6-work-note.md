# FT-04 Attachment Authority & Pipeline：Stage 6 工作记录

> 日期：2026-08-19
> owner：本 Stage integration owner
> 状态：Stage 6 代码与受保护 CI 已交付远端 main；等待 delivery truth PR 与 owner 验收，不代表 Blueprint 状态变化。

## 1. 基线与隔离

- 原工作树 `/Users/leo/code/Dao` 保持原分支；四个 FT-09/10 未跟踪文档属于用户，未编辑、未暂存、未移动、未删除。
- `git fetch origin --prune` 后基线：`origin/main@e3075fa4f7f031d7db3757fd0d0039dc30e8fb69`；当时 open PR 为 0。
- integration worktree：`/Users/leo/code/Dao-stage6-ft04-attachment`；branch `codex/ft04-stage6-integration`；从上述 SHA 创建且初始 clean。
- 依赖按 lockfile 从本地 cache 安装；安装后 lockfile/status 未改变。

## 2. 基线证据

- 全量 Vitest：Test Files `101 passed / 2 skipped / 0 failed (103)`；Tests `1430 passed / 2 skipped / 0 failed (1432)`；skip 是既有 OpenAI provider/router live tests。
- Core/desktop boundary checks：通过。
- schema 当前基线 v16；v17 尚未在本节基线出现。
- 本机能力探针：`file` 可用；ClamAV、Tesseract、`pdftotext` 在标准 PATH 不可用；Codex 自带的开发运行时路径不作为 Dao production dependency。

## 3. 权威映射与设计决策

- 直接 Requirement：`REQ-PRIM-009`、`REQ-MSG-009`。
- 联动：`REQ-MSG-001/002/005/006/010`、`REQ-NFR-001`～`005`、`007`～`011`、`013/014`、`REQ-UX-007/009`；FT-01/02/03/13/16。
- UI：正式 `J-02` 十态；1440×900 100/125/150/200%，840×560 100/125/150%；键盘、焦点、非颜色识别、有限 aria-live、VoiceOver、reduced motion。设计偏离：**无**。
- 事实模型：local/transport、durable processing、source eligibility、access projection 四轴映射十态；未绑定 artifact 用 principal-private target，绑定后才进入 Room stream/repair。
- 协议：50 MiB；PDF/PNG/JPEG/DOCX/XLSX/TXT/CSV；32 KiB raw chunk 适配现有 64 KiB WS payload；uploadId/attachmentId/uploadKey 分离；source bind 单 AuthorityWorker transaction。
- 存储：SQLite 仅 metadata/provenance；bytes/extracted text 在 server-controlled bounded store；FS+DB 以 crash truth table恢复，不宣称跨资源 ACID。
- production dependency：真实 ClamAV + bounded Poppler/Tesseract/ZIP/text adapters；缺失 fail closed/degraded，不 fallback fake。

## 4. Wave 0 审计与后续复审

三名 Agent 都使用彼此独立的 worktree/branch；没有一个 Agent 修改原始混合工作树或 Blueprint。初始只读审计与集成后复审给出的关键结论如下：

| 审计 | 结论与处理 |
| --- | --- |
| adversarial | 冻结 unbound principal-private、四轴十态、32 KiB chunk、source/recall/archive/revoke/generation、FS+SQLite crash truth、bomb budgets；发现并修复 Stage 5 `message-revision` repair registry/desktop blanket reject 漏接。末轮又发现 Agent extraction/read port、跨设备 metadata hydration、public `message.send.v2` attachment parser gate 与 combined sentinel 证据缺口；均作为发布阻断处理，不以文档降级。 |
| code seam / E2E | 分波实现 Core、store、protocol、Worker/DB/service、process pipeline、sync/repair；末轮用真实 AuthorityWorker/SQLite/loopback WS/ClamD protocol fixture/Desktop controller chain闭合三客户端、restart、repair 与 privacy evidence。 |
| dependency/security | Electron 37.x 的附件隔离 advisory 是 blocker；已精确升级 Electron `43.4.1`，精确锁 `file-type@22.0.2`、`fflate@0.8.3`、`saxes@6.0.0`，override 位于 `pnpm-workspace.yaml`；full audit 0。外部 ClamAV/Poppler/Tesseract 缺失必须 capability degraded，绝不 fake ready。 |

没有发现需要 owner 另作产品裁决的 PRD/protocol/formal design 冲突。`docs/protocols/identity-room-lifecycle.md` 的旧 archive/silent 文案没有覆盖 approved PRD/FT-02 裁决。

## 5. 实施事实

| 切片 | 已完成事实 |
| --- | --- |
| Core / J-02 | closed attachment metadata/event/repair/error contracts；50 MiB、七格式、32 KiB；local/transport、durable processing、source eligibility、access projection 四轴确定性映射十态；exact own-key/symbol/hidden-field guards 与 type-negative tests。 |
| schema v17 | 唯一 append-only v17，31 条 meaningful statements；fresh、v1～v16逐版升级、restart、future/physical/history checksum tamper；31/31 statement fault rollback；v1～v16 statement/fingerprint 未改写。 |
| object/process | 私有 tmp/quarantine/object/extraction 域、no-follow/TOCTOU、fsync/rename/content address、bounded reconciliation；`file-type` + 格式结构校验；ClamD INSTREAM、Poppler、Tesseract 的 real production composition；队列/并发/timeout/stdout/stderr/body 全有界。 |
| DB / single writer | AuthorityWorker 唯一 SQLite writer；upload exact replay、chunk checkpoints、finalize/private outbox、processing CAS、ready provenance、message/link/source/Room event/outbox/receipt 同事务；全局 32 active、principal+Room 4 active。 |
| access / future seam | Human preview/download 每个 range 重新授权并绑定 session family/lifecycle/access/generation；server-private Agent extraction reader 只接受 current running execution/assignment 与 active source，range 读取前后重验，返回 bounded UTF-8 + source revision/provenance，不公开 object key/path/token；不实现 FT-05/06 compiler。 |
| sync / recovery | uploader-private status 不进 Room；bind 后 metadata-rich Room event/repair；`message-revision` 与 `attachment` runtime registry 穷举；streaming/materialized fixed-watermark repair、checksum、clear-cache/restart；recall 输出 tombstone/excluded，无 raw revision/extracted text。 |
| Desktop | exact 8-method preload/main IPC、native dialog/opaque handle、32 KiB ACK progress、cancel/retry；每次 reauth preview/download、atomic native save；独立非持久 sandbox preview 拒 Node/navigation/window/permission/network；composer 与正式 J-02 十态/焦点/aria/zoom/reduced-motion 挂载；跨设备 private status 与历史 bound card 安全 metadata hydration。 |
| public bind | 已移除遗留 `attachment_feature_unavailable` parser gate；closed `AttachmentReference` 经 public `message.send.v2` 进入现有 Message Authority，并在 AuthorityWorker transaction 内只绑定 ready/same-Room/current-uploader/unoccupied source。 |

主要 TDD RED 都保留在 Agent 回报与提交历史中：缺模块、schema 16≠17、repair kind 漏接、cross-realm bytes 503、default jsdom parser、全局第 33 个 upload 被接受、Agent read port缺失、第二设备 private status被丢弃、历史 card 不发 status query，以及 public attachment bind 400。没有通过删除/skip/放宽原测试获得 GREEN。

## 6. 最终门禁状态

- 三认证客户端 public WS upload→ClamD/processing→READY→public `message.send.v2` bind→三端 live→restart delta/history→materialized/streaming repair 已通过；combined sentinel 对 SQLite/WAL/SHM、snapshot/cache、event/outbox、live/delta/history/repair、Desktop bridge、error/log/stdout/stderr 零禁区命中。
- 最终 integration：Test Files `133 passed / 2 skipped / 0 failed (135)`；Tests `1607 passed / 2 skipped / 0 failed (1609)`；typecheck、lint（0 warning）、build、Core/Desktop boundaries、diff check 全通过；Electron 输出 `app bridge, native selection, and secure preview loaded`。
- 四个 ready PR 均从当时最新 `origin/main` 创建，Node `22.13.1` 与 `22.x` 受保护 checks 全绿后 squash merge：[#49](https://github.com/LionelHao/Dao/pull/49) `b16953d`、[#50](https://github.com/LionelHao/Dao/pull/50) `7689cda`、[#51](https://github.com/LionelHao/Dao/pull/51) `bdc4782`、[#52](https://github.com/LionelHao/Dao/pull/52) `2cee92a`。代码交付 main 已回读为 `2cee92a322569235d08a6af0b28e5964f503073d`。
- 本机没有 ClamAV、Tesseract、`pdftotext`，且可见 `pdftoppm 26.05.0` 低于冻结 `26.07.0`；external-tool live smoke 安全 skip。deterministic evidence 使用真实 child process、真实 loopback ClamD wire protocol和真实 temp filesystem；production capability probe 在缺失/旧版时 degraded/fail closed，不把 fixture冒充部署 capability。
- Blueprint 与 owner acceptance 状态未修改；FT-05/06/10 没有被本阶段冒充完成。最终证据与 PR/CI 明细进入 `docs/deliveries/FT-04-Attachment-Pipeline-Stage6-交付说明.md`。
