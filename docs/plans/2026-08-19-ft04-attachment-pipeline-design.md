# FT-04 Attachment Authority & Pipeline：生产工程设计与协议状态机

> 日期：2026-08-19
> 状态：Stage 6 实施输入；只有本文列出的代码、迁移、故障恢复、Desktop 与真实组合证据全部通过后才可进入交付。
> Requirement：`REQ-PRIM-009`、`REQ-MSG-009`；联动 `REQ-MSG-001/002/005/006/010`、`REQ-NFR-001`～`005`、`007`～`011`、`013/014`、`REQ-UX-007/009`；FT-01/02/03/13/16。
> 权威 UI：`docs/design/README.md` 指向的正式审阅稿，旅程 `J-02`。与正式设计稿偏离：**无**。

## 1. 交付边界与不变量

FT-04 把附件实现为服务端权威 artifact，而不是消息里的路径、URL 或 renderer blob。客户端只提交选择、分片、取消、重试、绑定、预览和下载意图；服务端在当前 session、Room membership、Room lifecycle generation、access revision 和 artifact generation 下决定结果。

不可妥协的不变量：

1. 单文件最大 `52_428_800` bytes（50 MiB）；只支持 PDF、PNG、JPEG、DOCX、XLSX、TXT、CSV。扩展名、client MIME 和文件名都不是类型事实，必须与 magic/detected MIME 交叉校验。
2. `uploadId` 是一次 resumable 流程的服务端随机会话 ID；`attachmentId` 是 finalize 接受后生成的持久 artifact ID；`uploadKey` 是 Human 客户端稳定业务幂等键。三者不混用。
3. 原始 bytes、分片、隔离文件、提取/OCR 正文只在服务端受控、权限为 `0700/0600` 的 bounded store；不进入 SQLite/WAL、event、outbox、repair、日志、错误或诊断。SQLite 只存 metadata、hash、状态、provenance 和对象相对 opaque key。
4. 任一附件必须先扫描，再提取/OCR，最后才可 `ready`。malware 永久 `malware-rejected`，不能 preview/download/send/context；scanner 缺失或异常只能 `retryable-failure`/服务 degraded，不能 fail open 或调用 fake scanner。
5. 未绑定 artifact 只对 uploader principal 可见：private outbox 使用现有 `principal` target，使该 Human 的当前已授权设备收敛；upload handle 本身仍绑定创建它的 `sessionFamilyId`，其他设备只能看状态，不能直接续传本机 bytes。**绑定前不得进入 Room stable event/repair**，避免泄露未发送文件名。绑定成功后才通过 Room event/projection 对当前成员公开 metadata。
6. `message.send.v2` 中 source bind 是单一 AuthorityWorker transaction：复核 ready、同 Room、同 uploader、当前 membership、active lifecycle generation、当前 access revision、source 尚空；然后原子写 message envelope、attachment links、一次性 source pointer、Room event、outbox 和 idempotency receipt。revision 不能改变 attachments；改变附件必须新建 message。
7. 每次 preview/download/Agent context 都重新查询 AuthorityWorker，不依赖 renderer/cache 的“ready”。查询必须联结当前 source message/link；recall 后 operational exclusion，archive 只允许当前获权 Human 读取已经 ready+bound 的历史附件，revoke 立即拒绝并要求客户端 purge。
8. renderer 永远得不到绝对本地路径、Node/fs、session token、服务端路径、任意 URL、generic IPC 或 generic socket send。Desktop main 持有有界 opaque selection handle；preload 只暴露 closed attachment operations。
9. FS 与 SQLite 是两个资源，本文不把它们虚构成一个 ACID transaction。可见性通过私有临时文件、`fsync`、同文件系统 atomic rename、DB compare-and-set、内容 hash 和有界 orphan reconciliation 达成。
10. fake adapters 只允许在深层 test seam；package root 和 production composition 必须使用真实 scanner/extractor/OCR/process adapters。依赖缺失时启动可继续，但 capability 明确 degraded，附件不会 ready。

## 2. J-02 可见状态、事实源与恢复

| 状态 | 用户文案 / 操作 | 唯一事实源 | 恢复与分支 |
| --- | --- | --- | --- |
| `local-selected` | `LOCAL · 已选择`；可移除/上传 | Desktop main 的 opaque selection metadata；renderer local transient | 仅本地；Room archive/offline/revoke 时不发网络调用 |
| `uploading` | `UPLOADING · n / total bytes`；取消 | server chunk ACK 的累计 bytes，不用计时器伪造 | 离线/429/503 保留 uploadKey 并显式继续；401 重新认证；403 purge |
| `processing` | `PROCESSING` 或 `OCR`；可取消 | uploader-private durable ACK/projection | scanner/OCR unavailable 为 retryable；archive/revoke 使 generation 失效 |
| `ready` | `READY`；可绑定，绑定后可 preview/download | private projection；绑定后 Room stable event/projection | 每次访问重新授权；不可从 local completion 推断 |
| `retryable-failure` | 网络、容量、scanner/extractor/OCR 暂时不可用 | closed ACK/error 或 private stable status | 同 uploadKey / attachmentId 和新 requestId 显式重试 |
| `nonretryable-failure` | 加密 PDF、结构损坏、zip/image/PDF bomb | closed ACK/private status | 替换文件；不能自动改变 canonical metadata |
| `cancelled` | 已取消；重新选择/上传 | finalize 前可取消 upload；接受后是 durable attachment terminal + generation CAS | 后者延迟 GC，不声称“从未产生 artifact”，永不 operational 可见 |
| `size-type-rejected` | 大小或类型不支持 | local preflight 或 server authoritative reject | 413 大小、415 magic/MIME/extension、422 malformed/unsafe content |
| `malware-rejected` | 检测到恶意内容 | scanner result 的归一化 durable status | 隔离、不可重试同 bytes、不显示 raw scanner output |
| `permission-revoked` | 权限已撤销 | 403 ACK / identity-room stable event / access projection | main 取消读写、清 selection/upload/preview cache、焦点回恢复动作 |

`submitting` 只表示本地意图；chunk/finalize/cancel ACK 只证明对应 AuthorityWorker fact；Room stable event 只存在于 source bind 之后。状态识别同时使用文字、图标和线型，不依赖颜色或运动。

十个 UI 状态不是一个 durable enum，而由四个正交轴确定：

| 轴 | 值 |
| --- | --- |
| local/transport | none、selected、uploading、local-rejected、transport-failed |
| durable upload/processing | open、accepted/quarantined、processing、ready、retryable-failed、nonretryable-failed、malware-rejected、cancelled |
| source eligibility | unbound、bound-active、excluded-recalled |
| access projection | authorized、permission-revoked、archived-read-only、offline、repairing |

映射优先级是 `permission-revoked` > authoritative malware/size/type/nonretryable/cancelled > retryable > processing > ready > uploading > local-selected。`archived-read-only`、offline 与 repairing 是能力修饰：只读展示既有 `bound-active + ready`，不把 artifact 状态改写为失败；`excluded-recalled` 保留审计 metadata 但从普通附件 UI/context 移除。server 413/415 rejection 覆盖 local optimistic preflight；local rejection 永不伪装为 server stable fact。

### 2.1 HTTP/协议错误映射

| status | code 范围 | 含义与 UI |
| --- | --- | --- |
| 400 | `invalid_request` / `invalid_chunk` | closed shape/offset/hash 错；nonretryable，聚焦对应项 |
| 401 | `unauthenticated` | 不读取文件/adapter；保留安全 metadata，重新认证 |
| 403 | `room_forbidden` / `attachment_forbidden` | 零字节输出，purge 当前 Room/附件缓存 |
| 409 | `idempotency_conflict` / `upload_offset_conflict` / `attachment_already_bound` / `generation_conflict` | exact replay 可返回原 receipt；changed metadata/hash/source 必须冲突 |
| 410 | `upload_expired` / `attachment_gone` / `protocol_upgrade_required` | 新建 upload 或升级；不回退 generic transport |
| 413 | `attachment_too_large` / `chunk_too_large` | local preflight 与 server 都验证；server 是最终事实 |
| 415 | `attachment_type_unsupported` / `type_mismatch` | extension/MIME/magic 不一致或不支持 |
| 422 | `attachment_malformed` / `encrypted_pdf` / `archive_bomb` / `image_bomb` | bytes 在支持类型内但不可安全处理 |
| 429 | `attachment_capacity_limited` | 遵守 bounded retry hint；没有无界内存队列 |
| 503 | `storage_unavailable` / `scanner_unavailable` / `extractor_unavailable` / `ocr_unavailable` / `repair_barrier_active` | fail closed；显式重试，绝不 fake-ready |

## 3. Closed Core 与协议合同

Core 导出 exact-key guards 和 closed unions：

- `AttachmentFormat = pdf | png | jpeg | docx | xlsx | txt | csv`；
- `AttachmentReference { attachmentId }`（沿用 FT-03），仅绑定 ready artifact；
- `AttachmentMetadata`：ID、Room、original filename、detected MIME、byte size、SHA-256、uploader、created/ready time、processing status、source message ID（可空至 bind）；
- `AttachmentPrivateEvent`：只在 uploader-private channel，含状态与安全 metadata；
- `AttachmentRoomEvent`：`room.attachment.bound` / `room.attachment.excluded`，不含 bytes、路径、提取正文、raw adapter 输出；
- `AttachmentRepairRecord`：只含 bound metadata、processing/provenance summary、source/lifecycle；不含 unbound artifact 或提取正文；
- `AttachmentError`：以上 closed status/code/retryAfter 组合。

Public WebSocket v2 frames：

| frame | 关键字段 | 约束 |
| --- | --- | --- |
| `attachment.upload.begin` | requestId, roomId, uploadKey, safe filename, declared MIME, expected bytes, expected SHA-256 | 服务端产生 uploadId；同 key 同 canonical input replay，changed input 409 |
| `attachment.upload.chunk` | requestId, uploadId, ordinal, offset, byteLength, chunk SHA-256, base64 | raw chunk 最大 `32_768` bytes；完整 JSON 必须小于现有 64 KiB WebSocket ceiling |
| `attachment.upload.finalize` | requestId, uploadId | 仅 complete offsets；重算 whole hash/size/type，接受后产生 attachmentId |
| `attachment.upload.cancel` | requestId, uploadId | 幂等 terminal；accepted 后转 attachment processing cancel |
| `attachment.processing.retry` | requestId, attachmentId, expectedGeneration | 仅 retryable terminal，CAS 增 generation |
| `attachment.status.query` | requestId, attachmentId | uploader-private 或 bound/current-authorized |
| `attachment.preview.open` | requestId, attachmentId, representation | one-shot authorized stream handle；不是 URL/token/path |
| `attachment.download.open` | requestId, attachmentId | one-shot bounded server stream；native save 目标只在 main |

`32_768` byte chunk 的 base64 是 43,692 chars；协议测试以最长 IDs/filename/envelope 断言编码 frame `< 65_536` bytes。单文件最多 1,600 chunks；每个 upload 的 chunk row 与 part file 上限均固定。

## 4. 状态机与并发语义

### 4.1 Upload 与 artifact

```text
upload: open -> finalizing -> accepted
          |          |          \
          +-------> cancelled     attachment: quarantined -> scanning
                                                | clean          | malware/error/cancel
                                                v                v
                                             extracting/ocr -> ready | malware-rejected
                                                |                 | retryable/nonretryable/cancelled
                                                +-- CAS retry ----+
```

- chunk 要求 ordinal/offset 连续、chunk hash 正确；同 ordinal 的 exact replay 返回原 checkpoint，不同 bytes/length/hash 409。
- begin 绑定 `principalId + sessionFamilyId + roomId + accessRevision + lifecycleGeneration`。跨 principal/session family/Room 复用 uploadId 一律 403/409；重认证后只能通过当前 family 的显式 status/recovery，不继承已 revoke family。
- finalize 先在私有 staging 合并并重算，再将文件原子 rename 到 quarantine，最后 DB CAS `open -> accepted/quarantined`。任何 crash 都不会产生 ready 可见性。
- processing claim 写 `attempt + generation`；每次外部工具前、工具后、ready commit 前都重检 attachment generation、Room lifecycle generation 和 security reduction。迟到结果 CAS 失败并清理 artifact。
- finalize 前 cancel 删除/延迟清理 parts；finalize 接受后 cancel 持久为 attachment terminal `cancelled`，source 始终 null，generation 增加并阻止 late worker。

### 4.2 Source bind、recall、archive、revoke

| race | 可序列化结果 |
| --- | --- |
| ready vs bind | bind 在 ready commit 后成功；之前 `409 attachment_not_ready`，消息零写 |
| two messages bind same attachment | source CAS 仅一个 winner；loser `409 attachment_already_bound`，整条 message transaction 零写 |
| bind vs archive | 先 bind 则消息+附件均提交并成为历史；先 archive 则 bind 403/409，零新 business fact |
| worker result vs archive | ready commit 先完成则可历史访问；archive generation 先变则 late result CAS 失败，不在 reopen 自动恢复 |
| bind/preview/download vs membership revoke | AuthorityWorker 顺序决定；revoke 先发生则 adapter/file-read 调用计数为 0；已开始 stream 检查 cancellation token 并停止 |
| recall vs preview/context | recall 先发生则 operational access 0 bytes；已授权 stream 收到 generation invalidation 并停止；source pointer保留审计，link 转 excluded |
| reopen | 新 lifecycle generation；旧 pending upload/worker 不复活，Human 必须显式新建/重试 |

## 5. Schema v17 目标与 invariant

v17 只追加 migration，绝不改 v1～v16 statement、checksum 或既有表语义。目标表：

- `attachment_uploads`：upload identity、canonical input hash、owner/session/Room/generation、expected/received bytes、whole hash、format hint、status、timestamps；
- `attachment_upload_chunks`：`(upload_id, ordinal)` 唯一、offset/length/hash/opaque part key，append-only；
- `attachments`：artifact identity、Room/uploader、original name、declared/detected MIME、format、bytes/SHA、opaque object key、processing/source/lifecycle generation、timestamps；
- `attachment_processing_attempts`：attempt/generation/adapter kind+version/status、normalized reason code、time/bounds；
- `attachment_extraction_artifacts`：opaque object key、SHA/bytes、method/tool/version/page/range summary；不存正文；
- 现有 `message_attachment_links` 由 v17 trigger 补足 attachment authority：attachment 必须同 Room、ready、source null；source 一次性绑定；link/source 双向一致；recall 只允许 active→excluded；禁止 delete/任意 update。

FK、UNIQUE、CHECK 与 trigger 还必须证明：单 key canonical idempotency、chunk 连续检查由事务查询完成、状态合法边、generation 单调、object key 无 `/`/`..`、source 不可换绑、ready 才可 bind、malware/cancelled 不可 ready、append-only attempt/provenance。所有 meaningful v17 statements 在注入任一 statement failure 时整组 rollback，`user_version` 保持 16；fresh、v1～v16 upgrade、restart、future/tamper refusal 都是门禁。

## 6. Server-controlled object store 与 crash truth table

根目录由 server config 指定并在启动时验证非 symlink、owner-only。内部域：

```text
parts/<uploadId>/<ordinal>.part
quarantine/<attachmentId>.blob
objects/<sha256>.blob
extractions/<attachmentId>/<generation>.utf8
```

这些是说明性逻辑域；对 renderer/事件/错误不可见。实际 filename 只由已验证的 server UUID/SHA 生成，使用 no-follow/exclusive open；所有写入受 per-file 和 global byte budget 控制。

| crash 点 | 重启事实 |
| --- | --- |
| part write 前 | DB 无 checkpoint；客户端重发 |
| part fsync 后、DB checkpoint 前 | orphan part 无权威引用；reconciler 有界删除 |
| checkpoint commit 后 | exact replay 返回 checkpoint；part 丢失则 upload retryable-corrupt，不伪造完成 |
| assembled quarantine rename 前 | upload 保持 finalizing/open；临时文件清理 |
| rename 后、attachment DB commit 前 | orphan quarantine 有界清理 |
| scanner clean / extraction file rename 后、ready commit 前 | object/extraction orphan；DB仍不可访问；reconciler清理或 worker 同 generation重试 |
| ready commit 后、outbox 前 | bind前只有 private query；bind transaction 自带 Room event/outbox；不会靠 FS 推断 |

reconciler 每次最多 `128` 项/`256 MiB`，启动与周期执行；不遍历无界目录到内存。上传 idle `30 min`，绝对 TTL `24 h`；每 principal+Room 最多 `4` active、全局 `32` active；processing queue `64`、并发 `2`。

## 7. 真实 scanner / extraction / OCR 组合

生产 adapter 都用 `spawn`（无 shell）、固定 executable/args、受控 cwd/env、超时、stdout/stderr cap、kill tree 和 normalized error。raw stdout/stderr 不写日志/DB/event。

| 格式 | 类型/安全校验 | 处理 |
| --- | --- | --- |
| 全部 | 内建 signature + `/usr/bin/file --mime-type` 交叉检查；ClamAV `clamscan` 必须 clean | scanner timeout 120s；exit 0 clean、1 malware、2/error unavailable |
| TXT/CSV | UTF-8/BOM、NUL/控制字符、CSV row/column bounds | 内建 streaming decoder；提取最多 8 MiB/200k chars |
| DOCX/XLSX | ZIP central directory、path traversal、entry count 10k、expanded 200 MiB、ratio 100:1 | 精确锁定纯 JS ZIP 解码；只读已知 XML parts，不执行宏/外链/公式 |
| PDF | header/xref/page count 500/对象与嵌入文件 bounds；encrypted 拒绝 | `pdfinfo`/`pdftotext`；无文本页通过 `pdftoppm` 受控 raster 后 OCR |
| PNG/JPEG | dimensions ≤ 40MP、width/height ≤ 20k、decoded budget | Tesseract OCR；原图 preview 仍走 sandbox one-shot bytes |

Tesseract timeout 180s；pdf/text extraction 60s；tool stdout 单次 8 MiB、stderr 64 KiB。命令缺失时 capability report 为 unavailable，job retryable，应用其他能力可启动。测试 fake 只注入 adapter interface，production export 不暴露 fake/no-op。

## 8. Desktop closed bridge、preview/download 与 a11y

Desktop main：

- `dialog.showOpenDialog` 只在 Human 手势后打开；校验单选、安全文件类型和 `lstat/open`，生成最多 16 个、15 分钟 TTL 的 opaque selection handle；renderer 只看 safe filename/bytes/declared type。
- main 按 32 KiB 读、计算 chunk/whole SHA-256、调用 attachment-specific authority client；最多 1 个文件/2 个 in-flight chunks；取消关闭 fd、清 handle、发送 closed cancel。
- download 先授权再弹 native save dialog，写受控用户目标的 temp + fsync + atomic rename；renderer不接收目标路径或字节。
- preview：TXT/CSV 只显示 bounded escaped text；PDF/image 在独立 sandboxed `BrowserWindow`/受控内存响应中显示，`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、拒绝 navigation/window open/permissions/network；DOCX/XLSX 显示服务端提取的安全 text/table preview，不加载 Office active content。每次打开重新授权，没有 bearer URL。

Renderer 组件包含 selection row、progress、processing status、ready chip、failure recovery、malware/revoke terminal、bind/source indication。键盘可选择、取消、重试、预览、下载、移除；失败后 focus 到摘要/恢复按钮，关闭 preview 回触发器。只设置一个低频 `aria-live=polite`，按状态边播报短摘要，不逐 chunk/page；preview `aria-live=off`。支持 1440×900 的 100/125/150/200% 与 840×560 的 100/125/150%，无核心动作裁切或页面双轴滚动；`prefers-reduced-motion` 禁用非必要动画。

## 9. Sync、repair、outbox 与 privacy

- uploader-private unbound 状态不进 Room stream/repair；可由 authenticated private status query 及 private event channel跨本人设备恢复。
- bind transaction 产生 `room.attachment.bound`，payload 只含 metadata/provenance summary/source message；outbox 在发送前按当前 Room access 和 source operational eligibility投影，不盲重放旧 filename/status。
- `RoomRepairRecord` 加 bound `attachment` segment，并修复既有 `message-revision` contract/runtime registry 漏接；runtime kind 列表对 union 做穷举证明。streaming 与 materialized snapshot 都从 authority reference hydration，遇 watermark/access revision变化 fail closed。
- recall 事件使 link operational state excluded；普通 history、repair、Agent context不含 attachment；authorized audit seam 可保留 source pointer但不在本期公开。
- repair/outbox/event/cache sentinel scan 必须证明原始 bytes、OCR/extracted text、绝对路径、raw adapter output、token/secret 为零命中。

## 10. 安全升级与门禁

Electron 是 Desktop 运行时，即使列在 devDependencies 也按生产攻击面审计。当前锁文件 37.x 的附件 preview 隔离 advisory 是 Stage 6 blocker；实施必须升级到官方仍受支持且覆盖已知 advisory 的精确安全版本，重新生成 lockfile，`pnpm audit` 对运行时 direct/transitive high 为 0，并在实际 Electron binary 上运行 boundary smoke。Vitest-only advisory 要么升级清零，要么在交付中以不进入 artifact 的可复核证据单列，不能用 `pnpm audit --prod` 遮蔽 Electron。

## 11. 非目标与未来 seam

- FT-05/06 将消费已授权的 operational attachment/extraction reader；本期只提供 server-private port，不把提取正文放事件或 repair。
- 不做任意文件类型、在线 Office 编辑、公共分享 URL、renderer 直接 fetch、generic filesystem bridge、background auto-upload、无限断点保留或跨 Room attachment reuse。
- 不修改 Blueprint 或任务状态；交付说明只能记录真实证据，不能自称 owner verified。
