# FT-06 Context Compiler 设计稿

状态：**Stage 8 实现基线；owner 在本阶段任务中批准。** 本文只冻结 FT-06 的服务端上下文编译、来源读取与引用合同，不把 prototype-only 行为或尚未交付的 FT-07/08/09/10 当作事实。

## 1. 权威输入与边界

权威顺序为 PRD、协议/批准 spec、正式 UI 设计、生产实现与测试。起始远端基线为 `c0dc4421b3b5d5c00c4676e86bd205c482aa332c`，schema 为 v18。FT-05 提供 room corpus、五类 memory、source index、watermark 与 dispute/invalidation；FT-04 提供 attachment/extraction authority；T-0041 提供 execution、attempt、grant、Provider 与 `store:false`。

直接覆盖：`REQ-MEM-003/004/007/008/009/011/012`、`REQ-PRIM-014`、`REQ-PRJ-013`。不实现 FT-07 persona/routing、FT-08 新 invocation 状态机、FT-09 project 写模型或 FT-10 通用工具面。

旧 J-03 审阅稿曾写“人工重试复用同一冻结 context snapshot”；本阶段 owner 的明确任务要求人工 retry 创建新 execution 和新 snapshot。本文记录该批准后的语义：自动 retry/crash recovery 复用原 snapshot，人工 retry 是新 invocation lineage 并重新编译。Desktop 仍只呈现 server-confirmed execution lineage，不自行推断 snapshot。

## 2. Requirement 覆盖矩阵

| Requirement | 准确语义 | 协议/类型 | 数据库事实 | runtime / Provider | UI | 主要证据 |
| --- | --- | --- | --- | --- | --- | --- |
| MEM-003 | 默认输入是重要 memory、source、trigger、watermark 后 delta 与必要局部原文；不发全历史；超长 trigger 保留稳定身份、语义与可读索引 | `ContextCompilerInputV1`、`CompiledContextEnvelopeV1` | snapshot、manifest/items | 编译后 envelope 是 Provider 唯一上下文 | 无新增长期状态 | compiler golden/property、无 64 条窗口测试 |
| MEM-004 | 依据 manifest/source index 有界读取原消息、邻接内容、attachment extraction 或真实 project object；每次重验 membership | `room-memory.read` 参数/结果/closed error | read receipt、grant/dispatch、source revision | Adapter 前零调用拒绝；每页后复核 | 仅既有 source unavailable/deep-link 合同 | 权限矩阵、cursor 绑定、zero-call |
| MEM-007 | `confirmed memory snapshot + post-watermark raw delta + trigger/source` 单调且不重不漏 | manifest range、delta item | frozen watermark/head/range | budget 内原文，超限有序 digest/index | memory degraded 沿用既有状态 | boundary、backlog、restart |
| MEM-008 | invocation 冻结 snapshot/version/manifest；同 execution 自动 retry/crash 使用同一事实；只允许显式新 lineage 新 snapshot | snapshot/generation/lineage types | execution binding、generation、state/CAS | dispatch 前 revalidate，不重新挑选事实 | J-03 execution lineage | retry/crash/supersede/late result |
| MEM-009 | 模型配置决定确定性 token budget；按优先级 excerpt/segment/digest/index/omit；只有不可表示的单一必要输入才 `content_too_large` | config/accounting/degradation union | config/version/accounting | byte-identical compile | 不新增 UI | golden/property/boundary/multilingual |
| MEM-011 | 保留 speaker id/kind/time、reply/mention、Agent/Room/Goal/trigger reason；trusted 与 group data 分层 | structured envelope sections | immutable source refs | system/developer 仅 server policy；group content 是不可信数据 | 无 UI 变更 | request-shape/negative injection |
| MEM-012 | 只发当前 invocation 必要内容；`store:false`；不记录正文、secret、raw response/reasoning | compiled-only Provider input | 仅 restricted snapshot body；无 event/outbox/repair | no fallback、no retention | 无 UI 变更 | secret/PII sentinel |
| PRIM-014 | 全 corpus 由 steward 编译为五类 memory 与 index；Agent 按需检索，不用固定窗口/全历史 | memory/source envelope | FT-05 facts + snapshot refs | memory first、source tool on demand | 既有 Memory/source 入口 | >64 source、old source retrieval |
| PRJ-013 | 只读取真实 Goal/Decision/NextAction/Blocker/Ball/due/criteria/source；正文不替代权威状态 | private `ProjectContextAdapter` result | FT-09 未交付时无 project rows | production adapter 返回 `unavailable`，禁止推断/fixture | 不展示假项目事实 | disabled/unavailable tests |

## 3. 深模块合同

`compileContextV1(input, config)` 是 server-private、无 I/O、无时钟、无随机数的纯函数。输入已经是 AuthorityWorker 在单事务中授权并规范化的事实；编译器不能访问数据库、网络、环境变量或 Renderer。

输入按闭合版本包含：

- invocation/execution/agent/room/trigger identity；trigger revision、reason、author kind、server time、reply 与 mention；
- 当前可注入 memory versions 与其 source refs；
- 固定 `memoryWatermark`、`corpusHead` 和完整的 post-watermark source 表示；
- 明确检索片段（初次调用通常为空）及 attachment extraction segment；
- 当前 tool descriptors；
- project adapter 的 `available` 真实 projection 或 `unavailable/disabled`；
- server-owned compiler/model config。

输出 `CompiledContextEnvelopeV1` 分为：

1. `trusted.system`：固定安全/权限规则；
2. `trusted.developer`：结构化 Agent、Room、Goal availability、trigger reason、工具使用与 citation 输出合同；
3. `groupContent`：trigger、memory、delta、retrieval、attachment，全部标为 `trust: "untrusted_group_content"`，保留 source metadata；
4. `projectContext`：仅 adapter 的真实 projection；缺失时明确 `unavailable`；
5. `availableTools`；
6. `degradationNotes`；
7. `manifest` 与 accounting。

生产 `AgentRuntimeProviderInput` 只接受这个 closed envelope、tool continuation 和 limits；删除 `visibleConversation`。工具结果保持 Provider tool-output role，绝不拼入 system/developer。

## 4. 规范化与确定性

- 字符编码固定 UTF-8，换行规范为 LF；对象键以协议固定顺序编码，不依赖输入对象插入顺序。
- memory 按 `kind order → memoryRecordId → version`，delta/retrieval 按 `corpusSeq → sourceKind → sourceId → revision`，mention 按 range/target id，tools 按 id 排序。
- 重复 source identity 在编译前去重；相同 source 只能在一个区段携带正文，其余位置引用同一 manifest item。
- `manifestHash` 为 canonical manifest（不含自身 hash、snapshot id、createdAt）的 SHA-256；`contentHash` 为规范化原内容 SHA-256。runtime metadata 不参与纯编译 hash。
- 同输入、同 config 必须产生 byte-identical canonical envelope、manifest 与 hash；排列扰动不得改变结果。

## 5. 冻结预算

模型预算来自 server-side `ContextCompilerConfigV1`，Renderer/client 不可覆盖。本阶段生产配置：

| 项 | tokens | bytes / 次数 |
| --- | ---: | ---: |
| context hard limit | 65,536 | envelope 262,144 bytes |
| output reserve | 8,192 | Provider output 262,144 bytes |
| tool schema reserve | 6,144 | schema 49,152 bytes |
| trusted system/developer reserve | 4,096 | 32,768 bytes |
| trigger reserve | 8,192 | 32,768 bytes |
| identity/Room/Goal reserve | 4,096 | 24,576 bytes |
| memory budget | 12,288 | 49,152 bytes |
| raw-delta budget | 10,240 | 40,960 bytes |
| retrieval budget | 8,192 | 32,768 bytes |
| attachment budget | 4,096 | 16,384 bytes |
| degradation/manifest reserve | 4,096 | manifest 131,072 bytes |
| single segment | 2,048 | 8,192 bytes |
| source-read page / execution | 8 items / 32 calls | 32,768 / 262,144 bytes |
| source-read timeout | — | 5,000 ms |

`deterministic_utf8_v1` 的 content token estimate 是 UTF-8 byte length（保守的一 byte 一 token）加固定结构 overhead；它不是在线 tokenizer 猜测，也不动态抓模型窗口。Provider 的真实模型上限必须大于等于该配置，否则 server 启动失败。所有 accounting 都记录 estimator/config version。

全局优先级固定为：安全/权限/trusted → trigger identity/semantics → Agent/Room/Goal → confirmed memory → delta → explicit retrieval → attachment segment → supplementary context。区段 reserve 未用额度可按该顺序进入共享池，反向借用禁止。

降级顺序固定：完整 included → UTF-8/Unicode scalar 安全 excerpt（头尾并保留长度/hash）→ fixed-size segments → deterministic digest（source identity、length、hash、首尾摘要）→ index-only → omitted note。trigger 不得进入 omitted；若正文过大，至少输出 identity、语义 digest、segment index 与 read ref。只有这些表示自身仍不能装入 hard limit 时返回 `content_too_large`，并指出 source label 与恢复动作。

## 6. Manifest

每项包含 `ordinal`、`section`、`disposition`（`included|excerpted|segmented|digested|index_only|omitted|unavailable|invalidated`）、stable source identity/kind/revision、canonical order、original/included bytes 与 tokens、reason code、citation label、content hash、segment/range 与 availability。manifest 还记录 totals/reserves、watermark/head/delta range、compiler/config/model versions和 project availability。

manifest 不含 Provider body/header、secret、raw response、hidden reasoning、grant secret 或任意 filesystem/URL credential。citation label 是 server 生成的 manifest label，不是 source id。未经 manifest/read receipt 验证的文本不产生 citation。

## 7. Snapshot 生命周期与 v19 事实

首次 Provider dispatch 前，AuthorityWorker 在一个写事务中读取授权事实、编译并创建：

- `context_snapshots`：room/execution/invocation/agent/provider/model/compiler/config、trigger/revision/reason、memory version/watermark/head、authorization/tool revisions、budgets/hash、state、generation、timestamps、retention deadline；
- `context_snapshot_lineage`：manual retry / explicit supersede 的旧新 snapshot 与 execution；
- `context_manifests`、`context_manifest_items`、`context_snapshot_sources`；
- `context_snapshot_bodies`：唯一允许保存 canonical compiled envelope 的受限表；
- `agent_execution_context_bindings`：每 execution 恰一 active snapshot；
- `context_source_read_receipts`、`agent_message_citations`。

v19 仅追加 migration；v1-v18 statement/checksum/fingerprint 逐字不改。`snapshot_generation >= 1`，每 execution 唯一 binding；active snapshot 不得有 invalidated/superseded time；source/revision 与 room 复合约束；manifest ordinal/citation label 唯一；receipt 绑定 execution/snapshot/source/revision/generation；citation 只能引用 manifest item或 successful receipt。

自动 retry 与 crash recovery读取 binding/body，不重新编译。人工 retry 新 execution、新 snapshot，并写 `manual_retry` lineage。显式 supersede 新 execution/新 snapshot并写 `supersede` lineage；旧 terminal 不复活。旧 attempt 或 generation CAS 不命中为 409。

Provider 每次 dispatch 前对 room active、Agent active membership/capability revision、snapshot state/generation和全部 currently-required source visibility做 fail-closed revalidation。recall、source revision invalidation、memory dispute、room archive/membership revoke会把 snapshot 标为 invalidated或使 revalidation 拒绝；不得静默重编译或继续发送旧正文。

retention：active/nonterminal execution 保留；terminal 后 30 天清除 restricted body与read payload，但永久保留闭合 hash/accounting/lineage/citation metadata；invalidation 立即禁止再次读取正文。清理由后续 operations job执行，v19 先记录 `retain_until`。正文不进入 events/outbox/history/repair/WebSocket/Desktop、普通日志、stdout/stderr或diagnostic export。

## 8. `room-memory.read`

tool id 固定为 `room-memory.read`，effect=`read-only`。参数只允许 `{snapshotId, sourceLabel, mode, pageSize?, cursor?}`；mode 为 `source|neighbors|attachment_segment|memory_sources|project_object`。不接收 SQL、URL、path、cwd、regex或任意 room/source id。

每次 grant prepare/claim 与每一页读取都验证：server-minted Agent actor、execution/attempt、snapshot generation、active Room、active membership、capability与membership tool permission、grant、manifest label、same-room/source/revision、current visibility、not recalled/disputed/policy-invalid、attachment extraction access。失败不区分“无此 source”与“无权”，Adapter/reader 调用数为零。

closed status 映射：401 身份/会话无效；403 capability/membership/visibility；409 execution/snapshot/generation/cursor冲突；410 room/source/snapshot gone或invalidated；429页/次数/累计预算；503 authority/extraction暂不可用。offline 不执行工具；repair 完成前返回503；超时为503且不扩展范围。

cursor 是 server opaque authenticated binding，包含 room、execution、snapshot、generation、source label/revision、range/page、authorization epoch与expiry。返回值只包含 bounded data、provenance、immutable revision、next cursor与一次 read receipt/citation label。

FT-09 尚未交付，production `ProjectContextAdapter` 固定返回 `disabled`；`project_object` 读取返回 unavailable，不从消息推断。

## 9. Citation 闭环

Provider final 使用闭合 citation declaration：正文中的任意自然语言 source id 不解析；只有 Adapter 识别的独立 citation token part/严格标记才成为 declaration。token 必须是本 snapshot manifest label或successful source-read receipt label。server 校验 room、execution、snapshot、source revision、generation、visibility与 declaration 子集，去重并按 label 排序。

final commit 在 AuthorityWorker 单事务中再次 revalidate，插入 Agent message、verified `agent_message_citations`、execution terminal与既有 event/outbox。失败则整笔回滚且无 final。客户端只能接收 server-confirmed citation projection；点击仍走现有授权 source query。source recall/撤权显示正式 unavailable/tombstone，不泄漏正文。Stage 8 不新增未经正式设计覆盖的 Desktop 控件；若现有 timeline/source projection可承载，citation metadata只作为server-confirmed可选字段接入。

## 10. Provider 与隐私

OpenAI request 保持 native fetch、`stream:true`、`store:false`、closed SSE、AbortSignal与有界 buffer。system/developer只来自trusted结构；group content以结构化不可信数据块传递并包含speaker/relation/source metadata；tool result仍为function output。无secret为`noauth`，绝不fallback fake/fixed response。

restricted snapshot body只接收compiler输出，构建输入前移除secret/provider headers/raw tool body；sentinel扫描SQLite/WAL/events/outbox/repair/WebSocket/errors/log/stdout/stderr。ordinary business tables不得出现完整compiled body。

## 11. UI / 交互映射

FT-06主要是server/runtime。对应J-03 `@Agent → execution → final`、J-06“查看来源”、J-07 offline/repair；Memory panel对应PRIM-014。权威来源：execution/citation为stable event或projection，preview为local transient，source读取为server ACK后展示。401/403/409/410/429/503、offline、repair、retry、content-too-large均保持closed recovery，不用本地状态伪装成功。

本阶段不新增长期Desktop信息架构。键盘、焦点、非颜色识别、ARIA通告、200%缩放和reduced motion沿用正式FT-16合同；没有typing animation。设计偏离：除上文由本阶段owner明确更新的“人工retry新snapshot”语义外，无。

## 12. 验收与故障矩阵

- pure golden/property：重复、排列扰动、预算恰好/超一、Unicode/emoji/组合字符、长词/URL、空memory、大delta、tombstone/revision、超长trigger、版本升级；
- SQLite/Worker/restart：snapshot/binding原子、自动retry/crash字节一致、manual/supersede新lineage、source invalidation、late CAS、WAL reopen；
- source：room/membership/capability/grant/revision/cursor/limit/timeout矩阵，拒绝时reader zero-call；
- citation：arbitrary text不解析、foreign snapshot/receipt/revision/generation拒绝、commit前失效整笔回滚、history/repair/restart一致；
- Provider：request roles/layers、tool-output、store:false、noauth、bounded SSE/cancel/error、secret sentinel；
- migration：fresh与v1…v18到v19、future/checksum/fingerprint拒绝、fault rollback、schema equivalence、旧facts不变。

