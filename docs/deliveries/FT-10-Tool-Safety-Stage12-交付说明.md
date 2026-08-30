# FT-10 Tool Safety · Stage 12 交付说明

状态：FT-10 Stage 12 生产实现已经受保护分支合入远端 `main`，等待 owner 验收。本说明只记录可复核的实现、测试、审阅和远端事实；不把 Agent 自测、CI 或审阅写成 owner 验收，不标记 verified。

## 1. 一句话结果与远端事实

- 一句话结果：真实外部工具权限、精确 Human confirmation、execution grant、durable dispatch、`outcome_unknown`、Human review、独立 compensation、repair 与 Desktop J-05 已形成 Core closed contract → AuthorityWorker/SQLite transaction → committed permit/真实物理 adapter → stable event/outbox → fixed-watermark repair → Desktop 权威状态的生产闭环。
- predecessor：`6cce90b8c61c03a0f7e0be0a613e08461a3d8236`（FT-09 Stage 11 evidence；开始时 Authority schema v25）。
- 实现合入后的远端 `main`：`1913218519c1cdbc968e60e6e2a3db8e448dbbab`（Authority schema v26）。
- 实现 PR：[PR #75 — FT-10: deliver authoritative tool safety](https://github.com/LionelHao/Dao/pull/75)，squash merge SHA `1913218519c1cdbc968e60e6e2a3db8e448dbbab`。
- 实现 PR 最终 head：`67c87a4f3426a5a701c8d128ee07484cb5120c58`；148 个文件，新增 15,342 行、删除 607 行。
- 实现 CI：[quality 33316611639](https://github.com/LionelHao/Dao/actions/runs/33316611639)：[Node 22.13.1](https://github.com/LionelHao/Dao/actions/runs/33316611639/job/99271114499) 21m45s success；[Node 22.x](https://github.com/LionelHao/Dao/actions/runs/33316611639/job/99271114606) 19m43s success。
- 证据 PR：本证据分支创建后回填真实编号；PR 页面将保留最终 required checks，最终 squash merge SHA 由 GitHub 在本 PR 合入时记录。

仓库禁止 merge commit，因此实现 PR 按 branch protection 允许的 squash 方式合入；没有 force push、绕过 required checks 或修改 Blueprint。

## 2. 11 条 Requirement 逐条证据

统一代码入口：Core `packages/core/src/tool-safety.ts`；Authority/SQLite `packages/server/src/tool-safety/database-authority.ts` 与 `packages/server/src/persistence/`；runtime/adapters `packages/server/src/agent-runtime/`；协议与 repair `packages/server/src/protocol.ts`、`websocket.ts`、`persistence/repair-projection-registry.ts`；Desktop `packages/desktop/src/renderer/tool-safety/`。`packages/core/src/tool-safety-requirements.test.ts` 对 11 条直接 Requirement 做 exact、唯一、Core/Authority/UI bucket 完整性证明。

| Requirement | 已闭合产品语义 | 关键 Authority / UI 证据 |
| --- | --- | --- |
| `REQ-AGT-009` | `outcome_unknown` 永不进入 generic/automatic retry；原 toolCall 不重放，新动作必须创建新 execution/toolCall | crash/restart/shutdown 恢复只生成 review；J-05 unknown 只提供 review/新动作 |
| `REQ-AGT-010` | pending、confirmed-but-unclaimed、claimed/dispatched 三分支精确分离；cancel/recall/archive 不伪装物理回滚 | 双顺序 race、archive participant、grant/dispatch CAS 与 closed reason |
| `REQ-AGT-011` | read-only 仅在 Profile capability ∩ Assignment permission ∩ current Room eligibility ∩ execution grant 内自动执行；external catalog 精确三项 | exact catalog/type tests、permission zero-call matrix、gateway committed permit |
| `REQ-AGT-012` | confirmation 绑定 exact parameters/toolCall/executionVersion/sourceSnapshot/binding generation、具名 Human principal/session family、expiry 与 handoff | immutable Human decision、expectedVersion、handoff 单 winner、一次 grant issue/claim；Desktop named Human |
| `REQ-AGT-013` | durable claim 后不能证明未进入 adapter 时保守为 unknown；Human review 不调用 adapter；compensation 是独立新 lineage | crash truth table、restart、review CAS、新 execution/toolCall/dispatch compensation |
| `REQ-MEM-004` | Room Memory 与附件读取保持 server-private closed source seam，不进入动态 external adapter registry | 不可互赋 type、分页/执行点重验、公开 catalog/repair/raw projection 零泄漏 |
| `REQ-NFR-011` | manifest、prepare、confirmation、grant/dispatch claim、adapter、settle、continuation/final、recovery 每点重验 | 28 个拒绝 reason 的权限矩阵、revision/access/source/fence/expiry races |
| `REQ-NFR-014` | archive 冻结业务，但 expiry/revoke/review 安全收敛继续；reopen 不复活旧 authority | archive 同事务 settlement、late action 409/410、repair/Desktop archived read-only |
| `REQ-PRIM-018` | read 自动执行与 side-effect precise confirmation/grant/dispatch/unknown review 完整分治 | closed state unions、public commands、J-05 全状态 |
| `REQ-PRJ-013` | FT-09 Project query/command 只走 closed reducer/principal/CAS dispatcher，不接受自由文本或动态注册 | same-Room/membership/bounded projection 与零越权 mutation tests |
| `REQ-ROOM-004` | archive 同事务 reject pending、revoke active、fence waiting，保留 claimed/known/unknown 事实 | archive vs confirm/claim/settle/review fault/race、stable event/outbox/repair |

本阶段不扩张为 FT-12 flat notification center、FT-13 横切可靠性终局、FT-14 retention/credential policy、BYOK、新工具平台或发布安装包。

## 3. Closed catalog、精确权限与 Human confirmation

- external physical adapter catalog 精确只有 `http-json.read`、`repository.git-status`、`sandbox-file.write`；unknown tool/version/extra field fail closed，runtime 不能动态注册第四项。
- `room-memory.read`、附件读取与 FT-09 Project query/command 使用不同 discriminant 的 server-private seam；它们不能赋给 external descriptor/permit，也不会出现在 public manifest、repair 或 Desktop adapter catalog。
- 唯一权限公式是 `Global Profile capability ∩ Room Assignment permission ∩ current Room membership/active eligibility ∩ current execution grant`。on-mention Agent 也只能使用合法 Assignment 子集。
- canonical parser 拒绝 duplicate/extra key、非 NFC/非法 Unicode、非有限数、过深/过宽/超限、credential/header/token 与 schema/canonicalizer version 漂移；domain-separated hash 同时绑定 toolId、schemaVersion、canonicalizerVersion 与 canonical bytes。
- side-effect prepare 只创建 toolCall、server safe preview、sealed parameters 与 pending confirmation，不提前签 grant。safe preview 默认 ≤2KiB、hard ≤8KiB；不公开 raw/sealed parameters、hash 原像、credential、header、root、HTTP body、stdout/stderr 或 Provider 内容。
- confirmation 绑定 exact toolCall/invocation/execution/attempt/executionVersion/Room/Agent/tool/hash/sourceSnapshot/Profile/Assignment/access revision，以及具名 Human principal、session family、binding generation、expiry。`confirmed` 是 immutable decision；confirm 与唯一 active grant issue 在一个 AuthorityWorker transaction。
- public closed family 是 `tool.confirmation.decide`、`tool.confirmation.handoff.offer`、`tool.confirmation.handoff.accept`、`tool.outcome.review`、`tool.compensation.propose`；public frame只传对象 ID、expectedVersion 与 closed decision/resolution。旧 `agent.tool.confirm`、`agent.compensate` production handler 固定 410 `upgrade_required`，adapter 调用为 0。

## 4. Durable dispatch、unknown、review 与 compensation

| crash / race 点 | durable truth | 恢复结果 | 同一 dispatch 物理调用上限 |
| --- | --- | --- | ---: |
| prepare transaction 中 | 全有或全无 | FT-08 可重新 prepare | 0 |
| pending commit 后 | pending + sealed payload | 等具名 Human、reject 或 expire | 0 |
| confirm/grant commit 后 | immutable confirmed + active grant | 重验后 claim，或 revoke/expire | 0 |
| claim commit 前 | unclaimed | exact claim 可重试 | 0 |
| claim commit 后 / adapter 前 | claimed | 保守 `outcome_unknown`，不再发 permit | 0 物理；语义按可能发生 |
| adapter 中或 adapter 后 / settle 前 | claimed/dispatched | `outcome_unknown` | 1 |
| known settle 后 / continuation 前 | known outcome | 只恢复后续，不调用 adapter | 1 |
| unknown / reviewed | unknown 或 reviewed | 只恢复 review/closed projection | 1 |
| compensation | 独立新 dispatch lineage | 对新 dispatch 应用同一 truth table | 每个新 dispatch ≤1 |

- committed `DispatchPermit` 是不可序列化 brand，只能由同事务完成 grant claim、dispatch claim 与 execution phase/version CAS 后产生；package root、Worker JSON、preload、WebSocket 与模型输入均不能构造 permit。
- gateway once latch 确保同 dispatch 累计最多一次 adapter 进入；typed adapter outcome 只有 `known_succeeded | known_failed | ambiguous`，不能从任意 throw 猜物理事实。
- claim 后 recall/cancel/archive/revoke/expiry 不改写已发生事实；late settle 只闭合 dispatch，不能复活 parent execution 或越过 final CAS。
- Human review 只写 bounded safe evidence 与 closed resolution，不调用 adapter；review 与 late settle 使用 current unknown/version CAS，唯一 winner。
- compensation 明确显示为“新的副作用动作”，创建新的 invocation、execution、toolCall、confirmation、grant 与 dispatch；原 dispatch/history 不改写，也不称 undo/撤销。
- shutdown 顺序为停止 prepare/claim → commit pending/active/claimed 的合法 terminal/unknown/review truth → abort → bounded all-settled → 最后关闭 AuthorityWorker；初始化失败也等待 worker transport terminate/release，立即复用同一路径可成功。

## 5. 三个真实物理 adapter

- HTTP JSON read：只允许部署配置的 credential-free HTTPS origin/path slots、固定 GET/headers；拒绝 credential URL、IP literal、private/loopback/link-local/multicast、redirect 与 DNS rebinding；实际连接地址与解析结果绑定；connect/body/total deadline、decoded byte、encoding/decompression、UTF-8/JSON/depth/shape 均有界。
- Repository Git status：固定 absolute binary、trusted repository root/identity、`status --porcelain=v1 --untracked-files=no`、`execFile` 无 shell、allowlisted env；调用前复核 root identity/no symlink swap，timeout/abort kill；stdout/stderr 分别和合计有界，只给模型 bounded parsed records 与 omission marker。
- Sandbox file write：只接受 root 下 normalized NFC relative path；拒绝 absolute/`.`/`..`/backslash/alias、parent/target symlink、hardlink 与 prepare→claim swap；descriptor-relative/no-follow 等价遍历、expected hash fence、atomic temp + file fsync + rename + parent fsync；compensation 前复核 posthash，避免覆盖后续用户修改。
- adapter security 集中证据为 1 文件 / 12 tests，另有 fault/abort/sentinel/capacity/真实进程覆盖；缺少物理安全原语或启动 identity 时 startup fail closed，不退化为宽松实现或 fake Worker。

## 6. Schema v26、backfill、repair 与 archive

- v26 追加 canonical current/projection 与 immutable transition tables：tool call、sealed metadata、confirmation decision/handoff/current、grant transition/current、dispatch transition/current、review decision/current、compensation lineage、safe event/outbox/idempotency、recovery quarantine、repair descriptor与archive linkage；v1-v25 migration/history未重写。
- v26 有 74 条 immutable migration statements、27 条 trigger/startup reverse invariants、74 个逐 statement rollback 位置；migration checksum `d4a3cf1892d440264a71500f3c80e8fa748accdf925a2e425f840da042679538`，physical fingerprint `a5c6c02245dfab5a054e5035898f6a81ee805424901bb57ff96eb8eeac74f6cb`。
- backfill fixture覆盖 2 个 legacy grants 与 2 个 confirmations；可证明 dispatch映射为 claimed/confirmed/known truth，1 个 consumed-but-unprovable dispatch 进入 quarantine。migration 中 adapter/event/outbox/repair 均为 0，不生成 permit、不自动 resume。
- fresh v1→v26、每个历史 v1…v25→v26、重复 migrate、future/history/checksum/fingerprint/physical tamper、fresh/upgraded equivalence、WAL reopen、legacy组合、sealed AAD/version/size与 raw projection 零命中均有证明。
- 最终 schema migration/history/rollback：19 files / 135 tests。v26 四个 rollback range 使用四个独立 fresh single-fork project；四个断言仍逐一覆盖 1–20、21–40、41–60、61–74，未改断言或 30s 既有显式上限。
- `ROOM_REPAIR_REGISTRY` 注册 tool call/safe preview、confirmation decision/handoff/current、grant/dispatch transition/current、outcome/review、compensation lineage、safe reason/expiry/version/named Human/source reference；明确排除 raw/sealed parameters、grant capability、permit、token、HTTP/Git/Provider raw data与 credential。
- fixed watermark、W+delta、duplicate/out-of-order、cursor gap、512+ live buffer、clear-cache、reconnect、repair中 archive/revoke/expiry、old confirmation display-only、unknown review-only、poison/dead-letter 与多客户端收敛均覆盖。
- archive participant 与 pending confirmation/departure contributor 在同一 AuthorityWorker transaction 做 final recheck；pending/active/claimed/known/unknown 按真实状态收敛，reopen 只建立新 lifecycle generation，不复活旧 authority。

## 7. Protocol、Desktop J-05 与可访问性

- public frame 使用 exact allowlist、size bound、requestId/idempotency/expectedVersion；闭合 400/401/403/404/409/410/429/503。ACK只表示 Authority transaction，事实只由 stable event/projection/repair收敛。
- J-05 展示 pending、rejected、duplicate、params-changed、principal-revoked、confirmed、grant-revoked、dispatched、known-succeeded、known-failed、outcome-unknown、reviewed、expired、compensation proposed/pending/terminal。
- 每态显示 server 生成 safe target/summary、impact、reversibility、expiresAt、current/closed reason、具名 Human、安全 source deep link与恢复动作；local state只含 details/open/focus/submitting/review input。
- offline 时所有 tool write disabled且 transport=0；401重新认证且旧 binding 不重发；403刷新权限；409区分 duplicate/stale/params/grant/terminal；410创建新 invocation；429保留输入且不自动重复；503仅允许显式重试幂等 decision/query。
- repair staging 与 repair_failed 都保留旧的完整只读 projection，不用半页覆盖；unknown只显示 review，新 compensation 不修改旧 card。
- keyboard 顺序、Enter/Space、Escape只关闭详情并恢复焦点、ACK/event focus、非颜色状态、ARIA status/live、preview `aria-live=off`、840×560、1440×900、100%–200%/150% zoom、长路径换行、reduced motion 均有 DOM/root/surface 证据；无 typing animation。正式设计偏离：**无**。

## 8. 精确验证、CI 波折与审阅

最终实现候选依次通过：

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

- 全量：255 files（252 passed / 3 skipped / 0 failed）；2693 tests（2690 passed / 3 skipped / 0 failed）；最终配置本地 `pnpm test` 654.21s。
- Core：13 files / 116 passed。
- Desktop：74 files / 624 passed；Desktop production renderer boundary 为 29 个 source，无 Node/Electron authority。
- Server：168 files（165 passed + 3 skipped）/ 1953 tests（1950 passed + 3 skipped）。
- FT-10 专属 runtime/authority/surface：17 test files / 70 passed，另有 5 个 compile-time type-test 文件；schema物理拆分只增加文件数，不增加测试数。
- schema migration/history/rollback：19 files / 135 passed；v26 为 74 statements / 27 invariants / 74 rollback positions。
- FT-10 authority/worker focused：6 files / 154 passed；permission matrix 28 closed reasons；race/crash 8 files / 22 tests；WebSocket/sync/repair 5 files / 252 tests；Desktop J-05 3 files / 77 tests；sentinel/capacity 6 files / 12 tests并有真实 E2E。
- Core boundary 无 I/O dependency/import；Desktop boundary 无 Node/Electron authority；真实 Electron smoke、native selection、secure preview与app bridge通过。

CI 修复过程完整保留：

1. runs `33308368076`、`33309443102` 暴露长 schema worker 的 Vitest `onTaskUpdate` RPC timeout。
2. run `33310463462` 的 Node 22.13.1 通过；Node 22.x 只有四个旧大型 SQLite Buffer deep-equality 用例超时。断言改用 Node 原生 `Buffer.equals(...).toBe(true)`，仍是逐字节 exact comparison，不减少断言、不增加 timeout。
3. run `33312459018` 的 Node 22.x 通过；Node 22.13.1 的 Human recovery keyset 用例在共享资源尾部触及 15s，隔离重复约 3.5s。
4. run `33313911053` 在 v26 四个 rollback断言全部通过后出现 `onTaskUpdate`；run `33315252869` 再次证明单个 80s v26 worker仍会 RPC timeout，而另一 runner 在共享 persistence末端触及 Human keyset 15s。
5. 最终将 schema foundations/recent/integrity、legacy、四个 v26 range、Human authority 与其余 persistence 分配到有界 fresh single-fork 生命周期；保留原 `worker-persistence` single-fork、测试数量、断言和全部 timeout。最终 run `33316611639` 双 Node success。

没有提高默认 15s测试超时，没有放宽或删除既有测试，没有把真实 AuthorityWorker/SQLite/adapter改成 fake。CI 的唯一 annotation 是 GitHub Actions 自身 Node 20 action runtime deprecation，不是产品或测试失败。

三个独立只读审阅方向为 schema/migration/principal、runtime/dispatch/race/recovery、Desktop authority/error/a11y。最终结论均为 **P0=0、P1=0**；没有交付 blocker。审阅发现的 worker初始化释放、unknown review/shutdown fence、compensation review surface、named Human binding、internal memory seam与Desktop designated review问题均已修复并由最终全量/CI复验。

## 9. Live suite、secret hygiene 与已知边界

- 三个 OpenAI opt-in live suites（Agent、Router、Memory）因未同时显式提供 live flag 与 secret而安全 skip；跳过没有写成通过。
- 没有读取、打印、hash、比较或记录 secret 的值、长度、前后缀、Authorization header或可识别派生值。fake runtime、SSE parser、timeout/cancel、noauth、provider error、secret sentinel与真实 adapter zero-call边界未降低。
- GitHub marketplace actions 的 Node 20 action runtime deprecation 是 CI dependency维护项，不影响项目实际 Node 22.13.1/22.x 矩阵。
- 本阶段只交付已批准 FT-10 合同；不自行声明 FT-10 verified，owner 验收仍是后续唯一验证入口。

## 10. Git、保护文件、Blueprint 与 worktree

- 所有开发与证据工作均在隔离 worktree；原工作区 `/Users/leo/code/Dao` 未切分支、未 stage/commit/stash/reset/格式化或删除任何内容。
- 原工作区预期保持 `codex/ft02a-delivery-trace-fix@979863e7936962626b54a130d0260a4689a9bfb0`，仅有四个 owner 保护的未跟踪文档。最终证据 PR merge 与 worktree 清理后会再次只读核验 branch/HEAD/status 与四个 SHA-256。
- 实现 PR 合入后已从最新远端 `main@1913218519c1cdbc968e60e6e2a3db8e448dbbab` 创建独立证据 worktree `/Users/leo/code/Dao-ft10-stage12-evidence` / `codex/ft10-stage12-evidence`。
- `adapters`、`core`、`runtime`、`stage12 integration`、`surface` 与本 evidence 六个 Stage 12 临时 worktree 将在证据 PR merged 后先 `git fetch --prune`、核对 clean/真实合并状态，再以非强制 `git worktree remove` 删除并执行 `git worktree prune`。
- 未读写 Blueprint 内容或状态，未修改 Blueprint HTML/JSON、`gbp-data` 或 renderer；只按 owner 前置要求读取过 `grand-blueprint` skill说明，执行者未调用 verified 状态迁移。

## 11. 交付结论

以上证据只说明 FT-10 Stage 12 已满足实现、测试、独立审阅、required CI 与实现远端合入条件；证据 PR、最终远端 main 与 worktree 清理将在同一交付任务中继续闭合，最终产品验收仍由 owner 执行。
