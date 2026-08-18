# FT-07 Agent Profile & Routing 生产工程设计

> 日期：2026-08-18
>
> 状态：设计冻结候选；仅定义生产工程合同，不代表已实现或已验证
>
> 基线：`origin/main@fb37f7a`，Authority schema 当前版本为 `13`；本文不修改 schema，也不预占后续版本号

## 1. 目的、权威来源与范围

本文把已批准 PRD 中 FT-07 的 Agent Profile、Room Assignment、availability 与可信路由语义冻结成可实施的服务端合同。它不是对已批准 PRD 的重新评审，也不把历史 T-0016 交付状态改名为 FT-07。

权威来源按仓库宪法排序：

1. [当前批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)与[evidence map](../reconstruction/agent-im-evidence-map.md)；
2. [identity / Room lifecycle](../protocols/identity-room-lifecycle.md)、[message ACK](../protocols/message-ack.md)、[authoritative sync](../protocols/authoritative-sync.md) 协议规范，以及已冻结的 [FT-03](2026-08-18-ft03-message-authority-design.md)、[FT-08](2026-08-18-ft08-invocation-runtime-design.md)、[FT-13](2026-08-18-ft13-sync-reliability-design.md)合同；
3. [UI / 交互设计入口](../design/README.md)与[Requirement 覆盖矩阵](../design/design-requirement-coverage.md)；
4. [批准 PRD 实施映射](2026-08-18-approved-prd-implementation-map.md)、生产代码与测试。

本文直接覆盖：`REQ-AGT-001`、`REQ-AGT-002`、`REQ-AGT-003`、`REQ-AGT-004`、`REQ-AGT-005`、`REQ-AGT-007`、`REQ-ID-004`、`REQ-MEM-011`、`REQ-NFR-006`、`REQ-PD-004`、`REQ-PRIM-004`、`REQ-PRIM-011`、`REQ-PRIM-013`、`REQ-UX-005`。交叉验收依赖 FT-01、FT-02、FT-03、FT-06、FT-08、FT-10、FT-11、FT-13，不在 FT-07 内重复拥有其事实。

范围内：

- Tenant Administrator、Global Agent Profile、per-Room Assignment 的权威边界；
- Agent actor/profile/assignment 的分离、权限交集、参与模式与 availability；
- direct、routed、project-boundary 三种调用的可信来源；
- Router 输入、停止条件、选择结果验证及 runtime recheck；
- AuthorityWorker 命令、查询、CAS、审计、事件、outbox、迁移与 repair 合同；
- Desktop Settings 所需 DTO、状态机、错误和无障碍合同。

范围外：多 Provider、BYOK、模型自动切换、Agent 登录、任意 shell、任意 tool、任意 URL、第二 DB、第二 writer、外部 event bus，以及 Blueprint 修改。FT-07 只使用 T-0041 已批准的单 Provider/单模型配置与 closed tool registry；新增工具或副作用语义必须由 FT-10 另行批准。

## 2. Requirement 与设计旅程映射

| Requirement | FT-07 冻结点 | 设计旅程 / 分区 | 可见事实来源 |
|---|---|---|---|
| `REQ-ID-004` | Tenant Administrator 仅管理全局 Profile、能力上限和部署凭据；不隐式读取 Room | J-01 / Settings 的部署管理入口 | administrator session + Profile query/ACK/event |
| `REQ-PRIM-004`、`REQ-PRIM-011` | Agent actor 是稳定身份；Profile 是全局配置；Assignment 是 Room 关系 | J-01 / Settings Agent 分配 | Authority projection |
| `REQ-PRIM-013`、`REQ-AGT-003`、`REQ-AGT-004` | `active/on-mention` 与 `ready/busy/paused/noauth` 分离；明确点名的 on-mention 获得 Assignment 内完整批准权限 | J-03 / @Agent 与 execution；Settings 状态 | target intent、Assignment、runtime projection |
| `REQ-AGT-001`、`REQ-AGT-002`、`REQ-AGT-005`、`REQ-AGT-007` | 多 Agent、可信内部路由、职责/Goal/Ball/availability 决策、风险路由停止条件 | J-03 / Agent 参与；J-05 / tool grant | server-private route snapshot 与 runtime gate |
| `REQ-MEM-011` | Agent Profile 与 Assignment 的安全变更可被审计和撤销 | Settings / 成员与 Agent 分区 | ACK + stable event + audit |
| `REQ-PD-004` | Profile/Assignment 只持有最小必要元数据，Room 内容不进入部署管理查询 | J-01 / Settings | capability-filtered query |
| `REQ-NFR-006` | 单 writer、CAS、重启推导、repair、real-worker SQLite/WS 验证 | J-07 repair；Settings repair 状态 | AuthorityWorker + sync/repair |
| `REQ-UX-005` | Human 邀请与 Agent 分配是两个独立流程 | J-01 / Settings | 独立 query、command、ACK |

J-01 显示 Room 内可见的 Agent Assignment 与必要的模型/Provider 披露，但不把 Tenant Administrator 变成 Room 成员。J-03 以 FT-03 的结构化 target 绑定稳定 `actorId`，并显示 execution/availability。J-05 只显示 Assignment 内批准的 tool subset 及 FT-10 的 grant/confirmation 结果。设计偏离：**无**。

## 3. 权威对象与边界

### 3.1 Tenant Administrator

Tenant Administrator 是 FT-01 显式 bootstrap 得到的部署级 Human principal。FT-07 只消费 FT-01 的 administrator/session 判定，不创设第二套登录，也不允许 Agent 建立 session。

Tenant Administrator 可以：创建、更新、禁用 Global Agent Profile；设置 Profile capability/tool ceiling；读取部署级 Profile 元数据；管理部署级单 Provider 凭据的就绪状态。它不能仅凭该身份读取任意 Room 的消息、sync、导出、上下文、Goal、Ball、成员名单或 Assignment 详情。若同一 Human 需要 Room 内容，必须另外以正常 Room membership 通过 Room ACL。

Profile 禁用需要 Authority 内部枚举受影响 Assignment 并执行安全撤销，但该内部能力不等于向管理员响应 Room 内容。部署级查询不得返回消息、Room 上下文、Room 名称或成员；最多返回不泄露 Room 事实的聚合健康信息。Room 级变更事件只投递给该 Room 的授权成员。

### 3.2 三层对象严格分离

| 对象 | 标识与生命周期 | 可写字段 | 不得承载 |
|---|---|---|---|
| Agent Actor | 稳定 `actorId`，由服务端创建；历史消息引用永久稳定 | 无面向客户端的运行字段 | displayName 路由、权限、readiness、Provider/model |
| Global Agent Profile | `profileId` 一对一绑定 `actorId`；部署级、revisioned | displayName、全局职责说明、closed capability ceiling、closed tool ceiling、enabled/disabled | Room 内容、Room 角色、participation、availability、凭据明文 |
| Room Assignment | `assignmentId` 绑定 `roomId + profileId/actorId`；Room 级、revisioned | Room 职责、`active/on-mention`、capability subset、tool subset、durable pause | Profile 上限、客户端写 readiness/busy/noauth、Human role |

同一 Room 对同一 Agent 最多一个 current Assignment。历史 Assignment、Profile revision 与 actorId 不物理删除，以保证消息、execution、audit 和 repair 可解释。`displayName` 只用于呈现；任何权限、target、路由和幂等键都使用稳定 ID。

### 3.3 Capability 与 tool 交集

`effectiveCapabilities = Profile.capabilityCeiling ∩ Assignment.capabilitySubset ∩ currentMembershipPolicy`。

`effectiveTools = Profile.toolCeiling ∩ Assignment.toolSubset ∩ FT-10 currentMembershipToolPolicy`。

集合均由 Core closed registries 定义，未知值 fail closed。Assignment 不得扩大 Profile 上限；Profile 缩减立即缩小所有有效 Assignment。Provider/model 是部署级单一配置，不进入 Assignment，也不能由客户端或 Router 选择。on-mention 仅限制自主参与；在 FT-03 已权威确认的明确点名调用中，它获得上述完整 `effectiveCapabilities/effectiveTools`，不能被旧的 `participation === active` 工具判断削成空集。

### 3.4 Participation 与 availability

`AgentParticipation` 是闭集 `active | on-mention`。`silent` 不再是合法生产状态。

`AgentAvailability` 是只读 projection：`ready | busy | paused | noauth`。客户端不能提交或修改 availability/readiness：

- `paused`：Assignment durable pause override；
- `noauth`：当前部署 Provider/credential readiness 不满足；
- `busy`：该 Assignment/Agent 存在 Authority 中 durable running execution；
- `ready`：Profile enabled、Assignment current、Room active、membership/tool policy 有效，且没有 paused/noauth/busy。

用于安全判断的是各独立 gate，而不是单个展示枚举。展示优先级冻结为 `paused > noauth > busy > ready`；Profile disabled、Assignment removed、membership revoked 或 Room archived 是 **ineligible/不再作为 current Assignment 展示**，不能伪装为某种可恢复 availability。重启时只读取 durable pause；busy 从 durable execution 重算，noauth 从部署凭据重算，ready 再由其余事实推导。内存缓存不得成为事实来源。

## 4. 可信 invocation 来源与 public/internal 分离

### 4.1 三种可信来源

| invocation | 唯一可信来源 | FT-07 消费的证据 |
|---|---|---|
| direct invocation | FT-03 在 Human message 同一 Authority 事务中创建的结构化 `message_target` / invocation intent | committed source message、target actorId、Assignment/profile revisions、Human principal |
| routed invocation | terminal RouteJob decision 经 Authority 校验后创建的 server-private `route_decision` origin | route job/idempotency、候选快照、Goal/职责/Ball/availability revisions |
| project-boundary invocation | 项目边界 owner 在其 Authority transaction 中创建的 server-private `project_boundary` origin | confirmed checkpoint/due/Blocker authority fact 与版本 |

public Human invocation surface 只提交用户意图，例如消息正文与结构化 mention token；不得提交或覆盖 Agent identity、route kind、capability、tool、Provider、model、内部 origin、authority snapshot 或 route judgment。管理 API 可以引用 `profileId/assignmentId` 来修改其有权管理的资源，但该引用不等于声明 runtime Agent principal；创建 Profile 时 actorId 由服务端生成。

旧 `agent.invoke { kind, targetAgentId, ... }` public WS frame 必须关闭。兼容期若保留 decoder，只能返回受版本化协议约束的 `410`/升级提示，不得转译为新调用。server-private capability 以不可从 JSON 反序列化的 branded token/worker port 表达；internal operations 不能进入 public protocol union、Desktop preload 或网络 frame。

### 4.2 Closed Core boundary

Core 必须分别暴露 closed types 与 exact-key guards：

- `AgentActorId`、`AgentProfileId`、`AgentAssignmentId` branded IDs；
- `AgentProfileStatus = enabled | disabled`；
- `AgentParticipation = active | on-mention`；
- `AgentAvailability = ready | busy | paused | noauth`；
- closed `AgentCapabilityId` 与既有 closed `ToolId`；
- `AgentProfileRecord`、`AgentAssignmentRecord`、`RoomAgentProjection`；
- `DirectInvocationOrigin`、`RouteDecisionOrigin`、`ProjectBoundaryOrigin` 仅存在于 server-private package；
- `RouteCandidateSnapshot` 明确含稳定 IDs、Profile/Assignment revision、职责、有效 subset、availability、Goal/Ball fact versions，不含可用于选择的 displayName。

每个 guard 拒绝未知 key、未知 enum、重复集合、非规范排序、空职责、越界文本与 client-supplied derived fields。Core type tests证明 public protocol 无法构造 internal origin、Profile subset 无法被赋给 Assignment 外部值、availability 无写命令、`silent` 编译与运行时均失败。

## 5. Router 决策合同

Router 只在 Authority 生成并版本化的快照上决策：稳定 `actorId`、current Assignment、Room 职责、有效 capability/tool subset、availability gates、Ball、Goal/项目事实与限定对话摘要。displayName 可在结果呈现时联接，不能进入 provider 选择提示、排序键、幂等键或 judgment 验证。

规则顺序：

1. direct target 由 FT-03 决定；若 Profile/Assignment/Room/membership 当前无效则显式 rejected，不自动换 Agent；
2. project-boundary 仅接受已确认 checkpoint、due 或 Blocker authority fact；
3. routed/proactive 先校验 Room active、Profile enabled、Assignment active participation、availability ready、职责匹配、有效能力和事实版本；
4. 风险/语义主动路由若缺少足够且健康的 Goal 与职责事实，必须停止并记录 suppression；不得用 displayName、闲聊猜测或陈旧 memory 补齐；
5. 确定性 due 触发只可使用健康的项目 authority fact，不进行无目的轮询；
6. provider 只能在 Authority 给定的候选 closed set 中返回 judgment，结果再次 exact-key/ID/revision 校验；
7. 同一 Agent/同一模型只允许有界重试；失败、busy、paused、noauth 均显式呈现，不自动换 Agent、模型或 Provider；
8. Agent final 不创建新的 route job，也不级联触发其他 Agent。

`on-mention` 不参与 routed/proactive 候选，但在明确 direct target 时通过同一完整权限交集。系统不存在 silent Agent。

## 6. AuthorityWorker 命令、查询与事务

### 6.1 命令与授权

部署级命令：`profile.create`、`profile.update`、`profile.disable`、`profile.enable`。它们要求 FT-01 current Tenant Administrator session、idempotency key 与 expected revision；create 由服务端生成 profileId/actorId。

Room 级命令：`assignment.create`、`assignment.update`、`assignment.pause`、`assignment.resume`、`assignment.remove`。它们要求 FT-02 current owner/admin authority、Room revision 与 Assignment expected revision。Room archived 时只允许 pause/remove 或能力缩减，不允许 create/resume/扩大权限。membership revoke 仍由 FT-02 拥有，FT-07 消费其安全事件。

每条成功命令在同一 SQLite transaction 内完成：读取 ACL 与 current revisions、验证 closed subset、CAS domain rows、写 immutable audit、append stable event、append outbox、写 idempotency result。冲突 `409` 不产生部分事件；已删除/过期资源 `410`；未认证 `401`；无权 `403`；容量 `429`；Authority 不可用 `503`。不得出现 DB commit 后再 best-effort 入队的事实缝隙。

Profile disable/ceiling reduction是部署级安全变更：全局 gate 在同一事务立即生效，并为受影响 Room 生成不含 Room 内容的 room-scoped reduction events/outbox；若 fan-out 超出已测试的事务上限，命令在写入前以 `429` fail closed，不做分批部分禁用。Room 用户只看到本 Room 的 Assignment 结果；Tenant Administrator 响应不获得 Room 内容。

### 6.2 查询与 projection

- Tenant Administrator Profile query：Profile 元数据、ceiling、status、revision、部署 Provider/model 披露与 credential readiness；无 Room 内容。
- Room Settings query：本 Room 的 current Assignment、允许展示的 Profile 摘要、职责、participation、effective subsets、availability 与 revisions；要求 current Room membership。
- Internal route/runtime query：固定 revision 的 server-private snapshot；不通过 public protocol。

read model 只能由 stable event/repair 推进。ACK 表示命令已被 Authority 接受并给出 revision；本地 pending 不得冒充 persisted。availability 更新由 runtime/authority event 或 repair 推进，不由表单乐观写入。

## 7. 撤销与 race matrix

所有 route selection、intent claim、model start/continuation、tool prepare、tool claim/dispatch、final commit 都重查 Profile revision、Assignment revision、membership access revision、Room status 与必要的 availability gate。recheck 失败使用 closed reason，绝不换 Agent/model。

| 变更 | route/queued intent | 已 claim、model 未开始 | model 已调用 | tool grant 未 claim | tool 已 dispatch | final commit / recovery |
|---|---|---|---|---|---|---|
| Profile disable/ceiling reduction | suppress/cancel；call count 0 | abort；call count 0 | 中止后显式 failed/interrupted，不重路由 | revoke/expire | 保留真实 outcome；不得伪称未执行 | 禁止新 Agent final；repair 解释终态 |
| Assignment remove | 同上，仅该 Room | 同上 | 同上 | revoke | 保留 outcome | current Assignment 不复活 |
| membership revoke / Room archive | purge Room 可见缓存并 cancel | abort | 中止；不得继续读 Room | revoke | 记录 outcome，按 FT-10 补偿合同处理 | 禁止越权 final；Room repair 收敛 |
| durable pause | 不新选、不 claim | abort | 中止或在安全检查点停止 | revoke | 保留 outcome | 显示 paused，不自动 resume |
| noauth | 不新选、不 claim | call count 0 | provider auth 失败显式终止 | 不 prepare | 已 dispatch outcome 必须落盘 | 重启仍从 credential 推导 |
| busy | 不做 routed/proactive 新选择 | 相同 Assignment 的 reservation CAS 冲突 | 当前 execution 继续 | 当前 execution 可按交集继续 | 当前 execution 可完成 | durable running 结束后重算 ready |

明确 direct invocation 遇 busy 返回显式 busy/queued-policy 结果；具体是否允许 bounded per-room queue 由 FT-08 冻结，但不能换 Agent。on-mention direct 的权限矩阵与 active direct 相同。任何 revision race 都必须在 provider/tool adapter 前证明 call count 0；dispatch 后必须优先保存真实 outcome/outcome_unknown，不能用撤销覆盖历史。

## 8. schema、backfill 与静态 seed 迁移原则

FT-13 是 schema migration owner。实施时只能从届时真实 predecessor 派生版本、checksum 与 fingerprint；本文不命名、不预占版本号。仍使用同一个 Authority SQLite、同一个 AuthorityWorker writer、既有 audit/event/outbox，不引入第二数据库或 event bus。

目标持久化至少要能表达 `agent_profiles` 与 `room_agent_assignments` 的稳定 ID、revision、status/subsets、durable pause、审计时间；actor 表只保留稳定 identity。Human membership 继续由 FT-02 的 canonical membership 管理。Agent Assignment 是 Agent 的 canonical Room 关系；不得同时维护第二份可写 Agent membership 真相。若迁移期需要兼容旧 `room_memberships(kind='agent')` reader，只允许由 Assignment 派生的只读兼容 projection，并有相等性测试与明确移除切片。

历史 backfill：

1. 每个 legacy static Agent actor 按原 actorId 创建一对一 Profile，保留 displayName；旧 actor 全局 tool permissions 迁为 Profile tool ceiling；未知 capability/tool 使迁移 fail closed；
2. 每个 legacy Agent room membership 创建 Assignment，tool subset 取规范化后且不超过 Profile ceiling 的交集，原 Room 关系与 configuredAt 可追溯；
3. legacy `active/on-mention` 原样迁移；legacy `silent` 不进入新闭集，保守迁为 `on-mention + durable paused + migration-review audit marker`，管理员显式复核后才能 resume，禁止自动扩大参与；
4. legacy actor `readiness` 不作为新事实迁移：pause 只从 Assignment durable override；busy 从 running executions；noauth 从 credential；其余重算；
5. backfill 记录 source schema、规范化差异与 hash，不伪造用户操作；重复运行幂等；中断回滚；损坏/歧义数据阻止启动并给出 repair 指引；
6. `registerActors` 静态启动 seed 改为仅允许首次 bootstrap/显式迁移输入，正常启动不能用进程 options 覆写 Profile、Assignment 或 readiness。

## 9. 重启、sync 与 repair

启动顺序：校验 schema/fingerprint → 装载 Profile/Assignment durable facts → 恢复 execution/claims → 由 Provider credential 推导 noauth → 从 running execution 推导 busy → 应用 durable pause → 生成 ready → 恢复 route/runtime queues。恢复期间相关 Assignment 对外呈现 loading/repair，不先显示 ready。

FT-07 在 FT-13 registry 注册两类 projection：部署级 `agent-profile`（仅 Tenant Administrator scope）与 Room 级 `room-agent-assignment`。Room repair record 包含 record kind/version、roomId、assignmentId、actorId、Profile/Assignment revisions、安全的 Profile 摘要、职责、participation、effective subsets、availability、access revision、updatedAt；不含 Provider secret、内部 origin、route prompt、任意其他 Room 数据。Profile disable/rename/ceiling change必须使受影响 Room event 或 repair 收敛。

cursor gap、未知 event、projection mismatch 或 restart derivation 未完成进入 repair；repair snapshot 经 AuthorityWorker/FT-13 read port 生成，Desktop 原子替换对应 projection。security reduction 可越过普通 backlog 优先触发缓存失效，但仍保留可审计事件顺序。offline 客户端不得继续展示可操作的旧 grants。

## 10. Desktop Settings 冻结状态

Settings 保持 Human 邀请与 Agent Assignment 两个模块。Tenant Administrator 的 Global Profile 管理只在部署权限成立时出现；Room owner/admin 只管理本 Room Assignment。旧本地演示表单、假 Agent catalog、同步 callback 和“已捕获配置”不算 ACK，不得进入生产状态。

Room Agent 列表展示 displayName、Room 职责、participation、availability 文本+图标、effective capability/tool subset、Provider/model 披露。Profile ceiling 与 Assignment subset 分层标注；无权用户只读。`paused/noauth/busy` 必须有非颜色文字；disabled/removed 不作为 current 可用项。

| 状态 | UI 行为与事实来源 |
|---|---|
| loading | skeleton/进度文本；projection 未就绪，不显示 ready |
| empty | “尚未分配 Agent”；有权限显示添加按钮，无权限仅说明 |
| pending ACK | 仅本地 transient，控件防重复提交；不修改 stable badge |
| `401` | session 失效，保存焦点上下文后进入 FT-01 re-auth |
| `403` | 保留只读事实并说明权限不足；不隐藏已发生的失败 |
| `409` | revision 冲突，拉取 current projection，展示差异并要求重试 |
| `410` | Profile/Assignment 已失效，移除编辑态并回到 current list |
| `429` | 保留输入，显示 retry-after；不自动提交 |
| `503` | 保留输入，说明 Authority/Provider 暂不可用；不换模型 |
| offline | stable projection 可只读，所有 mutation 禁用并标记可能过期 |
| repair | 局部锁定 Agent Settings，显示修复进度；成功后原子替换并恢复焦点 |

键盘：全部列表、下拉、checkbox、pause/remove、重试可由 Tab/Shift+Tab/Enter/Space 操作；弹层打开焦点到标题或首个错误，关闭返回触发器；错误后焦点到错误摘要，再可到字段。状态不只靠颜色，图标有可访问名称。ACK、错误、availability/repair 终态用节制的 `aria-live` 通告，stream preview 不进入 live region。200% zoom 下无水平截断或控件覆盖；Desktop 最小宽度 840px 时列表可换行/分区，不把关键操作放到 hover。reduced motion 下取消 shimmer、位移动画与持续旋转，以静态进度文本替代。

## 11. 历史实现审计

### 11.1 T-0016 可复用机制

[T-0016 计划](2026-08-17-t0016-route-runtime-implementation-plan.md)与[交付](../deliveries/T-0016-四层发言判定与单次路由架构-交付说明.md)中的以下机制可经新合同包裹后复用：每 message 单 RouteJob、Authority 持久化状态机/CAS、per-Room FIFO 与全局 bounded concurrency、closed judgment guard、summary-only Provider input、`store:false`、server-only secret、有界同 Agent/同模型重试、terminal judgment 与 recovery 测试结构。

不可直接继承：`silent`、正文 regex 点名、structured help/risk/domain 仅靠旧 actor snapshot、用 `display_name AS role`、用 actor 全局 permissions 当 route capabilities、忽略 availability/Goal/Assignment revision、客户端可选 routed kind，以及 route terminal 后 best-effort `invoke`。这些都是历史 T-0016 行为，不是 FT-07 权威语义。

### 11.2 T-0041 可复用机制

[T-0041 设计](2026-08-12-t0041-agent-runtime-design.md)、[计划](2026-08-17-t0041-agent-runtime-implementation-plan.md)与[交付](../deliveries/T-0041-真实Agent运行时模型供应商与工具权限-交付说明.md)可复用：单 Provider adapter、server-only credential、closed tool descriptors/adapters、tool prepare/claim/settle、side-effect confirmation、outcome_unknown、checkpoint、bounded scheduler 与 real-worker 测试方式。

必须修正：当前 actor readiness/static tool permissions、`active` 才能 read/claim tool、public intent 携带 target/kind/provider/model、model/claim/tool 各阶段 recheck 不完整。FT-07 不扩大现有 fixed-origin read tool、fixed-binary repository tool 或 sandbox adapter，也不新增任意 shell/tool/URL。

### 11.3 当前实现必须关闭的缝隙

- `AgentActor` 同时承载 identity、readiness、tool permissions，启动 `registerActors` 又把静态 options 当事实；拆成 actor/Profile/Assignment 并迁移 seed；
- `room_memberships` 的 Agent participation/tool permissions 与 Profile 上限混杂；改为 Assignment canonical truth；
- public `agent.invoke` 可伪造 `kind/targetAgentId`，route/runtime worker operation 可携带 provider/model；public decoder 删除，内部 origin capability 与部署配置 server-side 注入；
- route snapshot 用 displayName/actor permissions，不用职责、Goal、Assignment/availability；替换为 revisioned snapshot；
- on-mention 的 direct execution 当前得不到 tool context/claim；按有效交集放行；
- runtime Agent final 当前通过 `onMessageCommitted` 再通知 Router；删除该级联，只允许 Human fact 或已批准 project boundary 创建 route；
- route terminal 后 runtime handoff 是 best-effort；由 FT-08A durable intent/outbox 接管并可恢复。

## 12. 跨 FT server-private seams

| Owner | FT-07 只消费/提供的 seam |
|---|---|
| FT-01 | 消费 Tenant Administrator bootstrap/session/revocation；不建 Agent login。Profile command 只接受 current administrator context |
| FT-02 | 消费 owner/admin、membership access revision、Room archive security-reduction；提供 Assignment mutation authorization request，不复制 ACL |
| FT-03 | 提供 stable Agent resolution、Assignment eligibility/revision；消费同事务 message target/direct intent，不解析正文 regex |
| FT-06 | 消费版本化 Goal/职责/上下文健康度与最小 provider envelope；缺失/陈旧时风险路由停止 |
| FT-08 | 提供 Profile/Assignment/availability gate 与 trusted origin validator；FT-08 拥有 durable intent、execution、claim/retry/recovery |
| FT-10 | 提供 Profile ceiling/Assignment subset；FT-10 拥有 membership tool policy、grant/confirmation/dispatch/revocation |
| FT-11 | 提供 Settings DTO、ACK/event/reducer 状态合同；FT-11 拥有真实 transport/IPC/controller 与最终 UI integration |
| FT-13 | 提供 projection/repair descriptor 与 backfill invariants；FT-13 拥有 migration version、registry、cursor/outbox/cache 集成 |

以上 seam 均为 server-private port 或 capability。任何内部 origin、Provider secret、authority snapshot、membership content 不得穿过 public WS。

## 13. 冻结结论

实施必须同时证明：三层权威分离；public/internal capability 分离；稳定 actorId 路由；Goal/职责不足时风险主动路由停止；无 silent/自动换 Agent/自动换模型/final 级联；on-mention direct 完整授权；管理员不越权读 Room；所有安全变更在 route/claim/model/tool/final 阶段 fail closed；重启、event、repair 与 Settings 状态来自 Authority。任何偏离必须回到对应 Requirement、协议或正式设计稿取得 owner 决策，不能用旧 T-0016/T-0041 行为覆盖。
