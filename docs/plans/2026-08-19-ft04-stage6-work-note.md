# FT-04 Attachment Authority & Pipeline：Stage 6 工作记录

> 日期：2026-08-19
> owner：本 Stage integration owner
> 状态：实施中；本文按真实提交与证据更新，不代表 owner 验收或 Blueprint 状态变化。

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

## 4. Wave 0 审计

三名只读 Agent 都从同一 `origin/main` SHA 建独立 clean worktree，所有权为“无”，不改代码/文档/Blueprint：

| 审计 | 关键结论 |
| --- | --- |
| adversarial | unbound metadata不能进 Room；十态必须四轴；32 KiB chunk；source bind/recall/archive/revoke/worker race；FS+DB crash truth；bomb limits；发现既有 `message-revision` repair contract/runtime 漏接 |
| code seam | 进行中；将补 Core/Worker/WS/sync/Desktop 文件级切片 |
| dependency/security | 发现 Electron 37.x runtime advisory 阻断附件 preview 隔离；`pnpm audit --prod` 不能隐藏 Electron；将补官方版本、license 与真实组合建议 |

已登记 Stage 5 recovery debt：Core `MessageAuthorityRepairRecord` 含 `message-revision`，但 Room repair runtime registry/descriptor 及 Desktop replica 没有完成 active revision chain repair；Stage 6 在增加 attachment record 前修复，recalled raw revision仍禁止。

## 5. 实施流水账

| 时间/阶段 | 事实 |
| --- | --- |
| baseline | 权威 PRD、approved map、protocol、formal design、FT-03/13 与 Stage 5 交付已审阅；无需要 owner 先裁决的产品冲突 |
| design freeze | 新建设计与实施计划；吸收 privacy、race、repair、payload、bomb、dependency review；等待 Wave 0 final 后冻结首个提交 |
| Wave 1+ | 待真实 commit/测试后填写 |

## 6. 待完成门禁

- Core closed contracts、schema v17、object store、real adapters、AuthorityWorker、protocol/WS、message bind、sync/repair/private outbox、Desktop closed bridge/J-02 UI 尚待实现。
- Electron 安全版本、lockfile audit 与实际 binary smoke 尚待完成。
- crash/restart、malware/OCR dependency-aware live smoke、全量质量门、ready PR/CI/squash merge/remote main 回读尚待完成。
- 最终交付说明只在上述事实完成后创建；Blueprint 与 owner acceptance 状态不由本 Stage 修改。
