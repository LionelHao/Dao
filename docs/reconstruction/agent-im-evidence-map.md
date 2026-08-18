# Agent IM 产品证据索引｜owner-approved reconstruction layer

> 文档性质：`《原生人机协作 IM 产品 PRD｜证据重建版 v0.1》` 的证据映射；不是遗失 PRD、设计稿或原型的原文恢复。  
> 当前层日期：2026-08-18  
> 对应确认清单：《PRD 细节确认清单 v1》  
> 阶段二闸门：owner 已明确确认清单完整准确并批准进入 PRD 编写阶段。  
> 产品基线闸门：owner 已于 2026-08-18 明确批准配套 PRD 成为新的产品定义基线。  
> 设计基线闸门：owner 于 2026-08-18 提交 UI 交互设计稿并要求项目 PRD/spec 应用，正式入口为 [`docs/design/README.md`](../design/README.md)。  
> 当前效力：配套 PRD 已是当前产品定义基线；UI 交互设计稿是 FT-16 的当前表现与交互基线；二者尚未自动成为 Blueprint must docs。  
> 写入边界：设计交付接入只更新项目文档与原始设计资产；未修改代码、测试、任务状态或 Blueprint，未运行 `gbp.py` 写命令。

## 0. 当前批准层

### 0.1 A/B/C/D 与 authority status

证据等级仍采用 A/B/C/D，但必须与“当前权威状态”分开读取：

| 证据等级 | 证明什么 | 当前写入规则 |
| --- | --- | --- |
| A｜已恢复/已批准 | 权威资料曾明确规定，或 owner 当前明确批准 | 只有 `current-owner-approved` / `current-retained-history` 可成为规范来源 |
| B｜实现反推 | 当前代码/测试确实如此 | 只能说明现状、风险和 Gap；不得自动成为需求 |
| C｜提案 | 为补齐遗失信息而提出的候选 | v1 批准后，本稿没有未批准 C 类规范 |
| D｜未知 | 无证据且未获决定 | v1 批准后，没有未披露的关键 D；历史档案仍有 `legacy-unknown` |

| Authority status | 含义 |
| --- | --- |
| `current-owner-approved` | owner 在访谈及《PRD 细节确认清单 v1》中批准，当前最高产品权威来源 |
| `current-retained-history` | 历史 A，且当前清单明确继承 |
| `historical-superseded` | 历史上确实存在，但已被当前 owner 决定覆盖 |
| `historical-deferred` | 历史上曾规划，当前明确延期 |
| `implementation-only` | 当前 B 类代码事实，不自动进入目标产品 |
| `legacy-unknown` | 旧资料仍无法恢复，且当前产品不再依赖其答案 |

证据冲突优先级：`current-owner-approved` > `current-retained-history` > `implementation-only`。历史 A 的精确行号不能覆盖更新的 owner A；B 类实现也不能以“已测试”为由改变产品要求。

### 0.2 当前 owner A 证据登记

`FCV1-*` 是配套 PRD 为最终清单分组添加的追踪锚点，不是新增产品决定。

| Evidence ID | 决策 ID / 锚点 | 原子结论 | Class | Authority status | 来源与 owner 回答摘要 | Relation / PRD 影响 |
| --- | --- | --- | --- | --- | --- | --- |
| EV-GATE-001 | v1-stage-2 | 最终清单完整、准确，批准进入 PRD 编写阶段 | A | current-owner-approved | owner，2026-08-18：“我确认《PRD 细节确认清单 v1》内容完整且准确，批准进入 PRD 编写阶段” | 解锁两份 reconstruction 文档；不等于第二次 PRD 批准 |
| EV-GATE-002 | prd-baseline-approval | 配套 PRD 获得第二次验收，成为新的产品定义基线 | A | current-owner-approved | owner，2026-08-18：“批准该 PRD 成为新的产品定义基线” | 将 PRD 状态从待审核重建稿提升为当前产品定义基线；不自动授权 Blueprint、任务或代码变更 |
| EV-GATE-003 | ft16-design-baseline | UI 交互设计稿完成交付并接入，后续 PRD/spec 以其作为 UI / 交互映射基线 | A | current-owner-approved | owner，2026-08-18：“现在交互设计稿也交稿了……让其他 spec 文档和 PRD 可以应用这个设计稿” | 闭合 FT-16 的设计输入入口；设计稿不反向覆盖 PRD 产品语义或 protocol 服务端事实，引用与偏离规则见 `docs/design/README.md` |
| EV-OWNER-001 | PD-001 | 产品是多人真实项目群聊中的原生人机协作 IM | A | current-owner-approved | owner 选 A，并强调所有冲突设计均应剔除 | supersedes “产品品类仍待实验决定”；PRD §2 |
| EV-OWNER-002 | PD-002～004、MVP-001 | 先完成 MVP，由 2–3 Human 与 Agent 跑真实项目，再从问题反馈迭代 | A | current-owner-approved | owner 逐项批准；反对无实际使用基础的实验和门禁 | supersedes 旧 M1/H1/H1b 和 M6 尾部试点；PRD §2/§11/§13 |
| EV-OWNER-003 | MEM-001～004、CTX-003 | Room 全量内容无损持久；steward 管理五类记忆；确认与争议有权威语义 | A | current-owner-approved | owner 对全部 ID 回复 A | extends T-0040；PRD §6 |
| EV-OWNER-004 | CTX-001、CTX-002、CTX-004 | Agent 默认只拿重要记忆、来源索引、trigger/raw delta 和必要原文，可按索引回查完整上下文 | A | current-owner-approved | owner 明确反对每次无脑塞全部聊天 | supersedes 固定 64 条与“全量 prompt”两种错误极端；PRD §5/§6 |
| EV-OWNER-005 | INV-001～003、AG-001、AGP-001、FAIL-001 | 结构化 `@Agent` 是真调用；多 Agent 并发独立；active/on-mention、无 silent；用户可见 accepted/running/completed/failed/cancelled，有界失败与 scoped preemption | A | current-owner-approved | owner 对各 ID 回复 A；最终清单把执行态、取消与失败恢复作为同一 Agent 运行合同整体批准 | supersedes 旧三档 participation 与 hard room-wide preemption；PRD §7 |
| EV-OWNER-006 | HUM-001、ROLE-001、ROOM-001～002、GOV-001 | Human/Agent 分治；一 Room 一 Project；唯一 owner、治理、归档/重开与责任清理 | A | current-owner-approved | owner 对各 ID 回复 A | retains 部分 identity-room 协议并扩展治理；PRD §3 |
| EV-OWNER-007 | MSG-001～003、REQ-001 | durable 消息、结构化 mention/reply、Human revision/recall、Agent correction、`@Human` Request | A | current-owner-approved | owner 对各 ID 回复 A | supersedes raw regex/legacy-only message surface；PRD §4/§5/§8 |
| EV-OWNER-008 | GOAL-001、DEC-001、ACT-001、TASK-001～002、BLOCK-001、PM-001 | Goal/Decision/NextAction/Blocker/Ball 构成轻量项目推进闭环 | A | current-owner-approved | owner 对各 ID 回复 A | replaces fixed OpenItem/LightTask-only product contract；PRD §8 |
| EV-OWNER-009 | TOOL-001、PRIV-001 | read tool 自动；外部副作用逐 execution、精确参数 Human 确认；Room fully AI-visible 且最小披露 | A | current-owner-approved | owner 对两项回复 A | retains T-0041 safety, extends privacy/context；PRD §5～§7/§10 |
| EV-OWNER-010 | IA-001、NOTIF-001、FCV1-PLATFORM、FCV1-ATTACHMENT、FCV1-A11Y | macOS Electron、Room-first 三栏、附件/OCR、flat in-app notifications | A | current-owner-approved | v1 最终清单整体批准 | old M4 advanced surfaces deferred；PRD §5/§9/§12 |
| EV-OWNER-011 | FCV1-DEPLOY/AUTH/PROVIDER/OFFLINE/RELIABILITY/RETENTION | 单租户私有 SQLite；部署级管理与 Room ACL 分离；密码邀请多 session；单 Provider；受服务端有限租约约束的加密离线只读；repair；archive 冻结/恢复计时与 export | A | current-owner-approved | v1 最终平台包整体批准（owner：“全部a”）；未在产品层拍脑袋固定离线小时数，要求发布前安全任务冻结有限默认值/上限 | PRD §3/§10 |
| EV-OWNER-012 | FCV1-DEFER/NONGOAL/METRIC/MILESTONE/PRIMITIVES | 八项显式延期、Non-goals、观察指标无硬阈值、新 M1～M6、18 项重建原语 | A | current-owner-approved | v1 最终清单整体批准 | supersedes fixed 14/旧 M4/旧指标门禁；PRD §4/§11～§15 |

### 0.3 历史 A 的继承、覆盖与延期

| Evidence ID | 历史原子结论 | 历史来源 | 当前状态 | 当前关系 |
| --- | --- | --- | --- | --- |
| EV-HIST-001 | 早期定位为持续、共享、多方在场的原生 IM，不是 IM+Bot/聊天壳 | `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:56-60,1073` | current-retained-history | 被 EV-OWNER-001 具体化为真实 Project Room 与多人试点 |
| EV-HIST-002 | 旧 M1 以 H1/H1b 实验和 go/no-go 决定后续里程碑 | 同上 `:37,69-80,108-152,154-351` | historical-superseded | 被 PD-002～004 覆盖；不得阻塞 MVP |
| EV-HIST-003 | 旧 M6/完成条件要求 ≥3 Human、≥4 Agent、连续四周，并把真实试点放在路线尾部 | 同上 `:69-74,800-817` | historical-superseded | 真实试点保留但改为 MVP 后 2–3 Human + Agent 项目；固定规模/周期门禁废止 |
| EV-HIST-004 | Human/Agent 身份和消息视觉分离 | `/Users/leo/code/Dao/docs/deliveries/T-0011-消息基础设施与人-agent-视觉分离-交付说明.md:5-25` | current-retained-history | 被 HUM-001/ROLE-001 继承；具体 UI 按新 IA |
| EV-HIST-005 | durable ACK、history/realtime 与稳定 ID 去重 | `/Users/leo/code/Dao/docs/protocols/message-ack.md:5-20` | current-retained-history | 被 MSG-001/FCV1-RELIABILITY 继承 |
| EV-HIST-006 | SQLite authority、事务 event/idempotency/outbox、cursor/repair | `/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:1-3,33-72` | current-retained-history | 被 FCV1-RELIABILITY 扩展为完整产品可见 repair |
| EV-HIST-007a | Human 定向 invite、Agent 由 owner/admin assignment、服务端执行成员撤权 | `/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:35-106` | current-retained-history | 被 ROOM-002/HUM-001/PRIV-001 继承并扩展 |
| EV-HIST-007b | 旧 Agent membership 包含 silent，旧 archived/history 访问语义按当时协议处理 | 同上 | historical-superseded | silent 被移除；归档后合法 Human 成员只读与撤权缓存规则按新 A 重写 |
| EV-HIST-008 | T-0041 真实 Provider、queued/running/completed/failed/cancelled execution 状态、最小权限和 side-effect confirmation | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0041-agent-runtime-design.md:3,252-269`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0041-agent-runtime-work-note.md:3-13` | current-retained-history | 执行终态与安全骨架保留；Provider/上下文/用户映射按新 A 扩展 |
| EV-HIST-009 | 旧路由有 silent/on-mention/active，direct @ 唤醒三档 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:62-74` | historical-superseded | 无 silent；on-mention 被点名时保留工具；direct invocation 结构化 |
| EV-HIST-010 | 旧 hard “人来让位”由任意 Human 消息触发 room-wide fence | 同上 `:115-126` | historical-superseded | 改为 reply/correction/cancel 关联的 scoped preemption |
| EV-HIST-011a | 旧 OpenItem/LightTask/Ball 证明“显式承诺对象 + 责任投影”的早期抽象 | 同上 `:76-113` | current-retained-history | 被新 Goal/Decision/NextAction/Blocker/Ball 轻量闭环继承 |
| EV-HIST-011b | 旧固定状态、LightTask Human-only、未确认 Agent proposal 和默认到期语义 | 同上 `:76-113` | historical-superseded | 以 DEC/ACT/TASK/BLOCK/PM owner A 重写 |
| EV-HIST-012 | 旧 M4=跨群 inbox、四级通知、移动端、全局搜索；M5=GBP | 旧蓝图 `:92-100,619-798` | historical-deferred | 仅基础 app notification 进入 MVP；其余见 DEF-001～005 |
| EV-HIST-013a | 旧蓝图声称存在十四原语，但完整名称、顺序与 P-01～P-14 映射无法恢复 | 旧蓝图 `:69-75,83-85` 与旧 evidence audit | legacy-unknown | 仅作为遗失信息留档，不再是当前产品依赖 |
| EV-HIST-013b | 固定十四原语曾被用作旧路线门禁 | 同上 | historical-superseded | 不再补猜或设门禁；v1 改用 18 项已确认重建原语 |

### 0.4 当前实现 B 与目标 Requirement 的冲突映射

| Evidence ID | B 类原子事实 | 绝对来源 | 关系到 Requirement / Gap |
| --- | --- | --- | --- |
| EV-IMPL-001 | 默认 Desktop 是空群/查询参数 review 页面 | `/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`；`/Users/leo/code/Dao/packages/desktop/src/renderer/main.ts:14-23` | conflicts REQ-UX-001～008；GAP-001 |
| EV-IMPL-002 | preload 空、Desktop 无 server/WS/cache/IPC 依赖 | `/Users/leo/code/Dao/packages/desktop/src/preload.ts:1`；`/Users/leo/code/Dao/packages/desktop/package.json:6-15` | conflicts live MVP；GAP-002 |
| EV-IMPL-003 | join/config 同步 callback 后立即显示成功 | `/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts:169-174,681-709,893-964` | conflicts REQ-UX-005/007；GAP-003 |
| EV-IMPL-004 | runtime 只读最近 64 条纯文本消息 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4683-4733` | conflicts REQ-MEM-001～004/009；GAP-004 |
| EV-IMPL-005 | Provider 把所有消息映为 `role:user`，丢作者/类型/时间 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:109-130` | conflicts REQ-MEM-011；GAP-005 |
| EV-IMPL-006 | 无 steward、五类 memory、watermark、引用、检索或 manifest | 同上；`/Users/leo/code/Dao/packages/core/src/collaboration.ts:252-277` | conflicts REQ-MEM-*；GAP-006 |
| EV-IMPL-007 | Message/协议无 mention/reply/revision/attachment | `/Users/leo/code/Dao/packages/core/src/index.ts:32-46`；`/Users/leo/code/Dao/packages/server/src/protocol.ts:256-281` | conflicts REQ-MSG-003～010；GAP-007 |
| EV-IMPL-008 | direct mention 仅正文 regex + 精确 Agent ID | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3980-3986` | conflicts REQ-MSG-003；GAP-008 |
| EV-IMPL-009 | Human 可自报 routed/structured invoke；source+target 永久唯一 | `/Users/leo/code/Dao/packages/server/src/protocol.ts:829-843`；`/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:283-293` | conflicts REQ-AGT-001/002；GAP-009 |
| EV-IMPL-010 | 仅 active context 获得 tools，on-mention/silent 被点名工具为空 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4695-4704` | conflicts REQ-AGT-003；GAP-010 |
| EV-IMPL-011 | persisted Agent readiness 未进入 route/model gate | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-decision.ts:63-140` | conflicts REQ-AGT-004；GAP-011 |
| EV-IMPL-012 | route judgment 与后续 invocation 可见终态脱节 | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-runtime-service.ts:228-239` | conflicts REQ-AGT-008；GAP-012 |
| EV-IMPL-013 | 任意 Human message 触发旧 preemption，ACK 等待其完成 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:202-215` | conflicts REQ-AGT-010/REQ-MSG-001；GAP-013 |
| EV-IMPL-014 | Provider timeout 分支可能不写 durable fail/retry | `/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:206,357-359` | conflicts REQ-AGT-009/REQ-NFR-005；GAP-014 |
| EV-IMPL-015 | 无 Goal/Decision 权威模型 | `/Users/leo/code/Dao/packages/core/src/collaboration.ts:19-85` | conflicts REQ-PRJ-001～003；GAP-015 |
| EV-IMPL-016 | runtime 不读项目对象；模型仅能 propose OpenItem | `/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:131-156` | conflicts REQ-PRJ-013；GAP-016 |
| EV-IMPL-017 | LightTask Human-only 且生命周期不完整 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2852-3038` | conflicts REQ-PRJ-005～008；GAP-017 |
| EV-IMPL-018 | defer/cannot_answer 合并且丢 reason，成员移除不闭合 owner | 同上 `:3105-3239` | conflicts REQ-PRJ-009/010；GAP-018 |
| EV-IMPL-019 | Ball overdue 不创建新 execution，Human reminder 不持久投递 | 同上 `:227-306` | conflicts REQ-AGT-006/REQ-PRJ-012；GAP-019 |
| EV-IMPL-020 | 无 ownership transfer/self-leave/reopen，admin 可移除 peer admin；现有 archive 路径会阻断成员历史访问 | 同上 `:1774-2411`；`/Users/leo/code/Dao/packages/server/src/room-lifecycle.test.ts:2074-2116` | conflicts REQ-ROOM-002～004/REQ-NFR-014；GAP-020 |
| EV-IMPL-021 | repair 缺少多项当前可见运行态 | `/Users/leo/code/Dao/packages/server/src/persistence/snapshot-worker.ts:421-591` | conflicts REQ-NFR-004；GAP-021 |
| EV-IMPL-022 | outbox 无 backoff/dead-letter，失败 peer 造成重复 | `/Users/leo/code/Dao/packages/server/src/outbox-dispatcher.ts:100-166` | conflicts REQ-NFR-003；GAP-022 |
| EV-IMPL-023 | 375px screenshot 实际不可读，且文件实际为 375×876、旧 review 却登记 375×812 并称响应式通过/无 Must Fix；真实 Electron minWidth=840，join brief 也说明 375 仅是桌面窄窗 | `/Users/leo/code/Dao/screenshots/t0037-visual-separation-mobile-375.png`；`/Users/leo/code/Dao/DESIGN_REVIEW.md:15,25,29-31`；`/Users/leo/code/Dao/packages/desktop/src/window.ts:19-22`；`/Users/leo/code/Dao/.design/t0039-room-join/DESIGN_BRIEF.md:24` | conflicts old review claim and screenshot provenance；GAP-023；不能作 mobile evidence |
| EV-IMPL-024 | 无 notification center、attachment pipeline、加密持久 cache 或 session UI | Desktop/Core/Server 当前生产源码读取清单见历史附录 | missing REQ-MSG-009、REQ-UX-006/008、REQ-NFR-007/008；GAP-024 |

### 0.5 Requirement 双向追踪

| PRD Requirement 组 | 数量 | 当前 owner 证据 | 保留历史证据 | 主要 B/Gaps | PRD 位置 |
| --- | ---: | --- | --- | --- | --- |
| REQ-PD-* | 5 | EV-OWNER-001/002/005/008/012 | EV-HIST-001～003 | — | PRD §2 |
| REQ-ID-* + REQ-ROOM-* | 9 | EV-OWNER-005/006/008/009/011 | EV-HIST-004/007a/007b | EV-IMPL-020/024 | PRD §3 |
| REQ-PRIM-* | 18 | EV-OWNER-001～012 | EV-HIST-004～013 | 跨全部 EV-IMPL | PRD §4 |
| REQ-MSG-* | 10 | EV-OWNER-003/004/005/006/007/008/009/010/011/012 | EV-HIST-004/005 | EV-IMPL-007/008/024 | PRD §5 |
| REQ-MEM-* | 12 | EV-OWNER-003/004/005/008/009/011 | EV-HIST-006/008 | EV-IMPL-004～006 | PRD §6 |
| REQ-AGT-* | 13 | EV-OWNER-003/004/005/006/007/008/009/010/011 | EV-HIST-008～010 | EV-IMPL-009～014/019 | PRD §7 |
| REQ-PRJ-* | 13 | EV-OWNER-003/006/007/008/009/010/011 | EV-HIST-011a/011b | EV-IMPL-015～019 | PRD §8 |
| REQ-UX-* | 9 | EV-OWNER-002/003/005/006/007/008/009/010/011/012 | EV-HIST-004/012 | EV-IMPL-001～003/023/024 | PRD §9 |
| REQ-NFR-* | 14 | EV-OWNER-003/005/006/009/010/011/012 | EV-HIST-005～008 | EV-IMPL-013/014/020～024 | PRD §10 |
| **合计** | **103 A** | **v1 current-owner-approved** | **只按原子项保留** | **24 implementation-only Gap** | PRD §2～§10 |

当前规范统计：`A=103, B=0, C=0, D=0`（Requirement 口径）。本稿当前批准层另登记 `B=24` 个高优先级、按能力合并的 implementation-only Gap；它们不声称穷举历史附录中的全部代码风险。显式延期 `8` 项，全部是 owner-approved deferral，不是 D。

### 0.6 显式延期证据

| Deferral ID | 当前安全默认 | owner-approved 触发条件摘要 | 追踪到 PRD |
| --- | --- | --- | --- |
| DEF-001 跨 Room inbox | Room badge + flat app notification center | 真实试点反复发生跨 Room 责任遗漏 | PRD §12/§15 |
| DEF-002 高级通知/OS push | durable in-app only | Desktop 关闭导致实际错过关键期限 | PRD §12/§15 |
| DEF-003 Mobile/Web | macOS Desktop-only | 试点明确需要 off-desktop actions | PRD §12/§15 |
| DEF-004 Global search | current-Room memory/source retrieval | 出现反复跨 Room 检索需求 | PRD §12/§15 |
| DEF-005 full Blueprint | lightweight project loop | 出现复杂依赖/milestone，或启动 adapter 任务 | PRD §15 |
| DEF-006 数值阈值 | 采集但不设 gate | 首个真实项目后准备以数字冻结优先级 | PRD §13/§15 |
| DEF-007 Multi-provider/BYOK | one server credential/model | 单 Provider 无法满足真实可用性/成本/合规 | PRD §15 |
| DEF-008 永久删除 UI | archive/reopen + export | owner/compliance 提出可验证删除义务 | PRD §15 |

## H. 2026-08-17 批准前历史审计快照

> 从本标题起至文末保留的是阶段一开始前已经存在的只读证据审计，取证快照为 2026-08-17，提交为 `bbf3d087f593cea8e193311a8ca51a1160db67a0`。其中“待 owner 决定”“当前批准状态 D”“C 待批准”等表述是**历史状态**，已被上面的 2026-08-18 v1 owner-approved 层覆盖；它们不得再用于判定当前 PRD 是否有未决问题。该快照仍保留，用于审计证据来源、旧冲突和文件读取范围。

## H1. 如何阅读本历史索引

### 1.1 证据等级

| 标记 | 含义 | 本文使用规则 |
| --- | --- | --- |
| **A｜已恢复决策** | 可由现存计划、协议、交付说明或多个独立证据直接证明 | 只恢复“现有资料明确规定了什么”；不等于找回遗失原文，也不自动等于 owner 已验收 |
| **B｜实现反推** | 当前代码和测试确实如此工作，但不能证明与遗失原稿文字相同 | 必须给出代码或测试路径；不得改写成“原设计就是这样” |
| **C｜重建提案** | 为补齐遗失信息而提出的新基线候选 | 每项均明确写“待 owner 批准”，批准前不属于既有需求 |
| **D｜未知** | 证据不足，无法恢复或不能安全补猜 | 保留未知，不用竞品、常识或任务标题凑答案 |

补充约定：陈旧蓝图中的目标、非目标、里程碑和任务标题可作为 **A｜已恢复的早期意图**；这个子标签只证明 2026-08-05 左右曾经这样规划，不证明当前状态或当前批准状态。

组合标记约定：`A+B` 不是第五种等级，只表示同一行同时包含一条 A 级规范/决策和一条 B 级实现事实；两者必须能在该行被分别读出。`A+D`、`B+D` 同理，未知或风险推论不会因与 A/B 同行而升级。

路径约定：表格中首次出现的证据使用绝对路径；同表的“同上”、`T-xxxx 交付/计划`和源码短名均回指 2.2、2.3 或附录 A 中列出的唯一绝对本地路径，不表示外部来源。

### 1.2 证据优先级

1. 当前 `main` 中代码、测试、协议、实施计划和交付说明，用于回答“系统现在如何工作”。
2. 迁移上下文与陈旧蓝图，用于回答“产品早期为何这样做、曾规划什么”。
3. 同一主题发生冲突时，当前实现和较新的权威文档优先；旧材料保留为演进记录，不覆盖当前事实。
4. 没有使用外部产品或网络资料补齐任何缺失需求。

## H2. 已完整读取的证据

### 2.1 产品与里程碑恢复

| 文件 | 完整读取范围 | 用途与限制 |
| --- | --- | --- |
| `/Users/leo/Downloads/ai-development-context-portable/docs/projects/agent-im.md` | 1–98 | 2026-08-09 迁移快照、旧仓库入口和 ACK 历史；不能代替当前仓库事实 |
| `/Users/leo/Downloads/ai-development-context-portable/docs/projects/articles.md` | 1–69 | 旧 Blueprint 的非 Git 存放和迁移风险 |
| `/Users/leo/Downloads/ai-development-context-portable/docs/MEMORY-COMPENDIUM.md` | 1–1495 | 全文核读；Agent IM 直接相关段落为 25–47 |
| `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html` | 1–2084 | `summary`、`goals`、`nonGoals`、`doneWhen`、`milestones`、`tasks`、`unknowns`、`timeline` 与 decision 派生逻辑；仅作陈旧意图档案 |

陈旧蓝图的关键数据位置：`goals` 56–61、`nonGoals` 62–68、`doneWhen` 69–75、`milestones` 76–107、`unknowns` 108–153、`tasks` 154–910、`timeline` 911–1072、`summary` 1073、正式 decision 派生逻辑 1886–1940。

| Blueprint 字段 | 数量/恢复结论 | 当前效力 |
| --- | --- | --- |
| `summary` | 1；已恢复产品类别、反 Bot/聊天壳、核心假设、M1 门槛与早期完成愿景 | **A｜早期意图**；不是当前状态 |
| `goals` | 4；已恢复原生 IM、核心假设、显式承诺、可插拔承诺层 | **A｜早期意图**；当前批准状态 D |
| `nonGoals` | 5 组；已恢复 | **A｜早期意图**；当前批准状态 D |
| `doneWhen` | 5；已恢复 H1/H1b、十四原语/P-01～P-14、真实团队、四周指标、Blueprint 自托管 | **A｜早期完成目标**；当前达成状态 D |
| `milestones` | 6；M1～M6 已恢复 | **A｜早期路线**；旧状态不迁移 |
| `tasks` | 36；标题已恢复 | **A｜历史标题**；旧 `todo/verified` 不迁移 |
| `unknowns` | 6；U-01～U-06 已恢复 | **A｜早期待验证问题**；后续答案 D |
| 正式 decisions | **A**：该 Blueprint 内为 0；timeline 为 3 status + 11 structure + 0 decision | **D**：是否另有已遗失的外部正式决策未知 |

蓝图 `ownerNote` 还记录：2026-08-05 时 H1/H1b 尚无结论、当时编制仅 1 Human + 1 Agent，并主张先补第二个可验收身份。该内容是 **A｜已恢复的早期 owner 判断**；当前编制与当前 owner 判断均为 **D｜未知**。来源：`/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:37`。

### 2.2 当前 M3 权威设计、交付与协议

以下文件均逐行读到 EOF：

- `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0021-展开M3发言判定与承诺原语-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0011-消息基础设施与人-agent-视觉分离-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0012-已读与已判定分离-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0013-at请求与调用双语义-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0014-编辑撤回与表情回应人agent分治-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0016-四层发言判定与单次路由架构-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0017-待答项最轻的承诺单位-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0018-轻任务轻量群的最小承诺-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0019-球的统一定义与持球义务-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0020-人来让位的硬规则-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0039-真实身份群与加入生命周期-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md`
- `/Users/leo/code/Dao/docs/deliveries/T-0041-真实Agent运行时模型供应商与工具权限-交付说明.md`
- `/Users/leo/code/Dao/docs/protocols/authoritative-sync.md`
- `/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md`
- `/Users/leo/code/Dao/docs/protocols/message-ack.md`

为核对当前实现与计划之间的演进，另完整读取：

- `/Users/leo/code/Dao/docs/plans/2026-08-07-t0014-message-reaction-separation.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-12-t0041-agent-runtime-design.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-12-t0041-agent-runtime-work-note.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0041-agent-runtime-implementation-plan.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0016-route-runtime-implementation-plan.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0017-open-item-implementation-plan.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0018-light-task-implementation-plan.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0019-ball-in-court-implementation-plan.md`
- `/Users/leo/code/Dao/docs/plans/2026-08-17-t0020-human-preemption-implementation-plan.md`

### 2.3 当前代码与测试

已完整核读 `packages/core/src`、`packages/server/src`、`packages/desktop/src` 下的生产源码、类型测试和行为测试，共 103 个文件：Core 8、Server 84、Desktop 11；其中 42 个 Vitest 文件和 3 个 compile-time type-test。精确文件清单见附录 A；以下是覆盖面索引。

| 包 | 已读内容 | 主要证据入口 |
| --- | --- | --- |
| Core | Actor、Message、membership、同步记录、OpenItem、LightTask、BallInCourt、runtime、route、preemption、reaction/calibration 的类型、guard 和测试 | `/Users/leo/code/Dao/packages/core/src/index.ts`、`/Users/leo/code/Dao/packages/core/src/collaboration.ts`、`/Users/leo/code/Dao/packages/core/src/sync.ts` 及同目录测试 |
| Server | 认证、房间生命周期、协议、WebSocket、SQLite authority、outbox/sync/repair、真实 Agent runtime、工具网关、单次路由、Ball、human preemption、组合根及测试 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts`、`/Users/leo/code/Dao/packages/server/src/persistence/schema.ts` 及同目录全部源码/测试 |
| Desktop | Electron 窗口、静态 renderer、视觉评审页面、本地 sync replica 及测试 | `/Users/leo/code/Dao/packages/desktop/src/main.ts`、`/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts`、`/Users/leo/code/Dao/packages/desktop/src/sync/client-sync-replica.ts` 及同目录测试 |

为核对可运行入口和脚本，还完整读取 `/Users/leo/code/Dao/package.json`、`/Users/leo/code/Dao/packages/server/package.json` 与 `/Users/leo/code/Dao/packages/desktop/package.json`。

本主审计实跑 `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm build`、`corepack pnpm test` 均退出 0。test 内 40 个测试文件通过，2 个 opt-in live smoke 文件跳过；827 个测试通过、2 个跳过，共 829 个，Core boundary 同时通过。这个结果只证明本地闭合测试，不证明外部模型 endpoint、目标部署环境或真实团队产品验证。

## H3. 恢复出的产品与系统决策

### 3.1 产品方向与边界

| ID | 等级 | 结论 | 本地来源 |
| --- | --- | --- | --- |
| PROD-01 | A｜已恢复的早期意图 | 产品面向“人与多个 AI Agent 持续、共享、多方在场地协作”的原生 IM，不是现有 IM 加 Bot，也不是给 Agent 工具套聊天壳。 | `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:56-60`、`:1073` |
| PROD-02 | A｜已恢复的早期意图 | 核心待验证假设是：持续、共享、多方在场的空间，相比一次性调用能产生独特协作价值。 | 同上 `:58`、`:1073` |
| PROD-03 | A｜已恢复的早期意图 | 群聊发言本身不产生承诺；进入承诺层后才产生可追踪义务，并应能唯一回答“球在谁手里”。 | 同上 `:59` |
| PROD-04 | A｜已恢复的早期意图 | 轻量日常协作与宏伟蓝图长期项目共用“球”的抽象，但承诺层可插拔。 | 同上 `:60` |
| PROD-05 | A｜已恢复的早期意图 | 用户始终在环；当前阶段不追求无人值守全自动执行。 | 同上 `:62-67` |
| PROD-06 | A｜已恢复的早期意图 | 音视频、网盘、组织架构、审批流、外部 IM 桥接、通用 Agent 角色/提示词库和 Thread 不在早期范围内。 | 同上 `:62-67` |
| PROD-07 | D｜未知 | 上述早期产品方向与非目标是否已由当前 owner 逐条重新批准，没有找到正式验收或 superseding decision。 | 蓝图无正式 decision；见本文 7.2 |

### 3.2 Human / Agent 类型、权限与视觉分离

| ID | 等级 | 结论 | 本地来源 |
| --- | --- | --- | --- |
| HA-01 | A | Human 与 Agent 可共同在场，但 Actor 数据形态不同：Human 有 reachability，Agent 有 readiness 和 tool permissions。 | `/Users/leo/code/Dao/docs/deliveries/T-0011-消息基础设施与人-agent-视觉分离-交付说明.md:15-25` |
| HA-02 | A | Human 消息使用圆头像与气泡；Agent 消息使用方形头像、角色色轨和无气泡结构，不能共享同一视觉模板。 | 同上 `:21-25` |
| HA-03 | A | Human 有已读；Agent 没有已读，使用“将回应 / 无需回应 / 被抑制”的已判定事实，并必须给出可读原因。 | `/Users/leo/code/Dao/docs/deliveries/T-0012-已读与已判定分离-交付说明.md:5-24` |
| HA-04 | A | `@human` 是请求并产生 OpenItem；`@agent` 是调用并产生 AgentExecution；两条语义不可双写。 | `/Users/leo/code/Dao/docs/deliveries/T-0013-at请求与调用双语义-交付说明.md:5-13`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:76-87` |
| HA-05 | A | Human 消息可编辑/撤回；Agent 消息不可编辑/撤回，只能追加关联更正并保留原记录。 | `/Users/leo/code/Dao/docs/deliveries/T-0014-编辑撤回与表情回应人agent分治-交付说明.md:5-18` |
| HA-06 | A | Human→human reaction 是纯社交事实；Human→Agent 的 👍/👎 是路由校准事实，两者不共用记录/API。 | 同上 `:11-22` |
| HA-07 | A | Human 入群依赖一次性邀请与接受/拒绝；Agent 由 owner/admin 配置 participation 和非空 tool grants 后加入。 | `/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:35-67` |
| HA-08 | A | 客户端不能自行提交消息 `authorId`/`authorKind`；作者由认证 principal 和当前成员关系派生。 | 同上 `:5-13`、`:28-33` |
| HA-09 | A | 移除成员保留其历史消息，但立即终止新读写、寻址和实时投递；权限必须在服务端方法中执行，不能只靠 UI 隐藏。 | 同上 `:69-106` |

### 3.3 消息、同步与权威事实

| ID | 等级 | 结论 | 本地来源 |
| --- | --- | --- | --- |
| MS-01 | A | 消息 ACK 只表示身份/成员/内容校验通过且已耐久接受；不表示其他客户端已收到、异步 worker 已完成或 Agent 已回应。 | `/Users/leo/code/Dao/docs/protocols/message-ack.md:5-12`；`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:61-70` |
| MS-02 | A | 历史与实时采用“先订阅，再读历史”，客户端按稳定 `Message.id` 去重，历史不能覆盖更新的实时状态。 | `/Users/leo/code/Dao/docs/protocols/message-ack.md:14-20` |
| MS-03 | A | SQLite Authority 是当前事实源；renderer cache、snapshot、内存订阅和已发送未标记的帧都不是事实源。 | `/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:1-3`、`:33-53` |
| MS-04 | A | Human command 的领域事实、稳定事件、幂等记录和 outbox 同事务提交；transport 是 at-least-once，客户端按稳定 `eventId` 逻辑去重，不能声称物理 exactly-once。 | 同上 `:61-72` |
| MS-05 | B | 当前 authority schema 为 v11；v6–v11 依次加入 runtime、single route、OpenItem、LightTask、Ball 和 hard human preemption。 | `/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:4`、`:1354-1359` |

### 3.4 M3 runtime、路由、承诺与调度

| ID | 等级 | 结论 | 本地来源 |
| --- | --- | --- | --- |
| M3-01 | A | M3 的依赖顺序为 T-0041 → T-0016/T-0017；继而 T-0016→T-0020，T-0017→T-0018→T-0019。路由、执行、承诺和调度是不同权威层。 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:5-21`、`:37-42` |
| M3-02 | A | 生产 runtime 使用真实 OpenAI Responses 流式 Provider，不存在生产 mock fallback；缺少 secret 时必须显式 noauth。 | `/Users/leo/code/Dao/docs/deliveries/T-0041-真实Agent运行时模型供应商与工具权限-交付说明.md:5-15`、`:65-79` |
| M3-03 | A | 每次工具调用复核 Agent capability、room membership、membership grant 和 execution grant；side-effecting 工具需要一次性、参数绑定的 Human confirmation。 | 同上 `:17-21`、`:49-54`、`:71-79` |
| M3-04 | A | runtime 执行状态为 queued/running/completed/failed/cancelled；取消先提交权威状态再传播 abort，partial stream 不进入权威消息历史，迟到旧 attempt 不得覆盖新状态。 | 同上 `:23-47` |
| M3-05 | A | 每条 room message 恰有一个 RouteJob；路由只读当前消息和闭合摘要，显式 `@agent` mandatory intent 与 provider 候选按 sourceMessage/agent 去重。 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:62-74` |
| M3-06 | A | participation 为 silent/on-mention/active；direct `@` 可一次性唤醒三档，结构化 Agent 求助只唤醒 on-mention/active，领域/风险/持球主动触发只允许 active。 | 同上 `:66-72` |
| M3-07 | A | 每个 RouteJob 对创建时的 Agent 成员形成闭集；每个成员必须有唯一最终 judgment 与原因，provider 失败不能吞掉 mandatory intent；消息 ACK 不等待路由。 | 同上 `:66-72` |
| M3-08 | A | 在线校准为 useful/not_needed `+2/-2`、👍/👎 `+1/-1`，按 Agent/topic 幂等累积并截断到 `[-4,4]`；Human→Human reaction 不影响路由。 | 同上 `:69-72` |
| M3-09 | A | OpenItem 是有唯一 owner 的闭合权威承诺，状态为 awaiting/answered/deferred/transferred，转交链不可改写；不能从自然语言猜 proposal 或 target。 | 同上 `:76-87`；`/Users/leo/code/Dao/docs/deliveries/T-0017-待答项最轻的承诺单位-交付说明.md:5-34` |
| M3-10 | A | LightTask 不依赖 GBP；普通“我来做”不创建任务，只有 Human 显式确认才创建；状态只有 todo→claimed→delivered→verified。 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:89-100` |
| M3-11 | A | LightTask claim 冻结 claimant role；deliver 解析唯一且不同角色的 verifier actor；只有持久化 verifierActorId 能验收，并逐条确认 criteria。 | 同上 `:93-98` |
| M3-12 | A | BallInCourt 是 OpenItem、LightTask 与只读 Blueprint fact 的投影，不是第二套可写状态；每个 source 只能有一个 holder。 | 同上 `:102-113`；`/Users/leo/code/Dao/docs/deliveries/T-0019-球的统一定义与持球义务-交付说明.md:9-21` |
| M3-13 | A | Agent 逾期球持久化一次不可抑制的结构化触发，由下一次唯一 RouteJob 消费；它不另建 autonomous invocation。Human 球只产生本人 needs-action/reminder，系统不能代 Human 发言，已读也不清除“需要我动”。 | `/Users/leo/code/Dao/docs/deliveries/T-0019-球的统一定义与持球义务-交付说明.md:23-45`、`:90-91`；`/Users/leo/code/Dao/docs/protocols/authoritative-sync.md:80-84` |
| M3-14 | A | “人来让位”是不可配置的硬 preemption fence：先耐久接受 Human 消息，再安全取消同 room 旧 work，再基于最新状态创建唯一 RouteJob 和 replacement。 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:115-126` |
| M3-15 | A | M3 只交付 room-scoped needs-action/reminder；跨群收件箱和通知送达属于 M4。 | 同上 `:104-111`；`/Users/leo/code/Dao/docs/deliveries/T-0019-球的统一定义与持球义务-交付说明.md:41-45`、`:90-92` |
| M3-16 | A | M3 的 Blueprint 边界只有闭合只读端口；真实 GBP 读写属于 M5。 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:102-111` |
| M3-17 | B | 当前生产 Blueprint adapter 恒空。 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:355-365` |

## H4. 当前实现反推的产品事实

下表均为 **B｜实现反推**，只描述当前代码，不主张是遗失规格原文。

| ID | 当前代码确实如何工作 | 代码/测试来源 |
| --- | --- | --- |
| B-01 | Core 在类型层把 HumanActor 与 AgentActor、HumanMembership 与 AgentMembership 分开；Server persistence contracts 另把 Human/Agent command 分开，并用 guard 拒绝非法跨语义状态。 | `/Users/leo/code/Dao/packages/core/src/index.ts:1-104`；`/Users/leo/code/Dao/packages/core/src/collaboration.ts`；`/Users/leo/code/Dao/packages/server/src/persistence/contracts.ts:373-490`；对应 type-test/test |
| B-02 | 当前服务端组合根真实装配 OpenAI Responses provider、HTTP JSON read、repository git status、sandbox file write、route runtime、human preemption 和 Ball runtime。 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:245-366` |
| B-03 | 缺少 `OPENAI_API_KEY` 时 readiness 返回 `noauth`；默认模型是 `gpt-5-mini`，默认 endpoint 是 OpenAI Responses API。默认值是当前实现选择，不是已恢复的遗失产品要求。 | 同上 `:245-251`、`:276-295` |
| B-04 | OpenItem/LightTask 默认逾期阈值都是 24 小时；生产 Blueprint projection 为空。24 小时是实现具体化，不能反写成原规格。 | 同上 `:355-365` |
| B-05 | Server 以 `startAuthoritativeServer(options)` 作为库式组合入口，调用方必须提供数据库路径、snapshot cache、actors、identity adapter 和 invitation secret；server package 没有独立 `start` script。 | 同上 `:41-66`；`/Users/leo/code/Dao/packages/server/src/index.ts:8-12`；`/Users/leo/code/Dao/packages/server/package.json:15-17` |
| B-06 | Desktop 的生产入口只加载本地静态 renderer；preload 为空；默认页面渲染空群，query 参数只进入视觉/原语/join review preview。 | `/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`；`/Users/leo/code/Dao/packages/desktop/src/preload.ts:1`；`/Users/leo/code/Dao/packages/desktop/src/renderer/main.ts:14-23` |
| B-07 | Desktop package 不依赖 server package，也没有 IPC/WebSocket 登录、房间订阅、消息发送或权威 command 桥；因此当前桌面不是已接通后端的端到端产品。 | `/Users/leo/code/Dao/packages/desktop/package.json:6-14`；同上三份 desktop 入口文件；全目录代码核读 |
| B-08 | Desktop 已有 Human/Agent 分离、OpenItem、LightTask、Ball、route judgment、runtime 和 preemption 的静态可审查渲染及 DOM 测试；这些 fixture/review preview 不能证明真实数据链已接通。 | `/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts`；`/Users/leo/code/Dao/packages/desktop/src/renderer/app.test.ts` |
| B-09 | Desktop 有可恢复 cursor/snapshot 的 client sync replica 及单元测试，但当前 renderer/main/preload 没有把它接到服务端和 UI。 | `/Users/leo/code/Dao/packages/desktop/src/sync/client-sync-replica.ts`；同目录测试；`/Users/leo/code/Dao/packages/desktop/src/renderer/main.ts:1-24` |
| B-10 | 当前 topic 相似度使用 64 维版本化 stable-hash embedding、最近 8 条可见消息与 cosine 0.82 阈值，不是真实语义 embedding endpoint。 | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-decision.ts:142-177` |
| B-11 | Agent runtime 全局最多 8 个 active、同 room 最多 1 个 active、每 room 最多 32 queued，最多 3 attempts、1 秒/4 秒退避；route runtime 另有最多 8 active rooms、每 room 32 queued。 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/contracts.ts:11-14`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:143-180`、`:419-438`；`/Users/leo/code/Dao/packages/server/src/route-runtime/route-runtime-service.ts:68-84` |
| B-12 | 当前数据库迁移已经把 M3 事实落到 schema v11，而不是只停留在 UI 卡片或内存模型。 | `/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:4`、`:1354-1359` 及 schema/store 测试 |

### 4.1 权威产品面与兼容性表面的边界

以下均为 **B｜实现反推**。它们用于纠正“某段代码存在，所以生产产品已经提供该能力”的误读。

| ID | 当前边界 | 代码/测试来源 |
| --- | --- | --- |
| B-SURFACE-01 | 当前权威 ClientFrame 没有 room lifecycle/governance、read receipt、独立 Agent judgment、calibration、edit/recall/correction、social reaction、`@all` 或 `@here` 命令。 | `/Users/leo/code/Dao/packages/server/src/protocol.ts:256-281` |
| B-SURFACE-02 | room lifecycle service 虽在组合根创建，却没有传入 WebSocket server；所以库内有治理能力不等于网络客户端可调用。 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:239-244`、`:387-396` |
| B-SURFACE-03 | `@human`→OpenItem、`@agent`→旧 mock execution、`@all/@here`、edit/recall/correction 和 social reaction 只完整存在于 compatibility in-memory primitives。Human read 与 calibration 已有 SQLite authoritative command/event/outbox，但没有 ClientFrame；生产组合根不能把 compatibility API 当默认网络协议。 | `/Users/leo/code/Dao/packages/server/src/primitives.ts:142-198`、`:235-250`、`:322-425`、`:628-906`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2630-2672`、`:3285-3417`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:239-243` |
| B-SURFACE-04 | 当前 durable 网络命令提供显式 `agent.invoke` 与 `open-item.create`。正文 direct Agent mention 只识别精确 Actor ID 并进入 RouteJob；Human mention 不自动创建 OpenItem。 | `/Users/leo/code/Dao/packages/server/src/protocol.ts:175-225`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3980-3985` |
| B-SURFACE-04a | 显式 `agent.invoke` 允许 Human 客户端提交 `direct_mention`、`structured_help` 或 `routed_candidate`，并直接调用 runtime 创建 execution，不经过 RouteJob；这与当前计划要求显式 `@agent` 合并进单次路由的 A 级合同冲突。 | `/Users/leo/code/Dao/packages/server/src/protocol.ts:829-843`；`/Users/leo/code/Dao/packages/server/src/websocket.ts:1656-1685`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:443-457`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4735-4822`；对照 `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:66` |
| B-SURFACE-05 | Actor 当前是启动时完整 payload seed；同 ID 的 displayName、reachability/readiness 或全局 tool capability 任一变化都会冲突，没有在线 actor-profile/presence transition producer。 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-worker.ts:400-466`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:140-152`；`/Users/leo/code/Dao/packages/server/src/persistence/sqlite-authoritative-store.test.ts:3324-3362` |
| B-SURFACE-06 | Provider/model/key 当前是全局单配置，不是 per-Agent。Authority runtime context 只有 authorId、没有 authorKind；OpenAI adapter 又丢弃 authorId，把全部可见消息映射为 `user` role。 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:245-251`、`:276-295`、`:326-330`；`/Users/leo/code/Dao/packages/core/src/collaboration.ts:252-259`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4705-4733`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:109-112` |
| B-SURFACE-07 | runtime service 的 readiness callback 只检查全局 API key；持久 Actor.readiness 是另一项静态 seed。route/direct invoke 忽略 Actor.readiness，工具 dispatch 才要求 Actor `ready`。 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:276-281`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2540-2554`、`:4748-4756`、`:5270-5296`、`:5420-5456` |
| B-SURFACE-08 | 只有 participation=`active` 时，runtime context 才给出 room tool grants；silent/on-mention 即使 direct invoke 也得到零工具。自动 routed/replacement job 没有 Human confirmation context，因此不能直接执行 side-effecting 工具。 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4683-4704`、`:5299-5302`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:475-504` |
| B-SURFACE-09 | Router 的 capability snapshot 使用 Agent 全局 capability，没有按当前 room grant 收窄；实际 tool dispatch 才取 capability 与 room grant 交集并 fail closed。 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2540-2607`、`:4114-4198`、`:4683-4704`、`:5270-5496` |
| B-SURFACE-10 | 当前有两套独立“已判定”事实：M2 `AgentJudgement` 写 `agent_judgments`，M3 `RouteJudgment` 写 `route_judgments`，repair/event kind 也不同；route runtime 不会填 M2 表。 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3473-3525`、`:3994-4028`、`:4275-4297`；`/Users/leo/code/Dao/packages/core/src/sync.ts:55-67`、`:165-175` |

## H5. 十四条原语证据矩阵

**结论：没有恢复十四条原语的完整原始名称、完整定义、原顺序或 P-01～P-14 设计稿映射。** 下表的 1～14 是本次重建的占位追踪槽位；即使当前计划明确出现 `#n`，也只表示该编号语义在现存文档中可见，不表示已经找回原 PRD 的正式标题。

| 占位槽位 | 状态 | 可安全记录的当前语义 | 不能声称的内容 | 本地来源 |
| --- | --- | --- | --- | --- |
| 1 | **已恢复｜A** | Human 与 Agent 共同在场，但身份数据与视觉形态分离 | 原始正式名称/P-01 画板原文 | `/Users/leo/code/Dao/docs/deliveries/T-0011-消息基础设施与人-agent-视觉分离-交付说明.md:15-25` |
| 2 | **已恢复｜A** | Human 已读与 Agent 已判定分离；Agent 沉默必须有闭合原因 | 原始正式名称和所有 UI 状态 | `/Users/leo/code/Dao/docs/deliveries/T-0012-已读与已判定分离-交付说明.md:11-24`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:64` |
| 3 | **已恢复｜A** | Agent“正在做什么”由权威执行状态/动作类别表达，不用假的 typing animation | P-03 原设计稿 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:48-58` |
| 4 | **已恢复｜A** | `@human` 是请求，`@agent` 是调用 | 原始完整标题 | 同上 `:50`、`:76-87` |
| 5 | **部分恢复｜A；精确映射未知｜D** | A：现行编辑/撤回、追加更正与在线校准语义可恢复；D：现存资料只把 #5/#11/#12 并列引用，#5 的原名与同 #12 的分工无法拆分 | 不得擅自命名或与 #12 对调；具体新命名才属于 C | `/Users/leo/code/Dao/docs/plans/2026-08-07-t0014-message-reaction-separation.md:12-16`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:64` |
| 6 | **已恢复｜A** | Human 邀请加入；Agent 以 participation + tool grants 配置加入 | 原始完整标题/成员列表全部 UX | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:48-58`；`/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:35-67` |
| 7 | **已恢复｜A** | “纯未读”与“需要我动”分离，行动事实来自 OpenItem/LightTask/Ball | 原始完整标题 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:76-111` |
| 8 | **已恢复｜A** | Agent participation 的 silent/on-mention/active 三档进入发言判定 | 原始完整标题 | 同上 `:62-72` |
| 9 | **已恢复｜A** | 消息顺序中的“人来让位”是不可配置硬规则 | P-09 画板原文 | 同上 `:27-31`、`:115-126` |
| 10 | **未知｜D** | 没有可唯一归属的名称或语义 | 不得用 M3/M4 任务标题补齐 | 未找到直接证据 |
| 11 | **已恢复｜A（标题不完整）** | Agent 消息作为行为记录，不可编辑/撤回，只能追加更正 | 原始正式标题 | `/Users/leo/code/Dao/docs/deliveries/T-0011-消息基础设施与人-agent-视觉分离-交付说明.md:17`；`/Users/leo/code/Dao/docs/deliveries/T-0014-编辑撤回与表情回应人agent分治-交付说明.md:9-18` |
| 12 | **部分恢复｜A；精确映射未知｜D** | A：Human→Agent reaction/calibration 的现行语义可恢复；D：它与 #5 的原始分工和 #12 原名不明 | 不得把“表情”直接宣称为 #12 原名；具体新命名才属于 C | `/Users/leo/code/Dao/docs/plans/2026-08-07-t0014-message-reaction-separation.md:12-16`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:64-71` |
| 13 | **已恢复｜A（标题不完整）** | Human membership 是社会角色/加入事实；Agent membership 携带 participation/tool permissions，工具权限可见且执行时复核 | 原始正式标题和全部成员列表交互 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:48-58`；`/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:51-67` |
| 14 | **未知｜D** | 没有可唯一归属的名称或语义 | 不得猜测 | 未找到直接证据 |

陈旧蓝图只能直接恢复六个短名：“在场、已读、@、编辑撤回、表情、成员列表”，来源 `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:83-85`。它没有给出六项与原编号的映射；“编辑撤回”是一项还是两项、“成员列表”对应哪个编号也未知。

## H6. 当前实现与遗失设计可能存在的差异

| 差异/演进 | 等级 | 证据与影响 |
| --- | --- | --- |
| 旧 T-0013 使用 mock 工具调用，T-0041 后改为真实 Provider 和三种受限工具，无生产 mock fallback | A｜明确演进 | `/Users/leo/code/Dao/docs/deliveries/T-0013-at请求与调用双语义-交付说明.md:5`；`/Users/leo/code/Dao/docs/deliveries/T-0041-真实Agent运行时模型供应商与工具权限-交付说明.md:7-21`。旧交付不能描述当前 runtime。 |
| T-0039 的 session/room JSON 与 message JSONL 后被 T-0040 SQLite Authority 替代 | A｜明确演进 | `/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:108-126`；`/Users/leo/code/Dao/docs/deliveries/T-0040-服务端权威持久化多客户端同步与故障恢复-交付说明.md:3-20` |
| T-0040 交付时 schema 为 v5，当前已演进到 v11 | A+B｜明确演进 | T-0040 交付 `:15`；`/Users/leo/code/Dao/packages/server/src/persistence/schema.ts:4`、`:1354-1359` |
| OpenItem 旧状态 `pending_response/responded` 已迁移为 `awaiting/answered` | A｜明确迁移 | `/Users/leo/code/Dao/docs/deliveries/T-0017-待答项最轻的承诺单位-交付说明.md:58-63` |
| T-0016 交付时 BallSummary 为空，T-0019 后已接通 Ball authority | A｜交付时序 | T-0016 交付 `:27-30`、`:82`；T-0019 交付 `:23-27`。不能把旧空实现写成当前缺口。 |
| 当前没有已批准的 room-phase 权威 producer；production 默认 discussion；structured Agent help 的上游 producer 仍是 seam | A+B｜已知未闭环 | `/Users/leo/code/Dao/docs/deliveries/T-0016-四层发言判定与单次路由架构-交付说明.md:32-37`、`:94-98`；route 源码核读 |
| 当前 topic embedding 是本地 stable-hash，而非真实语义 embedding | B｜实现具体化 | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-decision.ts`；是否符合遗失设计为 D。 |
| T-0018 计划使用 ActorId/当前成员语义，当前 command 路径只允许 authenticated Human 创建/流转 LightTask | A+B｜计划/实现收窄 | `/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:93-98`；T-0018 交付 `:23-27`、`:65-70`。Agent 能否参与流转需 owner 决定。 |
| 已 dispatched 的 side-effect tool 不被“人来让位”强杀；这是安全边界，但比 T-0020 计划字面范围更宽 | A+B｜安全例外 | T-0020 计划 `:119-126`；T-0020 交付 `:18-24`、`:70-74`。需 owner 显式批准为产品语义。 |
| replacement 当前是新 execution + `supersedesExecutionIds` lineage，不是同 execution 的新 attempt | B｜实现具体化 | T-0020 交付 `:11-16`、`:26-30` 及 human-preemption 源码/测试。需 owner 决定规范措辞。 |
| OpenItem/LightTask 默认 24 小时 | B｜实现具体化 | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:355-365`。遗失设计阈值未知，待 owner 批准。 |
| Agent 入群要求非空 tool grants，无工具的纯对话 Agent 不能成为 room member | A+B｜当前边界 | `/Users/leo/code/Dao/docs/protocols/identity-room-lifecycle.md:51-67`。是否符合长期产品意图未知。 |
| 生产 Blueprint adapter 为空 | A+B｜明确范围 | T-0019 交付 `:41-45`、`:88-92`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:355-365`。不得写成“已接入宏伟蓝图”。 |
| Server 的闭合领域/协议能力没有接入 Desktop 生产入口 | B｜当前产品断点 | `/Users/leo/code/Dao/packages/desktop/src/main.ts:8-15`、`preload.ts:1`、`renderer/main.ts:14-23`、desktop `package.json:6-14`。当前 UI 主要是静态评审/fixture。 |
| 真实 OpenAI live smoke 在本环境因无 secret 跳过 | A+B｜验证边界 | T-0041 交付 `:81-100`；本次 `pnpm test` 的两个 live 文件跳过。不能声称真实 endpoint/SLA 已在目标环境验证。 |
| 当前 Alpha 是单机 SQLite/单 AuthorityWorker，不提供多进程 writer lease，也不保证跨 room 调度公平 | A+B｜技术边界 | T-0040 交付 `:24-33`、`:64-67`；T-0021 计划 `:143-149` |
| T-0012～T-0014 的完整产品语义没有全部进入当前权威网络协议 | A+B｜规格/产品面差距 | 当前计划/交付明确 read/judged、@ 双语义、edit/recall/reaction；但 `/Users/leo/code/Dao/packages/server/src/protocol.ts:256-281` 缺少相应 ClientFrame，兼容实现位于 `primitives.ts`。 |
| 当前 Actor profile/presence 是静态 seed，不支持在线更新 displayName、全局 tool capability、可达性/就绪度 | B｜实现具体化 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-worker.ts:400-466`；没有 profile transition/heartbeat producer。遗失设计的在线规则未知。 |
| 当前模型上下文抹平多方 speaker 身份 | B｜实现具体化 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/openai-responses-provider.ts:109-112` 把可见消息都映为 `user`；这可能弱化“多人多 Agent 在场”语义，需 owner 明确模型上下文合同。 |
| 当前 direct mention 依赖 raw Actor ID，没有结构化 mention entity/displayName 解析 | B｜实现具体化 | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:3980-3985`。客户端寻址合同待批准。 |
| 显式 `agent.invoke` 当前绕过单次 RouteJob | A+B｜合同/实现冲突 | A：T-0021 计划要求显式 `@agent` 成为同消息 mandatory intent，`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:66`。B：ClientFrame 可直接提交三种 intent kind 并创建 execution，见 B-SURFACE-04a。 |
| M2 `AgentJudgement` 与 M3 `RouteJudgment` 是两套未统一事实 | B｜实现边界 | 两套表、event/repair kind 分离，route 不会写 M2 表；见 B-SURFACE-10。是否保留两套语义为 D。 |
| Agent overdue Ball 的“下一次唯一 RouteJob 消费”未闭合 | A+B｜合同/实现冲突 | A：T-0019 要求一次持久结构触发由下一次唯一 RouteJob 消费，不另建 autonomous invocation；B：scan 会持久化 boundary claim、`room.ball.overdue` event/outbox；零 queued 时首个后续新 RouteJob 会消费 claim，符合 A。差距是有多个既有 queued RouteJob 时会全部标 `has_ball` 且不消费 claim，之后新 RouteJob 仍可能再次消费同一 claim。来源：`/Users/leo/code/Dao/docs/deliveries/T-0019-球的统一定义与持球义务-交付说明.md:90-91`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:283-300`、`:2564-2614`；`/Users/leo/code/Dao/packages/server/src/ball-runtime/ball-authority.test.ts:108-169`。 |
| Router 看到全局 capability，不按当前 room grant 收窄 | B｜实现具体化 | provider 可能基于本房间不可用能力做候选判断；dispatch 仍会取交集并 fail closed。来源：B-SURFACE-09。 |

### 6.1 代码审计发现的实现风险

每行第一列和代码路径是 **B｜可直接证明的代码条件**；“产品影响”是 **D｜风险是否实际可达、频率与严重性未知**，除非测试已直接覆盖。相应测试或修复方案才属于 **C｜重建提案**。这些不是批准后的产品行为，也不等同于已复现的线上事故；本轮不修改生产代码。

| B｜可证明的代码条件 | 当前代码证据 | D｜待验证的产品风险 |
| --- | --- | --- |
| 客户端可控 `sentAt` 被用于历史、模型上下文和部分路由时序 | `/Users/leo/code/Dao/packages/server/src/protocol.ts:512-521`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:2432-2448`、`:674-700`、`:4147-4167`、`:4705-4712` | 恶意或漂移时间可改变展示/判定顺序；真正权威事件序是 `streamSeq` |
| 消息已 commit 后若 human-preemption 抛错，WebSocket 可能返回 error 而不是 ACK | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:202-220`；`/Users/leo/code/Dao/packages/server/src/websocket.ts:1539-1556` | 客户端遇到“是否已接受”的 ambiguous outcome，违背 ACK 可理解性 |
| RouteJob 可先 completed，再在 invoke 异常时只 report；恢复只捞 queued job | `/Users/leo/code/Dao/packages/server/src/route-runtime/route-runtime-service.ts:228-239`；`/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:4299-4381` | 可能出现 `will_respond` judgment 已落而 execution 丢失 |
| ephemeral Agent preview 发布不重新校验 token/membership | `/Users/leo/code/Dao/packages/server/src/websocket.ts:2090-2105`；对照 durable outbox `/Users/leo/code/Dao/packages/server/src/outbox-dispatcher.ts:99-125` | 已撤权 socket 可能继续收到非权威 partial preview；缺少对应授权测试 |
| side-effect confirmation 在运行期没有过期 timer，仅重启恢复时清过期 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/worker-runtime-authority.ts:225-241`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:305-317`；`authority-database-handler.ts:5592-5615` | 无人确认的 execution 可能长期停在 waiting |
| sandbox write 只做 lexical path resolve；symlink 越界、二进制 preimage 补偿和 preimage size 未形成闭合防线 | `/Users/leo/code/Dao/packages/server/src/agent-runtime/tools/sandbox-file-write.ts:67-99`、`:111-155`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/tool-adapters.test.ts:70-95` | side-effect 工具的边界仍需安全收紧 |
| 组合根不调用 compactor，默认没有 retention；identity stream 也无 compactor | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:900-965`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:125-396`；`/Users/leo/code/Dao/packages/server/src/index.ts:186-207` | room event/outbox/identity 数据会持续增长 |
| outbox 以 10ms poll 热重试且无 backoff；一个 peer 失败会让已成功 peer 重收同 logical event | `/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:387-396`；`/Users/leo/code/Dao/packages/server/src/outbox-dispatcher.ts:118-141`；`authority-database-handler.ts:1312-1331`；`outbox-dispatcher.test.ts:245-278` | 依赖客户端逻辑去重，故障期可能产生高频重复流量 |
| checkpoint 虽持久化，composition/recovery 没有恢复 committed steps/tool continuations；恢复时还把原 intent 重构为 `direct_mention` | `/Users/leo/code/Dao/packages/server/src/persistence/authority-database-handler.ts:5539-5673`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:284-295`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/agent-runtime-service.ts:696-714`；`/Users/leo/code/Dao/packages/server/src/agent-runtime/contracts.ts:140-143` | 重启后非 side-effect 步骤可能从头执行，routed/structured provenance 可能丢失 |
| human preemption runtime 没有 `close()`，server cleanup 不等待其串行 tail | `/Users/leo/code/Dao/packages/server/src/human-preemption/human-preemption-runtime.ts:28-31`、`:84-117`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:397-430` | shutdown 时可能与正在执行的 preemption 竞态 |
| package root 同时公开 legacy JSON/JSONL/in-memory API 与 SQLite authoritative API | `/Users/leo/code/Dao/packages/server/src/index.ts:32-56`、`:93-102`、`:155-183`；`/Users/leo/code/Dao/packages/server/src/authoritative-server.ts:11-16`、`:132-139`、`:239-243` | 调用方可能误选非默认事实源；新基线需明确 compatibility/legacy 标签 |

## H7. 陈旧档案的证据风险

### 7.1 T-0036 ID 冲突

- **A｜已恢复的历史事实**：陈旧蓝图的 T-0036 是“产出产品定义基线：PRD + 设计稿 + 交互原型”，见 `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:850-909`。
- **A｜已恢复的迁移快照事实**：迁移包把当前仓库的 T-0036 指向“项目骨架与零 I/O 领域内核”，见 `/Users/leo/Downloads/ai-development-context-portable/docs/projects/agent-im.md:95`。
- **A｜已证明的档案冲突**：同一个 T-0036 在两份档案中明确指向两个不同标题与交付物。
- **D｜未知**：何时、为何发生重编号以及两条历史如何关联无法恢复。禁止只按 ID 合并，也禁止写“T-0036 已完成”而不带来源和标题。

### 7.2 蓝图没有正式 decision 记录

- **A｜档案事实**：顶层 JSON 没有 `decisions` 字段；`timeline` 共 14 条，其中 3 条 `status`、11 条 `structure`、0 条 `decision`，见蓝图 `:911-1072`。
- **A｜档案事实**：renderer 只把同时具有 `kind === "decision"` 和 `id` 的 timeline 项视为正式 decision，见蓝图 `:1886-1940`；因此可恢复的正式 decision 集合为空。
- **D｜未知**：H1/H1b go/no-go、各 M3 交付的 owner 验收和当前 Blueprint horizon 均没有可恢复的正式决策记录。

### 7.3 蓝图链接断裂且来源链不完整

- **A｜档案事实**：蓝图引用的以下四个路径在当前示例目录均不存在；只能证明“蓝图曾声明有这些链接”，不能恢复正文：
  - `/Users/leo/code/grand-blueprint-context/示例/2026-08-agent群聊协作模式-prd.md`
  - `/Users/leo/code/grand-blueprint-context/示例/2026-08-agent群聊协作模式-设计稿.html`
  - `/Users/leo/code/grand-blueprint-context/示例/2026-08-agent群聊协作模式-交互原型.html`
  - `/Users/leo/code/grand-blueprint-context/示例/journal.jsonl`
- **A｜来源**：蓝图 `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:31`、`:893-905`、`:1074-1090`；非 Git/无版本历史风险见 `/Users/leo/Downloads/ai-development-context-portable/docs/projects/articles.md:15-17`、`:46-50`、`:54-59`。
- **A｜迁移事实**：迁移包记录的旧权威路径是 `/Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html`，当前提供的是 `/Users/leo/code/grand-blueprint-context/示例/...`，且没有哈希证明两者字节一致。来源：`/Users/leo/Downloads/ai-development-context-portable/docs/projects/agent-im.md:66-70`。
- **D｜未知**：当前示例是否就是旧权威文件的精确副本。

### 7.4 状态与执行漂移

- **A｜档案事实**：蓝图更新时间是 2026-08-05，且把 M2 任务保留为 seed/todo；迁移包 2026-08-09 已记录 M2 工作树与实现骨架。来源：蓝图 `:24-37`、`:437-486`；`agent-im.md:9-22`。
- **B｜当前事实**：当前 `main` 已包含 M2/M3 大量领域和服务端实现。
- **D｜未知**：上述实现是否经过了旧蓝图要求的 H1/H1b/H3 实验或当前 owner 的正式验收。代码存在不能替代产品假设结论。

## H8. 里程碑与历史任务标题

### 8.1 可恢复的早期里程碑

以下均为 **A｜已恢复的早期意图**，不作为当前任务状态：

| 里程碑 | 早期边界 | 当前证据结论 | 来源 |
| --- | --- | --- | --- |
| M1 前置验证与解阻 | H1/H1b/H3 报告、冻结阈值下的 go/no-go；裁定 GBP 权威版本 | D：实验数据和正式结论未找到 | 蓝图 `:76-82`、`:108-152` |
| M2 IM 底座 | 在场、已读、@、编辑撤回、表情、成员列表完成人/Agent 分离；≥3 Human + ≥4 Agent 同群收发 | B：领域、服务端和静态 UI 证据较强；D：真实桌面端到端与 owner 验收未知 | 蓝图 `:83-86`；T-0011～T-0014/T-0039/T-0040 交付；当前代码 |
| M3 发言判定与承诺原语 | 旧 exit：四层判定按单次路由落地；待答项/轻任务可用；Ball 跨讨论期/轻量群/蓝图群统一；噪音率首次可测 | A：当前 T-0021 将真实 runtime 纳入扩展后的 M3；B：schema/runtime 大量实现存在；B 差距：显式 `agent.invoke` 绕过 RouteJob、Agent overdue Ball 的 boundary claim 未保证只由下一次唯一 RouteJob 消费、room phase/structured help 未闭合、LightTask human-only、Desktop 未接线；D：真实 endpoint 与 owner 验收 | 蓝图 `:87-91`；`/Users/leo/code/Dao/docs/plans/2026-08-12-t0021-expand-m3.md:5-21`；本文第 4、6 节 |
| M4 高频路径与多端 | 跨群五分区 inbox、四级通知/紧急规则、移动端看/回/批/验、共用搜索索引 | A：只恢复方向；D：详细规则未恢复，当前实现不在本轮证据中 | 蓝图 `:92-95`；T-0019/T-0021 的 M3 边界 |
| M5 蓝图接入 | GBP 三字段、写入队列/版本确认、分权验收、自托管 | A：只恢复方向；B：当前生产 adapter 为空 | 蓝图 `:96-100`；T-0019 交付与 server composition root |
| M6 形态验证 | 真实团队完整 idea、连续四周指标 | A：只恢复方向；D：真实团队结果和指标定义未找到 | 蓝图 `:101-106` |

### 8.2 陈旧蓝图中的任务标题目录

以下只是 **A｜已恢复的历史标题**；不迁移 `todo/verified` 状态。

- M1：T-0001「设计 H1 / H1b 对照实验方案」；T-0002「准备实验素材：3 个真实 idea 场景与对照组基线」；T-0003「搭建实验组最小群聊原型」；T-0004「招募实验用户」；T-0005「执行对照实验与盲评」；T-0006「产出结论报告与 go / no-go 决策」；T-0007「裁定 GBP 权威版本并合并两份 protocol.md」；T-0008「起草 GBP 字段扩展提案并提交变更治理」；T-0009「补记三条摩擦到 journal」；旧 T-0036「产出产品定义基线：PRD + 设计稿 + 交互原型」。来源：蓝图 `:154-435`、`:849-909`。
- M2：T-0010「人与 agent 的在场体系：可达性与就绪度分离」；T-0011「消息基础设施与人 / agent 视觉分离」；T-0012「已读 / 已判定分离」；T-0013「@ 的请求 / 调用双语义」；T-0014「编辑撤回与表情回应的人 / agent 分治」；T-0015「展开 M2 · IM 底座」。来源：蓝图 `:437-516`。
- M3：T-0016 `四层发言判定 · 单次路由架构`；T-0017 `待答项：最轻的承诺单位`；T-0018 `轻任务：轻量群的最小承诺`；T-0019 `「球」的统一定义与持球义务`；T-0020 `人来让位的硬规则`；T-0021 `展开 M3 · 发言判定与承诺原语`。来源：蓝图 `:517-618`。
- M4：T-0022「待我处理收件箱（跨群五分区）」；T-0023「通知四级分级与用户预设紧急规则」；T-0024「移动端最小集：看 / 回 / 批 / 验」；T-0025「全局搜索：与 agent 检索共用索引」；T-0026「展开 M4 · 高频路径与多端」。来源：蓝图 `:619-700`。
- M5：T-0027「GBP 三个字段扩展落地」；T-0028「写入闸门：串行队列与版本校验」；T-0029「分权验收：角色 ≠ 角色」；T-0030「蓝图面板与全景视图」；T-0031「本蓝图自托管（自举验证）」；T-0032「展开 M5 · 蓝图接入」。来源：蓝图 `:701-798`。
- M6：T-0033「真实团队试点：≥ 3 人 + ≥ 4 agent 跑通一个完整 idea」；T-0034「指标采集与连续 4 周观察（M3 / M5 / M7）」；T-0035「展开 M6 · 形态验证」。来源：蓝图 `:799-848`。

### 8.3 陈旧蓝图中的 Unknowns

以下是 **A｜已恢复的早期待验证问题**；没有找到后续正式答案，所以它们对当前结论均保持 **D｜未知**：

| ID | 早期问题 | 证伪时的早期影响 | 原定回答任务 | 来源 |
| --- | --- | --- | --- | --- |
| U-01 | 是否真的需要持续、共享、多方在场空间，而非一次性调用 | 整个品类与 M2–M6 需要重判 | T-0006 | `/Users/leo/code/grand-blueprint-context/示例/2026-08-原生人机协作IM-蓝图.html:109-116` |
| U-02 | 多 Agent 是否比单模型“多角度分析”有实质增量 | 可能退化为多人 + 少量 Agent，并简化路由 | T-0006 | 同上 `:117-123` |
| U-03 | Human 是否愿意把 Agent 拉入有其他 Human 的群，而非只私聊 | 可能退回助手模式，并重做通知/分权验收 | T-0005 | 同上 `:124-130` |
| U-04 | GBP owner 是否接受 `timeline.id`、`timeline.supersedes`、`criteria.refs` | 影响 M5 的字段与决策层交互；早期档案称已有 5 个 M5 seed 压在此未知上 | T-0008 | 同上 `:131-138` |
| U-05 | 单次路由能否把发言判定成本压到可接受量级 | 可能减少档位或退化为纯 `@` 寻址 | T-0021 | 同上 `:139-145` |
| U-06 | 意图误识别到何种程度时，写入闸门应退化为仅显式指令 | 影响静默漏识别与无人认领的可区分性 | T-0026 | 同上 `:146-152` |

## H9. 无法恢复的信息（阶段一历史状态，非当前未决）

以下全部是 **D｜未知**：

1. 原 PRD、桌面设计稿和交互原型正文、状态机、页面结构、视觉 token、响应式/移动端细节和可访问性规格。
2. 十四条原语的完整正式名称、定义、顺序和 P-01～P-14 对照，尤其 #5/#12 的分工、#10、#14。
3. H1、H1b、H3 的实验数据、冻结阈值、go/no-go 结论，以及 U-01～U-06 是否后来得到回答。
4. 蓝图 `doneWhen` 中“M3/M4/M5/M7”究竟是指标编号还是里程碑引用；指标的分母、采样窗口和数据源。
5. “成员列表”的完整 Human/Agent 差异规则以及它与 #6/#13 的编号关系。
6. 当前 owner 是否继续批准 Thread、外部 IM 桥接、无人值守执行等非目标。
7. ≥3 Human、≥4 Agent、至少两个 Agent 有不同工具/数据源是否仍是产品验收规模。
8. owner transfer、多 owner、最后 owner 离开或被移除的房间治理语义。
9. Agent 是否可以创建、认领、交付或验收 LightTask。
10. 无工具权限的纯对话 Agent 是否应允许入群。
11. room phase 的权威 producer、discussion→execution 转换权限和 structured Agent help 的产生入口。
12. OpenItem/LightTask 24 小时默认阈值是否是批准产品规则。
13. stable-hash embedding 是否可作为 Alpha 基线，还是必须迁移到真实语义 embedding。
14. “人来让位”对已 dispatched side-effect tool 的例外是否已经得到 owner 批准。
15. replacement 是“新 execution + lineage”还是“同 execution 新 attempt”的规范术语。
16. Alpha 是否必须在目标环境通过真实 OpenAI endpoint、工具和恢复 live smoke。
17. M4 五个 inbox 分区的名称、排序、聚合；四级通知名称、阈值、DND/紧急穿透规则。
18. M5 GBP 真实读取、写回、冲突处理、LightTask→GBP task 升级与权限合同。
19. 当前 Blueprint 状态、当前 horizon，以及任何旧任务的当前状态。
20. 当前各 M3 交付文档均写“等待 owner 验收”；仅凭代码进入 `main` 不能证明 owner 已 verified。

## H10. 需要 owner 决定的问题（阶段一历史队列，已由 v1 批准层处置）

下列是 owner 决策队列：每项保留既有 A/B 事实与 D 未知；只有其中给出的具体候选方案是 **C｜重建提案，待 owner 批准**。若候选与 A 级合同冲突，owner 必须显式 supersede，而不能把实现缺口静默当成新规范。

1. 是否批准本轮新文档作为今后的产品基线，并明确它取代“继续假装旧 PRD 可找回”的做法。
2. 是否继续采纳 PROD-01～PROD-06 的产品定位、原则和非目标；哪些内容需要 supersede。
3. 为十四条原语批准正式名称、编号、人/Agent 语义、权限、视觉和实现覆盖，至少先解决 #5/#12、#10、#14。
4. 如何记载 T-0036 冲突；建议所有引用都带“来源 + 标题”，禁止裸 ID 合并。
5. H1/H1b 是否仍是硬 go/no-go；若不重跑旧实验，应批准以何种真实使用证据替代。
6. 是否继续采用 ≥3 Human + ≥4 Agent、两种差异化工具/数据源、连续四周作为形态验证规模。
7. 重新定义 M3/M4/M5/M7 指标名、分母、采样窗口、事件来源和阈值。
8. 是否允许 Agent 参与 LightTask 的创建/认领/交付/验收。
9. 是否允许无工具权限的纯对话 Agent 入群。
10. 批准 owner transfer、多 owner、最后 owner 离开/移除的治理规则。
11. 批准已 dispatched side-effect tool 不被强杀的安全例外，以及 replacement 的 lineage 语义。
12. 批准或修改 OpenItem/LightTask 默认 24 小时阈值。
13. 批准 stable-hash embedding 作为 Alpha 方案，或要求真实语义 embedding 与 migration。
14. 指定 room phase 和 structured Agent help 的权威 producer、权限与可见审计入口。
15. 决定 Alpha 验收是否要求目标环境 live smoke。
16. 决定 Desktop 接通登录、房间、权威同步、消息、runtime、route 和承诺 command 的最小端到端范围。
17. 重新批准 M4 的 inbox/通知/移动端/搜索详细规格；当前只有方向，没有可执行细节。
18. 重新批准 M5 的 GBP adapter、写入闸门、版本冲突和分权验收合同。
19. 决定是否保留早期 `@all` 仅 Agent、`@here` 仅 owner 且限频的语义；该规则只在旧 T-0013 交付中出现。
20. 明确当前 M3 交付的 owner 验收状态；本索引不会代替验收或改任务状态。
21. 批准当前权威网络命令面：哪些 room governance、read/judged、mention、edit/recall/correction 和 reaction/calibration 命令必须进入 Alpha。
22. 定义 reachability/readiness 的实时 producer、heartbeat、持久/临时边界，以及 route/runtime 应在哪一步按 readiness 门禁。
23. 定义多方对话进入模型上下文时必须保留的 speaker identity/kind/role，以及是否需要 per-Agent provider/model/credential。
24. 定义 direct invoke 对 silent/on-mention Agent 的工具授权，以及自动路由 side-effect 工具由哪位 Human、在哪一刻确认。
25. 决定消息客户端时间与服务端时间的合同；展示、模型上下文和路由判定是否统一采用 `streamSeq`/server timestamp。
26. A 级 ACK 合同已要求 durable acceptance 有稳定 accepted outcome；owner 只需批准修复方案（例如 commit 后立即 receipt、preemption 提交后恢复），若不修必须显式 supersede 该合同。
27. A 级路由合同已禁止 mandatory/`will_respond` 静默丢失；owner 只需批准原子 handoff、可恢复 outbox 或等价修复方案。
28. 要求 ephemeral preview 与 durable outbox 使用同等级的实时权限复核。
29. 批准 retention、outbox backoff、checkpoint 真续跑和 shutdown drain 的 Alpha 运维边界。
30. 将旧 JSON/JSONL/in-memory exports 明确标为 compatibility/legacy，或决定移出默认 public surface。
31. 修复显式 `agent.invoke` 绕过 RouteJob 的合同冲突；若保留旁路，必须限制可提交 intent kind 并显式 supersede 单次路由合同。
32. 修复同一 Agent overdue boundary 只绑定并消费到下一次唯一 RouteJob；“零 queued 时保留 claim、等待下一次 RouteJob”是现有 A 级边界。只有要升级为 overdue 时立即 autonomous invocation，才需要 owner 显式 supersede 当前边界。
33. 决定 M2 `AgentJudgement` 与 M3 `RouteJudgment` 是合并、映射还是保留两套；未决定前不得把二者写成同一事实。
34. 决定 Router 可见 capability 是否按 room grant 收窄；dispatch fail-closed 不能消除 provider 决策输入的跨房间能力暴露。

## H11. 阶段一历史证据结论（已被顶部当前批准层取代）

- **A**：可以恢复产品的早期方向、非目标、M1–M6 路线，以及当前协议/计划中已明确的人机分离、权威同步和 M3 领域规则。
- **B**：当前 `main` 的 Core/Server 已实现并测试大量 M2/M3 权威能力；Desktop 仍主要是静态评审壳，尚未接通服务端形成端到端产品。
- **C**：新的产品基线可以据此提出，但原语命名、关键产品阈值、治理、安全例外、Desktop Alpha 范围和 M4/M5 细节都必须等待 owner 批准。
- **D**：遗失原文、旧实验结论、正式 Blueprint decisions、完整十四条原语以及当前 owner 验收状态无法恢复。

> 上述 C/D 只描述 2026-08-17 的阶段一快照。2026-08-18 owner 已通过《PRD 细节确认清单 v1》处置当前产品所需决定；当前规范结论必须回到本文 §0：`A=103, B=0, C=0, D=0`（Requirement 口径），另登记 24 个高优先级合并的 implementation-only B 类 Gap 与 8 个已批准延期。

## H-附录 A：当前代码与测试读取清单

### A.1 Core

- `/Users/leo/code/Dao/packages/core/src/index.ts`
- `/Users/leo/code/Dao/packages/core/src/index.test.ts`
- `/Users/leo/code/Dao/packages/core/src/actor.type-test.ts`
- `/Users/leo/code/Dao/packages/core/src/collaboration.ts`
- `/Users/leo/code/Dao/packages/core/src/collaboration.test.ts`
- `/Users/leo/code/Dao/packages/core/src/collaboration.type-test.ts`
- `/Users/leo/code/Dao/packages/core/src/sync.ts`
- `/Users/leo/code/Dao/packages/core/src/sync.test.ts`

### A.2 Desktop

- `/Users/leo/code/Dao/packages/desktop/src/main.ts`
- `/Users/leo/code/Dao/packages/desktop/src/preload.ts`
- `/Users/leo/code/Dao/packages/desktop/src/window.ts`
- `/Users/leo/code/Dao/packages/desktop/src/window.test.ts`
- `/Users/leo/code/Dao/packages/desktop/src/renderer/index.html`
- `/Users/leo/code/Dao/packages/desktop/src/renderer/styles.css`
- `/Users/leo/code/Dao/packages/desktop/src/renderer/main.ts`
- `/Users/leo/code/Dao/packages/desktop/src/renderer/app.ts`
- `/Users/leo/code/Dao/packages/desktop/src/renderer/app.test.ts`
- `/Users/leo/code/Dao/packages/desktop/src/sync/client-sync-replica.ts`
- `/Users/leo/code/Dao/packages/desktop/src/sync/client-sync-replica.test.ts`

### A.3 Server

以下均位于 `/Users/leo/code/Dao/packages/server/src/`：

- 根目录：`index.ts`、`authoritative-server.ts`、`auth.ts`、`auth.test.ts`、`authority.e2e.test.ts`、`fallback-repair-coordinator.ts`、`fallback-repair-coordinator.test.ts`、`invitation-secret-protector.ts`、`invitation-secret-protector.test.ts`、`outbox-dispatcher.ts`、`outbox-dispatcher.test.ts`、`primitives.ts`、`primitives.test.ts`、`protocol.ts`、`protocol.test.ts`、`room-lifecycle.ts`、`room-lifecycle.test.ts`、`service.ts`、`service.test.ts`、`state-store.ts`、`state-store.test.ts`、`store.ts`、`subscription-registry.ts`、`subscription-registry.test.ts`、`sync-service.ts`、`sync-service.test.ts`、`websocket.ts`、`websocket.test.ts`。
- `agent-runtime/`：`agent-runtime-service.ts`、`agent-runtime-service.test.ts`、`contracts.ts`、`environment-secret-provider.ts`、`human-preemption-authority.test.ts`、`openai-responses-provider.ts`、`openai-responses-provider.test.ts`、`openai-responses-provider.live.test.ts`、`runtime-authority-protocol.ts`、`secret-sentinel.test.ts`、`sse-parser.ts`、`sse-parser.test.ts`、`tool-adapters.test.ts`、`tool-gateway.ts`、`tool-gateway.test.ts`、`worker-runtime-authority.ts`、`worker-runtime-authority.test.ts`。
- `agent-runtime/tools/`：`http-json-read.ts`、`repository-git-status.ts`、`sandbox-file-write.ts`。
- `ball-runtime/`：`ball-authority-protocol.ts`、`ball-authority-protocol.test.ts`、`ball-authority.test.ts`、`ball-runtime-service.ts`、`ball-runtime-service.test.ts`、`contracts.ts`。
- `human-preemption/`：`human-preemption-runtime.ts`、`human-preemption-runtime.test.ts`。
- `persistence/`：`authority-database-handler.ts`、`authority-worker.ts`、`contracts.ts`、`contracts.test.ts`、`contracts.type-test.ts`、`legacy-importer.ts`、`legacy-importer.test.ts`、`schema.ts`、`schema.test.ts`、`snapshot-worker.ts`、`snapshot-worker-client.ts`、`snapshot-worker-client.test.ts`、`sqlite-authoritative-store.ts`、`sqlite-authoritative-store.test.ts`、`worker-database-client.ts`、`worker-database-client.test.ts`、`worker-protocol.ts`。
- `route-runtime/`：`contracts.ts`、`openai-router-provider.ts`、`openai-router-provider.test.ts`、`openai-router-provider.live.test.ts`、`route-authority-protocol.ts`、`route-decision.ts`、`route-decision.test.ts`、`route-runtime-service.ts`、`route-runtime-service.test.ts`、`worker-route-authority.ts`。
- `fixtures/`：`authority-child.ts`。
