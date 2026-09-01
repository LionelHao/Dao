# FT-14 Privacy & Operations 协议

状态：Stage 14 生产合同。直接覆盖 `REQ-AGT-004/009/013`、`REQ-ID-004/005`、
`REQ-MEM-010/012`、`REQ-MSG-006/010`、`REQ-NFR-001/003/005/006/008/009/012/013`。

## 1. 单 Provider 与 no-retention

生产只允许一份服务端 OpenAI credential、`openai-responses` Provider 和启动时固定 model；
无 BYOK、多 Provider、自动 fallback 或自动换 model。三条生产 adapter（execution、router、
memory steward）都必须经 closed inventory 编码请求并显式 `store:false`，只发送当前冻结且仍
eligible 的 context。禁止 raw request/response、headers、hidden reasoning、Provider error body
进入 log、error、event、outbox、audit、diagnostics、export 或 repair。请求/响应/SSE/error body、
timeout、queue 与 shutdown 均有硬边界。

Room 可见 disclosure 是 closed 值：`providerId`、`modelId`、`credentialReadiness`、
`retentionDisabled:true`、`selectionPolicy:'server-managed-single'`、正整数
`disclosureRevision` 与 canonical UTC `disclosedAt`。不得包含 credential generation、key version、
secret metadata、endpoint token 或部署路径。readiness=noauth 时服务可启动，但 invocation 以
闭合配置错误终结，绝不选择 fake/mock。

## 2. Credential configuration/rotation

管理 mutation 只允许有效 Tenant Administrator，并且该角色不授予 Room 内容权限。secret 值
只能进入 owner 批准的 server-private、可版本化、可跨重启恢复并支持 stage/activate/discard 的
生产 backend。Authority SQLite/WAL 仅能保存无 secret 的 lifecycle metadata/audit；audit 也不得
记录 secret 长度、前后缀、hash 或可识别派生值。

当前仓库没有满足该合同的生产 backend，因此 production integration 必须保持
`configuration_unsupported`：没有普通 Room WebSocket/renderer IPC mutation，没有内存、环境
写回、普通文件或 SQLite fallback。已实现的 rotation state machine/keyring policy 仅是等待真实
backend 的封闭端口合同，不能冒充已接线能力。backend 获 owner 批准后，activation 必须保证旧
generation overlap 有界、running execution 使用冻结 generation、新 execution 仅用 activated
generation，并能在 crash 后 rollback 或 forward-recover；失败不得调用第二 Provider。

## 3. Offline read lease 发布策略

生产必须显式配置 `DAO_MAX_OFFLINE_READ_LEASE_MS`；缺失、非 canonical integer、低于 5 分钟或
高于 24 小时均拒绝启动。发布模板值为 8 小时，客户端不能上调。服务端签发同时受 refresh
session horizon 限制；clock skew allowance 为 0。Ed25519 active key 与 previous key 的验证 overlap
最多 24 小时，未知 key、签名错误、过期、actor/device/family/room/access/lease generation 不匹配
全部 fail closed。归档不暂停安全 expiry，revoke 后最坏离线残余暴露不超过已签 lease 的剩余期。

Desktop 只在 safeStorage 可用且 pinned verifier/authority binding 匹配时解包 data key；stolen
cache、stolen wrapped key、AAD/tag mismatch、downgrade/replay、长时间离线或 safeStorage unavailable
均保持 locked。在线 repair 仍可恢复，但不得退化成明文或进程内长期事实。

## 4. Diagnostics 与 Room export 强隔离

Diagnostics 只允许 Tenant Administrator，读取 closed operational metrics、版本、queue/dead-letter
摘要和去标识健康信息；它没有 roomId、Room corpus reader 或任意文件路径参数。artifact 原子生成、
最长 24 小时、下载重验 admin session，secret sentinel 必须为零。

生产 Desktop 复用既有 Message Authority WebSocket 的 authenticated session，协议只允许
`diagnostics.generate/read/abort`。每连接最多一个 stream、artifact ≤1 MiB、chunk ≤48 KiB；每次
read 都以当前 access token 重验 exact session 与 Tenant Administrator，按 offset、byte length、
canonical base64、safe filename、expiry 与 SHA-256 闭合。disconnect/abort 必须把 `AbortSignal`
传入共享 diagnostics limiter/generator，清 connection-private state；不得创建第二 WebSocket、listener、
scheduler 或 writer。401/403/409/410/429/503 映射为闭合错误，服务端文本和路径不进入 renderer。

Room export 只允许当前 active Human owner。begin 固定 watermark；每页最多 256，并在 page/complete
重验 session、membership、owner、lifecycle/access revision。内容只来自批准 Room projection，含
必要审计但不含 secret、Provider raw body/headers/hidden reasoning、sealed payload 或其他 Room。
临时 artifact 最长 1 小时。Diagnostics 与 export 不共享 authority、reader、artifact namespace 或
download method。

导出分类固定为 message、全部 message revision（含 recalled 原文）、recall audit、attachment
inventory、memory、source link、project fact、execution/tool/review、membership/governance audit。
附件 binding/exclusion、execution/attempt/retry/intent/cancellation、tool safety transition 与 governance
都按 `stream_seq <= watermark` 的不可变事件读取；project-boundary execution 只把事件与不可变 binding
拼接。memory version 必须由 watermark 内 exact `room.memory.version.changed` event 证明，并导出
`createdByActorId`、`replacesVersionId`、`originKind` 与最多 16 个按 BINARY 稳定排序的 exact
`sourceRefs { sourceKind, sourceId, sourceRevision }`；内部 `sourceJobId` 仅是 steward scheduling
correlation，不进入用户导出。分页期间 mutable current projection 或 watermark 之后的新事件不得改变
输出；manifest 只在成功 final audit 后发布。

renderer 不提交 filesystem path。保存只能经 closed preload IPC 到 Electron main，由 native save
dialog 决定目标；禁止 generic fs、shell、任意 URL 或任意 IPC channel。

## 5. Retention 与 worker operations

产品没有永久删除 UI；Room archive 是可逆审计只读状态。不可变审计/消息/项目/notification 按
Room lifecycle 保留。有限衍生物单独治理：command receipt 30 天、diagnostics 24 小时、Room export
1 小时；context/tool sealed payload 只按既有 eligibility/expiry purge，不改写 source fact。

每个 worker/queue 具备有界 input、batch、concurrency、timeout、attempt、backoff、recovery scan、
dead-letter 和 structured alert。host 每次 trigger 只调用一个 AuthorityWorker retention batch，
`hasMore/needs_reschedule` 交给既有 maintenance cadence；不得递归、hot-loop、新 timer、新 event bus
或第二写者。startup recovery 运行一次；shutdown 先停入口，再按依赖逆序 bounded drain。失败只
记录 closed classification 和稳定 IDs，不记录 payload、secret 或本机路径。

## 6. Desktop/IPC 与外部内容

保持 `contextIsolation:true`、`nodeIntegration:false`、closed preload surface、禁止任意 navigation/
new-window。attachment/preview/download 继续经现有 authority 与 bounded stream，不允许 renderer
获得 Node、credential、wrapped key 或 generic filesystem。所有 diagnostics/export/notification
桥接必须精确 key guard、payload/byte limit、request correlation、取消和 terminal cleanup。
