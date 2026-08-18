# 《原生人机协作 IM 产品 PRD｜证据重建版 v0.1》

> 文档状态：**已批准产品定义基线（证据重建版）**  
> 原始 PRD：已遗失  
> 重建依据：《PRD 细节确认清单 v1》及其逐项访谈记录  
> 阶段二批准：owner 于 2026-08-18 明确回复“我确认《PRD 细节确认清单 v1》内容完整且准确，批准进入 PRD 编写阶段”  
> 产品基线批准：owner 于 2026-08-18 明确回复“批准该 PRD 成为新的产品定义基线”  
> 当前效力：本文自该批准起成为当前产品定义基线。`.reconstructed` 保留用于证据来源追踪；本次批准不自动修改代码、测试、任务、里程碑或 Blueprint must docs。
> 配套设计基线：[Agent IM 设计基线索引](../design/README.md)；[UI 交互设计正式审阅稿](../design/2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.reconstructed.html)。该设计稿于 2026-08-18 交稿，作为 FT-16 对本文 Requirement 的 UI / 交互映射，不反向改写产品语义或服务端事实合同。

## 1. 文档身份、证据规则与批准记录

原始 PRD、原桌面设计稿和交互原型无法从现存资料完整恢复。本文不是对遗失文字的伪造还原，而是把三类证据合并为一份可审核规格：

- **A｜已恢复或已批准决策**：现存权威计划/协议/交付记录可直接证明，或 owner 在访谈与最终清单中明确批准。
- **B｜实现反推**：当前代码确实如此，但只用于说明现状和差距，不自动成为长期产品要求。
- **C｜待确认提案**：本稿不得包含未获批准的 C 类规范。
- **D｜未知**：本稿不得用经验补齐 D 类信息；若发现新的关键 D，必须停止写作并回到确认阶段。

本稿中的全部规范性 Requirement 均以 owner 批准的 A 类决定为依据。当前实现、测试和历史蓝图的 B/A-history 证据与冲突，集中记录于配套的 `agent-im-evidence-map.md`。历史材料中与当前批准清单冲突的规则，以当前 owner 决定为准。

### 1.1 本稿不得自行改变的硬约束

1. 产品核心是多个 Human 在真实项目群聊中持续调用、共同使用 Agent；不是单人 Agent Chat，也不是 IM 加 Bot。
2. 先交付可真实使用的 MVP，再让 2–3 名 Human 与 Agent 推进一个真实项目，并从实际反馈迭代；人工构造实验和数字门禁不得阻塞 MVP。
3. Room 全量内容无损保存，但每次模型调用只编译重要记忆、来源索引、触发内容与必要原文；Agent 可按索引检索完整上下文，禁止把“全量可用”误写成“每次无脑塞入全量原文”。
4. Human 与 Agent 是不同身份；`@Human` 是待对方接受的 Request，`@Agent` 是一次真实 invocation。
5. 项目推进必须由 Goal、Decision、NextAction、Blocker/OpenQuestion 与 Ball/NeedsAction 形成轻量闭环；不能只有聊天正文里的口头承诺。
6. 读操作可以自动执行；任何外部副作用必须逐次、精确参数绑定地由 Human 确认。主动 Agent 只能提出副作用建议。
7. MVP 是 Electron Desktop-first、macOS 必须支持、单租户私有部署；Web、原生移动端、OS push、全局搜索和完整 Blueprint 接入均不作为 MVP 前置。
8. 本稿已获批为产品定义基线，但该批准不是对代码、测试、现有 Blueprint、任务验收或里程碑状态的修改授权。

### 1.2 后续任务代码

| 代码 | 后续任务包 | 主要产物 |
| --- | --- | --- |
| FT-01 | Identity & Session | Account/Human/Agent/Session/Tenant Administrator、邀请、多设备与撤权合同 |
| FT-02 | Room Governance | Room 生命周期、角色、所有权转移、归档/重开与离群清理 |
| FT-03 | Message Authority | 消息、结构化 mention/reply、修订/撤回、ACK、history/realtime |
| FT-04 | Attachment Pipeline | 上传、哈希、预览/下载、提取/OCR 与 AI 可见性 |
| FT-05 | Room Memory | 全量 corpus、memory steward、五类记忆、确认与争议 |
| FT-06 | Context Compiler | watermark、raw delta、检索、引用、token 预算与冻结 snapshot |
| FT-07 | Agent Profile & Routing | Global Profile、Room Assignment、participation/readiness 与可信路由 |
| FT-08 | Invocation Runtime | invocation 状态、并发、重试、抢占、恢复与失败表达 |
| FT-09 | Project Loop | Goal、Decision、Request、NextAction、Blocker 与 Ball |
| FT-10 | Tool Safety | 工具闭集、读/副作用分级、确认、dispatch 与 outcome_unknown |
| FT-11 | Live Desktop | 登录、Room-first IA、服务端/WS/cache/IPC 真接线 |
| FT-12 | In-app Notifications | 持久通知中心、room badge、去重、状态与深链 |
| FT-13 | Sync & Reliability | SQLite authority、outbox、sync/repair、离线缓存与恢复 |
| FT-14 | Privacy & Operations | Provider 披露、日志/secret、导出、诊断、数据保留与离线租约威胁模型/上限 |
| FT-15 | Real-project Pilot | 2–3 Human 真实项目试用、观察指标与反馈闭环 |
| FT-16 | Design Contract | 桌面信息架构、核心旅程、状态/故障原型与可访问性标注 |

## 2. 产品定义、目标用户与成败边界

### 2.1 一句话定义

原生人机协作 IM 是一个以真实项目 Room 为协作现场的桌面通信产品：多个 Human 在正常群聊中持续调用具备不同职责与工具的 Agent；系统把消息沉淀为可追溯的群体记忆和轻量项目事实，使 Human 与 Agent 能共同获得信息、形成决策、分派行动、处理阻塞并推动项目。

### 2.2 规范性需求

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-PD-001 | 产品必须以“多个 Human 在同一个真实项目群聊中持续与 Agent 协作”为核心，不得退化为单人 Agent Chat、聊天壳或传统 IM 中的被动 Bot。 | A | PD-001、PD-002 | 2–3 名 Human 能在同一 Room 中互相沟通并分别调用 Agent；Agent 能引用共享项目上下文。 | 产品只能由一个人问答，或 Agent 看不到其他参与者的项目交流。 | Product、Core、Desktop、Server | FT-11、FT-15 |
| REQ-PD-002 | 当前阶段必须先形成可完成真实项目的 MVP，再以真实使用反馈持续迭代。 | A | PD-002、PD-004、MVP-001 | MVP 能被目标用户安装、登录、入群并完成一次端到端项目协作；后续优先级有真实反馈来源。 | 团队因未通过人工实验或固定数值门禁而不允许交付 MVP。 | Product、Roadmap、Analytics | FT-15 |
| REQ-PD-003 | 产品发现必须来源于使用现有 MVP 的真实体验；不得把脱离真实产品和真实项目的人工实验设为前置 go/no-go。 | A | PD-003、PD-004 | 反馈条目可追溯到真实 Room、旅程或失败；实验仅用于解决已观察到的问题。 | 先设计与核心旅程无关的实验，再据此冻结产品方向。 | Product、Research、Roadmap | FT-15 |
| REQ-PD-004 | MVP 目标用户必须是共同推进同一项目的 2–3 名 Human，以及一个内置 memory steward 和至少一个普通 participant Agent；架构支持增加 Agent，但不设固定数量门禁。 | A | PD-002、AG-001、FCV1-PILOT | 真实试点至少覆盖两个 Human 身份、一个 steward 与一个 participant Agent；增配 Agent 不需改变 Room 模型。 | 只有 1 Human + 1 Agent 的演示被宣称完成多人协作验证，或要求固定 ≥4 Agent 才能开始。 | Product、Core、Desktop | FT-07、FT-15 |
| REQ-PD-005 | 产品成功表现为真实项目中信息可追溯、决策可确认、责任可推进、Agent 调用可完成且噪音可控；失败表现为共享上下文失真、责任悬空、Agent 假调用/假完成或协作成本高于收益。 | A | PM-001、PD-001、FCV1-METRIC | 试点能用本稿第 13 节指标与定性访谈给出上述各维度证据；指标不作为首轮硬门禁。 | 只统计消息数或模型调用数就宣布产品成功。 | Product、Analytics、Operations | FT-15 |

### 2.3 Goals

- 让 Human 在原本就要进行的项目沟通里直接获得 Agent 的信息、分析、决策辅助和执行能力。
- 让 Room 形成可追溯、可按需检索的共享记忆，而不是依赖某个人维护孤立文档或每次重新解释背景。
- 把确认后的目标、决策、下一步、阻塞与责任显式化，使 Agent 能持续协助推进项目。
- 在服务端权威、最小权限、Human 确认和可恢复故障语义下，让 Agent 的运行和工具使用可信可控。
- 尽快完成 Desktop MVP，投入一个真实项目，再依据真实反馈演进。

## 3. 用户、身份、Room 与权限

### 3.1 概念模型

| 概念 | 定义 |
| --- | --- |
| Account | 可登录的 Human 账户；MVP 使用邀请绑定的密码账户。Agent 没有可交互登录账户。 |
| Human | 真实协作者；通过 Account/Session 被认证，在 Room 中拥有 owner/admin/member 角色。 |
| Agent | 服务端运行的协作者；拥有 Global Agent Profile，并通过 Room Assignment 加入 Room。 |
| Actor | Human 与 Agent 的封闭并集；身份类型不可互换。 |
| Session | Human 在一个设备上的可独立撤销认证会话；多个设备各有独立 session family。 |
| Tenant Administrator | 单租户部署级 Human principal；由 owner 控制主机上的显式 bootstrap 配置产生，管理 Global Agent Profile、全局能力上限与 Provider credential，但不是 Room 角色，也不因此获得任何 Room 内容访问权。 |
| Room | 一个项目的权威群聊和项目事实边界；MVP 中一个 Room 对应一个 Project。 |
| Global Agent Profile | Agent 的稳定身份、名称、职责、能力和全局工具上限。 |
| Room Assignment | Agent 在特定 Room 的 participation、房间职责、工具子集与可用状态。 |

### 3.2 规范性需求

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-ID-001 | Human 与 Agent 必须是可见且不可伪造的不同 Actor 类型；作者身份由服务端认证 principal 或内部 Agent capability 注入，客户端不得自报 authorKind/authorId。 | A | HUM-001、ROLE-001 | 伪造作者字段的帧被拒；时间线、项目对象和审计均可区分 Human/Agent。 | Human 通过 payload 把自己的消息落成 Agent 消息。 | Core、Protocol、Server、Desktop | FT-01、FT-03 |
| REQ-ID-002 | MVP 仅允许 Human 使用邀请绑定的密码账户登录；每台设备建立独立、可查看并可撤销的 session family。 | A | FCV1-AUTH | 两台设备可同时登录；撤销其中一个 session 不影响另一个；Agent 无登录入口。 | 一个 refresh token 在所有设备共享，撤销手机同时误登出桌面。 | Auth、Server、Desktop | FT-01 |
| REQ-ID-003 | Human 入群必须经定向邀请、登录披露和显式接受；接受后可见 Room 全历史。Agent 不走 Human 邀请，而由有权限的 Human 配置加入。 | A | ROOM-002、HUM-001、PRIV-001 | 非受邀账户不能接受邀请；接受页说明全历史与 AI 可见性；Agent 配置不生成 Human invite。 | Agent 通过注册链接加入，或 Human 接受前不知会暴露历史。 | Auth、Room、Desktop | FT-01、FT-02、FT-16 |
| REQ-ID-004 | Agent 必须由 Global Agent Profile 与 Room Assignment 两层组成；房间权限只能是全局能力的子集，名称变更不得改变稳定 actorId。Global Profile 仅能由认证的 Tenant Administrator 经服务端管理命令创建/更新/停用；每次变更耐久审计且不赋予该 administrator 隐式 Room 读取权。 | A | AGP-001、AG-001、FCV1-DEPLOY、PRIV-001 | 同一 Agent 可在不同 Room 获得不同职责/工具子集；越过全局能力的房间授权被拒；非 Tenant Administrator 的 profile mutation 被拒；管理员不加入 Room 时仍不能读 Room corpus。 | 用 displayName 当路由 ID，改名后旧 mention 失效；或 Room owner 借设置 assignment 擅自扩大 Global Profile。 | Core、Auth、Server、Desktop、Audit | FT-01、FT-07、FT-14 |
| REQ-ID-005 | 移除或离开的 Human/Agent 必须立即失去该 Room 的服务端读取、订阅、同步和执行权限；在线设备收到撤权后立即清除 Room cache。纯离线设备无法接收远端撤权，因此缓存解密权必须受有限、正值且由服务端签发的本地离线授权租约约束；部署必须配置 `maxOfflineReadLease`，客户端不得上调或选择“永不过期”，最晚在租约到期时锁定，并在下一次联网鉴权时先清除再允许进入。具体默认值与允许上限由 FT-14 威胁模型在发布前冻结。 | A | PRIV-001、FCV1-OFFLINE | 撤权后旧 token/WS/cursor 不能访问 Room；在线设备删除缓存；离线设备不能取得超过服务端 `maxOfflineReadLease` 的租约，到期即无法解密；缺少或非法 lease policy 时服务 fail closed；联网时在展示任何 Room 内容前完成撤权核验与清除。 | 允许客户端自行签发十年租约，或声称可离线阅读无限期缓存，同时承诺服务端能在设备永久断网时瞬时遥控删除。 | Auth、Server、Sync、Desktop、Security | FT-01、FT-13、FT-14 |
| REQ-ROOM-001 | 一个 Room 必须对应一个 Project，并始终最多有一个 active primary Goal；Room 是消息、记忆、项目对象和 Agent 权限的共同边界。 | A | ROOM-001、GOAL-001 | 新建 Room 后可设置唯一 active Goal；不同 Room 的数据/工具授权不可串用。 | 同一 Room 同时出现两个互相冲突的 active primary Goal，或检索串到其他 Room。 | Core、Server、Desktop | FT-02、FT-09 |
| REQ-ROOM-002 | Human membership 角色为 owner/admin/member；Room 必须始终恰有一个 owner。owner 管理治理与 admin，admin 管理 member 与普通 Agent 设置，admin 不得移除或降级同级 admin。 | A | GOV-001、ROLE-001 | 权限矩阵穷举通过；不能移除唯一 owner；admin 对 peer admin 操作被拒。 | admin 移除另一 admin，或最后 owner 离开后 Room 无 owner。 | Core、Server、Desktop | FT-02 |
| REQ-ROOM-003 | owner 离开前必须转移所有权；任何成员离开/被移除前，其 active Request、NextAction、Blocker、确认与待验收责任必须完成、转交或显式升级。 | A | GOV-001、TASK-002、BLOCK-001 | 有未处置责任时 leave/remove 返回可行动的冲突清单；转交后才成功。 | 责任人被移除后任务永远卡住且 UI 静默。 | Core、Server、Desktop | FT-02、FT-09 |
| REQ-ROOM-004 | active Room 可被 owner/admin 归档；归档后业务只读并冻结 Agent、memory steward、业务通知升级、项目状态变更与 deadline/reviewAt 等**业务 timer**；owner/admin 可审计地重开。冻结业务 timer 表示保留归档时剩余时长，重开时顺延未终结 deadline/reviewAt。认证/租约/confirmation/tool grant 等安全有效期不得因归档延长；archive 事务必须把尚未 dispatch 的 pending confirmation 记为 `rejected(room_archived)`、撤销 grant并收敛 execution。归档不阻止 session revoke、member/Agent remove、capability/grant reduction 等降低访问权的安全治理命令；这些命令必须审计且不得唤醒 Agent、steward、业务 timer 或通知升级。 | A | ROOM-002、GOV-001、FCV1-RETENTION、TOOL-001、PRIV-001 | archive 幂等；归档后发送/新执行/项目计时均暂停；未 dispatch 确认不可执行；归档状态仍能立即撤销 session/成员/Agent；重开后业务定时边界从冻结点继续。 | 必须先重开 Room 才能移除泄露账户；把 confirmation 冻结一年后重开仍可写文件；或已 dispatch 副作用被伪称撤销。 | Auth、Server、Runtime、Security、Desktop | FT-01、FT-02、FT-10、FT-13 |

### 3.3 权限矩阵

Tenant Administrator 是部署级 principal，不属于下表的 Room membership role。MVP 由 owner 控制主机上的显式 bootstrap 配置建立至少一个 Tenant Administrator；后续变更走认证的服务端管理命令、不得删除最后一个 administrator、必须写不可变审计。它只能管理 Global Agent Profile、全局 capability ceiling 与 Provider credential；除非另有普通 Room membership，否则不能 history/sync/export/context/query 任何 Room。

下表是 `REQ-ROOM-002`、`REQ-ROOM-003`、`REQ-ID-003`、`REQ-ID-004` 与工具需求的 Room 级展开，不新增独立权限决定。

| 动作 | owner | admin | member | Agent |
| --- | --- | --- | --- | --- |
| 查看 active/archived Room（仍为成员） | 允许 | 允许 | 允许 | 仅 active Room 且 assignment 有效 |
| 发送 Human 消息 | 允许 | 允许 | 允许 | 不适用 |
| 邀请/移除 member | 允许 | 允许 | 不允许 | 不适用 |
| 设置/移除普通 Agent assignment | 允许 | 允许 | 不允许 | 不允许 |
| 任命/降级 admin | 允许 | 不允许 | 不允许 | 不允许 |
| 移除 peer admin | 允许 | 不允许 | 不允许 | 不允许 |
| 转移 ownership | 允许，目标须为当前 Human member | 不允许 | 不允许 | 不允许 |
| 归档/重开 Room | 允许 | 允许 | 不允许 | 不允许 |
| 提议 Decision/责任/期限/承诺 | 允许 | 允许 | 允许 | 允许提出 |
| 确认普通项目提议 | 仅在满足 §8.2 对象 principal 时 | 仅在满足 §8.2 对象 principal 或兜底条件时 | 仅在满足 §8.2 对象 principal 时 | 不允许自行替 Human 确认 |
| 治理冲突兜底确认 | 允许 | 无 owner 时不可代替所有权动作 | 不允许 | 不允许 |
| 执行 read-only tool | 不适用 | 不适用 | 不适用 | assignment 授权内自动执行 |
| 执行 side-effect tool | 仅作为 §8.2 指定确认 principal 时逐次确认 | 同左；role 本身不产生确认权 | 同左；role 本身不产生确认权 | 仅在精确确认后执行 |

## 4. “十四条 IM 原语”的证据重建结果

历史蓝图要求“十四条原语”，但现存证据无法恢复其完整名称、顺序与 P-01～P-14 映射。owner 已在《PRD 细节确认清单 v1》中明确批准：**不再把无法恢复的固定十四条设为门禁，也不由 AI 猜补；改为完整列出本次逐项确认得到的 18 个产品原语。** 下列编号是本次重建的稳定追踪编号，不声称是遗失 PRD 的原编号。

| Requirement ID | 需求文本（重建原语） | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-PRIM-001 | **Actor 分治**：Human 与 Agent 共同在场，但认证、权限、作者身份与视觉语义不同。 | A | HUM-001、ROLE-001 | 同一时间线清晰辨认两类 Actor，服务端拒绝跨类型伪造。 | 两类消息共用无法辨认的模板或身份字段。 | Core、Server、Desktop | FT-01、FT-16 |
| REQ-PRIM-002 | **Account 与 Session**：只有 Human 登录；多设备 session 可独立撤销并驱动缓存锁定/清理。 | A | FCV1-AUTH、PRIV-001 | 多设备撤权与缓存行为通过端到端测试。 | Agent 出现密码登录，或撤销后仍能读缓存。 | Auth、Sync、Desktop | FT-01、FT-13 |
| REQ-PRIM-003 | **Room 即 Project**：Room 同时承载通信、记忆、项目事实与 Agent assignment。 | A | ROOM-001、GOAL-001 | 所有对象都绑定 roomId，跨 Room 访问 fail closed。 | 项目面板与聊天属于不同无关联边界。 | Core、Server、Desktop | FT-02、FT-09 |
| REQ-PRIM-004 | **Human 邀请 / Agent 配置**：Human 显式接受邀请，Agent 由 owner/admin 配置加入。 | A | ROOM-002、AGP-001 | 两条加入流程与审计记录分离。 | Agent 获得 Human invitation token。 | Auth、Room、Desktop | FT-01、FT-07 |
| REQ-PRIM-005 | **Room 治理**：唯一 owner、owner/admin/member 权限、责任清理、归档与审计重开。 | A | GOV-001、ROOM-002 | 权限和生命周期状态机全部可证伪测试。 | 房间无 owner 或归档后仍可写。 | Core、Server、Desktop | FT-02 |
| REQ-PRIM-006 | **权威消息**：服务端注入作者、durable ACK、history/realtime 同源、稳定排序与去重。 | A | MSG-001、MSG-002、FCV1-RELIABILITY | commit 后重试不产生第二条，重连视图一致。 | ACK 成功但重启后消息消失。 | Protocol、Server、Sync、Desktop | FT-03、FT-13 |
| REQ-PRIM-007 | **主时间线引用回复**：reply-to 绑定稳定 messageId 并留在主时间线，不发展完整 Thread。 | A | MSG-003、FCV1-NONGOAL | 点击引用定位原消息；原消息撤回时仍显示安全 tombstone。 | 引用靠复制正文，编辑后无法追溯。 | Core、Server、Desktop | FT-03、FT-16 |
| REQ-PRIM-008 | **Human 修订 / Agent 更正**：Human 可版本编辑与撤回；Agent final 不可改，只能追加关联更正。 | A | MSG-002、MSG-003 | history/sync/memory 对 revision/tombstone 一致；Agent 原消息保留。 | UI 显示撤回但 Agent context 仍读取旧原文。 | Core、Server、Memory、Desktop | FT-03、FT-05 |
| REQ-PRIM-009 | **附件**：图片和常见项目文件以哈希、元数据和来源进入 Room，可预览/下载并供 AI 提取/OCR。 | A | FCV1-ATTACHMENT | 上传后跨设备一致；Agent 引用附件来源；恶意/超限文件安全失败。 | 只在本地显示文件名，服务端和 Agent 看不到内容。 | Protocol、Storage、Memory、Desktop | FT-04 |
| REQ-PRIM-010 | **`@Human` Request**：结构化寻址产生待目标 Human 接受的请求，接受前不形成其责任。 | A | HUM-001、REQ-001 | 目标可接受/拒绝/转交；同名成员无歧义。 | 文本里出现 `@名字` 就自动把责任压给对方。 | Core、Server、Desktop | FT-03、FT-09 |
| REQ-PRIM-011 | **`@Agent` Invocation**：结构化寻址必须创建真实 execution，而不是视觉上假装已调用。 | A | INV-001、INV-002 | 可观察 accepted→running→终态；失败有稳定错误和恢复动作。 | UI 显示“已发送给 Agent”，服务端没有 execution。 | Core、Runtime、Desktop | FT-07、FT-08 |
| REQ-PRIM-012 | **Agent 执行在场**：用户可见 accepted、running、completed、failed 与 cancelled；selected/queued/waiting_confirmation/retrying 等是映射到前述产品态的内部子态/动作，preview 非权威。 | A | INV-003、FAIL-001 | 每次执行恰有一个终态；cancelled 与 failed 语义/指标分离；只有 final commit 进入历史。 | `will_respond` 被展示成保证答复，失败后永久 spinner，或 Human 取消被算成系统失败。 | Core、Runtime、Sync、Desktop | FT-08、FT-16 |
| REQ-PRIM-013 | **Agent Participation 与 Availability**：assignment 只有 active/on-mention；无 silent 产品档位，paused/noauth/busy 是可用状态。 | A | AG-001、INV-003 | on-mention 不主动插话但被点名时保留完整工具；paused 不进入新执行。 | on-mention 被点名后工具为空，或 silent 档长期吞掉显式调用。 | Core、Router、Runtime、Desktop | FT-07、FT-08 |
| REQ-PRIM-014 | **Room Memory**：steward 把全量 corpus 编译为五类重要记忆和消息索引；Agent 按需检索原文。 | A | CTX-001、CTX-002、MEM-001～004 | 旧决策可经记忆引用回到原消息；每次调用不发送全量原文。 | 第 65 条后历史永久遗失，或每次都无脑发送全历史。 | Memory、Server、Runtime、Desktop | FT-05、FT-06 |
| REQ-PRIM-015 | **Goal 与 Decision**：Room 有一个 active primary Goal；Decision 由提议、Human 确认及 supersede 形成权威链。 | A | GOAL-001、DEC-001 | 当前 Goal 唯一；每个 confirmed Decision 有确认者和来源。 | Agent 在正文说“已决定”就直接成为权威事实。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRIM-016 | **NextAction**：显式责任、期限、交付和验收；Human/Agent 均可成为 owner，Agent 责任须 Human 确认与验收。 | A | ACT-001、TASK-001、TASK-002 | 完整生命周期与重分配/重开通过状态机测试。 | Agent 自己创建、认领并验收自己的任务。 | Core、Server、Runtime、Desktop | FT-09 |
| REQ-PRIM-017 | **Blocker 与 Ball/NeedsAction**：阻塞有单一 owner 和升级语义；Ball 是责任投影，到期驱动提醒或 active Agent。 | A | BLOCK-001、PM-001 | 转交后 holder 更新；到期在安静 Room 也产生一次有界动作。 | owner 离群后 blocker 静默悬空，或到期只能等下一条聊天。 | Core、Server、Runtime、Desktop | FT-09、FT-12 |
| REQ-PRIM-018 | **Tool 安全**：read-only 自动；side effect 每次精确确认并有 unknown-outcome 语义。 | A | TOOL-001、PRIV-001 | 改参数、重复确认、撤权后的调用全部失败；未知结果不自动重试。 | 一次“永远允许”授权让 Agent 后续任意写文件。 | Runtime、Server、Desktop | FT-10 |

## 5. 消息、寻址、附件与实时语义

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-MSG-001 | `message.accepted` 只表示身份、成员资格与内容校验通过且消息已耐久提交；不得暗示其他客户端已收到、memory 已更新或 Agent 已回答。若消息带结构化 mention，同一事务还必须为每个 target 持久化 Request/invocation intent 或稳定 rejected outcome；单个 target 因并发撤权失效不丢弃 Human 消息，而作为逐 target rejection 返回，其他合法 target 独立 accepted。 | A | MSG-001、FCV1-RELIABILITY、INV-002、REQ-001 | commit 后、ACK 前故障并重试，返回同一 message/event/target outcomes；message commit 与 N 个 handoff 无丢失窗口；异步 worker 失败不推翻 message accepted。 | UI 在消息仅入库时显示“Agent 已处理完成”；或消息已含 @ 但 crash 后既无 intent 也无 rejection。 | Protocol、Server、Desktop、Persistence | FT-03、FT-08、FT-13 |
| REQ-MSG-002 | history、realtime、sync 与 repair 必须来自同一服务端权威事实；客户端以稳定 messageId/eventId 去重并按服务端序列收敛。 | A | MSG-001、MSG-002、FCV1-RELIABILITY | 并发发送、断线重连、重复 outbox 与 repair 后，各客户端得到相同顺序且无可见重复。 | 同一消息重投两次就在时间线显示两条，或 history 覆盖较新的实时状态。 | Server、Sync、Desktop | FT-03、FT-13 |
| REQ-MSG-003 | mention 必须是正文之外的结构化 entity，绑定稳定 actorId 与字符范围；displayName 只用于显示。 | A | INV-001、HUM-001、MSG-003 | 同名 Actor、改名、复制/编辑正文均不改变目标；无 entity 的普通 `@文本` 不触发。 | 邮箱、代码片段或昵称冲突误调用 Agent。 | Core、Protocol、Server、Desktop | FT-03 |
| REQ-MSG-004 | reply-to 必须绑定同 Room 的稳定 messageId 并在主时间线显示引用；MVP 不创建独立 Thread。 | A | MSG-003、FCV1-NONGOAL | 回复能定位原消息；跨 Room 引用被拒；原文撤回后显示 tombstone 而不泄露正文。 | reply 只存复制文本，无法确认所回应的版本和作者。 | Core、Server、Desktop | FT-03、FT-16 |
| REQ-MSG-005 | active Room 中 Human 可随时版本编辑自己的消息正文，系统保存不可变 revision audit；MVP 中已提交的结构化 mention、reply target 与附件关联不可通过正文编辑静默增删，变更寻址必须发送新消息或使用对应 cancel/transfer 动作。编辑不改变已冻结 invocation snapshot，也不得静默改写 confirmed Decision/责任/期限/承诺。 | A | MSG-002、DEC-001、INV-002 | history/sync/repair 返回一致当前版本与版本链；运行中 execution 标记 source revised 但输入不漂移；受影响 confirmed fact 保持原值并提示来源已修订。 | 编辑正文增加 `@Agent` 就偷偷产生第二次调用，或编辑旧消息后已确认 Decision 无审计地改变。 | Core、Server、Memory、Desktop | FT-03、FT-05 |
| REQ-MSG-006 | active Room 中 Human 可撤回自己的消息，时间线保留 tombstone 与审计元数据。recall 原子取消仍 pending 的 Request/invocation intent，并对关联 running execution 建立 scoped cancel fence；completed final 与 confirmed 项目事实不回滚。关联附件和撤回原文从后续 operational memory/context/retrieval 排除，但保留在有权 Human 的审计与 owner 数据导出中。归档后消息冻结。 | A | MSG-002、PRIV-001、INV-002 | 撤回后新调用、检索和摘要不返回正文/附件；pending 派生对象不继续执行；running 依 AGT-010 收敛；历史审计/export 仍可证明原版本。 | UI 已撤回但 Provider 仍收到原文；或 recall 物理删除已完成 Agent 结果/confirmed Decision。 | Core、Server、Memory、Desktop | FT-03、FT-05、FT-14 |
| REQ-MSG-007 | Agent final message 不可编辑或撤回；错误必须通过新消息并关联被更正消息，原记录保留。 | A | MSG-003、FAIL-001 | correction 可定位原 Agent message，二者在 history/repair 中均存在。 | Agent 直接覆写过去答案，让审计链消失。 | Core、Server、Desktop | FT-03 |
| REQ-MSG-008 | preview/stream chunk 是可丢弃且非权威的本地显示；只有成功提交的 final Agent message 才进入消息历史、搜索/记忆候选和项目提取。 | A | INV-003、MSG-001 | 取消、崩溃或断线后 preview 不出现在 history/repair；final 只出现一次。 | 半句话 preview 被 steward 当作 confirmed 决策。 | Runtime、Sync、Memory、Desktop | FT-03、FT-08 |
| REQ-MSG-009 | MVP 必须支持图片与常见项目文件；服务端保存文件 ID、原名、MIME、字节数、内容哈希、上传者、时间与 source message，支持安全预览/下载、文本提取/OCR 和 Agent 引用。 | A | FCV1-ATTACHMENT、CTX-004 | 跨设备打开同一附件；哈希可校验；不可解析时明确标记而不伪造内容；提取结果带附件来源。 | 仅本机 blob URL 可见，重启后附件丢失；Agent 声称读过实际未解析的文件。 | Storage、Protocol、Memory、Desktop | FT-04 |
| REQ-MSG-010 | Room 当前有效内容默认全部 AI-visible，包含加入 Agent 前的历史和有权限的附件；MVP 不提供任意逐消息 AI 排除开关。recall/tombstone 是消息生命周期，不是选择性隐私开关：其原文仅保留于 Human audit/export，禁止进入后续 Agent operational retrieval。配置 Agent/邀请 Human 时必须清晰披露该边界。 | A | CTX-003、CTX-004、PRIV-001 | 新 Agent 可按需检索加入前的有效消息；撤回内容不进入 Agent context；披露与审计可验证；跨 Room 始终隔离。 | 用户以为 Agent 只看加入后消息，系统未披露地发送旧历史；或把已撤回原文继续称为“全部 AI-visible”。 | Product、Memory、Privacy、Desktop | FT-05、FT-14、FT-16 |

## 6. Room Memory 与上下文编译

### 6.1 记忆类型

内置 memory steward 维护五类可引用记忆：

| 类型 | 含义 | 权威进入规则 |
| --- | --- | --- |
| Goal | 当前项目要达成什么及边界 | primary Goal 由 Human 确认；同时最多一个 active |
| Decision | 已讨论并获得 Human 明确确认的选择 | proposal 不等于 confirmed；更新使用 supersede |
| Context | 对项目有持续价值的背景、约束与解释 | steward 可自动提取；任何 Human 可 dispute |
| NextAction | 明确的下一步、责任人、期限与验收 | 责任/期限/承诺须由 §8.2 指定 Human principal 确认 |
| OpenQuestion / Blocker | 尚待回答或阻碍推进的事实 | 单一 owner；状态迁移和升级可追溯 |

### 6.2 规范性需求

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-MEM-001 | Room 必须无损持久保存所有 accepted 消息、revision/tombstone、附件元数据/提取物和 confirmed 项目事实，形成可重放、可授权检索的 room corpus。 | A | MEM-001、CTX-003 | 超过任何在线窗口、进程重启和 event compaction 后，旧内容仍可按 source ID 取回。 | 第 65 条消息到来后第 1 条从 Agent 能力中永久消失。 | Storage、Server、Memory | FT-05、FT-13 |
| REQ-MEM-002 | 每个 Room 必须有一个内置 memory steward；它不作为普通 participant 抢占群聊发言，而异步提取五类重要记忆、去重/合并并保留 source message/attachment 索引。 | A | CTX-001、MEM-001、AG-001 | 新消息 ACK 不等待 steward；处理完成后记忆可追溯到一项或多项原始 source；重复处理幂等。 | steward 以普通 Agent 身份频繁插话，或摘要没有任何来源。 | Memory、Runtime、Server | FT-05 |
| REQ-MEM-003 | participant Agent 的默认输入必须是当前重要记忆、来源引用、触发消息、尚未进入 memory watermark 的 raw delta 表示和完成任务所需的局部原文；不得默认注入全量聊天记录。trigger 的稳定 ID、作者、类型与语义表示不可丢；若 trigger 原文自身超出模型预算，编译器使用确定性 excerpt/digest + source index，并允许按需分段读取，而不是承诺每个字节都内联。 | A | CTX-001、CTX-002、MEM-002 | context manifest 可列出包含/摘要/省略的范围；超长 trigger 仍保留身份、关键语义与可检索 source；长 Room 请求仍有界。 | 每次调用都把全历史发给 Provider；或超长 trigger 被整体丢掉，Agent 不知道为何被调用。 | Memory、Runtime、Privacy | FT-06 |
| REQ-MEM-004 | Agent 必须能依据 memory source 索引调用 room-memory read 工具，按需读取原消息、相邻上下文、附件提取物或相关项目对象；检索每次重验当前 membership。 | A | CTX-001、CTX-002、TOOL-001 | 对旧 Decision 追问时可自动取回原文并在回答中引用；移除 Agent 后同一工具请求失败。 | Agent 看到 `sourceMessageId` 却没有任何办法读取详情。 | Memory、Runtime、Server | FT-06、FT-10 |
| REQ-MEM-005 | Context 可以由 steward 自动生效；Decision、责任、期限和承诺只能作为 proposal，必须由具名 Human 确认后才进入相应权威状态。 | A | MEM-003、DEC-001、ACT-001 | proposal 与 confirmed 可区分；确认事件含 confirmer、time、source 和版本；无确认时 Agent 不把它当事实。 | Agent 从一句“可能小王做”自动创建已确认责任。 | Memory、Project、Desktop | FT-05、FT-09 |
| REQ-MEM-006 | 任一当前 Human 成员可 dispute Context；disputed Context 在重新评估并 resolved 前不得进入 participant Agent context，原内容与争议链保留。 | A | MEM-004 | dispute 后下一次 context manifest 不含该 Context；resolve 记录操作者、理由和新版本。 | 已被 Human 指出错误的摘要继续指导 Agent 行动。 | Memory、Server、Desktop | FT-05、FT-16 |
| REQ-MEM-007 | 上下文编译必须使用单调 watermark：`confirmed memory snapshot + watermark 后 raw delta representation + trigger/source`；不得因异步 steward 落后制造认知空洞。预算内 delta 使用原文，超限部分以有序 digest/source index 表示并可检索。 | A | CTX-003、MEM-002 | steward 暂停期间的每条新消息都以原文或可定位表示出现在 manifest；处理后不重不漏、不重复语义。 | 刚发的纠正因尚未摘要而完全不进入 Agent 输入。 | Memory、Runtime、Server | FT-05、FT-06 |
| REQ-MEM-008 | 每个 invocation 必须冻结 context snapshot/version/manifest；同一 execution 的 retry 和 crash recovery 使用相同事实集合，只有明确 supersede 才创建新 snapshot。 | A | INV-002、CTX-003、FAIL-001 | 重启前后同一 attempt 的 context hash/manifest 一致；新消息不会悄悄污染旧 retry。 | 进程重启后最近窗口变化，Agent 对同一 execution 回答另一个问题。 | Memory、Runtime、Persistence | FT-06、FT-08 |
| REQ-MEM-009 | context compiler 必须按选定模型的 token budget 做确定性编译：固定保留 trigger/source 的身份与语义表示，按优先级纳入记忆、delta 和检索原文，并以 excerpt/digest/index/省略说明降级；不得因固定消息条数或静态 byte 上限整次硬失败。只有单个不可分割输入经允许的分段/提取仍无法表示时，才返回可恢复的 `content_too_large`。 | A | CTX-001、CTX-002、FAIL-001 | 最大允许消息和附件组合形成有界请求；超长 source 可分段检索；真正不可表示时错误指向具体 source 和恢复动作；manifest 可解释裁剪。 | 最近 64 条超过 256 KiB 后所有 Agent 调用直接失败，或静默截断 trigger 而无 source。 | Memory、Provider、Runtime | FT-06 |
| REQ-MEM-010 | memory steward 故障时聊天必须继续；显式 invocation 使用已确认记忆加 raw delta 表示降级。依赖可能过期语义记忆的风险/领域 proactive route 暂停并显示 degraded；直接由仍健康的权威 NextAction/Blocker/Ball 与 confirmed deadline 计算的 deterministic due 可以继续，但必须注入具体 project source，而不能依赖旧摘要。若 project authority/context 也不可读，则 due execution 同样暂停并通知 Human。 | A | MEM-004、FCV1-MEMFAIL、PM-001 | 注入 steward 故障后 Human 仍能收发与显式调用；语义主动插话暂停；健康项目事实的 due 不丢失且引用 source；项目读取也故障时不盲调用。 | memory worker 宕机导致整个 Room 无法聊天；旧摘要继续触发风险插话；或确定性 due 无故永久丢失。 | Memory、Runtime、Desktop、Operations | FT-05、FT-08、FT-14 |
| REQ-MEM-011 | 模型输入必须保留 speaker identity/kind、server time、reply/mention 关系、Agent 自身身份/职责、Room/Goal 与触发原因；系统指令与群正文必须分层。 | A | CTX-004、AGP-001、PRIV-001 | 模型可区分不同 Human、其他 Agent 和自身旧发言；群消息不能冒充 system instruction。 | 所有历史都映射为 `role:user`，Agent 把自己的旧话当成 Human 新要求。 | Core、Memory、Provider | FT-06、FT-07 |
| REQ-MEM-012 | 发给 Provider 的内容必须限制为当前 invocation 编译出的必要上下文，并禁用 Provider 侧请求/响应留存：若 API 提供 `store` 参数则设为 `false`，否则适配器必须证明等价的 no-retention 配置。日志不得记录原始消息/附件正文、secret 或隐藏推理。 | A | PRIV-001、FCV1-PROVIDER | Provider 请求审计能证明最小范围与 no-retention；日志扫描不出现正文/token/secret/raw reasoning。 | 为调试把完整 Room 和 API key 写入日志，或只因换 Provider 就默认开启训练/留存。 | Privacy、Provider、Observability | FT-06、FT-14 |

## 7. Agent 在场、路由、执行与工具

### 7.1 产品态与内部态映射

| 用户可见产品态 | 内部可包含的子态 | 用户理解 |
| --- | --- | --- |
| accepted | selected、queued | 调用已被服务端接受，尚未开始生成 |
| running | model_generation、tool_call、waiting_confirmation、waiting_upstream | Agent 正在处理；等待确认必须有明确行动入口 |
| completed | final committed | 权威 final 已提交；不等于所有项目建议已获 Human 确认 |
| failed | failed、dead-letter、noauth、outcome_unknown | 本次因错误或未知结果未正常完成；展示原因、影响与可用恢复动作 |
| cancelled | cancelled、superseded | 本次被 Human 取消或被关联的新上下文取代；它是独立终态，不等同执行失败 |

### 7.2 规范性需求

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-AGT-001 | 结构化 `@Agent` 必须为每个目标原子持久化独立、幂等的 invocation intent，并返回逐目标 accepted/rejected outcome；execution 可异步创建，但不得丢失 durable handoff。同一消息点名多个 Agent 时并发执行，共享同一冻结 room-facts snapshot/version；每个 Agent 另有包含自身身份、职责、assignment 与工具的独立 envelope/manifest，状态、失败和回复互不连带。 | A | INV-001、INV-002 | 两个 Agent 同时被点名时各有稳定 intent/execution/outcome；一个失败不取消另一个；message commit 后进程崩溃仍能恢复 intent；网络重发不重复执行；两者共享事实版本但 persona/tool manifest 不同。 | 消息已显示 @Agent，但崩溃窗口让 invocation 永远未创建；或两个 Agent 收到彼此错误的身份/工具。 | Protocol、Router、Runtime、Persistence、Desktop | FT-07、FT-08、FT-13 |
| REQ-AGT-002 | Human public API 只能发起 direct invocation；proactive/routed trigger 只能由可信服务端 authority 产生，客户端不得自报 `routed_candidate` 或 `structured_help`。 | A | INV-001、PRIV-001 | 伪造 route kind 被协议或 authority 拒绝；每个 routed invocation 可追溯到 route decision。 | Human 将普通消息标为 routed 以绕过产品规则。 | Protocol、Router、Server | FT-07、FT-08 |
| REQ-AGT-003 | Room Assignment 仅提供 `active` 与 `on-mention`：active 可受控主动参与；on-mention 只响应结构化点名/直接调用，但被调用时获得与 assignment 一致的完整 read/tool 能力；MVP 不提供 silent。 | A | AG-001、INV-003 | on-mention 不因普通消息被选中；被点名后可正常检索记忆和使用授权工具；设置界面无 silent。 | on-mention 被点名后只能无工具回答，或 silent 让 direct invocation 无声消失。 | Core、Router、Runtime、Desktop | FT-07、FT-16 |
| REQ-AGT-004 | `ready/busy/paused/noauth` 是 availability，不是 participation；route selection、claim、model invoke 和 tool dispatch 必须一致重验。Tenant Administrator 管理 Global Profile/全局能力；Room owner/admin 管理 Assignment 与显式 pause/resume。`paused` 是 durable Room Assignment override；`busy` 由 durable running execution 临时投影，`noauth` 由 Provider/credential readiness 计算，`ready` 在 assignment 有效且无 paused/busy/noauth 时派生；后三者在重启后重新计算。paused/noauth 不启动新工作并产生可见状态。 | A | AG-001、AGP-001、GOV-001、FAIL-001、FCV1-DEPLOY | 权限主体可计算；Profile 变更有 deployment audit 且不绕过 Room ACL；状态变更阻断尚未 claim 的 execution；重启保留 paused 但不把旧 busy 永久固化；noauth 显示配置问题；busy 排队有界。 | 任意 member 提升 Agent 全局能力；Tenant Administrator 因部署角色直接读取未加入 Room；Agent 已 paused 仍显示“会回复”；重启后永远 busy或意外解除 pause。 | Auth、Core、Router、Runtime、Desktop | FT-01、FT-07、FT-08、FT-14 |
| REQ-AGT-005 | active Agent 的 proactive 触发限于与当前 Goal/职责相关的新 Human 消息、风险/领域匹配、confirmed checkpoint、due 或 Blocker 升级；不得进行无事实触发的周期性闲聊，普通 Agent final 也不得自行委派或级联唤醒其他 Agent。 | A | PM-001、INV-003、BLOCK-001 | 每次主动发言有可见 trigger/source 与去重边界；无事件的安静 Room 不产生模型调用；Agent final 本身不形成 autonomous Agent-to-Agent 链。 | 定时器每十分钟让 Agent 随机“看看有什么能帮忙”，或一个 Agent 答案触发无限 Agent 接力。 | Router、Project、Runtime、Desktop | FT-07、FT-09 |
| REQ-AGT-006 | confirmed checkpoint、due 或 Agent-held Ball 必须能在安静 Room 中创建一次可观察的 route/execution，并把具体项目事实注入 context；重复扫描不得重复触发。 | A | PM-001、TASK-002、BLOCK-001 | 无新消息时到期仍进入 accepted/running；同一 boundary 只触发一次，状态变化后重新计算。 | 到期只把已有 RouteJob 标 `has_ball`，没有聊天就永远不行动。 | Project、Router、Runtime | FT-08、FT-09 |
| REQ-AGT-007 | Router 必须基于有界对话/项目上下文、Agent 明确职责、availability、assignment 能力与当前 Ball 做选择；displayName 不得冒充职责。 | A | AGP-001、CTX-002、PM-001 | 改名不改变路由；相同当前消息在不同 Goal/Blocker 下可给出不同、可解释的选择。 | 两个 Agent 只靠名字猜专业领域。 | Core、Memory、Router | FT-07 |
| REQ-AGT-008 | 面向用户必须清晰区分 accepted/running/completed/failed/cancelled，并在 running 中表达等待确认；`will_respond/selected` 只能视为接受链的一步，不能保证最终回复。原始 provider/router diagnostics 默认折叠。 | A | INV-003、FAIL-001、IA-001 | 每个非终态都有下一步或自动收敛；失败显示简短原因、影响和重试/修复入口；取消不计作失败。 | UI 永久显示“Agent 将回复”，实际因 noauth 没有 execution；或把 Human 主动取消报成系统故障。 | Runtime、Sync、Desktop | FT-08、FT-16 |
| REQ-AGT-009 | Provider 失败的自动 retry 使用同一 execution、Agent、模型与冻结 context snapshot，创建有界 attempt；达到上限后显式 failed/dead-letter，不得自动换 Agent、换模型或静默 fallback。Human 对 eligible failed/cancelled 终态执行“重试”会创建带 `retryOfExecutionId` 的新 execution；未完成 review/compensation 的 `outcome_unknown`、`cannot_undo/needs_review` 不具 generic retry eligibility，必须先闭合 review，且任何后续动作不得复用原 side-effect toolCall。仅当原 source、Context 与权限仍具 operational eligibility 时才默认复用原 snapshot；source 已 recall、Context 已 dispute 或访问已撤销时必须拒绝旧 snapshot retry，并要求创建排除失效内容的新 invocation/snapshot。Human 同时提供纠正/新上下文时属于新的 invocation/supersede。 | A | FAIL-001、FCV1-PROVIDER、INV-002、MSG-002、MEM-004、TOOL-001 | 故障注入可观察有限 attempt 与最终 failed；eligible 手动 retry 形成单一幂等新 execution 和 lineage；未知副作用在 review 前没有 retry 动作；失效 source/context 不会被重新注入；无第二 Provider 调用。 | 主模型失败后系统偷偷换模型；直接重试 outcome_unknown 导致副作用重复；或已撤回原文/已争议 Context 因复用 snapshot 再次发送给 Provider。 | Runtime、Provider、Memory、Desktop、Persistence | FT-08、FT-10、FT-14 |
| REQ-AGT-010 | Human preemption 必须是 scoped：只有绑定 execution 的回复、纠正或显式取消可 supersede 相关工作；普通无关新消息不得取消 Room 内全部 Agent。若 confirmation 仍 pending，cancel/supersede/source recall 必须原子将其记为带稳定 reason 的 rejected 并撤销未发 grant；若 confirmation 已 confirmed 但 dispatch claim 未提交，confirmation 事实保持 confirmed，独立 grant 原子变为 revoked，parent cancelled，后续 claim 被拒；若 dispatch claim 已提交，则保留已知 dispatch/success 或 outcome_unknown/compensation 证据，取消只停止后续步骤，均不得宣称副作用已撤销。 | A | INV-002、FAIL-001、MSG-002、TOOL-001 | 无关消息不影响运行；pending confirmation、confirmed-unclaimed grant 与 claimed dispatch 三个竞态分支各自原子收敛；旧 session/worker 的晚到 confirm或claim失败；known 与 unknown outcome 分开。 | confirmation 已 confirmed、dispatch 未 claim 时 archive 无法撤销 grant；execution 已 cancelled 但旧 worker仍写文件；或已成功写文件却显示“已撤销”。 | Runtime、Server、Auth、Desktop | FT-08、FT-10 |
| REQ-AGT-011 | read-only 工具可在 `global capability ∩ room assignment ∩ current membership` 内自动执行；MVP 外部/数据读取闭集为 room-memory lookup、附件读取、受限 HTTPS/Web read、repo read/status。项目对象 read/query 也是服务端内部 domain query，服从 §8 对象权限，不视为外部工具扩权。 | A | TOOL-001、AGP-001、FCV1-TOOLS | 未授权工具不可见/不可 claim；撤权后在执行点失败；读取结果带来源与大小/超时边界；项目 query 不绕过 Room ACL。 | Router 看见跨 Room 工具能力并据此承诺无法执行的动作。 | Runtime、Server、Tool Adapters | FT-10 |
| REQ-AGT-012 | sandbox write 是 MVP 唯一允许的**外部写工具**；每次调用必须向 §8.2 指定 confirmation principal 展示精确目标、参数、影响、可逆性和服务端过期边界。confirmation 状态为 `pending → confirmed / rejected / expired`，绑定既有 execution/attempt/toolCall/参数/current principal/current session family 且一次消费；target 接受 direct handoff offer 时才原子切换 principal/session binding，confirm 与 handoff.accept 竞态只能一个成功。confirmed 是不可改写的 Human 决定并恢复**同一 execution**，同时产生独立、单次消费的 dispatch grant；grant 只能 `active → claimed / revoked / expired`。archive、parent cancel/supersede、source recall 或撤权发生在 pending 时使 confirmation rejected；发生在 confirmed 且 claim 前时保留 confirmed、原子 revoke grant并 cancel parent；claim 后按 AGT-013 保留 dispatch 事实。任何旧 binding、非 active grant 或晚到 claim 都失败。安全 expiry 不因 archive 暂停。禁止任意 shell、deploy 与外部消息；内部项目 command 仍服从 §8 权限/Human gate。 | A | TOOL-001、PRIV-001、FCV1-TOOLS、ROOM-002、INV-002、MSG-002 | 修改参数、换 session、handoff 后旧 principal、parent 终结后的晚到 confirm/claim、重复使用、过期、撤权和归档竞态均失败；confirmed→grant→claim/revoke 可故障注入；proactive/direct 均恢复原 execution；所有 pending/grant 最终收敛。 | confirmed 后、claim 前没有可撤销状态，导致 archive 后 worker 仍写文件；或旧 invoker与handoff target都成功。 | Runtime、Server、Auth、Desktop | FT-01、FT-08、FT-10、FT-16 |
| REQ-AGT-013 | side-effect adapter 在 durable dispatch claim 后出现异常时必须标记 outcome_unknown、暂停自动/手动 generic retry 并要求 Human review/补偿；review 必须把该调用闭合为 known succeeded、known failed 或 compensated/accepted risk，之后如需再次行动只能创建新 invocation/toolCall。read-only 失败可按有界策略重试。 | A | TOOL-001、FAIL-001 | 模拟超时能进入 review；review 前同一副作用没有 retry 入口；原 toolCall 永不二次执行；Human 可查看证据并以具名动作闭合。 | 网络超时后点击普通“重试”就重复转账/写入，或 outcome_unknown 永久没有 review 终点。 | Runtime、Persistence、Desktop | FT-10、FT-14 |

## 8. Goal、Decision、Request、NextAction、Blocker 与 Ball

### 8.1 状态机

以下状态机是对应 Requirement 的展开；所有迁移均为服务端权威事件，必须带 actor、time、source、version 与幂等边界。

| 对象 | 状态与合法主路径 | 关键约束 | 对应 Requirement |
| --- | --- | --- | --- |
| Goal | 同时最多一个 `active`；替换通过 audited supersede 形成新 active | Agent 可提出，Human 才能确认 primary Goal | REQ-PRJ-001 |
| Decision | `proposed → confirmed / rejected`；`confirmed → superseded` | confirmed 必须有具名 Human confirmer；不得原位改写 | REQ-PRJ-002、REQ-PRJ-003 |
| Request | `pending_acceptance → accepted / rejected / cancelled`；`transfer(target')` 是审计迁移并回到 `pending_acceptance` 等待新目标；accepted 是 Request 握手终态 | 目标 Human 接受前不承担责任；accepted 必须原子创建或链接 NextAction（要做的事）或 OpenQuestion/Blocker（要回答/解除的事）。纯信息请求必须链接 OpenQuestion，由 answer/resolved 终结；Request 本身不再持有 Ball | REQ-PRJ-004 |
| NextAction | `proposed → accepted / rejected / cancelled`；`accepted → in_progress / cancelled`；`in_progress → delivered / cancelled / done（仅 Human-owned 且无 verifier）`；`delivered → done / in_progress(reopen) / cancelled`；`done → in_progress(reopen)`；active 状态可 `reassign(owner') → proposed` | Agent-owned 必须 Human 确认与 Human 验收；Human-owned 验收可选；reassign 后新 owner 重新接受 | REQ-PRJ-005～REQ-PRJ-008 |
| Blocker | `open → resolved / deferred / cannot_answer`；`deferred` 到 reviewAt 自动回到 `open`；`cannot_answer` 可经解决进入 resolved。`transfer(owner')` 先创建不改变当前 owner 的 transfer proposal；新 Human 接受或 Agent 责任获指定 Human principal 确认后，才原子换 owner、追加 transfer chain 并回到 `open` | 每个 Blocker 单一当前 owner；转交待确认时旧 owner/升级 principal 继续持有 Ball；cannot_answer 触发一次升级而非与 defer 合并 | REQ-PRJ-009、REQ-PRJ-010 |
| Ball / NeedsAction | 对每个 active Request/NextAction/Blocker/confirmation/due source 分别确定性投影一个 holder/boundary；来源终结或转交即迁移/清除。一个 Room 可同时有多个不同 source 的 Ball | Ball 不是第二套可随意写的业务状态；“单一 holder”是每个 source，不是全 Room 只能有一项责任 | REQ-PRJ-011、REQ-PRJ-012 |

### 8.2 迁移权限主体

下表把“相关/有权 Human”收敛为可计算 principal；owner/admin 兜底不允许跳过被绑定 Human 的明确接受。

| 对象/动作 | 允许 principal | 兜底与限制 |
| --- | --- | --- |
| Context dispute | 任一当前 Human member | dispute 立即停止该 Context 的 operational injection |
| Context resolve | 原 dispute Human；或 owner/admin 在 steward 重新评估并记录理由后 | 产生新版本，不能删除争议链 |
| Room-wide Goal/Decision confirm/reject | 任一当前 Human member 作为具名 confirmer | 若结论互相冲突，由 owner/admin 选择 supersede；涉及具名 Human 责任时仍需该 Human 接受 |
| Request accept/reject/transfer | 当前 target Human | requester 可在 accepted 前 cancel；target 不可用时 owner/admin 可 transfer，但新 target 仍须接受 |
| Human-owned NextAction accept/reject | proposed Human owner | proposer或 owner/admin 可 cancel；reassign 后新 owner 重新接受 |
| Agent-owned NextAction accept | 创建提议的 Human；无明确 Human proposer时由 owner/admin | Agent 只能在有效 assignment 下成为 owner；Agent 不得自确认 |
| NextAction progress/deliver | 当前 owner；Agent 仅更新自己的 Action | verifier 或 owner/admin 不能伪造 owner 的交付物 |
| NextAction done/reopen | 指定 verifier；未指定且为 Human-owned 时由 Human owner | Agent-owned 始终需要具名 Human verifier；verifier 不得等于 Agent owner |
| Blocker resolve/defer/cannot_answer | 当前 owner | owner 不可用时 owner/admin 只能发起 transfer/升级，不能代替其回答 |
| Blocker transfer | 当前 owner、requester 或 owner/admin 可发起；目标 Human 必须本人接受，目标 Agent 必须由创建提议的 Human确认，无明确 Human proposer时由 owner/admin确认 | 接受/确认前不改变当前 owner；旧 owner 不可用时 Ball 暂投给发起转交的 owner/admin；拒绝或过期保留原 owner 并触发重新分派 |
| Direct invocation cancel | invocation 的 invoking Human；owner/admin 可因安全/治理取消 | 其他 Human 可提交显式关联 correction，但 correction 本身不越权取消，除非 invoker/owner/admin确认 supersede |
| Direct side-effect confirmation | 初始为 invocation 的 invoking Human；handoff offer 被目标接受后为唯一 current confirmation principal | target-specific offer 只能由目标从其认证 session 接受；accept 事务撤销旧 binding、绑定接受 session并迁移通知；接受前旧 binding 仍可确认，confirm 与 accept 竞态只能一个成功 |
| Proactive side-effect proposal | 对应 NextAction/Blocker/Ball 的 Human holder；无 Human holder时默认 owner，owner 不可用时由一名 admin 以耐久 claim 成为唯一 current confirmation principal | proactive execution 已存在并停在 waiting_confirmation；confirmed grant 恢复同一 execution/attempt/toolCall，不创建第二 execution；并发 owner/admin claim 只能成功一个 |

### 8.3 规范性需求

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-PRJ-001 | 每个 Room 同时最多有一个 active primary Goal；Agent/steward 可提出 Goal，只有 Human 明确确认才能激活；更换 Goal 必须保留 supersede 链。 | A | GOAL-001、ROOM-001 | 并发确认只能产生一个 active；历史 Goal 与替换原因可追溯并可回跳来源。 | 两台设备分别确认两个 primary Goal，最终同时 active。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRJ-002 | Decision 必须区分 proposed、confirmed、rejected、superseded；proposal 可由 Human 或 Agent 发起，confirmed 必须记录具名 Human confirmer、来源、时间与版本。 | A | DEC-001、MEM-003 | Agent 提议不会自动生效；拒绝与确认跨设备一致；无 confirmer 的 confirm 被拒。 | Agent 文本包含“决定”就自动写成 confirmed。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRJ-003 | confirmed Decision 不可原位改写；新结论必须 supersede 旧 Decision，并保留双向链与受影响的 Goal/NextAction/Blocker 提示。确认与冲突兜底严格采用 §8.2 的 principal 规则。 | A | DEC-001、GOV-001 | 修改来源消息不改变 Decision；supersede 后默认 context 只用新结论且仍可查旧结论；具名责任未获本人接受时不能借 Decision 确认生效。 | 编辑旧消息就悄悄改掉团队已确认决定，或 owner 代未同意的 Human 接受个人责任。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRJ-004 | 结构化 `@Human` 必须与 accepted message 在同一事务中创建 pending Request 或 durable handoff，并返回该 target 的稳定 accepted/rejected outcome；目标 Human 显式接受后才产生责任。目标可拒绝；transfer 让新目标重新进入 pending_acceptance；requester 可在接受前 cancel。accepted 后 Request 握手终结，并原子创建/链接 NextAction 或 OpenQuestion/Blocker 追踪实际完成；纯信息请求必须由 linked OpenQuestion 的 answer/resolved 闭环，Request 的 Ball 同步迁移到该 linked source。 | A | HUM-001、REQ-001、MSG-001 | message commit 后 crash 不丢 Request；重放不重复；目标接受前 Ball 不归其承担；转交后新目标必须重新接受；每个 accepted Request 有一个可追踪责任 source；信息回答后不残留悬空 Request/Ball。 | 权威消息里已 @Human 但 Request 异步丢失；transfer 后直接把责任压给新目标；accepted 后责任消失在聊天正文里；或信息已经回答但 Request 永久挂起。 | Core、Server、Desktop、Persistence | FT-03、FT-09、FT-13 |
| REQ-PRJ-005 | NextAction 必须包含 title/description、单一 owner、来源、可选 due、验收条件与稳定态；合法边按 §8.1 明确。rejected/cancelled 为终态；reassign 回到 proposed 并要求新 owner 接受；reopen 从 delivered/done 回到 in_progress。无 verifier 的 Human-owned 具有唯一的直接 `in_progress → done` 边；其他 Action 需 `in_progress → delivered → done`。 | A | ACT-001、TASK-001、TASK-002 | 每条合法/非法迁移可穷举；owner 与 due 变化形成新版本；终态不继续投影 Ball；reassign/reopen/无 verifier 完成路径唯一。 | claimant 离群后不能 reassign；`reassigned` 成为无出边状态；或 Human 无 verifier 的小任务被强迫虚构 deliver/verify。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRJ-006 | Human 与 Agent 都可成为 NextAction owner；给 Human 的责任须本人接受，给 Agent 的责任须由 §8.2 指定 Human principal 确认且 assignment/availability 合法。 | A | TASK-001、ACT-001 | 未接受/未确认时保持 proposed；paused/removed Agent 不能接收新责任；role 本身不能替代 principal。 | Agent 自己从聊天猜测并认领一个未获 Human 同意的任务。 | Core、Server、Runtime、Desktop | FT-09 |
| REQ-PRJ-007 | Agent 可更新自己 NextAction 的 in_progress 与 delivered，并提交交付物/来源；Agent-owned Action 必须由 §8.2 指定 Human verifier 验收后才进入 done，Agent 不得自验收。 | A | TASK-002、TOOL-001 | Agent deliver 后 Ball 转给具名 verifier；Agent 尝试 done 被拒；验收记录具名 Human。 | Agent 发一句“完成了”就把自己的任务标 done。 | Core、Server、Runtime、Desktop | FT-09 |
| REQ-PRJ-008 | Human-owned NextAction 的独立验收是可选的：owner 可直接完成；若创建时指定 verifier/criteria，则必须按该合同验收。reopen 必须记录理由并重新投影 Ball。 | A | TASK-002 | 无 verifier 的 Human Action 可完成；有 verifier 时 owner 不能绕过；reopen 后提醒恢复。 | 所有 Human 小任务都被硬性双人验收卡住。 | Core、Server、Desktop | FT-09 |
| REQ-PRJ-009 | Blocker/OpenQuestion 必须有单一当前 owner（可为 Human 或有合法 assignment 的 Agent）、来源、影响、可选 due/reviewAt 与稳定态 open/resolved/deferred/cannot_answer。transfer 必须先形成不改变当前 owner 的 proposal；目标 Human 接受或 Agent 责任获 §8.2 指定 Human principal 确认后，才原子替换 owner、追加不可变链并回到 open。 | A | BLOCK-001、MEM-001、ACT-001 | 离群前必须发起并完成转交或显式升级；接受/确认前新目标不承担责任；resolved 停止 Ball；每次 transfer 可审计；移除/paused Agent 不可接收新 Blocker。 | Blocker 引用已移除 Actor且无升级；或 transfer 未经新 Human 接受就把责任压给对方。 | Core、Server、Memory、Desktop | FT-09 |
| REQ-PRJ-010 | `deferred` 与 `cannot_answer` 必须保持不同语义：defer 必须有 reason 与 reviewAt，并在 reviewAt 原子回到 open/新 boundary；cannot_answer 必须记录原因并产生一次升级，可经获接受/确认的 transfer 回到 open，或经处理进入 resolved。 | A | BLOCK-001 | 时间推进后 deferred→open 并重新 NeedsAction；cannot_answer 只升级一次；转交采用新 owner 接受/确认合同；两者 repair 后不混淆。 | handler 把两者都存为 deferred 并丢弃 reason，reviewAt 到后仍永久 deferred，或把 cannot_answer 未经接受直接转给旁人。 | Core、Server、Desktop | FT-09、FT-12 |
| REQ-PRJ-011 | Ball/NeedsAction 必须对每个 active Request、NextAction、Blocker、待确认或 due source 分别确定性投影一个 holder、source、since、reason 与 boundary；一个 Room 可有多个 source 的 Ball，但每个 source 同时只有一个 holder。责任转移产生新 boundary。 | A | PM-001、TASK-002、BLOCK-001 | 重算幂等；两个并行 Action 可各有 holder；同一 source 不重复；transfer/deliver/resolve 后 holder 正确变化；已读消息不清除 Ball。 | 把“单一 holder”误解为整个 Room 只能有一项责任，或同一任务同时提醒两位 holder。 | Core、Server、Sync、Desktop | FT-09 |
| REQ-PRJ-012 | due 到达时立即产生一次 in-app reminder；未解决、未 deferred、未 transferred 时，每 24 小时再提醒一次。Human holder 收通知，Agent holder 创建带具体事实的 invocation；所有边界跨重启去重。 | A | PM-001、NOTIF-001、FCV1-REMINDER | 时间推进与重启测试证明首提醒一次、随后每 24h 一次；处理后停止；Agent 在安静 Room 被唤醒。 | 每次扫描都重复通知，或只在用户打开 Room 查询时才看到 due。 | Server、Runtime、Notifications、Desktop | FT-09、FT-12、FT-13 |
| REQ-PRJ-013 | participant Agent 必须能读取当前 Goal、Decision、NextAction、Blocker、Ball、due、criteria 与 source，并通过闭合项目工具提出/执行其获准的迁移；正文声称不能替代权威状态。 | A | PM-001、ACT-001、TOOL-001 | 问“谁被什么卡住”时可依据权威对象回答并引用；Agent 状态更新与消息 final 原子关联。 | Agent 回复“任务已完成”，面板仍显示 in_progress 且无任何冲突提示。 | Memory、Runtime、Server | FT-06、FT-09、FT-10 |

## 9. 信息架构与核心旅程

### 9.1 Desktop 信息架构

```text
Desktop shell
├── Room list（active Room、badge、archived Rooms 入口）
├── 当前 Room
│   ├── Timeline（消息、引用、附件、Agent 状态）
│   ├── Composer（reply、结构化 mention、附件）
│   └── Project / Memory panel
│       ├── Goal 与重要 Context
│       ├── Decisions
│       ├── Requests / NextActions / Blockers / Ball
│       └── 来源与确认入口
├── Flat in-app notification center
└── Room settings drawer（Human invite、Agent assignment、治理）
```

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-UX-001 | MVP 必须是 Electron Desktop-first；macOS 是必须支持的平台，Windows 仅在试点用户需要时构建；不得把浏览器 review 页面或 375px 窄窗当作 Web/移动端产品。 | A | MVP-001、IA-001、FCV1-PLATFORM | macOS 安装包在真实 Electron 进程完成核心旅程；Windows 未构建不阻塞 MVP；无 Web/mobile 发布入口。 | 仅用 query-param review 页面和截图宣称产品完成。 | Desktop、Packaging、QA | FT-11、FT-15 |
| REQ-UX-002 | 主界面必须是 Room-first 三栏：左 Room list、中 timeline/composer、右 project/memory panel；settings 以 Room drawer 打开。布局在产品声明的最小桌面窗口下如何适配由 FT-16 验证，不在本 PRD 锁定折叠控件或沿用当前实现尺寸。 | A | IA-001 | 在产品最终声明的默认与最小支持窗口下，中栏和核心动作可用；切换 Room 时三栏原子切换相同 roomId。 | 右栏显示上一个 Room 的任务，或默认入口只有“空群聊”。 | Desktop、Sync | FT-11、FT-16 |
| REQ-UX-003 | Room list 必须显示有权 active Rooms、当前选择与 badge，并提供 archived Rooms 的可发现入口；不得建设旧 M4 五分区跨群工作台。 | A | IA-001、NOTIF-001、FCV1-DEFER | catalog 事件更新列表；撤权 Room 消失并清 cache；badge 与通知中心一致。 | Room 列表硬编码，或出现未批准的五分区 inbox。 | Desktop、Sync、Notifications | FT-11、FT-12 |
| REQ-UX-004 | 右栏必须区分 proposal、confirmed fact 与 disputed Context，展示 Goal、Decision、NextAction、Blocker/Ball 和来源；所有写操作由权威 ACK/event 驱动。 | A | IA-001、MEM-003、DEC-001 | proposal 不自动进入 confirmed；第二设备与刷新后状态一致；点击来源定位消息/附件。 | 点击卡片仅修改 DOM，却提示“已生效”。 | Desktop、Project、Memory | FT-09、FT-11、FT-16 |
| REQ-UX-005 | settings drawer 必须把 Human invitation 与 Agent assignment 分成两条路径，显示角色、participation、availability、职责与工具 grant，并按 viewer 权限控制操作。 | A | ROOM-002、AGP-001、GOV-001 | owner/admin/member 权限态、loading、ACK、401/403/409 与冲突恢复均有验收；普通 member 不能治理。 | 同步 callback 返回即显示“已发送/立即生效”。 | Desktop、Auth、Room | FT-01、FT-02、FT-07、FT-11 |
| REQ-UX-006 | 启动必须区分恢复 session、登录、加载 catalog、原子恢复 Room、无 Room、离线只读、撤权与不可恢复错误；不得先闪现未授权缓存。 | A | PRIV-001、FCV1-AUTH、FCV1-OFFLINE | 有效/过期/撤销 session、断网、坏 cache、首次用户分别得到正确状态；repair 前不显示半个 Room。 | token 过期后仍先显示完整历史再锁屏。 | Desktop、Auth、Sync | FT-01、FT-11、FT-13 |
| REQ-UX-007 | 所有异步操作必须显示 idle/submitting/accepted-or-completed/retryable-failure/nonretryable-failure；只有匹配 requestId 的权威 ACK/event 后才成功，并保留失败前输入。 | A | MSG-001、FAIL-001、IA-001 | 发消息、邀请、配置 Agent、项目迁移、归档、附件和确认分别注入 401/403/409/410/429/503；无伪成功或重复提交。 | callback 未抛同步异常就显示成功，超时还清空 composer。 | Protocol、Desktop、Server | FT-03、FT-11、FT-16 |
| REQ-UX-008 | 应用内通知必须是 durable、recipient-scoped、幂等事实，覆盖 mention、Request、confirmation、due、tool result、Agent completed/failed；提供 flat center、Room badge、稳定来源引用与服务端权威的未读/已处理状态。MVP 无 OS push。 | A | NOTIF-001、FCV1-DEFER | 每类来源触发一次且重放不重复；重启或另一授权 session 得到同一权威状态；来源仍可访问时可定位、不可访问时安全失败；归档/撤权后停止新投递。 | reminder 仅查询时临时出现，重启后消失；或 Electron OS toast 是唯一入口。 | Server、Sync、Desktop | FT-12 |
| REQ-UX-009 | Human/Agent 身份、状态、错误与选择不能只靠颜色；核心旅程必须可通过键盘与 macOS 辅助技术完成，焦点可预测，状态更新使用克制的可访问通告，并在实际最小桌面窗口下保留核心动作。具体缩放、对比度与动效测试矩阵由 FT-16 在实现前闭合。 | A | IA-001、FCV1-A11Y | 键盘和 macOS 辅助技术完成核心旅程；去除颜色后身份/状态仍能由结构和文字理解；高频 preview 不逐 token 刷屏。 | Agent/Human 只靠蓝紫区分，drawer 关闭后焦点丢失，或运行态持续轰炸读屏。 | Desktop、Design、QA | FT-16 |

### 9.2 通知 recipient 与状态投影

本表是 `REQ-UX-008` 的路由展开，不新增通知类别。`read` 只表示 recipient 看过通知；`handled` 由 source 对象进入已处理状态投影，不能靠读通知清除责任。

| 通知类型 | recipient | handled 条件 |
| --- | --- | --- |
| Human mention / Request | 被 mention/Request 的目标 Human；Request 结果同时通知 requester | Request accepted/rejected/cancelled/转交给新目标；旧 recipient 的项随之 handled |
| Direct invocation completion/failure | invoking Human | recipient 对结果执行显式 acknowledge，或执行 retry/cancel/repair 等恢复动作；仅打开/阅读只改变 `read`，不改变 `handled`；cancelled 通过 invocation 状态同步，不新增通知类别 |
| Proactive Agent completion/failure | 对应 NextAction/Blocker/Ball 的 Human holder/requester；不存在 Human source holder 时通知 owner，owner 不可用时通知全部当前 admin（按 recipient 去重） | source 项被确认、转交、解决或由具名 recipient 明确忽略；仅阅读不算 handled |
| Tool confirmation | 当前唯一 confirmation principal：direct 初始为 invoking Human，target 接受 handoff offer 后切换；proactive 为 source Human holder，无 holder 时为 owner或单一 durable-claim admin | confirmed/rejected/expired；handoff.accept 原子使旧通知 handled并给接受 session 创建 pending 通知；archive、parent cancel/supersede 或 source recall 以对应 rejected reason 收敛并 handled；晚到动作安全失败 |
| Tool result/outcome_unknown | 执行时的 confirmation principal 与 invocation requester（同一人去重）；confirmed 后 grant 在 claim 前被 revoke 也产生“未执行”结果 | known result 或 revoked-before-dispatch 由 recipient 显式 acknowledge 后 handled；outcome_unknown 只有完成 review/compensation 后 handled；仅打开不算 handled |
| Due reminder | Human Ball holder；Agent Ball 不给 Agent 发通知而创建 invocation，其失败按 proactive failure 路由 | source resolved/deferred/transferred；单纯 read 不清 Ball |

notification 的创建、read 和 handled 投影都必须是服务端权威、按 `(recipient, source boundary, type)` 幂等；recipient 被撤权后停止投递并按隐私规则清除本地项。

### 9.3 核心端到端旅程

| 旅程 | 起点与主路径 | 成功终点 | 失败/恢复合同 | 覆盖 Requirement |
| --- | --- | --- | --- | --- |
| J-01 首次加入 | 收到定向邀请 → 登录/建密码 → 查看历史/AI 可见性披露 → 接受 → 进入 Room | Human 看到全历史、当前 Goal、成员与 active Agent | invite 过期/非目标账户明确失败；不产生半 membership | REQ-ID-002～003、REQ-MSG-010 |
| J-02 多人群聊 | 两名以上 Human 收发消息、reply、edit/recall、附件 → realtime/sync 收敛 | 各设备顺序一致、无重复、来源可追溯 | 断线只读缓存；重连 repair；未 ACK 写入不伪装成功 | REQ-MSG-001～010、REQ-NFR-007～010 |
| J-03 显式调用 | composer 结构化 @ 一个或多个 Agent → accepted → running/必要工具 → final 或 failed | 每个 Agent 独立终态，final 引用共享上下文 | noauth、timeout、cancel、retry、outcome_unknown 均有行动入口 | REQ-AGT-001～004、REQ-AGT-008～013 |
| J-04 形成决定 | Human/Agent 提议 → §8.2 指定 Human principal 查看来源 → confirm/reject → steward/context 更新 | confirmed Decision 有 confirmer/source；旧结论可 supersede | 来源被修订不静默改写；争议 Context 暂停注入 | REQ-MEM-005～006、REQ-PRJ-002～003 |
| J-05 推进行动 | 创建/接受 NextAction → in_progress → delivered → Human 验收/完成；Blocker 可转交/延期/升级 | Ball 清除或转给下一责任人，所有迁移可追溯 | owner 离群前强制处置；due 重复提醒有界 | REQ-PRJ-004～013 |
| J-06 Agent 主动推动 | confirmed checkpoint/due/Blocker boundary → active Agent 被唤醒 → 读取具体项目事实 → 提议/行动 | 有来源、无重复、需要副作用时等待 Human 确认 | memory degraded 时暂停语义/风险触发；健康权威项目事实的 deterministic due 可继续；noauth/失败通知 Human | REQ-AGT-005～007、REQ-MEM-010、REQ-PRJ-012～013 |
| J-07 归档与重开 | owner/admin 归档 → 业务只读/冻结并撤销未 dispatch grant → 浏览/导出 → 审计重开 | 重开后恢复 active，历史审计完整，业务 deadline 从剩余时长继续 | 归档期间无 Agent/业务 timer/新通知；认证与安全 expiry 继续，pending confirmation 收敛；重复命令幂等 | REQ-ROOM-004、REQ-AGT-012、REQ-NFR-014 |

## 10. 非功能需求与部署边界

| Requirement ID | 需求文本 | 证据等级 | 来源决策 ID | 验收方式 | 失败反例 | 影响系统层 | 后续任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-NFR-001 | MVP 必须部署为 owner 控制主机或私有云中的单租户服务，使用 SQLite 作为权威持久层；renderer cache、内存、preview 和 Provider 状态均不是事实源。 | A | FCV1-DEPLOY、PRIV-001 | 重启后仅靠 SQLite 恢复权威 Room；清空客户端 cache 可经 sync/repair 重建；租户数据无共享命名空间。 | renderer localStorage 成为唯一项目事实，或多个租户混在同一无隔离空间。 | Deployment、Server、Persistence、Desktop | FT-13、FT-14 |
| REQ-NFR-002 | 每个权威 command 必须将 domain change、stable event、outbox 与 idempotency record 原子提交。在批准的 30 天 idempotency replay window 内，相同 scope/key/payload replay 原结果，相同 key 不同 payload 冲突；该 window 必须真正执行清理/过期语义。窗口届满后不再保证保有 key/hash 或重放原 ACK，客户端必须先用 history/sync 查询 outcome，再决定是否以新 key 发起新 command；稳定 aggregate ID/唯一约束仍防止可识别的重复事实。 | A | FCV1-RELIABILITY | commit 前故障全部回滚；commit 后 ACK 丢失在 30 天内重试返回相同 IDs；TTL 清理可测；窗口外客户端先 reconcile，不盲重放。 | 消息落库但无 event，重试再生成第二条；expires_at 永久不生效；或 TTL 后仍宣称旧 key 必定冲突/重放却已删除 record。 | Server、Persistence、Protocol | FT-13 |
| REQ-NFR-003 | 在线事件采用 at-least-once 投递，客户端按 eventId 去重；outbox 必须有退避、重试上限、dead-letter 与可观测告警。离线连接通过 cursor sync/repair 收敛。 | A | FCV1-RELIABILITY | send 后 mark 前崩溃产生重复传输但不重复应用；坏连接不无限热循环；dead-letter 可诊断。 | 一个失败 socket 让整个 Room 永久高频重投，或重复 event 创建两个任务。 | Server、Sync、Desktop、Operations | FT-13、FT-14 |
| REQ-NFR-004 | sync 必须要求连续 cursor；缺口/过期转 repair。repair 在固定 watermark 下重建所有客户端可见状态，包括 revision、memory/project、Ball/reminder、invocation、confirmation 与 notification。 | A | FCV1-RELIABILITY、CTX-003 | 清空客户端后仅靠 repair 得到与权威 DB 等价视图；并发新事件在 watermark 后继续应用。 | repair 后看不到 pending confirmation/notification，或展示半个 snapshot。 | Core、Server、Sync、Desktop | FT-13 |
| REQ-NFR-005 | runtime、route、memory、notification 和 Ball worker 必须有有界 queue、并发、输入、timeout、retry 与恢复扫描；不得永久 queued/running/spinner，也不得因批次上限永久遗留尾部工作。具体数值在实现设计中以容量测试确定，不作为本 PRD 人工门禁。 | A | FAIL-001、FCV1-RELIABILITY、FCV1-METRIC | 故障/重启/超时/超过一批数据后每项最终完成、明确失败或进入 Human review；资源不会无界增长。 | provider timeout 后 execution 永久 running，或第 257 项永不恢复。 | Runtime、Server、Operations、Desktop | FT-08、FT-13、FT-14 |
| REQ-NFR-006 | 单租户部署使用一份服务端生产 Provider credential 与一个明确模型选择；Provider/模型向 Room 用户披露，MVP 不支持 BYOK、多 Provider 或自动 fallback。secret 仅在服务端 secret provider 中可见，并仅能由 Tenant Administrator 经部署管理路径配置/轮换；变更写不含 secret 值的审计。 | A | FCV1-PROVIDER、FCV1-DEPLOY、PRIV-001 | renderer/事件/日志/导出不含 credential；非 Tenant Administrator 不能配置/读取 secret；轮换审计含 actor/time/provider/model 但无 key；缺 key 显示 noauth；失败不调用第二模型。 | API key 进入 Room 设置或客户端 bundle；Room admin 能导出 credential；或失败时偷偷换 Provider。 | Auth、Deployment、Provider、Runtime、Desktop、Audit | FT-01、FT-07、FT-14 |
| REQ-NFR-007 | 离线时 Desktop 只可读取最后一次完整、校验通过且加密的 cache；不得接受离线 message/project/tool writes。重连先 sync/repair，再由用户显式重试未接受操作。 | A | FCV1-OFFLINE、PRIV-001 | 断网仍可读完整旧视图；发送/确认不显示 accepted；重连不重不漏且旧 confirmation 不自动执行。 | 离线消息显示已发送，重连生成重复事实；repair 半途覆盖完整旧 cache。 | Desktop、Sync、Security | FT-11、FT-13 |
| REQ-NFR-008 | token/离线授权租约过期时加密 cache 必须锁定；logout 清除 credential，可保留无法在未认证状态解密的加密 cache；membership revoke/remove 由服务端立即执行，在线设备收到事件即清除对应 Room cache，离线设备最晚在服务端签发且不超过 `maxOfflineReadLease` 的本地授权到期时锁定，并在重连鉴权时先清除。部署没有有限正值 policy、或客户端请求超上限时必须 fail closed；默认值和允许上限由 FT-14 在发布前冻结并进入安全配置测试。 | A | PRIV-001、FCV1-OFFLINE | 过期授权无法读正文；重新认证且仍有权时可恢复；在线撤权事件后目标 Room 数据从磁盘和内存删除；服务端拒绝无上限/客户端上调 lease，离线设备不能无限期解密。 | 被移除成员永久离线仍可无限期浏览 Room；客户端把租约改成“永不过期”；或 logout 把 refresh token 留在明文文件。 | Auth、Desktop、Storage、Security | FT-01、FT-13、FT-14 |
| REQ-NFR-009 | 日志、trace、运行 diagnostics 和**诊断包导出**默认不得包含 raw message/attachment、密码/token/Provider secret 或隐藏推理；允许记录稳定 ID、状态、大小、时延、错误分类和 context manifest 元数据。本限制不禁止 REQ-NFR-012 所定义、由有权 owner 显式发起的 Room 数据导出。 | A | PRIV-001、FCV1-PROVIDER | secret/corpus canary 扫描生产日志与诊断包无命中；诊断包仍能定位 execution/event/worker 故障；owner 数据导出走独立授权路径。 | 为可观测性把 prompt、附件正文和 chain-of-thought 全量落盘，或误把完整 Room export 当普通诊断附件。 | Server、Desktop、Operations、Privacy | FT-14 |
| REQ-NFR-010 | 用户表面不得出现可见重复、顺序回退、跨 Room 串数据、无终态 spinner 或伪成功；所有失败必须关联对象、稳定分类和安全恢复动作。 | A | FAIL-001、FCV1-RELIABILITY、IA-001 | 并发、多设备、重放、失联、权限变更与 crash E2E 覆盖；每个 pending 状态有 timeout/终态。 | 同一 Agent final 显示两次，或按钮一直 loading 且无诊断。 | End-to-end、Desktop、Server | FT-11、FT-13、FT-16 |
| REQ-NFR-011 | 权限必须在每个 command、query、subscribe、context build、tool claim、download 和 worker resume 的服务端执行点重验；UI 隐藏不能替代授权。 | A | PRIV-001、GOV-001 | 操作中途撤权后后续阶段 fail closed；旧 WS/session/URL 不能继续访问；已 dispatch 副作用进入 review。 | 移除 Agent 后 queued execution 仍读取全历史并完成。 | Auth、Server、Runtime、Storage | FT-01、FT-10、FT-13 |
| REQ-NFR-012 | 消息、项目对象、memory 和审计按 Room 生命周期保留；MVP 不提供永久删除 UI。owner 可完整导出 Room 原始内容、结构化事实、附件清单与审计；私有部署 owner 负责底层数据生命周期。 | A | FCV1-RETENTION、PRIV-001 | export 可校验且不丢 source/version；普通 member 不可导出无权数据；UI 只有 archive/reopen，没有伪“永久删除”。 | 删除按钮只删客户端显示但服务端仍留，或导出漏掉 revision/Decision。 | Server、Storage、Desktop、Operations | FT-14 |
| REQ-NFR-013 | Electron 必须启用 context isolation、禁用 renderer Node integration，并通过最小 preload/IPC 暴露认证、传输、加密 cache 与文件能力；所有外部内容和附件预览采用安全边界。 | A | IA-001、PRIV-001 | 安全配置测试、IPC schema 测试、恶意附件/链接测试通过；renderer 不能直接读任意本地文件或 secret。 | preload 暴露通用 shell/fs，群消息能触发任意系统命令。 | Desktop、Security | FT-11、FT-14 |
| REQ-NFR-014 | archive 是可逆且可审计的业务只读状态，不是删除：原授权成员可浏览历史/附件/项目事实；业务写入、Agent、steward、deadline/reviewAt timer 和新业务通知冻结；owner/admin 可审计地重开。认证、离线租约、confirmation/tool grant 等安全有效期继续流逝；未 dispatch grant 在 archive 事务撤销，不能跨归档复活。session revoke、member/Agent remove、capability/grant reduction 等安全治理命令在 archived 状态仍必须立即生效并清 cache，但不得触发业务 runtime。 | A | ROOM-002、GOV-001、FCV1-RETENTION、TOOL-001、PRIV-001 | archive/reopen 多设备一致且幂等；归档期间业务 mutation/worker 被拒；旧 confirmation 不能 dispatch；安全 token 正常过期；撤权无需 reopen 且不唤醒 Agent；审计可导出。 | 归档后无法撤销被盗 session；Agent 继续因 due 发言；或重开后旧文件写确认仍能执行。 | Auth、Room、Server、Runtime、Security、Desktop | FT-01、FT-02、FT-10、FT-13 |

## 11. M1～M6 路线与范围边界

下列路线取代陈旧蓝图中“先做 H1/H1b 人工实验、失败则 M2–M6 作废”和“M6 才真实试点”的门禁。产品基线的第二次批准已经完成，但它不修改 Blueprint 状态；只有 owner 另行授权任务映射后，才能据此创建或改写正式任务。

| Milestone | 当前定义 | 退出条件 | 明确不含 |
| --- | --- | --- | --- |
| M1｜证据基线 | 完成本证据重建、owner 细节确认与 PRD 二次批准 | evidence map/PRD 可双向追踪；无未披露关键假设；owner 明确批准新基线 | 人工对照实验、数字 go/no-go、旧 Blueprint 状态迁移 |
| M2｜多人 Room 基础 | Account/Session、邀请、Room 治理、真实消息/reply/revision、附件底座、权威 sync | 两个独立 Human session 在真实 Electron/Server 中稳定协作并跨重启恢复 | Agent 假数据、静态 review 页面作为验收 |
| M3｜Memory + 真实 Agent | corpus/steward/context compiler、Global Profile/Assignment、结构化 invocation、真实 Provider/runtime/tool safety | Agent 能在多人 Room 中引用共享历史/附件，多轮调用有终态并可安全用工具 | 全历史无脑注入、silent、自动模型 fallback |
| M4｜轻量项目闭环 | Goal、Decision、Request、NextAction、Blocker、Ball 与基础 app notification | 从对话提议到 Human 确认、行动交付/验收、阻塞升级、安静 Room due 唤醒全链可恢复 | 陈旧 M4 的跨群分区、四级 push、Mobile、global search |
| M5｜Desktop 集成与可靠性 | 三栏 live IA、离线只读 cache、完整 repair、archive/reopen、通知中心、隐私/诊断、打包 | macOS 安装包在真实进程通过核心旅程、故障恢复、安全与可访问性验收 | full Blueprint、Web/mobile、多 Provider |
| M6｜真实项目试点 | 2–3 Human 使用 MVP 与 Agent 推进一个真实项目，收集观察指标与定性反馈并排迭代优先级 | 试点复盘能指出有效价值、真实失败与下一迭代，不以预设数值作冻结门禁 | 固定 ≥3 Human/≥4 Agent、连续四周硬阈值 |

## 12. 陈旧 M4 四项产品合同与当前处置

历史 M4 的四项是跨群待我处理、通知、移动端和全局搜索。owner 没有让标题自动变成 MVP 要求，而是逐项批准了以下当前合同：

| 旧 M4 项 | 当前 A 类合同 | MVP 安全默认 | 重新决策触发 | 当前状态 |
| --- | --- | --- | --- | --- |
| 跨群待我处理 | 不建设五个分区、互斥/排序/分页等旧工作台合同 | Room badge + flat durable app notification center，深链到来源；Ball/NeedsAction 仍是 room-scoped 权威事实 | 真实项目中反复出现跨 Room 责任遗漏，并能用试点事件说明需要聚合 | 显式延期（DEF-001） |
| 通知 | MVP 仅做应用内持久通知及基础类型，不批准旧“四个等级”、DND 穿透、OS push 或多设备系统推送规则 | mention/Request/confirmation/due/tool result/Agent completion/failure 进入 app center | 用户在 Desktop 关闭时实际错过关键期限，且 app-only 无法解决 | 基础部分当前；高级部分延期（DEF-002） |
| 移动端 | MVP 不提供移动端“看、回、批、验” | macOS Desktop 完成全部核心动作；无响应式移动产品承诺 | 试点用户明确需要离开桌面处理项目责任，且桌面通知不足 | 显式延期（DEF-003） |
| 全局搜索 | MVP 不建设跨 Room 全文/附件/项目统一搜索 | 当前 Room 通过 memory panel、source link 与 room-memory retrieval 找回内容 | 真实使用反复出现跨 Room 检索需求，且通知/Room 导航无法解决 | 显式延期（DEF-004） |

## 13. 指标与产品学习

本阶段的指标用于观察和定位问题，不设置未经真实项目校准的硬阈值。历史 H1/H1b/H3、固定四周与固定人数指标不再是 go/no-go。

| 指标 | 定义/公式 | 样本与数据源 | 如何使用 |
| --- | --- | --- | --- |
| Invocation outcome | completed / accepted；并分 failed、cancelled、noauth、outcome_unknown | 每个真实 invocationId；runtime events | 找出真调用失败和恢复成本，不把 preview 计完成 |
| Context citation reachability | 可成功打开且内容匹配的 Agent 引用 / Agent 给出的全部引用 | final message、context manifest、source resolver | 验证共享上下文可追溯 |
| Context dispute | disputed Context 数 / 自动生效 Context 数；另看 resolve 时长 | memory events、dispute chain | 发现 steward 失真类型，不以低争议掩盖没人使用 |
| Decision outcome | confirmed/rejected/superseded proposal 分布与确认时长 | Decision events | 判断建议是否帮助团队形成决定 |
| NextAction flow | accepted→in_progress→delivered→done 的耗时、reassign/reopen 分布 | NextAction events | 找出责任与验收卡点 |
| Blocker outcome | resolved/deferred/transferred/cannot_answer 分布与停留时长 | Blocker events | 发现静默悬空与升级失效 |
| Reminder effectiveness | reminder 后在观察窗口内发生处理迁移的比例；重复提醒次数 | Notification + project events | 校准 24h 重复提醒是否有帮助/噪音 |
| Proactive noise | 被 Human 标为无关/打断/关闭的主动发言 / 全部主动发言，辅以访谈 | route trigger、feedback、访谈 | 调整 active trigger，不作为 MVP 前置门禁 |
| Tool confirmation | confirmed/rejected/expired/outcome_unknown 分布与处理时长 | confirmation/tool events | 验证副作用边界是否可理解、可操作 |
| Qualitative project value | Human 对信息补充、决策帮助、责任推进和协作成本的具体事件复盘 | M6 访谈、Room 事件样本 | 决定下一轮迭代，优先于脱离情境的满意度分数 |

## 14. Non-goals

以下不属于 MVP；其中有些是明确延期，另一些是明确排除的产品边界：

- Web 客户端、原生移动端、OS push 与旧四级通知体系。
- 陈旧 M4 的五分区跨 Room 工作台和全局搜索。
- full GBP/Blueprint 读写、自举和里程碑/依赖管理；MVP 只使用本稿的轻量项目对象。
- 独立 Thread、音视频、外部 IM 桥接、网盘、协作文档/在线文档套件。
- 社交 reaction、详细 read receipt、`@all/@here`。
- autonomous Agent-to-Agent delegation、无人值守外部副作用、任意 shell、deploy 或对外发送消息。
- 通用 Agent 角色市场/角色库；MVP 只需项目所需 Profile/Assignment。
- 多租户 SaaS、组织架构、审批流、SSO、BYOK、多 Provider 与自动 fallback。
- 永久删除 UI；MVP 使用 archive/reopen、完整 export 和私有部署底层数据治理。
- 把固定“十四原语”、人工对照实验、固定人数/四周/数值阈值作为交付门禁。

## 15. 显式延期登记

所有下列延期均由 owner 在 v1 清单中批准并接受风险，不是未回答的 D。共 8 项。

| Deferral ID | 延期项与原因 | 影响范围 | 当前安全默认 | 重新决策触发 | 最晚决定闸门 | 保留 seed |
| --- | --- | --- | --- | --- | --- | --- |
| DEF-001 | 旧跨 Room 待我处理工作台；MVP 先验证一个真实项目 Room 的闭环 | IA、排序、聚合、跨 Room 权限 | Room badge + flat app notifications | 真实试点出现可复现的跨 Room 责任遗漏 | 启动任何旧 M4 inbox 扩展任务前 | event/source/recipient 稳定 ID |
| DEF-002 | 高级通知、四级等级、DND 穿透与 OS push；当前不证明必要 | Notification、multi-device delivery | durable in-app center；无 OS push | Desktop 关闭导致实际错过关键期限 | 引入系统推送/后台送达前 | notification type、recipient、source、state |
| DEF-003 | Mobile/Web；优先把 macOS Desktop MVP 做真 | Platform、offline、push、mobile security | Desktop-only | 试点明确需要 off-desktop 的看/回/批/验 | 创建任何 mobile/web client 任务前 | 闭合协议与响应式信息层级，不承诺 UI |
| DEF-004 | Global search；先用 Room memory/source retrieval | Search、index、cross-room ACL | current-Room memory lookup 与来源链接 | 跨 Room 检索成为反复任务 | 创建全局索引前 | stable source IDs、权限重验、可重建事件 |
| DEF-005 | full Blueprint/GBP；轻量项目循环足以支撑 MVP | M5 adapter、写回、冲突、自举 | Goal/Decision/NextAction/Blocker/Ball | 出现复杂依赖、milestone 或长期计划需求 | 任何 Blueprint adapter 写任务前 | project object IDs、source/version、只读 adapter 边界 |
| DEF-006 | 数值成功阈值；没有真实项目基线 | Analytics、go/no-go | 采集第 13 节指标但不设门槛 | 完成首个真实项目并准备用指标冻结优先级 | 第一次以数字作发布/优先级门禁前 | versioned metric definitions 与样本说明 |
| DEF-007 | Multi-provider/BYOK；降低安全与运行复杂度 | Provider、credential、fallback | server-side 单 Provider/单模型 | 真实可用性、成本或合规需求无法由单 Provider 满足 | 接入第二 Provider 或用户 credential 前 | provider/model disclosure、context snapshot 元数据 |
| DEF-008 | 永久删除 UI；私有部署中先保证审计与可恢复 | Retention、compliance、export | archive/reopen + full export | owner/compliance 提出可验证删除义务 | 设计任何永久删除/retention job 前 | tombstone/version/export schema 与底层运维手册 |

## 16. Owner 决策记录

### 16.1 编号说明

`PD-*`、`CTX-*` 等是访谈中使用的原始决策 ID。`FCV1-*` 是为了让 Requirement 可双向追踪而给《PRD 细节确认清单 v1》已经获批的平台/延期分组添加的**文档锚点**；它们不新增产品决定，也不改变 owner 的原意。

| 决策 ID / 锚点 | 确认结论 | owner 原始回答摘要 | 证据等级 | 对应来源 | 影响章节 | 后续复核 |
| --- | --- | --- | --- | --- | --- | --- |
| PD-001 | 原生人机协作 IM 是确定产品方向 | `A`，随后强调所有设计必须服从多人协作中持续使用 Agent 的核心 | A | owner 访谈 + v1 批准，2026-08-18 | 2、14 | 否 |
| PD-002 | MVP 后由 2–3 Human 与 Agent 做真实项目 | `A`；先有初步产品，再用真实问题迭代 | A | 同上 | 2、11、13 | 否 |
| PD-003 | 反馈来自已有 MVP 的真实使用 | 不先设计可能无意义的实验 | A | 同上 | 2、11、13 | 否 |
| PD-004 | MVP/持续迭代优先，不被旧门禁卡住 | `B` 方案：以完成 MVP 为最终目标 | A | 同上 | 2、11 | 否 |
| CTX-001、CTX-002 | steward 提取最重要内容和消息索引；Agent 按需回查，不全量塞 prompt | 两项均 `A` | A | 同上 | 4、6 | 否 |
| MEM-001～004 | 全量 corpus、五类记忆、Human 确认、Context dispute | 四项均 `A` | A | 同上 | 6、8 | 否 |
| CTX-003、CTX-004 | watermark/raw delta、冻结 snapshot、身份/项目/附件上下文边界 | 两项均 `A` | A | 同上 | 5、6、10 | 否 |
| INV-001～003 | 结构化真调用、并发独立、产品态/participation/主动边界 | 三项均 `A` | A | 同上 | 4、7、9 | 否 |
| PM-001 | Agent 依据项目事实持续推动，事件触发而非无目的巡检 | `A` | A | 同上 | 7、8、13 | 否 |
| DEC-001、ACT-001 | Decision 与行动/责任需 Human 确认并可追溯 | 两项均 `A` | A | 同上 | 6、8 | 否 |
| MVP-001、IA-001 | Desktop MVP 与 Room-first 三栏 IA | 两项均 `A` | A | 同上 | 9、11 | 否 |
| AG-001、AGP-001 | steward + participant Agent；Profile/Assignment 两层 | 两项均 `A` | A | 同上 | 2、3、7 | 否 |
| ROOM-001、ROOM-002 | 一 Room 一 Project；生命周期、历史、归档/重开 | 两项均 `A` | A | 同上 | 3、8、10 | 否 |
| MSG-001～003 | durable 消息、Human 修订/撤回、Agent correction、reply/mention | 三项均 `A` | A | 同上 | 4、5、6 | 否 |
| FAIL-001 | 有界 retry、显式失败、无静默替代与永久 spinner | `A` | A | 同上 | 7、9、10 | 否 |
| GOV-001、ROLE-001、HUM-001 | 唯一 owner、角色权限、Human/Agent 分治 | 三项均 `A` | A | 同上 | 3、8 | 否 |
| PRIV-001、TOOL-001 | Room AI 可见性、最小披露、读自动/副作用逐次确认 | 两项均 `A` | A | 同上 | 5～7、10 | 否 |
| REQ-001、NOTIF-001 | `@Human` Request 接受语义；应用内持久通知 | 两项均 `A` | A | 同上 | 8、9、12 | 否 |
| GOAL-001、TASK-001、TASK-002、BLOCK-001 | primary Goal、完整 NextAction、Agent/Human 分工、Blocker | 四项均 `A` | A | 同上 | 8 | 否 |
| FCV1-PILOT | 2–3 Human 真实项目；无固定 Agent 数/四周门禁 | 最终清单整体批准 | A | 《PRD 细节确认清单 v1》+ 阶段二批准 | 2、11、13 | 首个试点后校准 |
| FCV1-PLATFORM、FCV1-DEPLOY | macOS Electron；单租户私有服务、SQLite；部署级管理与 Room 权限分离 | 最终清单整体批准 | A | 同上 | 3、9、10 | 仅 Windows 试点需求出现时 |
| FCV1-AUTH、FCV1-OFFLINE | 密码+邀请、多 session、加密离线只读与撤权清 cache；离线解密受服务端有限租约约束 | 最终清单整体批准；具体默认值/硬上限由发布前安全任务冻结，不允许无上限 | A | 同上 | 3、9、10 | FT-14 发布安全评审 |
| FCV1-PROVIDER、FCV1-TOOLS | 单 Provider/模型；批准工具闭集与禁止项 | 最终清单整体批准 | A | 同上 | 7、10、14 | 触发 DEF-007 时 |
| FCV1-RELIABILITY、FCV1-MEMFAIL | 原子幂等、at-least-once 去重/repair；memory degraded | 最终清单整体批准 | A | 同上 | 6、7、10 | 实现容量值需设计评审 |
| FCV1-ATTACHMENT、FCV1-A11Y | 附件/OCR/AI 可见；Desktop 可访问性边界 | 最终清单整体批准 | A | 同上 | 5、9、10 | 支持文件类型清单在设计任务闭合 |
| FCV1-REMINDER、FCV1-RETENTION | 到期后每 24h app reminder；archive 冻结计时并从剩余时长恢复、export、无删除 UI | 最终清单整体批准 | A | 同上 | 3、8、10、15 | 触发 DEF-008 时 |
| FCV1-DEFER、FCV1-NONGOAL | 八项延期及完整 Non-goals | 最终清单整体批准 | A | 同上 | 12、14、15 | 仅各 deferral trigger 出现时 |
| FCV1-METRIC、FCV1-MILESTONE、FCV1-PRIMITIVES | 观察指标无硬阈值；新 M1～M6；18 项重建原语取代固定 14 门禁 | 最终清单整体批准 | A | 同上 | 4、11、13 | 指标阈值按 DEF-006 |

### 16.2 被否决或覆盖的方案

| 方案 | 当前处置 | 覆盖依据 |
| --- | --- | --- |
| 先做 H1/H1b 对照实验，失败则 M2–M6 作废 | 否决；MVP 与真实项目反馈优先 | PD-002～004 |
| 固定 ≥3 Human、≥4 Agent、连续四周指标作为门禁 | 否决 | PD-002、FCV1-PILOT |
| 猜补遗失的十四条原语并作为验收 | 否决；用 18 项已确认合同重建 | FCV1-PRIMITIVES |
| 每次把 Room 全量聊天无脑塞给模型 | 否决；全量可用 + 有界编译 + 按索引检索 | CTX-001、CTX-002 |
| Agent 只看最近固定 64 条 | 否决；旧内容必须可检索并进入必要 context | MEM-001、CTX-001 |
| `silent/on-mention/active` 三档 | `silent` 否决；保留 active/on-mention | AG-001、INV-003 |
| 任意 Human 新消息取消 Room 所有 Agent work | 否决；改为关联 reply/correction/cancel 的 scoped preemption | INV-002 |
| Agent 从自然语言自动确认 Decision/责任/期限/承诺 | 否决；只能 proposal，Human 确认 | MEM-003、DEC-001、ACT-001 |
| Agent 或系统自动执行外部副作用 | 否决；逐 execution/精确参数 Human 确认 | TOOL-001 |
| Provider 失败自动换模型/Agent | 否决；同 Agent/模型有界 retry 后显式失败 | FAIL-001、FCV1-PROVIDER |
| 旧 M4 四项全部作为 MVP 前置 | 否决；只做基础 in-app notification，其余延期 | NOTIF-001、FCV1-DEFER |
| full Blueprint/GBP 作为 MVP 项目层 | 延期；先做轻量闭环 | FCV1-DEFER、DEF-005 |

## 17. 当前实现与目标产品的差距（B 类）

本节登记 24 个对产品验收影响最大的、按能力合并后的当前仓库 Gap；它们不改变前述 A 类需求，也不等于已授权实现。该数量是本稿的**高优先级分组条目数，不是所有代码风险的穷举计数**；更细的 preview 权限复核、confirmation timer、sandbox 路径/补偿、checkpoint provenance 与 shutdown drain 等 B 类风险保留在 evidence map 的历史实现审计 H6，后续任务必须重新做代码级风险盘点。

| Gap ID | 当前实现事实（B） | 冲突/缺失的目标 | 主要证据 | 对应任务 |
| --- | --- | --- | --- | --- |
| GAP-001 | Electron 默认只 `loadFile(index.html)`，renderer 默认空群；join/M2/visual 依赖 query-param review | 真实登录、Room list、live timeline/project panel 不存在 | `/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`；`/Users/leo/code/Dao/packages/desktop/src/renderer/main.ts:14-23` | FT-11 |
| GAP-002 | `preload.ts` 为空，Desktop package 仅依赖 Core | 无 auth/API/WS/cache/IPC 真接线 | `/Users/leo/code/Dao/packages/desktop/src/preload.ts:1`；`/Users/leo/code/Dao/packages/desktop/package.json:6-15` | FT-11、FT-13 |
| GAP-003 | Desktop join/config callback 是同步 `void`，调用后立即显示成功 | 无 loading、durable ACK、request correlation 与 401/403/409 UX | `/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts:169-174,681-709,893-964` | FT-01、FT-07、FT-11 |
| GAP-004 | runtime context 只查最近 64 条消息 | 不满足全量 corpus 上的重要记忆/引用/按需检索 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4683-4733` | FT-05、FT-06 |
| GAP-005 | OpenAI adapter 把所有历史映射为 `role:user`，丢 authorId/kind/time；没有 Agent/Room system context | 破坏多人对话身份与职责语义 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:109-130` | FT-06、FT-07 |
| GAP-006 | 没有 memory steward、五类记忆、watermark、引用、context manifest 或 room retrieval | 整个批准记忆合同缺失 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4705-4733`；`/Users/leo/code/Dao/packages/core/src/collaboration.ts:252-277` | FT-05、FT-06 |
| GAP-007 | Message 仅有纯文本基础字段；生产协议无结构化 mention/reply/revision/recall/attachment | 消息与寻址核心能力缺失 | `/Users/leo/code/Dao/packages/core/src/index.ts:32-46`；`/Users/leo/code/Dao/packages/server/src/protocol.ts:256-281` | FT-03、FT-04 |
| GAP-008 | direct mention 依赖正文 regex 与精确 Agent ID | 无稳定 actorId entity，可能误触发且不支持 Human Request | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3980-3986` | FT-03 |
| GAP-009 | public `agent.invoke` 允许 Human 自报 routed/structured kind，且同 source+target 永久唯一 | 不满足可信来源与连续 turn | `/Users/leo/code/Dao/packages/server/src/protocol.ts:829-843`；`/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:283-293` | FT-07、FT-08 |
| GAP-010 | 仅 participation=`active` 的 context 才带工具；on-mention 被点名后工具为空；代码仍有 silent | 与批准的 active/on-mention 产品合同直接冲突 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4695-4704` | FT-07、FT-08 |
| GAP-011 | Actor/Profile 目前主要是启动静态 seed，缺在线 profile/availability producer；persisted per-Agent readiness 不进入 route/model gate，主要只在 tool claim 检查 | 无法兑现可管理 Profile、pause/resume、busy/noauth 重启派生；paused/noauth 仍可能先产生 will_respond | `/Users/leo/code/Dao/packages/server/src/persistence/authority-worker.ts:400-466`；`/Users/leo/code/Dao/packages/server/src/route-runtime/route-decision.ts:63-140`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:5270-5515` | FT-07、FT-08 |
| GAP-012 | route judgment 先提交，后续 invoke 失败只记 diagnostics | selected/will_respond 与可见 execution 终态脱节 | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-runtime-service.ts:228-239` | FT-08、FT-11 |
| GAP-013 | Human preemption 对任意新 Human message 运行，ACK 等待其完成；取消集合/副作用语义与新 scoped 合同不同 | 无关联式 supersede；accepted message 可能因后置错误收 error | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:202-215`；`/Users/leo/code/Dao/packages/server/src/human-preemption/human-preemption-runtime.ts:75-133` | FT-08、FT-13 |
| GAP-014 | provider timeout abort 后可能直接 return，不写 durable retry/fail，直到重启才恢复 | 可能永久 running | `/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:206,357-359` | FT-08、FT-13 |
| GAP-015 | Core/Server 没有 Goal/Decision；现有 OpenItem/LightTask 状态与新 Project loop 不等价 | primary Goal、Human-confirmed Decision 缺失 | `/Users/leo/code/Dao/packages/core/src/collaboration.ts:19-85` | FT-09 |
| GAP-016 | runtime 不读取现有 OpenItem/LightTask/Ball；模型唯一项目工具是提出 OpenItem | Agent 无法依据权威项目状态推进 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4683-4733`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:131-156` | FT-06、FT-09、FT-10 |
| GAP-017 | LightTask 仅 Human 命令、无 unclaim/reassign/cancel/reopen；多个 verifier role 会阻塞 | 不满足 Human/Agent owner 与完整 NextAction 生命周期 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2852-3038` | FT-09 |
| GAP-018 | OpenItem 的 defer/cannot_answer 都落 deferred 且丢 reason；成员移除不检查 owner | 不满足 Blocker 分义、升级与离群闭环 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3105-3239` | FT-02、FT-09 |
| GAP-019 | Ball overdue 只标记已有 queued RouteJob；Human reminder 仅 query/scan 返回 | 安静 Room 不会唤醒 Agent，也无 durable app notification | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:227-306` | FT-09、FT-12 |
| GAP-020 | 无 ownership transfer、self-leave、unarchive；admin 当前可移除另一 admin；现有 archive 路径会让成员失去访问且不同实现分支语义不一 | Room 治理、归档后授权只读与可审计重开缺失 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:1774-2411`；`/Users/leo/code/Dao/packages/server/src/room-lifecycle.ts:1517-1993`；`/Users/leo/code/Dao/packages/server/src/room-lifecycle.test.ts:2074-2116` | FT-02 |
| GAP-021 | repair snapshot 不含 revision、Ball boundary/reminder、tool confirmation/grant/dispatch 等批准的可见状态 | 清 cache 后不能完整重建产品视图 | `/Users/leo/code/Dao/packages/server/src/persistence/snapshot-worker.ts:421-591` | FT-13 |
| GAP-022 | outbox 无 backoff/dead-letter；一个失败 connection 可让成功 peer 重复；无连接时直接标 dispatched | 依赖客户端去重/sync 但运营恢复不闭合 | `/Users/leo/code/Dao/packages/server/src/outbox-dispatcher.ts:100-166` | FT-13、FT-14 |
| GAP-023 | Desktop 375px visual screenshot 把内容压成一字宽窄条；文件实际为 375×876，但 review 登记为 375×812、仍声称响应式通过且无 Must Fix；实际 Electron `minWidth=840`，另一个 375 join review 也明示仅为桌面窄窗重排 | 该截图不能作为 mobile/响应式验收，且视觉审计结论、尺寸 provenance 与产物冲突 | `/Users/leo/code/Dao/screenshots/t0037-visual-separation-mobile-375.png`；`/Users/leo/code/Dao/DESIGN_REVIEW.md:15,25,29-31`；`/Users/leo/code/Dao/packages/desktop/src/window.ts:19-22`；`/Users/leo/code/Dao/.design/t0039-room-join/DESIGN_BRIEF.md:24` | FT-16 |
| GAP-024 | 当前没有 durable app notification center、附件 pipeline、加密持久 cache 与 session 管理 UI | 多项 MVP 产品表面完全缺失 | `/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts`；`/Users/leo/code/Dao/packages/desktop/src/sync/client-sync-replica.ts` | FT-01、FT-04、FT-11～13 |

## 18. 需求追踪矩阵

本稿共有 **103 条规范性 Requirement，全部为 A 类**。每条的来源、验收、失败反例、影响层和后续任务均已在首次出现的表格中给出；下表提供章节级双向索引。

| Requirement 组 | 数量 | 主要来源决策 | PRD 章节 | 主要后续任务 |
| --- | ---: | --- | --- | --- |
| REQ-PD-* | 5 | PD-001～004、PM-001、MVP-001 | 2 | FT-15 |
| REQ-ID-* | 5 | HUM-001、ROLE-001、ROOM-002、PRIV-001、FCV1-AUTH | 3 | FT-01、FT-07、FT-13 |
| REQ-ROOM-* | 4 | ROOM-001～002、GOV-001、TASK-002 | 3 | FT-02、FT-09 |
| REQ-PRIM-* | 18 | v1 全部已确认领域、FCV1-PRIMITIVES | 4 | FT-01～FT-16 |
| REQ-MSG-* | 10 | MSG-001～003、INV-001、CTX-004、FCV1-ATTACHMENT | 5 | FT-03、FT-04 |
| REQ-MEM-* | 12 | CTX-001～004、MEM-001～004、PRIV-001 | 6 | FT-05、FT-06 |
| REQ-AGT-* | 13 | INV-001～003、AG-001、AGP-001、FAIL-001、TOOL-001 | 7 | FT-07、FT-08、FT-10 |
| REQ-PRJ-* | 13 | GOAL-001、DEC-001、ACT-001、REQ-001、TASK-001～002、BLOCK-001、PM-001 | 8 | FT-09、FT-12 |
| REQ-UX-* | 9 | MVP-001、IA-001、NOTIF-001、PRIV-001 | 9 | FT-11、FT-12、FT-16 |
| REQ-NFR-* | 14 | PRIV-001、FAIL-001、FCV1-DEPLOY/AUTH/OFFLINE/RELIABILITY/RETENTION | 10 | FT-13、FT-14 |
| **合计** | **103** | **《PRD 细节确认清单 v1》** | **2～10** | **FT-01～FT-16** |

Evidence class 统计口径：规范性 Requirement 为 `A=103, B=0, C=0, D=0`；本稿另列 `B=24` 个高优先级合并 Gap 条目，它们不计入 Requirement，也不声称穷举所有代码风险。

## 19. 后续设计稿和交互原型的输入合同

本节的首份交付已经接入项目：[UI 交互设计正式审阅稿](../design/2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.reconstructed.html)，其可编辑源稿、运行时、覆盖范围和 spec 引用模板见[设计基线索引](../design/README.md)。后续 feature spec 应以 `REQ-*` / FT 编号和设计稿 `J-01`～`J-07`、组件或状态分区建立双向引用；设计稿负责表现与交互映射，本文继续负责产品语义和权限边界，`docs/protocols/` 与 feature spec 继续负责服务端事实、ACK、事件和恢复合同。

后续设计/原型必须以 Requirement ID 标注覆盖面，并至少交付以下可验证状态；不得用静态 happy-path gallery 代替 live product contract。

1. Room-first 三栏在默认与最小实际 Electron 窗口的布局适配、loading、empty、offline、archived、revoked、degraded 和 fatal error；是否使用折叠控件由设计验证决定。
2. Human/Agent 消息、reply、structured mention、revision/tombstone、Agent correction、附件 processing/failed 与 context source disclosure。
3. `@Human` Request 与 `@Agent` invocation 的不同流程；多 Agent 并发、accepted/running/waiting confirmation/completed/failed/cancelled/retry。
4. project/memory panel 中 proposal/confirmed/disputed/superseded 的视觉分层；Goal、Decision、NextAction、Blocker、Ball 的所有合法状态与禁止操作。
5. Human invitation、Agent assignment、ownership transfer、责任清理、archive/reopen 的权限、loading、ACK、冲突和审计入口。
6. side-effect confirmation 的目标、参数、影响、可逆性、过期、拒绝、重复、撤权和 outcome_unknown review。
7. flat notification center、Room badge、深链、已读/已处理、多设备同步和归档/撤权后的行为。
8. 键盘、焦点、macOS 辅助技术、非颜色识别、reduced motion、由 FT-16 闭合的缩放/对比矩阵，以及高频 preview 的克制通告。
9. 每个交互必须标明权威 source（本地暂态 / server ACK / stable event / projection）和错误恢复动作。

原型评审必须同时包含至少一条失败反例；没有服务端事件/状态机支撑的点击效果必须标为 prototype-only，不能显示“已生效”。

## 20. 产品基线批准与后续变更治理

owner 已于 2026-08-18 明确回复 **“批准该 PRD 成为新的产品定义基线”**。该批准确认：

- 103 条 A 类 Requirement 忠实覆盖《PRD 细节确认清单 v1》；
- 18 项重建原语用于表达当前产品，不伪装成遗失十四条原语的原文恢复；
- 8 项延期及其安全默认、触发条件和 seed 获得接受；
- 24 个 implementation-only B 类 Gap 只描述目标与现状的差异，不改变产品定义；
- M1～M6、旧 M4 四项处置、Non-goals、指标与平台边界成为当前规划依据。

因此，本文自批准日起是当前产品定义基线。文件名与标题继续保留 `reconstructed` / “证据重建版”，用于诚实标示原始 PRD 已遗失及本文件的来源链；该标记不再表示“待审核”。若后续需要改名、建立 Blueprint must-doc 关系、创建实现任务或修改既有验收标准，必须作为独立、可审计的变更执行。任何改变 Requirement、延期或产品边界的修订，都必须更新版本、记录来源并重新取得 owner 批准。
