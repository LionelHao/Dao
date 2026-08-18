# FT-07 Agent Profile & Routing 拆环实施计划

> 日期：2026-08-18
>
> 状态：设计冻结后的实施计划；docs-only，不代表 FT-07 已实现或 verified
>
> 设计输入：[FT-07 生产工程设计](2026-08-18-ft07-agent-profile-routing-design.md)
>
> 基线：`origin/main@fb37f7a`，当前 Authority schema `13`；migration 版本由 FT-13 在合入时分配

## 1. 实施原则与 Definition of Ready

本计划按垂直安全环拆分，而不是按 UI、server、DB 分别堆积。每一环必须先写失败测试，再实现最小 closed contract，再用 AuthorityWorker/real SQLite/WS 验证。共享 schema、AuthorityWorker、protocol 与 projection 文件必须串行集成；不引入第二 DB、writer 或 event bus。

开始生产实现前必须满足：

- FT-01 administrator/session seam 可调用，FT-02A owner/admin/access revision 与 archive reduction 已稳定；
- FT-03/FT-08A 对 direct target 与 durable invocation intent 的共同 ownership 已按本计划顺序冻结；
- FT-13 为实际 predecessor 分配 migration slot、checksum/fingerprint 规则与 repair registry key；
- FT-06 提供 Goal/职责/上下文健康度的 server-private接口，缺失时已有 fail-closed路径；
- FT-10 closed tool registry 与 membership permission query 不再要求 FT-07复制工具安全事实；
- docs/design 基线未变化；若变化先更新 Requirement/旅程映射。

每环完成都只能表述为该环合同通过，不能提前宣称 FT-07 已实现。最终验收措辞由 owner gate 决定。

## 2. 文件 ownership 与改动预算

以下是实施期预期文件切片，不是本 docs-only 变更：

| 区域 | 预期生产文件 | 预期测试文件 | owner / 串行约束 |
|---|---|---|---|
| Core closed types | `packages/core/src/agent-profile.ts`、Core exports | `packages/core/src/agent-profile.test.ts`、type-test fixture | FT-07；先于所有 consumer |
| public protocol | `packages/server/src/protocol.ts`、WS dispatcher | `protocol.test.ts`、`websocket.test.ts` | FT-03/FT-08A/FT-07 联合；关闭旧 surface 后再接新 path |
| internal protocol | `agent-runtime/runtime-authority-protocol.ts`、route/runtime ports | 对应 protocol/worker tests | FT-08 owner operation envelope，FT-07 owner gate payload；不得进入 public union |
| schema/backfill | `persistence/schema.ts`、migration/importer、schema fingerprint | schema/importer/upgrade tests | **FT-13 migration owner**；只从合入时 predecessor 派生版本 |
| Authority commands | `authority-database-handler.ts`、`authority-worker.ts`、worker client/contracts | SQLite store、worker client、real worker tests | 单 writer；按环串行 |
| route policy | `route-runtime/route-decision.ts`、provider input、route service | decision/provider/service/recovery tests | FT-07；复用 T-0016 scheduler，不复用旧语义 |
| runtime gates | agent runtime authority/service、tool-gateway seam | worker/runtime/tool race tests | FT-08/FT-10 owners，FT-07 提供 revision gate |
| sync/repair | sync service、snapshot worker、FT-13 registry | cursor/gap/repair/restart E2E | FT-13 owner registry，FT-07 owner record validator |
| Desktop | renderer Settings feature/reducer/styles；FT-11 transport/controller | renderer state/a11y/IPC tests | FT-11 集成；FT-07 提供 DTO/state fixtures |

禁止在一个 PR 同时无界改写 schema、route scheduler、runtime engine 与 Desktop。每环保持可回滚，且不以兼容旧 `silent` 或 public `agent.invoke` 为理由扩大协议。

## 3. 环 0：基线与 characterization fence

目标：在任何行为改变前把旧事实与新冲突固定为可删除的 characterization tests。

先写/调整测试：

- public `agent.invoke` 仍接受 `kind/targetAgentId` 的现状测试标注为 removal target；新增负测要求新 public decoder 拒绝 agent identity、route kind、capability、tool、Provider/model、origin；
- route tests固定旧 `silent`、displayName role、actor global permission snapshot、Agent final cascade、best-effort handoff 为冲突清单；
- runtime tests固定 on-mention tool context/prepare/claim 当前 call count 0 的错误行为，随后在环 6 翻转；
- static `registerActors` 重启覆盖/冲突、legacy actor readiness 与 membership seed 建 fixture；
- schema/version/fingerprint、真实 origin/main predecessor、dirty worktree 检查进入实施 checklist。

完成门：旧行为有精确文件/测试定位；没有生产语义变化；T-0016/T-0041 可复用机制与冲突项一一对应设计第 11 节。

## 4. 环 1：closed Core 与 type-test boundary

RED：

- `silent`、未知 capability/tool、额外 key、重复/乱序 subset、客户端 writable availability 编译或 guard 失败；
- actor/profile/assignment 不能互相赋值；displayName 不能当 actorId；public origin 不能构造 internal invocation；
- Assignment subset 超过 Profile ceiling 返回 closed validation error。

GREEN：

- 增加 branded IDs、Profile/Assignment records、participation/availability/status、closed capability registry、exact guards、canonical sorting；
- server-private package 定义不可 JSON 构造的 origin capability；Core/public exports 不导出它；
- availability calculator 接收独立 durable/derived facts，只返回 projection，不提供 set 命令。

REFACTOR/门：类型导出图无 circular dependency；type tests与 runtime guard tests一致；public package API review 证明没有 internal token、Provider/model selection 或 readiness mutation。

## 5. 环 2：migration、backfill 与静态 seed 退场

此环由 FT-13 分配实际版本并拥有 schema edit。不得在 FT-07 分支预写版本常量。

RED：

- 从合入时 predecessor 的真实快照升级；actorId/displayName/history 保留；active/on-mention membership 正确 backfill；
- legacy silent 变为 `on-mention + paused + migration-review audit`，不能执行；未知权限、重复 Assignment、损坏 JSON、fingerprint mismatch 均阻止启动并回滚；
- migration 重跑幂等；中途 fault injection 不留半表/半事件；旧 snapshot/readers在兼容窗口与 Assignment projection 相等；
- 正常重启不再允许 static options 覆盖 Profile/Assignment/readiness。

GREEN：

- 创建 canonical Profile/Assignment persistence、indices/checks/revisions；actor 只保留 identity；
- backfill旧 actor tool permissions为 Profile ceiling、旧 Agent membership为 Assignment；写 migration provenance/hash；
- 增加只读兼容 adapter并列出删除条件，禁止双写真相；
- legacy importer 与 child fixture走同一 validator。

门：schema checksum/fingerprint、upgrade/rollback/fault tests、真实前任版本 E2E 通过；只使用单 SQLite/AuthorityWorker；migration owner签字。

## 6. 环 3：Tenant Administrator 与 Global Profile authority

RED：

- 非 administrator、过期/revoked session、Agent context均 `401/403`；Tenant Administrator不能通过 Profile query读 Room ID、消息、成员、Goal、Assignment内容；
- create 服务端生成 actorId/profileId；update/disable/enable要求 expected revision；replay 返回同一结果；冲突无 audit/event/outbox；
- ceiling reduction/disable 对 route/runtime gate 即时生效；fan-out超限在写前 `429`；audit无 secret；
- Provider secret永不进入 DB/event/log/DTO，noauth只来自 readiness provider。

GREEN：

- 实现 Profile commands/query、administrator ACL port、CAS、audit/event/outbox；
- 生成受影响 Room 的安全缩减事件，但响应只含部署级 Profile 结果；
- static actor bootstrap仅能创建未存在 identity/Profile，不能在启动时更新。

门：AuthorityWorker真实线程 + SQLite tests证明同事务、无越权 query、call count 0、replay/CAS/fan-out boundary；FT-01 session revoke 后立即失败。

## 7. 环 4：Room Assignment authority 与 permission intersection

RED：

- 只有 FT-02 current owner/admin可 create/update/pause/resume/remove；普通成员和 Tenant Administrator（无 Room role）均 `403`；
- archived Room只允许 pause/remove/缩减；Profile disabled不能新建/恢复；subset越 ceiling、未知 tool、stale revision失败；
- Human role与Agent participation不混用；同 Room/Agent唯一 current Assignment；remove不删除历史；
- membership revoke/access revision变化立即使 Assignment ineligible；Room query不能跨 Room；
- active与on-mention在 direct权限交集相同，route候选仅active。

GREEN：

- 实现 Assignment commands/query、closed intersection、Room-scoped events/audit/outbox；
- 建立 Profile/Assignment/access revisions 组合 gate；
- 旧 Agent membership write path关停或只进入迁移 adapter。

门：permission matrix、archive reduction、CAS/replay、Profile ceiling race、membership revoke tests通过；DB中只有一个可写 Agent Room事实。

## 8. 环 5：FT-03 direct invocation 与 public surface closure

合入前提：环 1/3/4 可提供 stable resolution 与 Assignment eligibility；FT-03 message authority和FT-08A intent schema已在同一集成序列。

RED：

- 客户端提交 targetAgentId、route kind、capability/tool、Provider/model、origin/internal snapshot 均被 public exact guard拒绝；旧 frame按版本合同 `410`/unsupported，不转译；
- 正文 `@displayName`、regex、同名显示名不能触发 Agent；只有FT-03结构化 target在Human message事务中绑定actorId；
- target不存在、Profile disabled、Assignment removed、membership revoked、Room archived产生同事务显式 rejected outcome；不自动换 Agent；
- on-mention direct创建的intent带固定Profile/Assignment/access revisions与完整有效subset。

GREEN：

- 删除/隔离 public `agent.invoke`；消息 command只携带用户目标 token；Authority解析为 stable actorId；
- 在FT-03同事务写 target outcome与FT-08A durable intent/outbox；server-side注入single Provider/model；
- internal origin token只在 worker port创建与消费。

门：public WS fuzz/unknown-key tests、同名 Agent tests、transaction fault injection、real WS双客户端ACK/event/repair通过；public bundle/IPC不含 internal operation。

## 9. 环 6：Router snapshot、停止规则与 durable handoff

RED：

- 候选排序/结果不读取displayName；改名不改变decision；伪造candidate ID/revision被拒；
- on-mention不进routed/proactive候选；active若paused/busy/noauth/ineligible也不进；
- Goal或职责事实不足/陈旧时risk/domain semantic proactive必须suppressed；健康due authority fact可按批准规则触发；
- Agent final不产生RouteJob；同一Agent失败不换Agent/模型；无silent；
- route terminal与intent creation在durable Authority事务/outbox内；crash后恢复，不再best-effort invoke；
- Profile/Assignment/access/Goal/Ball revision在decision完成与intent claim前改变时call count 0。

GREEN：

- 替换RouteCandidateSnapshot：稳定IDs、Room职责、有效subsets、availability gates、Ball/Goal/context fact versions；
- 保留T-0016 bounded queue、per-Room FIFO、closed judgment、summary-only provider、store:false与同Agent/同模型bounded retry；
- 把direct/routed/project-boundary分成三个server-private origin constructors；
- 删除Agent final `onMessageCommitted -> routeRuntime.notify`级联；RouteJob只由批准的Human/project facts创建；
- 由FT-08A durable intent/outbox接管terminal handoff。

门：decision table、metamorphic displayName test、事实缺失/陈旧 test、crash-at-every-boundary recovery、no-cascade E2E通过；旧T-0016交付状态仍保持历史标签。

## 10. 环 7：availability、claim/model/tool race

RED 按下表为每个阶段写 adapter/provider call-count 与 durable terminal assertion：

| race | 必测边界 |
|---|---|
| Profile disable/reduce | route snapshot后、intent claim前、model start前、tool prepare/claim前、final commit前 |
| Assignment remove | queued、claimed、model streaming、confirmation pending、recovery |
| membership revoke/archive | context read前后、tool dispatch前后、final commit与cache purge |
| pause/noauth | claim前必须0调用；运行中到安全点中止；重启保持derived结果 |
| busy | reservation CAS、同Agent direct显式结果、routed suppression、execution结束重算 |

GREEN：

- 在FT-08 claim、provider stream开始/继续、FT-10 tool prepare/claim/dispatch、final commit植入统一 revision gate；
- availability展示优先级 `paused > noauth > busy > ready`，但安全判断读取独立 facts；
- on-mention direct不再被`participation === active`拦掉tool context/claim；仍受Profile∩Assignment∩membership交集；
- provider/model从部署配置读取并冻结到execution，不接受client/Router值，不fallback；
- dispatch后撤销保存真实outcome/outcome_unknown，遵循FT-10 compensation，不改写历史。

门：real provider fake + real worker SQLite fault tests覆盖所有格；每种撤销前call count 0、撤销后outcome不丢；restart从durable running/credential/pause重算一致。

## 11. 环 8：sync/repair 与 restart derivation

RED：

- profile/assignment event gap、未知record version、projection hash mismatch、rename/disable fan-out、离线期间membership revoke；
- restart恢复中不先显示ready；running execution推busy、credential缺失推noauth、pause覆盖其他展示；
- Tenant Administrator repair不能读Room；Room repair只含本Room安全projection；security reduction使旧grant/缓存不可操作；
- snapshot生成与domain mutation竞争时由revision/cursor得到前或后完整状态，不出现混合记录。

GREEN：

- 向FT-13 registry注册`agent-profile`与`room-agent-assignment`descriptor/validator；
- AuthorityWorker生成scope-correct snapshot；Desktop reducer按record原子替换；
- startup gate等待schema验证、execution recovery、credential readiness和availability derivation完成；
- profile变化生成必要Room-scoped event/outbox，绝不把Room内容写入部署级audit response。

门：真实worker kill/restart、SQLite WAL、WS reconnect/cursor gap、双客户端security revoke E2E通过；无第二DB/writer/bus。

## 12. 环 9：Desktop Settings（FT-11 integration seam）

此环实现正式设计稿，不复用旧静态演示表单的业务成功语义。FT-07提供DTO、状态reducer与feature tests；FT-11拥有live transport/IPC/controller整合。

RED：

- J-01：Human邀请与Agent分配完全分区；Tenant Administrator/Profile入口与Room ACL分别控制；无权不泄露数据；
- J-03：stable Agent mention/Assignment/participation/availability、execution状态；on-mention明确点名可调用；
- J-05：只显示effective tool subset与FT-10 grant/confirmation；Profile ceiling与Assignment subset可区分；
- loading、empty、401、403、409、410、429、503、offline、repair与pending ACK全覆盖；本地pending不改变stable事实；
- 键盘顺序、焦点返回/错误摘要、非颜色状态、节制aria-live、200% zoom、840px、reduced motion自动化或可重复人工证据。

GREEN：

- 用Room projection/Profile admin query渲染；availability只读；pause/remove等命令显示pending→ACK→event；
- 删除`silent`选项、假catalog、同步`onConfigureAgent`成功文案；
- conflict刷新current projection并保留可安全重放的输入；offline/repair禁用mutation；
- Provider/model仅展示部署事实，不提供选择器或BYOK。

门：renderer unit + DOM a11y + IPC contract + real WS user journey E2E通过；与[正式设计入口](../design/README.md)逐状态截图/行为核验；偏离记录为“无”。

## 13. 环 10：端到端验收与删除兼容层

必须建立真实AuthorityWorker + SQLite + WS测试矩阵：

1. administrator创建Profile → Room owner分配active/on-mention → 两客户端sync/repair；
2. Human结构化点名on-mention → 完整read/tool subset → final，不产生二次RouteJob；
3. active Router使用职责/Goal/Ball/availability，displayName改名不影响；Goal/职责不足风险路由停止；
4. Profile disable、Assignment remove、membership revoke、pause/noauth分别命中claim/model/tool各race；
5. crash在command commit/outbox、route decision/intent、claim/provider、tool dispatch/settle、final/event之间，重启后唯一终态；
6. public伪造identity/kind/capability/provider/model/origin全部拒绝；Tenant Administrator跨Room查询拒绝；
7. 401/403/409/410/429/503/offline/repair与Desktop焦点/a11y合同可复现。

当所有production reader均切到Assignment canonical source、旧协议窗口结束、legacy snapshot已升级后，删除：旧public `agent.invoke` decoder、`silent` guards/reason codes、actor readiness/tool-permission事实字段的runtime reader、旧Agent membership write path、displayName role snapshot、best-effort routed invoke和Agent-final route notify。删除前后均跑migration fixture与real-worker E2E。

## 14. 合入顺序与依赖列车

推荐的最小冲突合入顺序如下；若实际分支已先合入某环，只能在接口相容且测试证据等价时调整，不能跳过 gate：

| 顺序 | 合入单元 | 原因 / gate |
|---:|---|---|
| 1 | FT-07 环1 closed Core；FT-08A/FT-03只消费接口 | 先冻结三层对象、public/internal边界，不碰schema |
| 2 | FT-13分配migration slot并合入FT-07环2 Profile/Assignment backfill | schema/current只能由migration owner串行推进 |
| 3 | FT-07环3/4 Profile与Assignment Authority | 为direct target、route、runtime提供唯一事实与revision gate |
| 4 | FT-03 message target transaction + FT-08A durable intent/scoped fence | direct来源与intent必须同Authority事实闭环；同时关闭旧public surface |
| 5 | FT-07环6 Router policy/durable handoff | route terminal只创建FT-08A intent，不直接best-effort invoke |
| 6 | FT-08B execution lifecycle/retry/recovery + FT-07 availability reservation | busy与claim来自durable execution，不能先做静态readiness UI |
| 7 | FT-08C接FT-06 context、FT-07 gates、FT-10 tool permission | 最后收紧provider envelope、tool dispatch和所有race recheck |
| 8 | FT-13 sync/repair/restart集成 + FT-11 Settings | projection稳定后接live UI；repair registry贯穿此前各环，最后完成整体验收 |

FT-13不是仅在第8步出现：第2步拥有migration，第3至7步审阅event/outbox/repair descriptor，第8步完成跨feature真实恢复。FT-03不拥有Profile/Assignment，FT-07不拥有message transaction或execution lifecycle，FT-08不复制Room ACL。

## 15. TDD、质量门与回滚

每一环执行 RED → GREEN → REFACTOR：

- RED 必须先证明旧错误、权限越界或race可触发；
- GREEN 只实现该环closed contract；
- REFACTOR 后跑受影响package unit/type tests、AuthorityWorker SQLite tests、WS协议tests与选定real-worker E2E；
- `git diff --check`、Markdown相对链接扫描、Requirement ID对照、schema fingerprint检查为每个docs/production PR的固定门；
- migration PR另需真实predecessor upgrade、fault injection、restart、rollback/restore rehearsal；
- UI PR另需J-01/J-03/J-05逐状态、keyboard/focus/非颜色/aria-live/200%/840px/reduced-motion证据。

回滚只允许回滚reader/feature flag到仍理解新schema的安全版本；不得把已写Profile/Assignment降回可写legacy membership，也不得恢复public伪造surface、silent或Agent final cascade。安全缩减变更不因UI回滚而撤销。

## 16. 最终验收清单

- [ ] actor/Profile/Assignment、Profile ceiling/Assignment subset、participation/availability均为closed type并有type-test boundary；
- [ ] Tenant Administrator与Room ACL分离，跨Room内容读取负测通过；
- [ ] public invocation不能提交identity/kind/capability/tool/provider/model/origin，三种internal来源均有不可伪造证据；
- [ ] Router只按stable actorId、Assignment职责、availability、Goal/Ball事实，displayName metamorphic test通过；
- [ ] on-mention direct完整权限、no silent/no fallback/no final cascade、Goal/职责不足风险路由停止；
- [ ] Profile disable、Assignment remove、membership revoke、pause/noauth/busy在claim/model/tool/final各race fail closed；
- [ ] migration由FT-13从真实predecessor分配版本，static seed/backfill/restart/repair测试通过；
- [ ] FT-01/02/03/06/08/10/11/13 server-private seams无重复权威事实；
- [ ] Desktop J-01/J-03/J-05及全部错误/离线/repair/a11y状态通过；
- [ ] real-worker SQLite/WS E2E、Markdown链接、Requirement对照、diff检查通过；
- [ ] 没有多Provider/BYOK、第二DB/writer/bus、Agent login、任意shell/tool/URL或Blueprint改动；
- [ ] 交付说明不把T-0016当FT-07，也不在证据完成前宣称FT-07 implemented/verified。
