# FT-10 Tool Safety：生产工程设计

> 日期：2026-08-18
>
> 性质：设计冻结；不是生产实现、交付、验收或 verified 声明
>
> 产品权威：[当前批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
>
> 证据索引：[agent-im evidence map](../reconstruction/agent-im-evidence-map.md)
>
> UI / 交互权威：[Design README](../design/README.md) 与 [103 条 Requirement 覆盖矩阵](../design/design-requirement-coverage.md)
>
> 路线与文件所有权：[approved PRD implementation map](./2026-08-18-approved-prd-implementation-map.md)
> 实施拆环：[FT-10 implementation plan](./2026-08-18-ft10-tool-safety-implementation-plan.md)

## 1. 结论与冻结边界

FT-10 不新建通用 Agent 工具平台。它在 T-0041 已交付的三个受限物理 adapter、一次确认、execution grant、claim-before-adapter、append-only dispatch 与 `outcome_unknown` 机制上，冻结新 PRD 所需的生产安全闭环：

1. 工具目录是编译期闭集，只有 `http-json.read`、`repository.git-status`、`sandbox-file.write`；
2. 每个 prepare、confirmation、grant claim、dispatch、continuation/final、restart resume 都由服务端重算权限交集；
3. read-only 工具可以在完整交集内自动执行；side-effect 工具必须逐 toolCall、精确参数、具名 Human、当前 session family 确认；
4. confirmation、grant、dispatch 和 outcome/review 是互相独立但由 AuthorityWorker 原子协调的权威事实；
5. durable dispatch claim 是不可伪装回滚的安全分界。claim 后未知结果只进入 `outcome_unknown`，禁止 generic/automatic retry；
6. compensation 是新的、显式确认和审计的 side-effect invocation/toolCall，不是 cancel 的同义词，也不改写原 dispatch 历史；
7. public protocol、repair、Desktop 与 diagnostics 只获得最小安全投影；renderer 永远不持有 credential、grant capability、sealed parameters、adapter handle 或内部 command capability。

本设计直接承担 implementation map 中 FT-10 的 11 条 Requirement：`REQ-AGT-009`、`REQ-AGT-010`、`REQ-AGT-011`、`REQ-AGT-012`、`REQ-AGT-013`、`REQ-MEM-004`、`REQ-NFR-011`、`REQ-NFR-014`、`REQ-PRIM-018`、`REQ-PRJ-013`、`REQ-ROOM-004`。横切实现还必须遵守 `REQ-ID-004/005`、`REQ-AGT-003/004/008`、`REQ-MSG-006/008`、`REQ-NFR-002/004/005/006/007/009/010/013` 与 `REQ-UX-007/009`；这些是依赖或验收边界，不扩大 FT-10 的产品所有权。

本文件完成后只能表述“FT-10 设计达到实施准备条件”，不能把 T-0041 历史能力直接标成完整 FT-10 verified。

## 2. 输入审计与前置缺口

### 2.1 已完整核读的当前输入

- 根 `AGENTS.md`、`CONTEXT.md`；
- 当前批准 PRD、evidence map、Design README、覆盖矩阵、approved PRD implementation map；
- T-0041 work note、design、implementation plan、delivery；
- 当前仓库中的 FT-01、FT-02/FT-02A、FT-03、FT-08、FT-13 设计、计划和相关交付说明；
- 已通过 PR #28 合入的 [FT-07 设计](./2026-08-18-ft07-agent-profile-routing-design.md)与[实施计划](./2026-08-18-ft07-agent-profile-routing-implementation-plan.md)，以及通过 PR #29 合入的 [FT-09 设计](./2026-08-18-ft09-project-loop-design.md)与[实施计划](./2026-08-18-ft09-project-loop-implementation-plan.md)；
- 当前 Core collaboration/sync、agent-runtime/tool-gateway、三个 tools、worker-runtime-authority、AuthorityWorker handler/schema、public protocol/WebSocket、Desktop execution/confirmation renderer 与相邻测试。

### 2.2 输入状态与合入门

任务开始时 FT-06、FT-07、FT-09 设计/实施计划均不在当时批准基线。最终发布审计时 FT-07、FT-09 两组文档已分别通过 PR #28、#29 合入当前基线；本任务只核读而不修改它们。FT-06 文档在当前 worktree、其他现有 worktree 与 `git log --all` 中仍不存在。

已合入的 FT-07 设计确认了 Profile ceiling、Assignment subset、current membership policy 与 execution grant 的四项交集，以及 active/on-mention 与 availability 分离的 seam，本设计与之相容。已合入的 FT-09 设计确认了 read-only project query、closed domain command 与具名 Human confirmation 的 seam；其 24 条直接 Requirement 已逐项核对并与批准 PRD、approved implementation map 完全一致。实施开始前仍必须重新检查实际已合入文档；若任一合同与本文件引用的批准 PRD Requirement 冲突，按 `AGENTS.md` 停止并请求 owner 裁决。

### 2.3 T-0041 可复用机制与不得继承的结论

| T-0041 现状 | FT-10 处置 |
| --- | --- |
| 三个 closed tool ID 与物理 adapter；无通用 shell、任意 binary/cwd/URL/file write。 | 保留并收紧；新增工具必须是新产品任务和显式 closed union 变更，不能运行时注册。 |
| `claimTool` 成功后才调用 adapter；拒绝矩阵断言 adapter call count 0。 | 保留为核心线性化点；扩展到 prepare/confirm/revoke/archive/recall/restart 全矩阵。 |
| confirmation/grant 只用 nullable `consumed_at` 表达；side-effect grant 在 prepare 时创建。 | 替换为闭合状态和不可变迁移记录；side-effect grant 只能在 confirmation 变为 confirmed 的同一事务签发。 |
| 权限读取静态 actor capability、membership permissions、`participation=active` 与 readiness。 | 替换为 FT-07 的 Global Profile capability ∩ Room Assignment permission ∩ current Room membership ∩ current execution grant；on-mention direct invocation 不因 participation 丢工具。 |
| confirmation principal 由调用 prepare 的 Human context 绑定，owner/admin 规则较宽。 | 替换为 PRD §8.2 的 current confirmation principal 与 target-specific handoff；role 本身不产生确认权。 |
| dispatch 为 `dispatched/succeeded/failed/outcome_unknown`；任意 side-effect exception 都 unknown。 | 扩展 prepared/claimed/dispatched 与 known/reviewed 投影；保守异常仍 unknown，明确“未触达 adapter”的失败才 known failed。 |
| manual retry 接受任何 failed/cancelled execution。 | `outcome_unknown`、`cannot_undo/needs_review` 在 review 闭合前明确不 eligible；原 toolCall 永不重用。 |
| compensation 可从 completed side effect 创建新 execution。 | 保留“新 execution”形状，改为显式、新 confirmation、新 grant、新 dispatch；不把原 dispatch 改写为 undone。 |
| repair 只有 confirmation-required event，Desktop 只有一次确认按钮。 | 扩展完整安全投影和 J-05 状态；所有动作等待匹配 ACK/event/projection。 |
| sandbox path 只做 lexical resolve。 | 增加 descriptor-relative handle/no-follow/symlink-race 防线；不能以 lexical test 作为 sandbox 完成证据。 |

## 3. 范围、非目标与工具分类

### 3.1 编译期闭集

```ts
export type ToolId =
  | "http-json.read"
  | "repository.git-status"
  | "sandbox-file.write";

export type ToolEffect = "read-only" | "side-effect";

export type ToolDescriptor =
  | { readonly id: "http-json.read"; readonly effect: "read-only" }
  | { readonly id: "repository.git-status"; readonly effect: "read-only" }
  | {
      readonly id: "sandbox-file.write";
      readonly effect: "side-effect";
      readonly reversibility: "compensatable";
    };
```

工具 registry 由 production composition root 以 exact three-entry assembly 构造。不存在 public/plugin/runtime `registerTool()`、任意 schema、任意 URL/header、任意 argv/env/cwd、任意 path/root 或 provider-selected adapter。未知 tool ID 在 Core guard、provider output parser、worker protocol、Authority handler 和 gateway 五层 fail closed。

### 3.2 read-only

- `http-json.read`：仅配置的 credential-free HTTPS origin 与 path template；参数只填 closed path/query slot；拒绝 redirect、IP literal/私网目标（除非部署配置明确列出）、非 JSON、压缩炸弹、超时和超限 body。Provider/Agent 不能设置 URL、method、headers、credential、proxy 或 DNS policy。
- `repository.git-status`：固定 absolute binary、固定 repository root、固定 argv `status --porcelain=v1 --untracked-files=no`、固定 allowlisted env；不通过 shell，不接受 cwd/argv/env。repository identity 是 server config，不是 tool parameter。
- room-memory lookup、附件读取由 FT-06/FT-04 的内部 read/query seam 提供，并遵守同一 membership/source 权限和有界输出；它们不把任意 storage URL 暴露为 HTTP 工具。
- project query 是 FT-09 server-private domain query，不进入外部 adapter registry，不授予 project mutation。

read-only 失败可按 FT-08 的 closed transient 策略、同 execution/snapshot、有限 attempt 重试；每次新 attempt/claim 仍重验全部权限。read-only 也必须有 durable grant/claim，不能因为“无副作用”绕过 membership/assignment/source ACL。

### 3.3 side-effect

`sandbox-file.write` 是 MVP 唯一外部写工具：配置 root 下的 normalized relative UTF-8 path、bounded UTF-8 content、expected-current SHA-256。必须使用 no-follow/descriptor-relative traversal 或等价、可证明不受 symlink swap 影响的文件句柄策略；父目录创建、temp、fsync、rename、preimage capture、postimage hash 与 compensation record 全部有界。

禁止通用 shell/terminal、deploy、外部消息、任意网络写、任意文件写、任意 binary、任意 Provider/BYOK。FT-09 project command 是 closed internal domain command，不是把自由文本交给 adapter；Agent 只能提出或调用具名命令，Human gate 仍按 PRD §8.2 决定。

## 4. Core closed types、guards 与 type tests

### 4.1 权威状态

```ts
export type ToolConfirmationState =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired";

export type ToolGrantState = "active" | "claimed" | "revoked" | "expired";

export type ToolDispatchState =
  | "prepared"
  | "claimed"
  | "dispatched"
  | "known_succeeded"
  | "known_failed"
  | "outcome_unknown"
  | "reviewed";

export type ToolReviewResolution =
  | "known_succeeded"
  | "known_failed"
  | "compensated"
  | "accepted_risk";
```

`confirmed` 是不可改写的 Human 决定；它不会因为 grant revoked、parent cancelled 或 Room archived 被改回 rejected。`claimed` 是 grant 单次消费终态，不能撤销。dispatch 的 `reviewed` 必须携带 review resolution、具名 Human、时间、证据摘要 hash 与可选 compensation invocation/toolCall 引用；不携带 raw evidence body。

### 4.2 精确 binding

```ts
export interface ToolCallBinding {
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionVersion: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly toolId: ToolId;
  readonly canonicalParameterSha256: string;
  readonly sourceSnapshotId: string;
}

export interface ConfirmationBinding extends ToolCallBinding {
  readonly principalActorId: string;
  readonly sessionFamilyId: string;
  readonly bindingGeneration: number;
  readonly expiresAt: string;
}
```

confirmation 必须绑定 user 要求的 executionId、attempt、toolId、规范化参数 SHA-256、room、principal、session family、expiresAt，并额外绑定 stable `toolCallId`、execution version、source snapshot 和 binding generation，避免同 attempt 多 toolCall、handoff 或 stale version 混淆。

### 4.3 参数规范化、preview 与 sealed payload

- 每个 tool 有独立 exact parser；拒绝额外字段、重复 JSON key、NaN/Infinity、非 NFC string、非法 Unicode、超深/超宽结构和超限内容。
- canonical bytes 使用版本化 RFC 8785-compatible JSON profile；hash 输入固定为 `toolId + schemaVersion + canonicalParameters`，UTF-8 后做 SHA-256。schema/profile version 是 binding 一部分，升级不重解释旧 hash。
- public confirmation preview 由 parsed parameters 生成 closed、非可逆模板：HTTP 只显示配置数据源和 path label；Git 只显示配置 repository label；sandbox write 显示相对 path、create/replace、content byte count、expected hash short form，不显示完整 content。
- pending side-effect 跨 restart 所需参数以 server-private AES-GCM sealed invocation payload 保存，AAD 绑定完整 `ToolCallBinding`；DB/repair/event/log/diagnostic 中没有 raw params。secret、HTTP headers、raw provider/tool body、stdout/stderr、hidden reasoning 永不持久化。sealed payload 有 key version、byte limit、expiry，review 结束后按 FT-14 retention policy清理；renderer 永远收不到密文或 key。
- 参数 schema 禁止 credential/token/header 字段；secret sentinel 必须扫描 SQLite/WAL/snapshot/outbox/wire/cache/log/stdout/stderr/diagnostics/DOM，raw canary 和 secret 均零命中（隔离测试输入除外）。

### 4.4 必需 type/guard tests

- 任意字符串不能赋给 `ToolId`；read-only descriptor 不能携带 side-effect compensation 字段；side-effect descriptor 不能省略 reversibility。
- public confirmation command 只能含 `confirmationId`、`expectedVersion` 和 decision，不能含 actor/room/session/grant/capability/hash/raw params。
- renderer projection 不能赋给 internal grant/dispatch permit；internal capability 不能经 JSON/public frame 构造。
- confirmation/grant/dispatch/review record 的状态特定字段必须 exact：pending 无 confirmer，confirmed 有 decision time，revoked 有 reason，reviewed 有 resolution。
- `outcome_unknown` 不能满足 generic retry eligible guard；compensation 不能复用原 toolCallId/grantId/dispatchId。
- repair record 和 public event 禁止 raw params、sealed payload、compensation token、credential/header/body/stdout/stderr/reasoning 字段。

## 5. 状态机与不变量

### 5.1 prepare → confirmation → grant

```text
read-only:
  toolCall prepared → grant active → grant claimed → dispatch claimed

side-effect:
  toolCall prepared
    → confirmation pending
      → rejected(reason) ───────────────┐
      → expired                         ├→ parent cancelled/failed，adapter 0
      → confirmed → grant active        │
                       → revoked/expired┘
                       → claimed → dispatch claimed
```

规则：

1. prepare 只创建 toolCall、safe preview、sealed payload 和 pending confirmation；side-effect **不提前签发 grant**。
2. Human confirm command 在一个 AuthorityWorker transaction 重验 binding/principal/session/membership/Room/source/execution/tool permission；winner 把 confirmation 变为 immutable confirmed，并签发唯一 active grant。replay 同一 command 返回同 receipt；另一个 session 的重复决定不再签发 grant。
3. reject 把 pending → rejected 并 fenced/cancel parent；adapter 0。expiry worker 或任何执行点发现 `now >= expiresAt` 时以 CAS pending → expired；安全 expiry 不因 archive 暂停。
4. confirmed confirmation 的 grant 在 claim 前可因 cancel/supersede/source recall/archive/principal/session/member/assignment/Profile/capability reduction变为 revoked；confirmation 保持 confirmed。
5. confirmation handoff 是 target-specific offer/accept transaction：accept winner 增加 binding generation、撤销旧 pending binding并建立新 pending binding；confirm 与 handoff.accept 只能一个成功。旧 principal/session family 永久失败。

### 5.2 grant 与 dispatch

```text
grant active → claimed
            ↘ revoked
            ↘ expired

dispatch prepared → claimed → dispatched
                           ↘ known_failed (仅证明 adapter 未产生副作用)
                dispatched → known_succeeded
                           → known_failed
                           → outcome_unknown → reviewed(resolution)
```

- `grant claimed` 与 side-effect confirmation consumption、dispatch prepared→claimed、execution phase CAS 在**同一个 AuthorityWorker transaction**；transaction 内再次重验完整权限交集和全部 binding。
- adapter 只能接收已提交的 opaque `DispatchPermit`。permit 是进程内一次性对象，不序列化、不持久化、不进 renderer；同一 `dispatchId` 的进程内 latch 保证至多调用一次。
- runtime 在进入 adapter boundary 前提交 `dispatch claimed`；随后 best-effort 标记 `dispatched`. claim commit 后 crash（无论 adapter 实际是否开始）都保守转 `outcome_unknown`，绝不重发 permit或调用 adapter。
- `known_failed` 只用于 adapter 能证明未发生副作用或明确返回失败且合同证明原子未写；未知 throw、timeout、abort、进程崩溃、settle ACK 丢失一律 `outcome_unknown`。
- dispatch claim 后的 cancel 只取消 parent 的后续 provider/tool/final 步骤并传播 abort；dispatch/outcome/review 继续独立收敛，不显示“已撤销”。

### 5.3 outcome 与 review

- `known_succeeded`、`known_failed` 是 adapter settle 的不可变已知结果；`outcome_unknown` 是必须 Human review 的事实，不是 generic failed。
- `outcome_unknown` 没有自动 retry、manual generic retry、同 toolCall resume 或 compensation shortcut。review principal 由 PRD §8.2 current Human principal、原 confirmer或 owner/admin 安全兜底规则计算并在执行点重验。
- review command 只记录结论，不调用 adapter：`known_succeeded`、`known_failed`、`accepted_risk`，或引用一个**已完成且已知成功**的新 compensation toolCall 后记录 `compensated`。
- review 后如需再次行动，创建新 invocation/execution/toolCall/confirmation/grant/dispatch；原 toolCall 永不再次执行。
- compensation 的 source 指向原 dispatch/review，使用当前权限、新精确参数、新 Human confirmation和新 adapter call；失败/unknown 有自己的 outcome/review，不改写原事实。

### 5.4 replay 与冲突

| 输入 | 权威结果 | adapter 次数 |
| --- | --- | ---: |
| exact command idempotency replay，payload相同 | 原 ACK/receipt；无新 state transition | 0（若原 claim 已调用，累计仍最多 1） |
| duplicate confirmation，同一 pending winner已 confirmed | 返回 current confirmed/grant projection或 409 duplicate；绝不签第二 grant | 0 |
| duplicate confirmation，已 rejected/expired/revoked binding | 409/410 closed terminal | 0 |
| same idempotency key，changed payload | 409 `idempotency_conflict` | 0 |
| canonical params/hash changed | 409 `tool_parameters_changed`；旧 confirmation/grant终结，要求新 toolCall | 0 |
| expired confirmation/grant | 410；CAS expired | 0 |
| stale attempt/version/binding generation | 409 `stale_tool_call` | 0 |
| claim receipt丢失后重放 | 返回同 dispatchId/current outcome；不重新发 permit | 累计最多 1 |

## 6. 权限交集与执行点重验

唯一授权公式：

```text
effective tool authority =
  Global Profile capability
  ∩ Room Assignment permission
  ∩ current Room membership / active Room eligibility
  ∩ current execution grant
```

其中 current Room membership 同时要求 Agent assignment 仍存在、Human confirmation principal 仍是当前 Human member、source/attachment/project query 仍可 operationally 读取。`ready/busy/paused/noauth` 是 FT-07/08 availability gate，不替代 capability；UI 隐藏不是授权。

| 执行点 | 必须重验 | 失败收敛 |
| --- | --- | --- |
| Provider tool manifest build | Profile/Assignment revision、membership、origin、source/snapshot ACL、Room active、closed catalog | tool 不可见；Provider 0，或继续无工具生成。 |
| tool prepare | execution/attempt/version、toolCall uniqueness、catalog/schema、四项交集（side-effect 此时尚无 grant，检查 grant eligibility）、source/Room | zero confirmation/grant/dispatch；adapter 0。 |
| confirmation read/submit/reject/handoff | current principal/session family、membership、binding generation、params hash、expiry、parent/fence、Room | 403/409/410；adapter 0。 |
| grant issue | confirmation winner、四项交集前三项、execution current、Room/source active | no grant；adapter 0。 |
| grant/dispatch claim | 四项完整交集、confirmation consumed-once、attempt/version/hash/expiry、无 fence、Room active | grant revoked/expired或closed rejection；adapter 0。 |
| adapter boundary | committed dispatch permit、local once latch、deadline/buffer budget、cancel state；不重新解释 params | 无 permit则0；有 permit累计最多1。 |
| settle / continuation / final | dispatch identity/current outcome、execution/attempt/fence、Room/membership/Assignment/Profile/source | outcome仍保留；阻止后续 provider/final。 |
| restart resume | confirmation/grant/dispatch/outcome/review、expiry、Room/source/profile/assignment/membership | claimed/dispatched不重放；unknown进review；未claim才可继续。 |

任何 profile capability、Room Assignment permission、membership 或 execution grant reduction 都立即影响下一执行点；只增权限不能让旧 rejected/revoked/expired toolCall复活。

## 7. AuthorityWorker transaction、CAS 与 server-private seams

AuthorityWorker 继续是唯一 writer。每个 accepted command 在同一 `BEGIN IMMEDIATE` 中提交 domain record、immutable transition/audit、stable event、outbox、idempotency receipt；adapter、renderer、WebSocket、timer、repair worker都不能写 authority fact。

### 7.1 FT-10 command family

| server-private operation | transaction 输出 / CAS |
| --- | --- |
| `prepareToolCall` | current execution/attempt/version + permissions → toolCall + sealed payload + safe preview；read-only另签 active grant，side-effect写 pending confirmation。 |
| `decideToolConfirmation` | pending + expected version/binding + current Human authority → confirmed+唯一 grant，或 rejected+parent fence；exact replay同 receipt。 |
| `expireToolSafetyRecords` | keyset bounded CAS pending/active且 `expires_at <= now` → expired，收敛 parent；claimed/dispatched不碰。 |
| `revokeUnclaimedToolAuthority` | confirmed 保持；active grant → revoked；pending confirmation按原因 rejected；fence waiting execution。 |
| `claimToolDispatch` | active grant + confirmed confirmation（side-effect）+完整重验 → consume confirmation、grant claimed、dispatch claimed、execution phase/version CAS。 |
| `markDispatchEntered` | claimed → dispatched；若已 terminal/unknown返回current，不重复 permit。 |
| `settleToolDispatch` | claimed/dispatched + expected version → known succeeded/failed/unknown；迟到 settle只更新独立 dispatch，不复活parent。 |
| `reviewUnknownOutcome` | unknown + current named Human + evidence hash → reviewed resolution；无 adapter。 |
| `beginCompensationInvocation` | outcome_unknown（原 review 保持未闭合）或 known result + current authority → 新 invocation/toolCall proposal；不复制旧 grant/dispatch。只有新 compensation toolCall 已 known succeeded 后，原 outcome_unknown 才可 review 为 compensated。 |

### 7.2 给 FT-02 archive transaction

提供 transaction-local `ArchiveToolSafetyParticipant.settleUndispatched(roomId, archiveGeneration, now)`：

1. pending confirmation → `rejected(room_archived)`；
2. active、未 claim grant → `revoked(room_archived)`；
3. waiting execution/attempt → fenced/cancelled，阻止 resume/final；
4. claimed/dispatched/known/unknown/reviewed facts原样保留；必要时只写“parent archived/cancelled after claim”的关联审计；
5. participant **不调用 adapter**、不等待 runtime、不做 compensation、不把 dispatch 改写为 revoked。

它必须与 Room archived state、timer freeze、audit/event/outbox/idempotency 在同一个 FT-02 Authority transaction；participant 任一步失败则 archive 全事务回滚。reopen 不复活任何 rejected/revoked/expired记录。

### 7.3 给 FT-08 runtime

提供 closed `RuntimeToolSafetyPort`：prepare、confirm/reject/handoff、grant/dispatch claim、mark dispatched、settle、review、final eligibility CAS。所有操作带 expected execution attempt/version/toolCall version；stale attempt/version 409且adapter 0。

cancel 顺序固定为 `cancel/fence commit → runtime abort`。claim 前 cancel走 reject/revoke；claim 后 cancel保留 dispatch事实并只阻止 continuation/final。restart scan不为 claimed/dispatched/outcome_unknown生成 permit，不自动重放；pending/confirmed-unclaimed只有重新通过当前权限/expiry检查才可继续。

### 7.4 给 FT-09 project commands

提供两个不同 discriminant 的 server-private seam：

- `ProjectToolQuery`：read-only、Room-scoped、bounded projection，只读 Goal/Decision/Request/NextAction/Blocker/Ball/source；每次 query重验当前 membership/source ACL；
- `ProjectDomainCommand`：编译期 closed command union，只能提交 FT-09 已定义的合法迁移和 expected object version；Agent capability由 runtime注入，不能由 public文本构造。

Agent 自由文本、provider raw tool JSON 或“我已完成”正文不能改变项目事实。需要 Human confirmation/acceptance/verification 的对象仍由 PRD §8.2 的具名 Human 决定；FT-10 不能用外部工具 confirmation替代 FT-09 domain confirmation。

### 7.5 给 FT-13 repair/restart

提供 public-safe current projection records：confirmation、grant、dispatch、review。records 只含 stable IDs、tool display ID、state、safe preview、reason code、expiresAt、version、named Human display reference和关联 source；不含 secret、raw/sealed params、hash原像、grant capability、compensation token、provider/tool body。

record descriptor加入 FT-13 单一 closed registry，materialized/streaming 共用 mapper；fixed watermark 后的新 transition只经 delta应用。restart/recovery分页 drain-until-empty；单个坏记录进入 closed dead-letter/repair alert，不能阻塞尾部。dead-letter 只阻断 worker自动推进，不允许 adapter retry。上述有界、脱敏的 tool safe preview 是 confirmation 权威投影的一部分并进入 repair；Provider partial stream preview、raw/sealed params 与 token 不进入 repair。

## 8. public/internal protocol separation

### 8.1 public Human frames

建议 closed frame family：

- `tool.confirmation.decide { requestId, confirmationId, expectedVersion, decision: confirm|reject }`
- `tool.confirmation.handoff.offer/accept`（只有 PRD §8.2 target-specific handoff producer/target）
- `tool.outcome.review { requestId, dispatchId, expectedVersion, resolution, evidenceSummary }`
- `tool.compensation.propose { requestId, dispatchId, expectedVersion }`

public input不含 roomId（从对象解析后与session membership复核）、principalId、sessionFamilyId、agentId、attempt、toolId、parameter hash/raw params、grantId、dispatch permit、capability、provider/model/URL/header/path root。ACK仅表示 authority transaction结果；adapter执行结果来自 stable event/projection。

### 8.2 internal only

prepare/claim/mark-dispatched/settle/recovery/archive participant/project query/domain command只存在 worker closed protocol或进程内 capability。capability是非序列化 branded type，package root、preload、renderer和WebSocket schema均不导出。错误只返回 closed code、对象ID、current safe projection和retry/review action，不返回SQL、stack、raw body或参数。

## 9. 威胁与拒绝矩阵

| Threat / race | 拒绝或线性化结果 | adapter |
| --- | --- | ---: |
| 未注册 tool / tool ID 混淆 | parser/registry拒绝 | 0 |
| 任意 URL/header/method、argv/env/cwd、absolute/`..`/symlink path | descriptor parser/adapter handle策略拒绝 | 0 |
| Profile无capability / Assignment无permission / Agent或Human已离群 | prepare/confirm/claim/resume重验拒绝 | 0 |
| on-mention Agent被direct调用 | 使用完整Assignment子集；不得因非active丢工具 | 依实际合法call |
| UI隐藏按钮但伪造frame | 服务端对象principal重验403 | 0 |
| changed params / canonicalizer version | 409，旧binding终结，新toolCall | 0 |
| wrong principal/session family/Room | 403；handoff前旧binding仍唯一，accept后旧binding永久失效 | 0 |
| duplicate/exact replay | 同receipt/current projection；无第二grant/permit | 累计≤1 |
| confirmation/grant exact expiry | 410 + terminal expiry | 0 |
| principal/session family revoke | pending reject；confirmed grant claim前revoke；claim后保留dispatch | 0或累计≤1 |
| source recall / parent cancel / supersede | 同上，reason稳定且source operationally excluded | 0或累计≤1 |
| Room archive/reopen | archive原子settle未claim；reopen不复活 | 0或累计≤1 |
| claim前 revoke vs claim | single writer winner：revoke先则claim失败；claim先则dispatch事实保留 | 0或1 |
| claim后 cancel vs adapter settle | parent cancelled；settle只闭合dispatch，不写final | 累计1 |
| crash after claim before adapter | outcome_unknown；restart不发permit | 0（物理）但语义按可能发生处理 |
| crash/timeout during/after adapter | outcome_unknown；Human review | 累计1 |
| known success then recall/archive | success保留；不自动compensate | 累计1 |
| generic retry unknown | 409 needs_review | 不增加 |
| compensation | 新invocation/toolCall/confirmation；原事实不变 | 新call各≤1 |
| raw params/body/header/stdout/stderr/reasoning进入event/log/repair | guard/sentinel/build失败 | 不适用 |
| queue/buffer/timeout/shutdown超界 | 429/closed failure/bounded drain；无永久spinner | 未claim 0；已claim不重放 |

## 10. 双顺序 race 冻结

| Race | A 先提交 | B 先提交 |
| --- | --- | --- |
| archive vs confirmation confirm | archive：pending rejected、parent fenced；late confirm 409/410 | confirm：confirmation confirmed + grant active；archive随后 revoke grant、parent cancel；adapter 0 |
| archive vs dispatch claim | archive：grant revoked；claim 409 | claim：dispatch claimed保留；archive只cancel后续；settle/unknown继续 |
| recall vs confirm | recall rejected pending；confirm失败 | confirm事实保留，recall revoke unclaimed grant |
| revoke vs claim | revoke未claim grant；adapter 0 | claimed dispatch保留；撤权阻止continuation/final |
| cancel vs claim | cancel commit reject/revoke；adapter 0 | claim事实保留；cancel commit-before-abort，不称回滚 |
| grant expiry vs claim | expiry CAS winner，claim 410 | claim winner，expiry worker跳过claimed |
| adapter settle vs cancel | known outcome写入，然后parent cancel只阻止后续 | parent cancel先，迟到settle仍只闭合dispatch |
| review vs late settle | review只允许unknown current version；late settle冲突 | known settle先则review载入known，无需unknown review |

AuthorityWorker `BEGIN IMMEDIATE` 和 expected version决定 winner；Desktop时间戳、按钮点击顺序、socket到达顺序都不是事实源。

## 11. crash/restart/outcome truth table

| Crash point | durable truth | restart action | adapter cumulative max |
| --- | --- | --- | ---: |
| prepare transaction前/中 | 无toolCall或整笔回滚 | 原runtime按FT-08决定是否重试prepare | 0 |
| pending confirmation已commit | pending + sealed payload | 若未过期且权限仍有效继续等待；否则reject/expire | 0 |
| confirm transaction后/grant claim前 | confirmed + active grant | 重验后可claim；revoke/expiry不复活 | 0 |
| claim transaction前 | 未claimed | 可安全重新尝试同claim command | 0 |
| claim commit后/permit执行前 | claimed dispatch | 直接outcome_unknown，删除本地permit；不调用 | 0（但按可能发生审查） |
| adapter进入后/mark dispatched前 | claimed | outcome_unknown | 1 |
| dispatched后/settle前 | dispatched | outcome_unknown | 1 |
| known outcome settle commit后/parent continuation前 | known outcome | 不调用adapter；重验后续execution eligibility | 1 |
| outcome_unknown | unknown | 只恢复review UI/notification；无generic retry | 1 |
| reviewed | reviewed | 只恢复closed projection；新动作需新toolCall | 1 |
| compensation任何阶段 | 作为独立side-effect应用同一表 | 不影响原dispatch | 每个新dispatch≤1 |

## 12. 有界资源与 shutdown

| 面 | 默认 / hard ceiling | 失败语义 |
| --- | --- | --- |
| pending confirmations per execution / Room | 1 / 64 | 409或429，不创建半记录 |
| confirmation TTL | 5 min / 15 min | exact expiry→410；archive不暂停 |
| active grant TTL | 60 s / 5 min，且不晚于confirmation | claim前expired；不续期复活 |
| canonical parameter bytes | 256 KiB / 1 MiB | 400 `tool_input_too_large` |
| sandbox content | 256 KiB / 1 MiB | prepare前拒绝 |
| HTTP decoded body | 256 KiB / 1 MiB | abort+known read failure；无持久raw body |
| Git stdout+stderr | 128 KiB / 1 MiB | kill child，closed failure；stderr不持久化 |
| safe preview / public summary | 2 KiB / 8 KiB | deterministic truncation + hash/omission marker |
| adapter timeout | HTTP 15s、Git 10s、write 10s / 30s | read-only closed retry eligibility；side-effect claim后unknown |
| repair/recovery batch | 100 / 500 | keyset drain-until-empty，poison record隔离 |
| per-Room claimed side effects | 1 / 1 | 后续排队或429；不并行side effects |
| shutdown | 15s / 30s | stop new claim→commit cancel/unknown→abort→bounded all-settled→AuthorityWorker last |

所有 constructor/config 对 0、负数、NaN、Infinity、超 hard ceiling fail startup。流式 body、decompression、stdout/stderr、file preimage、sealed payload、modelInput、queue、timer和close wait都必须计入预算；不能先无界读完再检查长度。

## 13. J-05 Desktop 设计合同

### 13.1 状态与权威来源

| J-05 状态 | 权威来源 | 必须显示 / 动作 |
| --- | --- | --- |
| pending | stable confirmation-required event / repair projection | safe目标、参数摘要、影响、可逆性、expiry、confirm/reject；无raw content。 |
| rejected | stable event/projection | Human拒绝或system reason文本；“未执行”；新invocation入口。 |
| duplicate | matching ACK/current projection | 409 duplicate与“已由另一session处理”；载入最新，不再dispatch。 |
| params-changed | 409 + terminal projection | hash binding失效、adapter 0；以新参数创建新toolCall。 |
| principal-revoked | terminal session/membership event | 旧binding不可复活；先移除敏感preview并重新认证。 |
| confirmed | confirmation event | Human决定已记录、尚未dispatch；说明grant仍可被revoke。 |
| grant-revoked | grant event/projection | confirmed保持；原因；明确“未执行”；无retry旧grant。 |
| dispatched | dispatch event/projection | 已进入不可假装回滚分界；cancel只停止后续。 |
| outcome_unknown | dispatch outcome event/projection | 高显著但非仅颜色；generic retry隐藏/禁用；焦点到Human review。 |
| reviewed | review event/projection | named reviewer、closed resolution、evidence summary；新动作/新compensation入口。 |
| expired | expiry event/projection | “已过期，未执行”；无复活按钮。 |

safe preview 由server event/projection产生，不由renderer从raw params重建。renderer只发对象命令；confirm/reject/review按钮进入 submitting，直到 matching requestId ACK和stable projection收敛。重复eventId不重复通告或移动焦点。

### 13.2 错误、offline 与 repair

| 分支 | UI 恢复合同 |
| --- | --- |
| 401 | 清当前提交态，锁定敏感Room projection，焦点到重新认证；旧binding不自动重发。 |
| 403 | 显示当前权限/主体已失效；刷新对象projection；无“再试一次”旧claim。 |
| 409 | 区分 duplicate、stale version、params changed、grant revoked、already terminal；载入current projection。 |
| 410 | confirmation/grant/source expired/gone；显示新invocation动作。 |
| 429 | 保留用户review输入，显示server retryAfter；禁止自动重复side-effect command。 |
| 503 | 保留完整旧projection与输入，显示服务不可用；只允许重试幂等Human decision/query，不自动dispatch。 |
| offline | 只读最后完整加密cache；confirm/reject/review/compensate全部禁用且transport call count 0。 |
| repair | fixed-watermark staging完成前保留旧完整只读视图；repair后旧confirmation不自动执行。 |
| repair_failed | 保留旧完整只读projection，提供重试repair/重新认证；无永久spinner。 |

### 13.3 可访问性

- 卡片和按钮使用明确标题、state text、icon/shape，不依赖绿/黄/红；`OUTCOME_UNKNOWN`、`REVOKED`、`EXPIRED`均有可读文本。
- 键盘顺序为状态摘要→详情→来源→primary decision→secondary decision；Space/Enter触发，Escape只关闭详情，不取消事实。
- 提交后焦点留在原动作；ACK/event后移到同卡状态标题；409/410焦点到恢复动作；card被撤权移除时焦点回execution heading。
- status使用克制 `aria-live=polite`；权限撤销/unknown需一次 `role=status` 或 `alert`，preview `aria-live=off`；重复event不重复播报。
- 200% zoom与840px最小Desktop窗口下不水平遮挡primary action，长ID/路径安全换行；详情可折叠但状态/动作不可隐藏。
- `prefers-reduced-motion` 下无依赖动画、闪烁或自动滚动；状态改变用文字/结构表达。
- 与设计基线偏离：**无**。设计稿步进按钮和fixture仍是 prototype-only。

## 14. migration/backfill 原则

- 本设计不预占版本号。当前合并基线是 v13（FT-02A）；实施时由 FT-13 migration coordinator读取实际 predecessor并唯一分配 next immutable migration。
- 绝不修改历史 migration statement/checksum/fingerprint。fresh、所有受支持历史版本→next、future refusal、每条新statement fault rollback、physical invariant均用真实SQLite测试。
- 旧 `consumed_at IS NULL` confirmation/grant 不能猜成新 pending/active：
  - 已有dispatch引用的 grant → claimed；confirmation若匹配dispatch → confirmed+consumed；dispatch按旧state映射known/unknown；
  - 无dispatch但已consumed的异常行拒绝migration或进入显式 `legacy_needs_review` quarantine，绝不签permit；
  - 未consumed side-effect confirmation/grant不自动恢复执行，backfill为 `rejected(legacy_unbound)` / `revoked(legacy_unbound)` 并fence parent；
  - 未consumed read-only grant backfill为expired，需runtime新prepare；
  - 旧 succeeded side effect可保留known succeeded，但不能据此声称新review/confirmation principal合同已验证。
- backfill只写事实/审计，不生成新业务notification、不调用adapter、不唤醒runtime、不产生新confirmation；旧 sealed compensation按原key读，但只有新显式compensation流程可使用。
- rollout为 reader/guards → migration/backfill → internal producers → public commands → repair/replica → Desktop；rollback只关闭新producer/consumer，不降schema、不删事实、不恢复旧permissive路径。

## 15. 验收证据门

实施交付至少必须给出：

- closed Core guards/type tests与public/internal不可互赋；
- 三adapter安全边界、symlink/redirect/argv/env/body/buffer/timeout测试；
- 完整adapter call-count-zero拒绝矩阵，以及每个side-effect dispatch累计最多1次；
- confirmation/grant/dispatch/review AuthorityWorker transaction/CAS/idempotency/fault tests；
- archive/recall/revoke/cancel/expiry/claim双顺序race；
- crash/restart truth table与unknown不重放；
- secret/raw params/body/header/stdout/stderr/reasoning sentinel；
- real SQLite/AuthorityWorker/WS多session E2E、fixed-watermark repair、outbox replay；
- J-05全部状态、401/403/409/410/429/503/offline/repair与a11y DOM/Electron验收；
- migration实际 predecessor/version/checksum/fingerprint与backfill/quarantine数量；
- 明确列出尚未合入或尚未真实验证的 FT-06/07/09/13 production seam，不得用fake宣称production完成。

## 16. 设计完成口径

本设计冻结 read-only/side-effect分类、confirmation/grant/dispatch/outcome/review状态机、权限交集、transaction/CAS、四个跨FT server-private seam、protocol/repair/privacy、有界资源、J-05和migration原则。实施顺序与文件级TDD见配套计划。

**FT-10 设计达到实施准备条件。**
