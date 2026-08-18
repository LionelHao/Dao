# FT-10 Tool Safety：拆环实施计划

> 日期：2026-08-18
>
> 性质：文件级 TDD 与串行合入计划；本任务不写生产代码
>
> 权威设计：[FT-10 Tool Safety design](./2026-08-18-ft10-tool-safety-design.md)
>
> 产品权威：[当前批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
> UI / 交互权威：[Design README](../design/README.md) 与 [Requirement 覆盖矩阵](../design/design-requirement-coverage.md)

## 1. 目标、原则与实施门

实施只把冻结设计落到现有 T-0041 深模块，不建设通用 Agent 工具平台。固定顺序为：

```text
FT-10A closed contracts
→ FT-10B adapter hardening
→ FT-10C authority state/migration
→ FT-10D FT-02/08/09 transaction integration
→ FT-10E protocol + FT-13 repair
→ FT-10F Desktop J-05
→ FT-10G real-worker/WS/Electron evidence
```

每片严格 RED → minimal GREEN → focused regression → fault/race evidence。fake adapter/clock/capability只在deep test seam；production composition root只装配三个真实受限adapter。FT-06 context contract 或 FT-07/09 production seam 尚未实际合入时，相应production gate必须 `dependency_unavailable`/503或feature-off，不能回退最近64条、静态actor权限、legacy OpenItem/LightTask或任意自由文本command。

本计划直接追踪 approved implementation map 分配给 FT-10 的完整集合：`REQ-AGT-009`、`REQ-AGT-010`、`REQ-AGT-011`、`REQ-AGT-012`、`REQ-AGT-013`、`REQ-MEM-004`、`REQ-NFR-011`、`REQ-NFR-014`、`REQ-PRIM-018`、`REQ-PRJ-013`、`REQ-ROOM-004`。任何增删必须先与批准 PRD 和 implementation map 对照，不从候选计划复制编号。

开始每片前：

1. 读取根 `AGENTS.md` 与届时更深层 `AGENTS.md`；记录 `git status --short --branch` 和 `git worktree list --porcelain`；
2. 读取实际已合入 FT-02、FT-07、FT-08、FT-09、FT-13 文档和 `AUTHORITY_SCHEMA_VERSION`；重新核查 FT-06 是否补齐、FT-07/09 production seam 是否真实合入；FT-09 的 24 条直接 Requirement 已与批准 PRD 和 implementation map 对齐，实施时确认 merged 文档未发生漂移；
3. 确认 shared file owner。schema/migration、AuthorityWorker handler/protocol、snapshot registry、Desktop preload/renderer各时段只能有一个owner；
4. 不修改历史migration、Blueprint或批准PRD/设计；不提交通用shell/terminal、任意网络/文件权限、多Provider/BYOK；
5. tests和production改动同slice合入；不以直接SQL happy fixture、静态DOM或历史T-0041 delivery替代新authority证据。

## 2. 串行合入与唯一 migration owner

### 2.1 跨 FT 必须串行的顺序

| 顺序 | owner / 输入 | FT-10 可开始或合入的内容 |
| ---: | --- | --- |
| 0 | FT-01 + FT-02A 已合入 | 使用current Human/session family、canonical owner/governance revision；不改其schema。 |
| 1 | FT-06 context seam + FT-07 Profile/Assignment seam | 冻结source eligibility、bounded retrieval、Profile ceiling、Assignment subset、active/on-mention、availability revision与reduction producer；缺任一安全输入时相关production wiring关闭。 |
| 2 | FT-02/FT-08/FT-09/FT-10 shared contract spine | 只合closed Core与server-private interface/type tests：archive participant、turn-aware intent、attempt/version、project command、confirmation/grant/dispatch；不写shared schema，不启用新side effect。 |
| 3 | FT-09 authority base，随后 FT-02 departure integration | 先建立read-only project query与closed domain command的唯一事实，再接member departure；合入前重验其已对齐的 24 条直接 Requirement 未发生漂移。 |
| 4 | FT-08A/B runtime authority | 合入scoped fence、attempt/version、restart scan、cancel commit-before-abort与final CAS；FT-10不靠旧room-wide preemption兼容。 |
| 5 | **FT-10 authority migration + transaction integrations** | 由唯一migration owner基于真实predecessor分配一个batch；落confirmation/grant/dispatch/review，并接FT-08 lifecycle与FT-09 project adapter。 |
| 6 | FT-02 archive settlement integration | archive transaction调用已存在的FT-10 participant：拒绝pending、撤销unclaimed、fence waiting、保留claimed/dispatched；不得先合一个绕过FT-10的archive旁路。 |
| 7 | FT-13 repair/outbox batch | 注册FT-10 records、fixed-watermark parity、dead-letter/restart/replica；不建snapshot-v2。 |
| 8 | FT-11/16 Desktop integration | J-05 live transport/replica/UI与Electron验收。 |

FT-10A/B中不触碰shared schema/handler/protocol的工作可以在1～4期间准备；其合入不能启用production side-effect新路径。shared files 的 review/merge 序列固定为：contract spine → FT-09 authority base → FT-02 departure integration → FT-08 runtime authority → FT-10 migration/integrations → FT-02 archive settlement → FT-13 repair。FT-02 在序列中出现两次是有意的：先冻结participant contract，后在FT-10 participant真实存在时才启用archive settlement；两步之间不得出现旁路业务行为。

### 2.2 migration owner

FT-13 migration coordinator 是唯一版本分配与migration文件owner；FT-10 owner提交：

- closed physical record proposal、indexes/triggers/invariants；
- predecessor-neutral upgrade/backfill/quarantine测试fixture；
- 每条statement fault expectation；
- FT-02/08/09需要同transaction访问的SQL operation contract。

coordinator读取实际merged predecessor后分配唯一next version，追加immutable migration并发布checksum/fingerprint。其他slice不得预占版本、临时改历史statement或各自加“辅助migration”。

## 3. 全局测试层级与固定断言

测试层级：Core/type → adapter unit/security → worker protocol → real SQLite migration/invariant → AuthorityWorker transaction/CAS → runtime/gateway fault → public protocol/WS → repair/replica → Desktop DOM/a11y → compiled child/Electron E2E。

所有side-effect用例都记录 `(toolCallId, grantId, dispatchId, adapterCallCount)`；任何拒绝前adapter为0，任何已提交dispatch累计至多1。任何 `outcome_unknown` 用例同时断言自动attempt、generic retry、resume、restart和repair均不增加call count。

每片生成独特 canary：credential、session family token、HTTP header/body、sandbox content、provider/tool raw body、stdout、stderr、hidden reasoning、sealed payload plaintext。测试只允许canary存在于隔离输入/内存；SQLite/WAL/outbox/event/repair/cache/wire/error/log/diagnostic/DOM/build snapshot为零命中。

## 4. FT-10A — Core closed types、canonicalizer 与 protocol brands

### 4.1 RED first

| 顺序 | 先写失败测试 | 再改生产文件 | 退出证据 |
| --- | --- | --- | --- |
| A1 tool union | `packages/core/src/collaboration.test.ts`、`collaboration.type-test.ts` | `packages/core/src/collaboration.ts` | exact three ToolId、read-only/side-effect descriptor、状态机/eligibility guards。 |
| A2 sync projection | `packages/core/src/sync.test.ts` | `packages/core/src/sync.ts` | confirmation/grant/dispatch/review events与repair records；raw字段negative guards。 |
| A3 internal brand | `packages/server/src/persistence/contracts.type-test.ts`、`agent-runtime` contract type tests | `persistence/contracts.ts`、`agent-runtime/contracts.ts` | public/internal capability、renderer projection/DispatchPermit互不可赋值。 |
| A4 canonicalizer | 新 `agent-runtime/tool-parameters.test.ts` | 新窄模块 `agent-runtime/tool-parameters.ts` 或每adapter parser共用closed helper | duplicate key/extra field/Unicode/size/depth/canonical version/hash golden vectors。 |

### 4.2 必测用例

1. unknown/fourth tool ID在所有guard失败；动态registry重复/缺项使production startup失败；
2. sandbox参数字段exact，hash对key order稳定，对任一byte变化不同；canonicalizer version进入hash；
3. public DTO不能携带room/principal/family/attempt/hash/raw params/grant/capability；
4. `outcome_unknown`不满足generic retry guard；reviewed必须有resolution/named Human/version；
5. safe preview确定性、≤2KiB、content/header/token canary不出现；
6. repair/public event closed union不接受sealed payload/compensation token/raw evidence。

### 4.3 完成门

Core保持零I/O；server internal brands不从package root、WebSocket或preload导出；所有unknown JSON在进入persistence/renderer前拒绝。达到这里只是contract ready。

## 5. FT-10B — 三个 production adapter 硬化

该slice不改authority schema，可与上游文档/接口冻结并行；仍不得启用新production flow。

### 5.1 `http-json.read`

**RED:** 在 `packages/server/src/agent-runtime/tool-adapters.test.ts` 增加：credential URL、non-HTTPS、redirect chain、cross-origin redirect、IP literal/private DNS answer、DNS rebinding test seam、unexpected content encoding、declared/stream/decompressed body超限、invalid UTF-8/JSON、timeout/abort、slow body、extra params。断言request method/header固定，response headers/body不进summary/log。

**GREEN:** 修改 `tools/http-json-read.ts`：closed endpoint resolver、redirect=`error`、connect/body总deadline、streaming decoded byte counter、JSON depth/shape budget、safe summary。Agent永远不能传header、method、base URL或credential。

### 5.2 `repository.git-status`

**RED:** 固定binary/root/argv/env/no-shell；参数非空、symlink repository root swap、stdout和stderr分别/合计超限、timeout/abort、child close/error、malicious filename/newline。用spy断言真实`execFile`参数exact，raw输出不进log/authority。

**GREEN:** 修改 `tools/repository-git-status.ts`：启动时验证configured root identity，固定allowlist env，独立有界stdout/stderr和deadline，输出parser只给model bounded porcelain records/omission marker；不接受cwd/argv/env。

### 5.3 `sandbox-file.write`

**RED:** 在临时目录覆盖absolute、`..`、空segment、backslash、Unicode alias、parent/target symlink、prepare后claim前symlink swap、hardlink策略、preimage>limit、content>limit、expected hash conflict、temp/fsync/rename各故障点、abort before/after rename、compensation post-hash mismatch。明确rename后abort不能报“已回滚”。

**GREEN:** 修改 `tools/sandbox-file-write.ts`：descriptor-relative/no-follow handle策略（或平台等价安全原语）、bounded preimage、atomic temp/fsync/rename、posthash、sealed compensation。若Node/目标平台不能可靠证明symlink race关闭，adapter startup fail closed，不退回lexical check。

### 5.4 adapter合同

- adapter返回typed `known_succeeded | known_failed | ambiguous`，不让gateway凭任意throw猜“失败”；
- modelInput、summary和compensation token各自限长；raw stdout/stderr/HTTP body只在有限内存解析，完成/失败即释放；
- 每adapter必须接收AbortSignal和deadline；所有resource finally关闭；
- compensation adapter仍只能经新FT-10 toolCall流程调用，不能公开直接调用方法。

## 6. FT-10C — 唯一 authority migration 与状态机

### 6.1 schema RED

在 `packages/server/src/persistence/schema.test.ts` 先覆盖：

1. fresh及所有支持历史版本→actual next；future/unknown拒绝；历史checksum/fingerprint逐字不变；
2. confirmation/grant/dispatch/review closed CHECK、foreign key、unique toolCall/grant/dispatch、version monotonic与state-specific trigger；
3. side-effect pending不能已有grant；confirmed必须恰有一个active/terminal grant；一个grant最多一个dispatch；review只引用unknown；compensation不能引用自身/复用toolCall；
4. 每条new statement fault整笔回滚；migration history/version/数据保持predecessor；
5. 旧consumed/unconsumed/dispatch组合按design backfill；异常进入quarantine并不进入resume；backfill adapter call count 0、event/outbox 0；
6. raw/sealed parameter字段不出现在public projection/index/error；sealed payloadAAD/version/size invariant。

### 6.2 worker contracts/transactions RED

先扩：

- `persistence/contracts.test.ts`、`contracts.type-test.ts`；
- `worker-protocol` parser/tests；
- `worker-database-client.test.ts`；
- `agent-runtime/worker-runtime-authority.test.ts`；
- `persistence/sqlite-authoritative-store.test.ts`。

逐operation断言domain+audit+event+outbox+idempotency同transaction；在每个SQL mutation之间注入throw，结果全有或全无。重点：

- prepare side-effect只有pending，无grant；read-only有active grant；
- confirm winner同transaction写confirmed+唯一grant；reject写terminal+fence；
- confirmation consume+grant claim+dispatch claimed+execution phase CAS同transaction；
- stale attempt/version/hash/binding/expiry/permission全为0写或规定的terminal transition，adapter 0；
- settle迟到只影响dispatch，不复活cancelledparent；
- unknown review不调用adapter；从 unknown 发起compensation只创建新proposal/intent，原dispatch/history与未闭合review保持不变；只有新compensation toolCall已知成功后才可把原review闭合为compensated；
- expiry/recovery使用keyset batch并drain-until-empty，poison record隔离。

### 6.3 GREEN文件

仅由shared persistence owner依次修改：

- `packages/server/src/persistence/schema.ts`；
- `contracts.ts`、`worker-protocol.ts`、`worker-database-client.ts`；
- `authority-worker.ts`、`authority-database-handler.ts`、`sqlite-authoritative-store.ts`；
- `agent-runtime/runtime-authority-protocol.ts`、`worker-runtime-authority.ts`。

不在`tool-gateway.ts`做第二套权限状态；gateway只消费authority permit并报告typed settle。

## 7. FT-10D — gateway/runtime 与 FT-02/08/09 transaction integration

### 7.1 gateway拒绝与call-count矩阵

扩展 `tool-gateway.test.ts` 为参数化矩阵：

- catalog/adapter missing；Profile capability、Assignment permission、Agent membership、Human principal membership；Room archived；paused/noauth；execution/attempt/version/fence；source recalled/disputed；toolCall/tool/hash/canonical version；confirmation state/principal/family/binding/expiry/replay；grant state/expiry；dispatch replay；queue/deadline/shutdown。

每行断言adapter 0、无dispatch permit、closed error code和安全projection。成功side-effect重复claim/restart/settle最多1次；read-only按每个新attempt各有新grant且有界。

### 7.2 FT-02 archive participant

**RED across** `room-lifecycle`/governance store tests、`worker-runtime-authority.test.ts`、`agent-runtime-service.test.ts`：

1. pending→rejected(room_archived)、active→revoked、waiting execution fenced与Room archive同transaction；
2. participant任一点故障，Room/archive/timer/tool/event/outbox全部回滚；
3. claimed/dispatched/known/unknown/reviewed不改写；adapter不会由archive调用；
4. archive后late confirm/claim/resume 409/410且adapter 0；reopen不复活；
5. archived state仍允许session/member/Assignment/Profile/capability reduction且不唤醒runtime。

**GREEN:** 只通过FT-02 transaction-local participant assembly接入；禁止post-commit callback“补偿”archive。

### 7.3 FT-08 runtime integration

**RED:** prepare/confirm/claim/dispatch/final全带expected attempt/version；cancel commit-before-abort；claim前cancel和claim后cancel双顺序；timeout/abort原因区分；restart不重放claimed/dispatched/unknown；outcome_unknown generic retry 409；final CAS在known/review和权限重验后才允许。

**GREEN:** 修改 `agent-runtime-service.ts`、`tool-gateway.ts` 和窄contracts；删除旧manual retry对`side_effect_outcome_unknown`的eligibility。runtime只保存bounded local permit/latch/controller，不保存authority替代状态。

### 7.4 FT-09 project seam

**RED:**

- query仅same Room/current membership/bounded current project projection；跨Room/source withdrawn/oversize失败；
- provider自由文本、unknown command、arbitrary object/status/actor/version全拒绝；
- 每条closed command调用FT-09 current state machine和principal规则；Agent不能confirm Goal/Decision、替Human接受责任或自验收Agent-owned Action；
- Human-gated对象产生FT-09 proposal/confirmation，不复用external tool confirmation；
- project command与Agent final需要原子关联时由FT-09/08同writer contract完成，不能“正文说完成”后best-effort写对象。

**GREEN:** FT-10只提供tool descriptor/adapter facade与runtime注入capability；实际domain mutation保持FT-09 owner。full Blueprint/GBP adapter保持不存在。

## 8. FT-10E — public protocol、WebSocket、FT-13 repair

### 8.1 closed protocol RED/GREEN

先扩 `packages/server/src/protocol.test.ts`、`websocket.test.ts`：

- decide/handoff/review/compensation frames exact field、size、unknown/extra/type拒绝；
- public不能提交room/principal/family/agent/attempt/tool/hash/raw params/grant/permit/capability/provider；
- 401/403/409/410/429/503精确映射与requestId correlation；
- callback/ACK不表示adapter成功；duplicate ACK/event按ID收敛；
- revoked/expired session在AuthorityWorker内重验，不只依赖socket旧auth；
- error/safe detail无canary/SQL/stack/rawbody。

再修改 `protocol.ts`、`websocket.ts` 和composition wiring。旧 `agent.tool.confirm` 若无法安全机械映射新decision/version合同则feature-off/upgrade required，不保留宽松兼容。

### 8.2 FT-13 repair registry

先扩：

- `packages/core/src/sync.test.ts`；
- `packages/server/src/persistence/snapshot-worker-client.test.ts`、registry parity tests；
- `packages/server/src/sync-service.test.ts`；
- `packages/desktop/src/sync/client-sync-replica.test.ts`。

覆盖confirmation/grant/dispatch/review所有current states，materialized/streaming canonical bytes与checksum相等；fixed watermark W后transition只在delta；repair中revoke/archive/expiry使staging失效或按winner收敛；有界、脱敏的 tool safe preview 随 confirmation projection 注册，Provider partial stream preview、raw/sealed params与token不注册。clear-cache后projection与authority一致；old confirmation只显示，不自动confirm/claim/dispatch。

dead-letter/restart测试必须证明unknown只恢复review、poison record不阻塞尾部、outbox event重放只应用一次。FT-13未合入registry时，Desktop不得宣称完整恢复。

## 9. FT-10F — Desktop J-05 与可访问性

### 9.1 reducer/DOM RED

先在 `packages/desktop/src/renderer/app.test.ts` 和live controller/transport tests覆盖：

1. pending、rejected、duplicate、params-changed、principal-revoked、confirmed、grant-revoked、dispatched、outcome_unknown、reviewed、expired；
2. 每态显示design中规定的safe target/impact/reversibility/expiry/reason/recovery，非颜色识别；
3. confirm/reject/review/compensate仅发closed object command，submitting直到matching ACK/event；错误保留输入；
4. duplicate click、多sessionevent、out-of-order ACK、reconnect/repair不重复dispatch/通告；
5. outcome_unknown没有generic retry；compensation显示“新动作”，不显示undo/cancelled side effect；
6. offline所有write transport call count 0；repair_failed旧完整projection只读；
7. 401/403/409/410/429/503分别有design恢复动作；
8. keyboard tab/order、Enter/Space、focus recovery、aria label/status/live、200% zoom、840px、reduced motion；preview `aria-live=off`；
9. renderer public state/DOM不含credential/grant/hash/raw/sealedparams/compensation token。

### 9.2 GREEN文件和所有权

在FT-11/16 renderer owner窗口修改：

- `packages/desktop/src/sync/client-sync-replica.ts`；
- `packages/desktop/src/renderer/app.ts`、`styles.css`、必要的feature component文件；
- live command controller/transport的closed method；
- preload只在FT-11 owner批准的固定domain API上加方法。

renderer不直接持有WebSocket token、session family internal ID、grant capability、raw params、file API或generic IPC。静态review route保留为设计证据，但不能作为live验收。

## 10. FT-10G — real SQLite/AuthorityWorker/WS/Electron E2E

### 10.1 compiled child场景

使用真实SQLite WAL、compiled AuthorityWorker、真实WebSocket、两个Human session family、active与on-mention Agent、三个production adapter（HTTP用受控HTTPS fixture seam，Git/文件用真实临时资源）：

1. read-only HTTP和Git在完整交集内执行；分别在prepare/claim/continuation前reduce Profile/Assignment/membership，adapter 0；
2. sandbox pending→confirm→claim→known success；另一session duplicate confirm不产生第二grant/dispatch；
3. changed params、expired、wrong principal/family、session revoke、member remove、Assignment/Profile reduction逐点注入，adapter 0；
4. archive/recall/cancel/revoke与confirm/claim的两个提交顺序全部覆盖；
5. claim commit后分别kill child before adapter、during adapter、after adapter before settle，restart均无第二call并进入unknown/review；
6. known success后cancel/recall/archive保留结果；不自动compensate；
7. review四种resolution；compensation新invocation/new toolCall/new confirmation，原dispatch/history保持不变，且原unknown只在新compensation已知成功后闭合为compensated；
8. project read/query与closed command走FT-09 seam；自由文本不改变object；具名Human gate生效；
9. send-before-outbox mark/event重放/cursor gap/fixed-watermark clear-cache repair，多客户端最终一致；
10. shutdown在pending、active、claimed、adapter running、unknown五点，30s内终结/审查且无zombie/permit重放。

### 10.2 sentinel与容量

- 扫 authority DB/WAL/SHM、snapshot/cache、event/outbox、WS frames/errors、server/Desktop stdout/stderr/log/diagnostic、DOM/build artifact；禁区canary零命中。
- PR档：64 pending confirmations/Room、500 recovery records、10k repair mixed records、1k duplicate events；nightly：实际hard ceiling和100k repair；记录CPU/RSS/DB/WAL/latency。
- 达不到容量时可收紧batch/default，不得放宽权限、去掉加密/confirmation、静默截断、无界buffer或自动重放unknown。

### 10.3 Electron验收

真实macOS Electron main/preload/renderer完成J-05：键盘confirm/reject、另一session revoke、offline、repair、outcome review、200% zoom、840px、VoiceOver语义、reduced motion。必须证明UI动作经真实WS→AuthorityWorker→event/repair返回，不是DOM callback假成功。

## 11. 文件级预期修改清单

文件名以当前仓库为准；实现时可把新窄模块放在相同目录，但不得创建通用plugin/tool platform。

| 区域 | tests first | production |
| --- | --- | --- |
| Core | `collaboration.test.ts`、`collaboration.type-test.ts`、`sync.test.ts` | `packages/core/src/collaboration.ts`、`sync.ts`、`index.ts` |
| Tool contracts/gateway | `agent-runtime` contract/type tests、`tool-gateway.test.ts` | `agent-runtime/contracts.ts`、`tool-gateway.ts`、`tool-parameters.ts` |
| Adapters | `tool-adapters.test.ts`、security/fault tests | `tools/http-json-read.ts`、`repository-git-status.ts`、`sandbox-file-write.ts` |
| Persistence | `schema.test.ts`、contracts/worker/store tests、`worker-runtime-authority.test.ts` | `schema.ts`、`contracts.ts`、`worker-protocol.ts`、`worker-database-client.ts`、`authority-worker.ts`、`authority-database-handler.ts`、`sqlite-authoritative-store.ts` |
| Runtime | `agent-runtime-service.test.ts`、archive/scoped cancel tests | `runtime-authority-protocol.ts`、`worker-runtime-authority.ts`、`agent-runtime-service.ts`、composition root |
| Protocol | `protocol.test.ts`、`websocket.test.ts` | `protocol.ts`、`websocket.ts` |
| Repair | registry/snapshot/sync/replica tests | `core/sync.ts`、snapshot registry/worker、sync service、Desktop replica |
| Desktop | `renderer/app.test.ts`、controller/transport/Electron tests | renderer components/styles、closed controller/preload API |
| E2E | `authority.e2e.test.ts`、compiled child fixture、sentinel/capacity | composition seams only；无test branch |

## 12. slice退出与回滚门

| Slice | 可以开启的能力 | 回滚 |
| --- | --- | --- |
| A | 无production能力；只提供closed readers/guards | 保留types/readers，producer不开 |
| B | adapter单测/production construction，但不可被runtime新flow调用 | composition feature-off |
| C | authority可读写新facts；public commands仍off | 停producer，不降schema/删facts |
| D | internal runtime/archive/project flow；需所有依赖green | 停claim/producer；claimed facts继续review |
| E | public decision/review与repair；需协议版本门 | 停新frame；current facts仍可读/repair |
| F | live J-05；需replica完整 | UI只读降级，不本地伪状态 |
| G | production candidate | 任何failed safety gate阻止交付声明 |

绝不回滚到：提前side-effect grant、renderer capability、旧宽松confirm、generic retry unknown、自动compensation、任意URL/path/binary或room-wide preemption。

## 13. 最终验证顺序

实施集成完成后，从实际worktree依次执行并记录版本、数量、耗时和skip：

1. Core guards/type tests与canonicalizer golden/property tests；
2. 三adapter security/fault/bounds tests；
3. actual predecessor migration、all-history/future/fault/backfill/quarantine；
4. AuthorityWorker confirmation/grant/dispatch/review transaction/CAS/idempotency tests；
5. gateway adapter call-count矩阵与runtime cancel/restart/unknown tests；
6. FT-02 archive、FT-08 scoped runtime、FT-09 project command交叉race tests；
7. protocol/WebSocket/repair/replica/outbox tests；
8. Desktop J-05 DOM/controller/a11y tests；
9. real compiled child SQLite/AuthorityWorker/WS multi-session crash/restart E2E；
10. secret/corpus sentinel与PR capacity；
11. real macOS Electron journey；
12. `corepack pnpm typecheck`；
13. `corepack pnpm lint`；
14. `corepack pnpm verify:core-boundary`；
15. `corepack pnpm verify:desktop-boundary`（若届时仍为仓库命令）；
16. `corepack pnpm test`；
17. `corepack pnpm build`；
18. `git diff --check`、文档相对链接扫描、Requirement集合对照、`git status --short --branch`。

opt-in Provider live smoke不是FT-10安全状态机的替代证据；若无secret跳过必须如实记录。工具live smoke只记录closed summary/hash/size，不保存raw output。

## 14. 交付说明必须包含

- 11条FT-10 Requirement及横切Requirement到测试的精确映射；
- actual migration predecessor/version/checksum/fingerprint和backfill/quarantine数量；
- effective permission四项交集在每个执行点的证据；
- adapter call-count-zero拒绝矩阵与dispatch最多一次矩阵；
- archive/recall/revoke/cancel/expiry/claim双顺序和crash truth table；
- unknown review/compensation新动作证据；
- repair inventory、fixed watermark、dead-letter/restart边界；
- J-05全部状态、错误/offline/repair/a11y与真实Electron证据；
- sentinel与bounded resource结果；
- 未合入或未真实验证的FT-06/07/09/13 production seam与外部环境限制；
- 明确说明T-0041是mechanism base，不是完整FT-10 verified。

## 15. 本设计任务的完成口径

本文件只安排未来实施，不修改 `packages/**` 或 Blueprint，不创建migration版本，不声称任何新测试已通过或FT-10已实现。

**FT-10 设计达到实施准备条件。**
