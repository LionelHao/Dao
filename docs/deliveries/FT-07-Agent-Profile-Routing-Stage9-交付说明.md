# FT-07 Agent Profile & Routing · Stage 9 交付说明

状态：FT-07 的 Stage 9 生产实现已通过受保护分支合入远端 `main`，等待 owner 验收；本说明不把 Agent 自测、独立审阅或 CI 写成 owner 验收，也不标记 verified。

## 1. 结果与远端交付事实

- 一句话结果：Global Agent Profile、Room Assignment、availability、可信 direct/routed origin、durable handoff、FT-06 persona/context 接入和真实 Desktop Agent Settings 已进入生产 composition，并保持 FT-08/09/10/14 seam fail closed。
- 起始基线：`5234b9a9a043ef03cb5ecf37f00a4671800612b8`（FT-06 Stage 8 evidence，Authority schema v19）。
- FT-07 最终实现 `main` SHA：`a48b8b454b13645fe6b18f2e4bcee9a851ecb7cb`（PR #69 squash merge）。
- schema：v20 交付 Profile/Routing Authority；v21 只追加 immutable direct invocation binding，不改写 v1-v20 历史。
- 本交付记录 PR：创建后回填；其 squash merge 将成为本阶段证据 tip。

| PR | 范围 | merge SHA | 必需 CI |
| --- | --- | --- | --- |
| [#62](https://github.com/LionelHao/Dao/pull/62) | Stage 9 rebaseline | `74e46260093b61bda5543eab3b4cb979bd346c9b` | [quality 32722437158](https://github.com/LionelHao/Dao/actions/runs/32722437158)，双 Node success |
| [#63](https://github.com/LionelHao/Dao/pull/63) | Core closed Profile contracts | `1bb810e286cc019e6af6e3c2388af324fc51cb5c` | [quality 32723143448](https://github.com/LionelHao/Dao/actions/runs/32723143448)，双 Node success |
| [#64](https://github.com/LionelHao/Dao/pull/64) | no-silent 与 public surface hardening | `87e5602769c17a943a1780e97ea1346bd44d3afc` | [quality 32724956463](https://github.com/LionelHao/Dao/actions/runs/32724956463)，双 Node success |
| [#65](https://github.com/LionelHao/Dao/pull/65) | Authority schema v20 | `aac6164e3bf5997dea7e6c8ceceedbf9b4952d17` | [quality 32731031217](https://github.com/LionelHao/Dao/actions/runs/32731031217)，双 Node success |
| [#66](https://github.com/LionelHao/Dao/pull/66) | runtime/public no-cascade | `19153709cec2dc946276ba10767189b7d9ada530` | [quality 32733810668](https://github.com/LionelHao/Dao/actions/runs/32733810668)，双 Node success |
| [#67](https://github.com/LionelHao/Dao/pull/67) | Tenant Administrator/Profile Authority | `35fd3a10d470ac73140718268806f7cb650c9a21` | [quality 32731976548](https://github.com/LionelHao/Dao/actions/runs/32731976548)，双 Node success |
| [#68](https://github.com/LionelHao/Dao/pull/68) | Profile fan-out、Assignment、trusted routing | `ae3149e0a0b3e3dc421b06e47c06f87038a85385` | [quality 32735120300](https://github.com/LionelHao/Dao/actions/runs/32735120300)，双 Node success |
| [#69](https://github.com/LionelHao/Dao/pull/69) | 最终 protocol/sync/context/runtime/Desktop composition 与对抗加固 | `a48b8b454b13645fe6b18f2e4bcee9a851ecb7cb` | [quality 32752727166](https://github.com/LionelHao/Dao/actions/runs/32752727166)：[Node 22.13.1](https://github.com/LionelHao/Dao/actions/runs/32752727166/job/97513186016)、[Node 22.x](https://github.com/LionelHao/Dao/actions/runs/32752727166/job/97513186370) success |

`main` 继续要求 strict、管理员同样受约束的双 Node required checks、linear history、conversation resolution；force push 与 branch deletion 均禁用，没有绕过保护。

## 2. 14 条 Requirement 闭环

| Requirement | FT-07 生产代码/合同 | 测试与交付证据 | 后续边界 |
| --- | --- | --- | --- |
| `REQ-AGT-001` | FT-03 structured target 绑定 stable actor/Profile/Assignment revisions；routed decision 与 intent 同事务持久化 | `durable-trusted-intent-authority`、multi-target/context isolation、restart E2E | FT-08 完整 execution lifecycle |
| `REQ-AGT-002` | public `agent.invoke` 固定 410；direct/routed origin 是 server-private closed capability | public forgery matrix、real-process restart 仍零 runtime/Provider 调用 | FT-08 public 控制命令仍不得携带 origin |
| `REQ-AGT-003` | participation 闭集仅 `active/on-mention`；on-mention direct 保留 Assignment 内 read/tool | Core negative types、exact guards、Router exclusion、direct gate tests；Desktop 无 silent | 已闭合 |
| `REQ-AGT-004` | availability 独立推导 `paused > noauth > busy > ready`；pause durable，busy/execution 与 noauth/SecretProvider 派生 | Assignment service、restart/WAL、noauth/no-fallback、Desktop read-only projection | FT-08 最终 busy queue；FT-14 credential ops |
| `REQ-AGT-005` | 缺 Goal/project fact 时 suppressed；Agent final/correction 不建 RouteJob；FT-09 trigger unavailable | route policy、quiet-room zero-call、Agent-final no-cascade、legacy pending terminalization | FT-09 提供真实 checkpoint/due/Blocker |
| `REQ-AGT-007` | Router 只消费 stable-ID、revisioned、hashed bounded candidate snapshot；终态再次复核 authority | 14 项 FT-07 policy、displayName metamorphic、terminal revalidation/race matrix | FT-09 注入项目事实版本 |
| `REQ-ID-004` | Agent Actor / Global Profile / Room Assignment 三层分离；Profile 仅 Tenant Administrator；Room ACL 独立 | v20 invariants、admin/Profile/Assignment ACL/CAS/audit、跨 Room information-flow negatives | FT-14 最终 credential rotation |
| `REQ-MEM-011` | FT-06 compiled envelope 接入真实 actor、Profile/Assignment responsibilities、participation、effective sets、revisions、availability/trigger | compiler/database/property、multi-Agent persona/tool isolation、stale revision fail-closed | FT-09 Goal 事实替换 unavailable seam |
| `REQ-NFR-006` | 单一 server Provider/model、`store:false`、SecretProvider readiness；无 BYOK、fallback 或 secret persistence | noauth、secret sentinel、Provider closed output/SSE/cancel/error tests；Desktop 只读披露 | FT-14 rotation/retention/ops |
| `REQ-PD-004` | Profile/Assignment 为有界多 Agent authority，不建立人数或 displayName 身份门禁 | empty/multiple catalog、fan-out、multi-client convergence | FT-15 真实试点 |
| `REQ-PRIM-004` | Human invitation 与 Agent configuration 使用独立 command/event/projection | protocol negative tests、Desktop 独立分区 | 已闭合 |
| `REQ-PRIM-011` | structured `@Agent` 在 Human message Authority transaction 中产生 durable direct binding | message v2 replay/restart、stable actor target、ACK/event 驱动 UI | FT-08 完整终态 |
| `REQ-PRIM-013` | `active/on-mention` 与 `ready/busy/paused/noauth` 分离 | Core/Assignment exact guards、Desktop 文本+非颜色识别 | FT-08 共享 busy 最终闭合 |
| `REQ-UX-005` | Settings 按 viewer authority 展示 Profile/Assignment/provider/availability，消费真实 ACK/event/repair | Desktop contracts/runtime/surface/view-model 共 44 项，另有真实 WS/Worker/SQLite E2E | FT-11 shell 整合 |

正式 UI 旅程映射为 J-01（启动、Room catalog、Settings 权限分离）、J-03（structured direct/multi-Agent 独立失败）、J-05（effective tool subset 与 revision gate）、J-07（offline/repair/revoke/atomic projection）。设计偏离：**无**。

## 3. 三层权威、ACL 与命令

- Agent Actor 只提供永久 `actorId` 和 actor kind；改名不会改变 mention、message、execution、audit 或 routing identity，Agent 没有 Human session。
- Global Agent Profile 与 Agent actor 一对一，包含 displayName、全局职责、enabled/disabled、closed capability/tool ceilings、revision/audit 时间；只有认证后的 current Tenant Administrator 可以 create/update/enable/disable/list/get。
- Room Assignment 绑定 `roomId + profileId + actorId`，包含 Room 职责、active/on-mention、durable pause、closed subsets、current/removed history 与 revision；只有 current Room owner/admin 可以 create/update/pause/resume/remove/list/get。
- Tenant Administrator 来自 owner-controlled bootstrap 后的 SQLite registry、CAS、idempotency 与 immutable deployment audit；Agent principal不能成为 administrator，最后一个有效 administrator 不能删除，session revoke 后立即失权。部署角色不授予任何 Room 读取权。
- archived Room 复用 `AssignmentSecurityReductionParticipant`，只允许 pause/remove/安全缩减，不允许 create/resume/扩大；remove 保留历史，不物理删除。

mutation 在同一 AuthorityWorker transaction 中完成 session/principal、admin/Room ACL、lifecycle/access revision、CAS、subset/ceiling、domain/history/audit、stable event/outbox、idempotency 与 invalidation；closed errors 覆盖 400/401/403/404/409/410/429/503，没有部分提交。

## 4. 权限交集、participation 与 availability

生产交集为：

```text
effectiveCapabilities = Profile ceiling ∩ Assignment subset ∩ current Room access policy
effectiveTools        = Profile ceiling ∩ Assignment subset ∩ current membership tool policy
```

集合必须 closed、canonical sorted、unique；unknown 或扩大 ceiling 均 fail closed。Profile disable/ceiling reduction、Assignment pause/remove、membership/access revoke、Room archive 会使 route/claim/model/context/source read/tool prepare/claim/dispatch/final 的适用 revision gate 收缩；Provider/Adapter 前失败为零次调用。FT-10 的 confirmation/grant/dispatch 与 `outcome_unknown` 语义未被复制。

`silent` 已从新 Core、public protocol、Desktop、Router candidates 和生产写路径删除；历史 silent 由 v20 迁移为 `on-mention + paused + migration review`，不会变成主动 active。`on-mention` 不参加自主 routing，但 structured direct target 使用完整有效 read/tool authority。

availability 是只读 projection，不是客户端 readiness：paused 取 durable Assignment override，noauth 取当前单一 Provider credential readiness，busy 取 durable running execution，只有其余 authority 全满足才为 ready；restart 会从持久事实重新推导，不回退 fake Provider。

## 5. 可信 origin、Router 与 durable handoff

- direct：唯一 producer 是 FT-03 Human message 同一 Authority transaction 的 structured stable actor target；正文 `@displayName`、regex、重名与 client target kind 不触发，失效 target 独立 rejected、不换 Agent。
- routed：唯一 producer 是 terminal RouteJob decision；candidate snapshot、hash、selected actor、Profile/Assignment/access revisions、provenance、decision 与 routed intent 在同一 Authority transaction 闭合。pending handoff claim/recover 经真实 SQLite/WAL restart 恢复。
- project-boundary：FT-09 未交付，production 返回 `dependency_unavailable/suppressed`；没有用消息、OpenItem、LightTask、Ball 或 fixture 冒充 checkpoint/due/Blocker。

Router 不读取 displayName 作为职责、排序、幂等或 Provider key；on-mention、paused/busy/noauth/ineligible 排除，缺 Goal/职责/健康项目事实保持 zero-call suppressed。Provider 只能从 Authority closed set 选择，输出再校验 stable ID 与 revisions；失败不换 Agent/model/Provider。Agent final/correction 不 notify Router，也不会级联唤醒其他 Agent。

Provider 返回后、terminal decision transaction 内再次复核 source/Room/Profile/Assignment/membership/access/provider/busy 与全部 revision；任何变化将选择改写为 suppressed，并产生零 handoff/intent。FT-08 仍负责完整 accepted/running/terminal、preemption、timeout/retry/recovery状态机，本阶段没有用 best-effort callback 冒充 execution。

## 6. FT-06 Context、Provider 与 privacy

每个 compiled Agent envelope 现在使用真实 stable actorId、Profile displayName/global responsibility、Room responsibility、participation、effective capability/tool sets、Profile/Assignment revisions、availability facts 和 trigger。多 target 可共享 immutable Room facts，但 persona/assignment/tool manifest 独立；一个 Agent 失败不污染另一个，旧 revision 在安全点 fail closed；没有恢复 64-message fallback，群正文不进入 system/developer instruction。

MVP 仍只有一个明确 Provider/model、server-side SecretProvider、`store:false`；有权 Room 用户只看到 provider/model/readiness disclosure，没有 BYOK/模型选择器。无 secret 时服务启动且 availability=noauth，不调用 fake/model fallback。secret 值及其长度、前后缀、hash、Authorization header或可比对派生值均未读取、打印或写入 SQLite、audit、event、outbox、repair、WebSocket、Desktop与普通日志。

## 7. schema、sync/repair 与 Desktop

- v20：97 条 append-only statements；51 条 trigger invariants、9 条 startup invariants（合计60）；97 条逐 statement rollback assertions；11 项 migration tests。fresh 与每个 v1-v19 升级、future/history/physical tamper、fresh/migrated equivalence、v14 seam、silent/static seed、历史 actorId/displayName、restart/WAL/repair 均覆盖。v1-v19 checksum/fingerprint 未修改；v20 checksum=`f4b4f080c7f5815cc6f399b5775a083514493cec675c04abd98a13cae0226b7f`，fingerprint=`1ca2a806a52cd2ce9632b02e215a25ba13bc3ebc4336f5152c48f21d60faa2a0`。
- v21：6 条 immutable direct-binding statements、5 条 trigger + 1 条 startup invariant、6 条 rollback assertions、5 项 migration tests；只补 direct source→Profile/Assignment/access frozen binding。
- deployment Profile 与 Room Assignment 使用 scope-correct event/outbox/sync/repair；Profile rename/disable/ceiling fan-out，Room repair不泄露其他Room，Provider disclosure无secret。真实多客户端、cursor gap/duplicate/out-of-order、restart/WAL、expired repair与access revoke purge均收敛。
- Desktop main 维持一个认证 WebSocket request multiplexer，消费真实 `agent-profile.sync/repair`、`room.sync`、Assignment repair与Room subscription；stable event不由 ACK+snapshot伪造。snapshot、periodic sync与live event有 generation/epoch/current-Room fence、per-Assignment removal tombstone、repair watermark、event-ID去重和512条硬上限；overflow从未推进的cursor catch-up。
- Renderer pending ACK 不改变 stable projection；409刷新权威事实并保留安全输入；offline/repair/revoked/archived禁用mutation并purge撤权缓存。loading/empty/401/403/409/410/429/503、焦点归还、错误摘要、keyboard、ARIA live、非颜色识别、200% zoom、840px与reduced motion均有正式状态/测试。

## 8. 精确验证证据

- `corepack pnpm test`：200 files（197 passed / 3 skipped / 0 failed）；2173 tests（2170 passed / 3 skipped / 0 failed）；247.89s。命令内 Core I/O boundary 与 Desktop renderer boundary（23 production sources）通过。
- 分包：Core 9 files / 94 passed tests；Desktop 61 files / 480 passed tests；Server 127 passed + 3 skipped files / 1596 passed + 3 skipped tests。
- `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm build`、`corepack pnpm verify:core-boundary`、`corepack pnpm verify:desktop-boundary`、`corepack pnpm --filter @native-im/desktop smoke`、`git diff --check` 均通过。
- admin/Profile authority：bootstrap 2、protocol 2、service 6、SQLite 11、worker integration 2；Assignment authority：policy 12、security reduction 4、service 15、protocol 2、worker integration 1。
- trusted routing/runtime：FT-07 decision 14（含 displayName metamorphic）、origin 5、durable trusted intent 18、frozen runtime gate 15；私有 route protocol/SQLite/human-preemption/runtime 聚焦矩阵 6 files / 122 tests。
- Context property：seeds `1129601030,1296387335,3737844653`，每 seed 256 次 permutation；每 seed 32 次 large-delta。Context compiler/database/property 4 files / 40 tests。
- race/repair反例覆盖：Provider返回后terminal revalidation、Profile/Assignment/access reduction、stable-event先于ACK、bootstrap/recover snapshot与live event、remove→旧upsert、repair中revoke、Profile sync与snapshot、512/600 buffer overflow、cursor乱序/重复、session/Room revoke purge。
- real path：AuthorityWorker、SQLite/WAL reopen、closed WebSocket、multi-client sync/repair、routed handoff crash/restart与 real-process Authority E2E 26/26。
- Desktop：61 files / 480 tests；Agent Settings contracts/runtime/surface/view-model 44项；Electron smoke通过。真实 Desktop Agent Settings WS/Worker/SQLite E2E 在最终代码上连续3轮均1 passed / 25 skipped，无flake。
- CI 首轮 Node 22.13.1 唯一失败是既有 worker termination 后测试用100次`setImmediate`轮询短于真实清理时间；Node 22.x 同轮success。轮询改为2秒硬截止/10ms间隔，不提前释放coordinator、不放宽产品断言；完整 WorkerDatabaseClient 54/54与失败反例连续3轮通过，最终 quality 32752727166 双 Node success。

因没有显式 live flag 和/或 OpenAI secret，Agent、Router 与 Memory live smoke 安全跳过；CI fake、SSE parser、Router closed output、取消、noauth、错误与 secret sentinel 覆盖未降低。

## 9. 独立审阅、风险与阶段边界

同一独立审阅者进行了六轮只读对抗审阅。前五轮发现并推动关闭：Provider后终态authority复核、membership tool policy交集、真实Desktop sync/repair、event cursor分域、revoke purge、snapshot/live安装竞态、remove tombstone、recover旧snapshot回退、repair/revoke写回、无界buffer与Profile sync/catalog回退。最终审阅代码对象为`25fde4e431a42b62f8aba14069af6084a04637a9`，结论：**无 blocker**；其后只增加审阅/验证文档和CI测试等待加固，没有改变生产代码。

当前没有已知 FT-07 生产 blocker。明确未冒充完成的共享边界：

- FT-08：完整 execution lifecycle、preemption、timeout、retry/recovery与最终多目标并发。
- FT-09：真实 Goal/Ball/checkpoint/due/Blocker project loop；当前 producer suppressed/dependency unavailable。
- FT-10：完整 confirmation/grant/dispatch review与side-effect race matrix；本阶段只提供Profile/Assignment/access revision gate。
- FT-14：secure credential rotation、retention和运营审计；secret不进SQLite，unsupported mutation闭合返回。

## 10. Git、受保护文件、Blueprint 与 worktree

- 实现与文档提交均来自隔离 worktree；原工作区 `/Users/leo/code/Dao` 的 branch、tracked状态未被本阶段改写。
- Blueprint HTML/JSON及其renderer未修改；从起始SHA到实现SHA的文件清单没有Blueprint路径。
- 原工作区四个用户 untracked 文件仍未 stage、commit、移动、覆盖或格式化，SHA-256 与起始值一致：
  - FT-09 design：`88a98e90739f79bfb97f90282a673d6a444cc57e12c782b721e6ba2f87a8f122`
  - FT-09 implementation：`8600eca88483da83ad9c2b4722cda4f891635990cef2be115218874250a5649c`
  - FT-10 design：`8c75b4e4a77cd4f0cce3fcccea58eeb51f497547a05ca9ac839e2d24e6ed9578`
  - FT-10 implementation：`8b535d6bafd118d977690071cfc499870dedc78e61f6a7f9b33874886007fdcd`
- PR #69 合入并`git fetch --prune`确认后，逐个检查clean并删除以下实现worktree：`context-integration`、`desktop-sync`、`direct-binding`、`final-integration`、`runtime-gates`、`sync-integration`、`sync-protocol`；`git worktree prune`后目录与注册项均消失。
- 本交付记录 worktree 是证据PR的唯一剩余Stage 9临时worktree；证据合入、再次确认远端merge与clean状态后删除并prune。最终只保留阶段开始前的 `/Users/leo/code/Dao`。
