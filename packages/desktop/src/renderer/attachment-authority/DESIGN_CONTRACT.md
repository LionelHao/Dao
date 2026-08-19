# Desktop FT-04 Attachment Authority Renderer Contract

> 范围：Stage 6 Wave 1 的纯 renderer view-model / DOM contract。这里没有 transport、IPC、preload、main、文件选择器、URL、token、path、raw bytes、scanner 或 fake success。与正式设计稿偏离：**无**。

## Requirement / FT / Journey

| 范围 | 权威映射 | 本目录合同 |
| --- | --- | --- |
| 附件 authority | `REQ-PRIM-009`、`REQ-MSG-009`；FT-04，联动 FT-01/02/03/13/16 | 附件是服务端 artifact；renderer 只呈现安全 metadata、四轴事实和 closed intent。 |
| 消息与来源 | `REQ-MSG-001/002/005/006/010`、`REQ-UX-007`；`J-02` | READY 不由本地读完或 callback 推断；绑定前是 uploader-private，绑定后才有 Room source；recall 从普通 UI 移除。 |
| 可靠性与权限 | `REQ-NFR-001`～`005`、`007`～`011`、`013/014` | archive/offline/repair/revoke 是能力修饰；preview/download 每次需重新授权；403 清可见 metadata。 |
| 可访问性 | `REQ-UX-009`；FT-16 | 原生按钮、可见 focus、非颜色文字/图标/线型、一个 bounded polite region、preview live off、规定缩放与 reduced motion。 |

正式 UI 来源是 `docs/design/README.md` 指向的审阅稿，旅程 `J-02 发消息与 ACK` 的附件步骤、十态 `ATTACH` 定义和 FT-16 验证矩阵。原型步进按钮不构成生产成功证据。

## 四轴与十个可见状态

| 轴 | closed values |
| --- | --- |
| local / transport | `none`、`selected`、`uploading`、`local-rejected`、`transport-failed` |
| durable processing | `open`、`accepted-quarantined`、`processing`、`ready`、`retryable-failed`、`nonretryable-failed`、`malware-rejected`、`cancelled` |
| source eligibility | `unbound`、`bound-active`、`excluded-recalled` |
| access projection | `authorized`、`permission-revoked`、`archived-read-only`、`offline`、`repairing` |

确定性优先级：permission revoked > malware / size-type / nonretryable / cancelled > retryable > processing > ready > uploading > local selected。`acknowledgedBytes === totalBytes` 仍是 UPLOADING；只有 stable event/projection 的 durable ready 才能显示 READY。

| 可见状态 | 权威来源 | eligible intent |
| --- | --- | --- |
| LOCAL SELECTED | local transient | upload、remove |
| UPLOADING | server chunk ACK checkpoint | cancel |
| PROCESSING / OCR | accepted ACK、stable event 或 private projection | cancel |
| READY + unbound | stable event/projection | bind、remove |
| READY + bound active | Room/private projection | preview、download；host 每次重新授权 |
| RETRYABLE FAILURE | closed error/private projection | closed recovery；不自动重试 |
| NONRETRYABLE FAILURE | closed reject/private projection | replacement/upgrade/restart as exact code requires |
| CANCELLED | cancel ACK/projection | replacement/remove；没有迟到成功 |
| SIZE / TYPE REJECTED | local preflight 或 server authoritative 413/415 | replacement/remove |
| MALWARE REJECTED | stable event/projection | remove only |
| PERMISSION REVOKED | 403 或 access projection | purge-visible rendering、reauthenticate only |

`excluded-recalled` 不渲染普通附件项、metadata 或 action。archive 只允许当前仍获权 Human 对既有 `bound-active + ready` 做 preview/download；offline/repairing 只显示最后完整 projection，因无法完成当前 reauthorization，访问和写入动作均 fail closed。

## Exact error mapping

| HTTP | codes | visible / recovery |
| --- | --- | --- |
| 401 | `unauthenticated` | retryable；重新认证 |
| 403 | `room_forbidden`、`attachment_forbidden` | permission revoked；清 metadata；重新认证 |
| 409 | `idempotency_conflict`、`upload_offset_conflict`、`attachment_already_bound`、`attachment_not_ready`、`generation_conflict` | retryable conflict；载入最新 projection |
| 410 | `upload_expired`、`attachment_gone`、`protocol_upgrade_required` | 新 upload、换文件或升级；不回退 legacy |
| 413 | `attachment_too_large`、`chunk_too_large` | size/type rejected；文件过大时换文件，分片超协议上限时升级客户端；server 覆盖 local optimistic result |
| 415 | `attachment_type_unsupported`、`type_mismatch` | size/type rejected |
| 422 | `attachment_malformed`、`encrypted_pdf`、`archive_bomb`、`image_bomb` | nonretryable；换文件 |
| 429 | `attachment_capacity_limited` + bounded hint | retryable；按 hint 后显式 retry |
| 503 | storage/scanner/extractor/OCR unavailable、repair barrier | retryable；依赖恢复后显式 retry，绝不 fake READY |

错误摘要包含 `ERROR`、HTTP、closed code 与恢复动作；不显示 stack、adapter output、路径或文件正文。失败后 focus 到摘要；权限撤销 focus 到恢复动作。

## Keyboard / focus / non-colour / announcements / layout

- 所有动作是有 accessible name 的原生 `button[type=button]`，Tab 顺序等于视觉顺序；host 接入后负责 preview/dialog 关闭时把焦点还给触发器。
- 状态同时使用 uppercase status text、静态 glyph 与 solid/dashed/double rail；颜色从不单独承载状态。
- surface 恰有一个 `role=status` + `aria-live=polite` + `aria-atomic=true`。上传通告不包含 chunk、百分比或 byte count；preview policy 固定 `aria-live=off`。
- 1440×900 验证 100/125/150/200%；840×560 验证 100/125/150%。CSS 使用 logical sizing、wrapping 和 840px reflow，核心动作不进隐藏 overflow menu，不制造页面双轴滚动。
- `prefers-reduced-motion: reduce` 将 transition/animation 降到 `0.01ms`；状态不依赖 motion，无模拟 typing/progress 动画。

## 后续接线边界

Wave 3 host 必须用 closed bridge 提供四轴事实、当前权限和安全 metadata，并把 typed callback 连接到 attachment-specific commands。renderer 不取得 absolute path、selection handle internals、session token、URL、raw bytes/base64/blob、generic IPC 或 generic socket send。本目录的 callback 只表达 local intent；调用返回或 callback 未抛错都不能直接推进 durable state。
