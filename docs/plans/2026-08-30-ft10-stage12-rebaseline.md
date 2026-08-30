# FT-10 Tool Safety · Stage 12 生产 rebaseline

> 日期：2026-08-30  
> 状态：生产实施基线；不表示 delivered、verified 或 owner 验收  
> predecessor：`origin/main@6cce90b8c61c03a0f7e0be0a613e08461a3d8236`  
> Authority schema predecessor：v25  
> 产品权威：已批准 PRD；协议与 UI 权威遵循根 `AGENTS.md`

## 1. 结论

Stage 12 从实际远端 `main` 的 v25 开始，在一个 immutable v26 中完成 FT-10 的 canonical toolCall、confirmation、grant、dispatch、review、compensation lineage、legacy quarantine、repair projection 和 archive linkage。production 外部物理 adapter 闭集精确为：

- `http-json.read`
- `repository.git-status`
- `sandbox-file.write`

`room-memory.read`、附件读取和 FT-09 project query/command 是 server-private closed domain/read seam，不属于外部 adapter registry。不存在 public/plugin/runtime `registerTool()`、任意 shell、任意 URL/header/method、任意 binary/argv/env/cwd、任意 path/root、deploy、外部消息写入、BYOK、多 Provider 或 Blueprint adapter。

设计旅程为 J-05“side effect → 精确确认 → dispatch → result/review”。正式设计偏离：**无**。

## 2. Git、schema 与生产现状

### 2.1 起始事实

- 原工作区 `/Users/leo/code/Dao` 保持 `codex/ft02a-delivery-trace-fix@979863e7936962626b54a130d0260a4689a9bfb0`；四个既存未跟踪计划文件未被写入、暂存、移动或格式化。
- 实现 worktree：`/Users/leo/code/Dao-ft10-stage12`，branch `codex/ft10-stage12-tool-safety`，从 `origin/main@6cce90b...` 创建。
- 实际 schema：`AUTHORITY_SCHEMA_VERSION = 25`。
- 起始全量基线：236 files（233 passed / 3 skipped）；2523 tests（2520 passed / 3 skipped）。三个 skipped suites 是显式 opt-in OpenAI live suites。
- `worker-persistence` single-fork 编排必须保留；不增加默认测试超时、不把真实 Worker 改 fake。

### 2.2 已交付 seam

- FT-06：immutable context snapshot、source read/re-auth、`room-memory.read` server-private adapter。
- FT-07：Global Profile、Room Assignment、membership/access、active/on-mention、availability 与 revision gate。
- FT-08：五态 execution、attempt/version、scoped cancellation、cancel commit-before-abort、retry/recovery、final CAS。
- FT-09：Goal/Decision/Request/NextAction/Blocker/Ball、closed project query/command dispatcher、repair 与 Desktop Project Panel。
- FT-02C：transaction-local `ArchiveToolSafetyParticipant` skeleton；archive/reopen 与安全 expiry 分离。
- T-0041/v6 + v14：旧 confirmation/grant/dispatch 与 compensation 机制，只作为迁移输入和机制基础。

### 2.3 已核实缺口

1. `packages/core/src/agent-profile.ts` 的 `AGENT_TOOL_IDS` 含四项，并把 `room-memory.read` 与三个物理 adapter 混为同一 `AgentToolId`；`collaboration.ts` 的 `ToolDescriptor` 同样混合 internal read。
2. v6 `agent_execution_grants`、`tool_confirmations` 使用 nullable `consumed_at`；side-effect prepare 提前建立 grant。
3. v14 添加 current state/revision，但 `confirmed` 仍要求 `consumed_at` 非空，Human decision、grant issue、claim consumption 没有完全分离。
4. `tool_dispatches.state` 仍是 `dispatched/succeeded/failed/outcome_unknown`；没有 prepared/claimed、immutable transition、review 或新 compensation lineage。
5. binding 缺 `toolCallId`、invocation、execution version、canonicalizer/schema version、source snapshot、Profile/Assignment revisions、binding generation。
6. `tool-gateway.ts` 直接从 authority 取得可序列化 parameters；没有 branded `DispatchPermit` 与 dispatch once latch；gateway把任意 side-effect throw归为 unknown、任意 read throw归为 failed，adapter没有 typed outcome。
7. HTTP adapter没有 DNS/连接地址绑定、IP/private address拒绝、独立 connect/body/total deadline、encoding/decompression/JSON shape预算。
8. Git adapter没有启动 root identity与symlink swap证明；argv仍含 `-C`，raw stdout直接进入 model input，stderr/合计预算与恶意 filename/newline未闭合。
9. Sandbox adapter只做 lexical `resolve()`；会递归建父目录，未关闭 parent/target symlink/hardlink/prepare→claim swap；rename后未 fsync parent；补偿仍由旧 execution直接调用 adapter。
10. public 仍暴露 `agent.tool.confirm { confirmationId, executionId }` 与 `agent.compensate { executionId }`；没有 expectedVersion、decision、handoff、review或新 toolCall compensation contract。
11. repair只有 `agent.tool.confirmation-required` event；Desktop `app.ts` 只有一次“确认执行一次”按钮，没有 reject/review/handoff/compensation及完整 J-05 状态。

## 3. 11 条直接 Requirement

| Requirement | Stage 12 闭合语义 | 主要证据层 |
| --- | --- | --- |
| `REQ-AGT-009` | unknown 不进入 automatic/generic retry；restart只恢复 review；新动作使用新 execution | Core guard、runtime、Worker restart、Desktop |
| `REQ-AGT-010` | pending/confirmed-unclaimed/claimed dispatch 三分支；cancel/recall/archive不伪装回滚 | Authority race、FT-08 cancel、J-05 |
| `REQ-AGT-011` | read-only 在四项交集内自动执行；外部 catalog 精确三项 | Core/tool catalog、gateway、physical adapters |
| `REQ-AGT-012` | 精确参数、具名 Human/session family、expiry、handoff、一次确认、grant issue/claim | canonicalizer、Authority CAS、protocol/Desktop |
| `REQ-AGT-013` | durable claim 后 ambiguous → outcome_unknown → Human review；原 toolCall不重放 | dispatch crash/restart、review、compensation |
| `REQ-MEM-004` | room-memory/附件 read保持internal closed source seam并逐页/执行点重验 | FT-06 adapter integration、zero-call matrix |
| `REQ-NFR-011` | manifest/prepare/confirm/claim/adapter/settle/final/recovery每点重验 | permission matrix、race E2E |
| `REQ-NFR-014` | archive业务冻结但安全 expiry/revoke继续；reopen不复活 | v26 archive participant、repair/Desktop |
| `REQ-PRIM-018` | read自动；side effect precise confirmation/grant/dispatch/unknown review | closed state machine、J-05 |
| `REQ-PRJ-013` | project query/command只走FT-09 closed reducer/principal/CAS，不接受自由文本 | project tool dispatcher tests |
| `REQ-ROOM-004` | archive同事务reject pending、revoke active、fence waiting、保留claimed/known/unknown | ArchiveToolSafetyParticipant fault/race |

横切继续遵守 `REQ-ID-004/005`、`REQ-AGT-003/004/008`、`REQ-MSG-006/008`、`REQ-NFR-002/004/005/006/007/009/010/013`、`REQ-UX-007/009`；不把它们冒充为 FT-10 单独完成。

## 4. v26 migration、backfill 与 quarantine

v26 追加 canonical current/projection 与 immutable transition tables：tool call、sealed payload metadata、confirmation decision/handoff/current、grant transition/current、dispatch transition/current、review decision/current、compensation lineage、safe event/outbox/idempotency、recovery quarantine、repair descriptor与archive linkage。不得修改 v1-v25 statements/checksum/fingerprint。

Backfill：

1. 有旧 dispatch 的 grant → claimed；匹配 confirmation → confirmed；旧 `succeeded/failed/outcome_unknown` 映射为 `known_succeeded/known_failed/outcome_unknown`；不调用 adapter、不生成 permit。
2. 未 consumed side-effect confirmation/grant → `rejected(legacy_unbound)` / `revoked(legacy_unbound)`，fence parent。
3. 未 consumed read-only grant → expired，由 runtime 新 prepare；不自动 claim。
4. consumed 但无可证明 dispatch → `legacy_needs_review` quarantine；不进入 resume，不创建 notification/confirmation/grant/permit。
5. 旧 known success只保留历史，不证明新 principal/binding/review。
6. 旧 sealed compensation只可由新的显式 compensation proposal读取；旧 direct compensate生产路径固定410。

Migration必须覆盖 fresh v1→v26、每个 v1…v25→v26、v25→v26、重复 migrate、future/unknown、history/fingerprint/physical tamper、每条 v26 statement rollback、fresh/migrated equivalence、WAL reopen、startup invariants、legacy组合、quarantine zero-resume、backfill adapter/event/outbox=0、sealed AAD/version/size与公开表面raw参数零命中。除非 reader-first rollout或机械修正有明确证据，不增加 v27。

## 5. 权限重验矩阵

唯一公式：

```text
effective tool authority =
  Global Profile capability
  ∩ Room Assignment permission
  ∩ current Room membership / active Room eligibility
  ∩ current execution grant
```

| 执行点 | 额外重验 | 失败结果 |
| --- | --- | --- |
| Provider manifest | profile/assignment/access revisions、origin、source snapshot、Room active | tool隐藏或closed no-tool；adapter 0 |
| prepare | execution/attempt/version/fence、catalog/schema/hash、source、availability | zero toolCall/confirmation/grant/dispatch |
| confirmation query | named principal/session family、membership、generation、expiry、safe source | 403/409/410；adapter 0 |
| confirm/reject | expected version、current decision、Room/source/execution、前三项交集 | no grant或terminal decision |
| handoff offer/accept | PRD producer/target、target membership/session、generation winner | old binding终结；adapter 0 |
| grant issue | confirmed winner、current eligibility、unique grant | no duplicate grant |
| grant/dispatch claim | 四项完整交集、hash/canonical version、expiry、shutdown、per-Room side-effect slot | no permit；adapter 0 |
| adapter boundary | committed branded permit、once latch、deadline/budget、root/endpoint identity | 无 permit则0；同dispatch累计≤1 |
| settle | dispatch/version、typed outcome、parent/fence current | 只闭合dispatch，不复活parent |
| continuation/final | known/review、source、membership/profile/assignment、execution CAS | 无final/Project mutation |
| restart/recovery | state/expiry/quarantine/Room/source/revisions | claimed/dispatched不重发；unknown只review |
| compensation proposal | original dispatch/version、current Human、new exact parameters | 新invocation/toolCall；旧事实不改 |
| project query/command | same Room、current membership、bounded projection、FT-09 principal/CAS | zero project mutation |
| archive/reopen late action | generation、terminal decision/grant/dispatch | reopen不复活；adapter不重发 |

`on-mention` Agent在合法 direct invocation 中使用完整合法 Assignment 子集。

## 6. Dispatch crash truth table

| crash point | durable truth | recovery | adapter cumulative max |
| --- | --- | --- | ---: |
| prepare transaction中 | 全有或全无 | 可由FT-08重新prepare | 0 |
| pending commit后 | pending + sealed payload | 等Human或expire/reject | 0 |
| confirm/grant commit后 | confirmed + active grant | 重验后claim或revoke/expire | 0 |
| claim transaction前 | unclaimed | exact claim可重试 | 0 |
| claim commit后/adapter前 | claimed | outcome_unknown；不再发permit | 0物理，语义按可能发生 |
| adapter中 | claimed/dispatched | outcome_unknown | 1 |
| adapter后/settle前 | claimed/dispatched | outcome_unknown | 1 |
| known settle后/continuation前 | known outcome | 重验后续；不调用adapter | 1 |
| outcome_unknown | unknown | 只恢复review | 1 |
| reviewed | reviewed | 只恢复closed projection | 1 |
| compensation任一阶段 | 独立新dispatch | 应用同一truth table | 每个新dispatch≤1 |

## 7. 双顺序矩阵

| race | A先 | B先 |
| --- | --- | --- |
| archive vs confirm | pending rejected；late confirm 409/410 | confirmed保留；archive revoke unclaimed grant |
| archive vs claim | revoke；claim失败 | claimed dispatch保留；archive只cancel parent |
| recall vs confirm | pending rejected | confirmed保留；revoke grant |
| revoke vs claim | grant revoked，adapter0 | dispatch claimed，结果独立收敛 |
| cancel vs claim | reject/revoke commit后abort | claim保留，cancel不称回滚 |
| expiry vs claim | expired winner，410 | claimed winner，expiry跳过 |
| settle vs cancel | known后parent cancel | cancel后late settle只闭合dispatch |
| review vs late settle | review仅对current unknown CAS | known settle先则review冲突/刷新 |
| handoff accept vs confirm | 新generation winner，旧binding终结 | original confirm winner，handoff冲突 |
| params change vs confirm | 旧binding终结 | confirm只在hash仍current时成立 |
| source recall vs final | final CAS失败 | committed final保留，source另行tombstone |
| shutdown vs claimed adapter | commit unknown/cancel后abort | settle winner保留known outcome |

## 8. Public / internal protocol 分离

Public closed family：`tool.confirmation.decide`、`tool.confirmation.handoff.offer`、`tool.confirmation.handoff.accept`、`tool.outcome.review`、`tool.compensation.propose`。对象读后由server解析Room/principal/session/binding。public不得携带 roomId/principal/session/agent/attempt/tool/raw或canonical parameters/hash/canonicalizer/source/grant/permit/capability/provider/URL/header/root/token。

Legacy `agent.tool.confirm` 与 `agent.compensate` 保留strict malformed decoder，但 production handler固定410 `upgrade_required`，runtime/DB/adapter调用0。

Internal only：prepare、claim、DispatchPermit、mark entered、settle、expiry/recovery、archive participant、project query/command、sealed payload、compensation token。`DispatchPermit` 是非序列化brand，不从package root、Worker JSON、preload或WebSocket构造。

## 9. Repair inventory

FT-13单一 `ROOM_REPAIR_REGISTRY` 注册：tool call/safe preview、confirmation current/decision/handoff、grant current/transition、dispatch current/outcome、review、compensation lineage、reason、expiry、version、named Human safe display reference、source reference。materialized/streaming共享mapper、stable key、canonical bytes与checksum。

明确排除 raw/sealed parameters、hash原像、grant capability、permit、compensation token、HTTP header/body、stdout/stderr、Provider body/reasoning、credential。fixed W、W+delta、duplicate/out-of-order、cursor gap、512+ buffer、clear-cache、reconnect、repair中archive/revoke/expiry、old confirmation display-only、unknown review-only、poison/dead-letter与多客户端收敛均必须测试。

## 10. Desktop J-05

状态：pending、rejected、duplicate、params-changed、principal-revoked、confirmed、grant-revoked、dispatched、known-succeeded、known-failed、outcome-unknown、reviewed、expired、compensation proposed/pending/terminal。

每态显示server生成的safe target/summary、impact、reversibility、expiresAt、current state、closed reason、recovery action、具名Human与可访问source deep link。local仅保存details/open/focus/submitting/review input；ACK只表示Authority transaction；事实来自stable event/projection。

offline所有tool write disabled且transport=0；repair staging完成前保留旧完整只读projection；repair_failed同样保留旧projection。401重新认证且旧binding不重发；403刷新权限；409区分duplicate/stale/params/grant/terminal；410新invocation；429保留输入且不自动重复；503只允许显式重试幂等decision/query。键盘顺序、Space/Enter、Escape只关详情、ACK/event焦点、非颜色、ARIA、200% zoom、840px、长路径换行与reduced motion按正式设计实现；preview `aria-live=off`；无typing animation。

## 11. 文件级 TDD 与所有权

| 切片 | owner | 独占文件/区域 | RED重点 |
| --- | --- | --- | --- |
| A Core/canonicalizer | Core Agent | Core tool contracts、新canonicalizer及相邻tests | exact three、internal split、duplicate key/Unicode/hash/preview/brands |
| B adapters | Adapter Agent | 三adapter及security/fault tests | SSRF/DNS、Git identity/process、sandbox no-follow/atomic/compensation |
| C persistence/authority | 总Agent串行整合 | schema、contracts、worker protocol/client/handler/store | v26/backfill/quarantine/transaction/CAS/fault |
| D runtime/integration | Runtime Agent | gateway/runtime窄模块及tests | permit/latch、permission zero-call、cancel/restart/project seam |
| E protocol/repair/Desktop | 后续单一Agent | protocol/WS/repair/replica/renderer/main/preload | closed frames、legacy410、J-05/offline/a11y |
| F independent review | 只读 reviewers | 不写共享文件 | security/principal/schema/dispatch/race/repair/Desktop/scope |

共享热点只由总Agent在整合窗口修改：`collaboration.ts`、`sync.ts`、`schema.ts`、persistence contracts/protocol/handler、`authoritative-server.ts`、`protocol.ts`、`websocket.ts`、Desktop replica与root。

## 12. Requirement → code → tests → UI 证据矩阵

每条直接Requirement都必须在 `packages/core/src/tool-safety-requirements.test.ts`（或等价exact fixture）有唯一记录，并分别指向：closed Core/type证据、真实AuthorityWorker/SQLite或physical adapter证据、如有用户表面的Desktop DOM/a11y/repair证据。不得用单一smoke代替逐条覆盖。最终交付说明以真实文件、测试计数、PR/CI/merge信息替换本文件中的计划性位置。

## 13. 范围与未知

- owner 未知：无。当前批准输入足以实施。
- FT-13共享边界：复用现有central registry、cursor/fixed-watermark/eventId规则；不宣称FT-13横切终局全部由本阶段完成。
- FT-14共享边界：只实现安全默认sealed payload expiry/cleanup seam；不冻结长期retention或release运营策略。
- Blueprint：本阶段不读写、不改状态、不标记verified。

