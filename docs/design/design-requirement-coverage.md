# Agent IM 设计 Requirement 逐项覆盖矩阵

> 状态：FT-16 当前 UI / 交互基线的逐项索引
> 权威产品语义：[已批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
> 对应设计稿：[正式审阅稿](./2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.reconstructed.html) / [可编辑源稿](./2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.dc.html)

本矩阵只证明设计映射，不声称代码已经实现。每个 Requirement 只列一个主映射；跨层要求会同时标记“视觉 + 协议”。“非视觉协议”表示其正确性必须由 feature spec、服务端实现和自动化测试证明，设计稿只负责披露、状态与失败恢复，不用前端效果伪造事实。

旧 Web/移动端、OS push、五分区跨 Room inbox、全局搜索、完整 Blueprint、BYOK/多 Provider、独立 Thread 与永久删除 UI 均保持批准边界；本次没有用设计补回这些延期能力。

| Requirement ID | 分类 | 设计主映射 | 可检查的表达 / 边界 |
| --- | --- | --- | --- |
| REQ-PD-001 | 视觉 + 产品边界 | 交互原型 / Room 三栏 / J-03、J-04 | 同一 Room 同时展示 3 Human、2 Agent、共享 timeline 与 project facts；Human Request 与 Agent invocation 分轨。 |
| REQ-PD-002 | 非视觉产品治理 | 覆盖矩阵 / 工程交接 | MVP 优先与真实反馈顺序不由单个页面实现；设计不增加数字 go/no-go。 |
| REQ-PD-003 | 非视觉产品治理 | 覆盖矩阵 / 明确未设计 | 设计只提供真实旅程与失败态，不引入脱离产品的实验前置。 |
| REQ-PD-004 | 视觉 + 试点边界 | Room shell / Settings drawer | 成员与 Agent assignment 表达 2–3 Human、memory steward、participant Agent；不设置固定 Agent 数 UI 门槛。 |
| REQ-PD-005 | 视觉 + 协议 | J-02～J-07 / 状态分支 | 可追溯来源、确认、责任、真实 execution、错误与降噪状态均有可检查表面。 |
| REQ-ID-001 | 视觉 + 安全协议 | Human/Agent 消息组件 / J-03 | 圆形 Human 与方形 Agent、标签和色轨同时区分；author 只来自权威事件。 |
| REQ-ID-002 | 视觉 + 安全协议 | J-01 登录 / session 撤销态 | 仅 Human 有登录表面；每设备 session family 与撤销后的 cache 锁定可见。 |
| REQ-ID-003 | 视觉 + 协议 | J-01 邀请 / Settings 两条流程 | Human 定向邀请含历史与 AI 可见披露；Agent 走独立 assignment 流程。 |
| REQ-ID-004 | 视觉 + 非视觉治理 | Settings drawer / Agent assignment | 显示 Global Profile 与 Room Assignment 子集；Tenant Administrator 的全局权限仍是服务端协议。 |
| REQ-ID-005 | 视觉 + 安全协议 | J-01 revoked/fatal / J-07 来源不可访问 | 撤权后不展示 Room 内容、清 cache；离线租约默认值留给 FT-14。 |
| REQ-ROOM-001 | 视觉 + 协议 | Room 三栏 / 右栏 Goal | 三栏绑定同一 roomId；只显示一个 active primary Goal。 |
| REQ-ROOM-002 | 视觉 + 协议 | Settings drawer 权限态 | owner/admin/member 与唯一 owner、peer admin 禁止操作均有状态入口。 |
| REQ-ROOM-003 | 视觉 + 协议 | Settings drawer 责任冲突 / J-04 | 离群前展示 Request、NextAction、Blocker、确认与验收责任清单及转交动作。 |
| REQ-ROOM-004 | 视觉 + 协议 | 状态分支：归档 Room | 归档只读、业务 timer 冻结、安全有效期继续、未 dispatch grant 撤销与审计重开可见。 |
| REQ-PRIM-001 | 视觉 + 协议 | Human/Agent 组件 | 身份、认证、权限与视觉语义分治。 |
| REQ-PRIM-002 | 视觉 + 协议 | J-01 | Human 登录、多 session 与撤销清 cache。 |
| REQ-PRIM-003 | 视觉 + 协议 | Room 三栏 | 消息、记忆、项目事实与 assignment 同 roomId。 |
| REQ-PRIM-004 | 视觉 + 协议 | J-01 邀请 / Settings | Human 邀请与 Agent 配置分离。 |
| REQ-PRIM-005 | 视觉 + 协议 | Settings / 归档状态 | 唯一 owner、角色治理、责任清理、归档与重开。 |
| REQ-PRIM-006 | 视觉 + 协议 | J-02 / 工程交接 | durable ACK、history/realtime 同源、稳定 ID 去重。 |
| REQ-PRIM-007 | 视觉 + 协议 | 消息 reply 组件 | reply-to 绑定 messageId 且留在主时间线；不创建 Thread。 |
| REQ-PRIM-008 | 视觉 + 协议 | 状态分支：版本链 / Agent correction | Human revision/recall 与 Agent 追加更正分开。 |
| REQ-PRIM-009 | 视觉 + 协议 | J-02 附件生命周期 | 选择、上传、处理、ready、失败、安全拒绝与撤权全链路。 |
| REQ-PRIM-010 | 视觉 + 协议 | J-04 | @Human Request 在接受前不形成责任。 |
| REQ-PRIM-011 | 视觉 + 协议 | J-03 | @Agent 创建真实 accepted/running/terminal execution。 |
| REQ-PRIM-012 | 视觉 + 协议 | J-03 / execution component | 五个用户态明确；preview 标记非权威。 |
| REQ-PRIM-013 | 视觉 + 协议 | Settings Agent assignment | active/on-mention 与 ready/busy/paused/noauth 分层，无 silent。 |
| REQ-PRIM-014 | 视觉 + 协议 | 右栏 Memory / memory degraded | steward、五类记忆、来源索引与按需检索。 |
| REQ-PRIM-015 | 视觉 + 协议 | J-06 / Goal、Decision 卡 | Goal 与 Decision proposal-confirm-supersede 权威分层。 |
| REQ-PRIM-016 | 视觉 + 协议 | 右栏 NextAction | 责任、期限、交付、验收与 Human/Agent owner。 |
| REQ-PRIM-017 | 视觉 + 协议 | 右栏 Blocker/Ball / 通知 | 单 owner、升级、Ball 投影与 due reminder。 |
| REQ-PRIM-018 | 视觉 + 安全协议 | J-05 | read 自动；side effect 精确确认、grant、dispatch 与 outcome_unknown。 |
| REQ-MSG-001 | 视觉 + 协议 | J-02 ACK | accepted 仅表示耐久提交；逐 mention target outcome 独立。 |
| REQ-MSG-002 | 视觉 + 协议 | J-02 / J-07 repair | history、realtime、sync、repair 同源并按 messageId/eventId 收敛。 |
| REQ-MSG-003 | 视觉 + 协议 | composer 结构化寻址 | mention chip 与正文分离并绑定稳定 actorId。 |
| REQ-MSG-004 | 视觉 + 批准边界 | reply 组件 | 同 Room 稳定 messageId；明确不建独立 Thread。 |
| REQ-MSG-005 | 视觉 + 协议 | 状态分支：版本编辑链 | revision audit 可见，mention/reply/附件关系不可静默编辑。 |
| REQ-MSG-006 | 视觉 + 协议 | 状态分支：tombstone / J-03 cancel | recall 保留 tombstone，pending intent 与关联 execution scoped cancel，不回滚 final/facts。 |
| REQ-MSG-007 | 视觉 + 协议 | Agent correction 组件 | Agent final 不可编辑/撤回，只能追加关联更正。 |
| REQ-MSG-008 | 视觉 + 协议 | J-03 preview/final | preview 非权威且 aria-live=off；只有 committed final 入历史。 |
| REQ-MSG-009 | 视觉 + 协议 | J-02 附件 / 来源按钮 | file metadata、preview/download、提取/OCR 与 Agent 引用来源可见。 |
| REQ-MSG-010 | 视觉 + 安全披露 | J-01 邀请披露 / 附件 ready | Room 有效内容默认 AI-visible；recall 原文不再进入 operational retrieval。 |
| REQ-MEM-001 | 非视觉协议 + UI 投影 | 右栏 Memory / repair | room corpus 的无损持久与可重放由协议保证；UI 只投影来源、版本与 repair 结果。 |
| REQ-MEM-002 | 视觉 + 协议 | 右栏 STEWARD | 内置 steward、五类记忆、watermark 与非 participant 身份可见。 |
| REQ-MEM-003 | 非视觉编译协议 | 工程交接 / Memory 状态 | 默认输入组成与禁止全量 prompt 不由 UI 模拟；来源索引和 raw delta degraded 有表面。 |
| REQ-MEM-004 | 视觉 + 安全协议 | read-only tool 状态 / 来源深链 | room-memory read 与附件读取带来源，执行时重验 membership。 |
| REQ-MEM-005 | 视觉 + 协议 | J-06 | Context 可生效；Decision/责任/期限/承诺保持 proposal 至具名 Human 确认。 |
| REQ-MEM-006 | 视觉 + 协议 | 右栏 DISPUTED | 任一 Human 可 dispute，resolved 前暂停注入且保留争议链。 |
| REQ-MEM-007 | 非视觉编译协议 | memory degraded / 工程交接 | watermark + raw delta + trigger/source 的连续性由 context compiler 实现。 |
| REQ-MEM-008 | 非视觉运行协议 | J-03 retry lineage | execution retry/crash recovery 使用冻结 snapshot；纠正产生新 invocation。 |
| REQ-MEM-009 | 非视觉编译协议 | 状态分支 / 工程交接 | token budget、excerpt/digest/index 与 content_too_large 是协议，不伪造页面成功。 |
| REQ-MEM-010 | 视觉 + 协议 | 状态分支：MEMORY DEGRADED | 聊天/显式调用继续；风险主动路由暂停；project authority 不可读时 due 也暂停。 |
| REQ-MEM-011 | 非视觉模型协议 | 消息身份 / 工程交接 | speaker kind、时间、reply/mention、Agent 职责、Room/Goal/trigger 必须进入 envelope。 |
| REQ-MEM-012 | 非视觉隐私协议 | J-01 Provider 披露 / 工程交接 | 必要上下文、store=false、无原文/secret/hidden reasoning 日志；UI 不显示凭据。 |
| REQ-AGT-001 | 视觉 + 协议 | J-03 双 Agent | 逐目标 intent 持久、共享 room facts snapshot、独立 envelope 与互不连带终态。 |
| REQ-AGT-002 | 非视觉安全协议 | J-03 / 工程交接 | public API 只表达 direct invocation；routed/proactive 来源不由客户端选择。 |
| REQ-AGT-003 | 视觉 + 协议 | Settings Agent assignment | 仅 active/on-mention；被点名时仍获得 assignment 内完整 read/tool。 |
| REQ-AGT-004 | 视觉 + 协议 | Settings availability / J-03 | ready/busy/paused/noauth 可见；route/claim/model/tool 的重验是服务端约束。 |
| REQ-AGT-005 | 非视觉路由协议 | 右栏 Goal / 状态分支 | 主动触发必须有 Goal/职责事实；无无目的巡检或 Agent 级联。 |
| REQ-AGT-006 | 视觉 + 协议 | due 通知 / execution | 安静 Room 的 checkpoint/due/Ball 可生成一次可观察 execution，并跨重启去重。 |
| REQ-AGT-007 | 非视觉路由协议 | Settings 职责 / 工程交接 | Router 使用职责、availability、assignment、Ball；displayName 只用于显示。 |
| REQ-AGT-008 | 视觉 + 协议 | J-03 execution 卡 | accepted/running/completed/failed/cancelled 与 waiting confirmation；diagnostics 折叠。 |
| REQ-AGT-009 | 视觉 + 协议 | J-03 retry | 同 execution 有界 attempt；Human retry 新 execution；outcome_unknown 先 review。 |
| REQ-AGT-010 | 视觉 + 安全协议 | J-03 scoped cancel / J-05 grant | 只有关联纠正/取消 supersede；pending/confirmed/dispatched 分界不伪装回滚。 |
| REQ-AGT-011 | 视觉 + 安全协议 | read-only tool 状态 | global capability ∩ assignment ∩ membership 自动执行；工具闭集由协议限定。 |
| REQ-AGT-012 | 视觉 + 安全协议 | J-05 confirmation 分支 | 精确目标/参数/影响/可逆性/expiry/binding/一次消费，以及拒绝、重复、变参、撤权、claim 前 revoke。 |
| REQ-AGT-013 | 视觉 + 安全协议 | J-05 outcome_unknown | claim 后异常暂停 generic retry，Human review 闭合；后续只能新 toolCall。 |
| REQ-PRJ-001 | 视觉 + 协议 | 右栏 Goal | 最多一个 active primary Goal，proposal 需 Human 确认，替换保留链。 |
| REQ-PRJ-002 | 视觉 + 协议 | J-06 Decision | proposed/confirmed/rejected/superseded 与 confirmer/source/version。 |
| REQ-PRJ-003 | 视觉 + 协议 | J-06 supersede | confirmed 不原位改写，显示双向 supersede 与影响对象。 |
| REQ-PRJ-004 | 视觉 + 协议 | J-04 Request | pending、接受、拒绝、转交、取消及责任/Ball 迁移。 |
| REQ-PRJ-005 | 视觉 + 协议 | 右栏 NextAction / 组件状态 | 必填字段和 proposed→accepted→in_progress→delivered/done 等合法态。 |
| REQ-PRJ-006 | 视觉 + 协议 | NextAction owner | Human/Agent 均可 owner；Agent 责任需指定 Human 确认。 |
| REQ-PRJ-007 | 视觉 + 协议 | NextAction delivered/verifier | Agent 可更新和交付，但 Human verifier 才能 done。 |
| REQ-PRJ-008 | 视觉 + 协议 | NextAction done/reopen | Human owner 可直接完成；有 verifier 时按合同验收，reopen 记录理由。 |
| REQ-PRJ-009 | 视觉 + 协议 | Blocker/OpenQuestion | 单一 owner、source/impact/due/reviewAt、transfer proposal 与不可变链。 |
| REQ-PRJ-010 | 视觉 + 协议 | Blocker deferred/cannot_answer | 两种语义分离，reviewAt 回 open 与一次升级可见。 |
| REQ-PRJ-011 | 视觉 + 协议 | Ball/NeedsAction | 每 source 单 holder/boundary；同 Room 可有多个 Ball source。 |
| REQ-PRJ-012 | 视觉 + 协议 | 通知中心 DUE REMINDER | 立即提醒与 24h 再提醒；Human 通知、Agent invocation，跨重启去重。 |
| REQ-PRJ-013 | 非视觉 domain 协议 + UI | 右栏项目面 / read-only query | Agent 可读项目权威事实并只走闭合 domain command；正文声明不替代状态。 |
| REQ-UX-001 | 批准平台边界 | 默认/最小 Electron 窗口 | macOS Desktop-first；375px、Web、移动端不作为验收。 |
| REQ-UX-002 | 视觉布局 | 1440 三栏 / 840 最小窗口 | Room list、timeline/composer、project/memory；最小窗左轨+分段控件。 |
| REQ-UX-003 | 视觉 + 批准边界 | Room list | active/selected/badge/archived 入口；明确不建旧五分区跨 Room 工作台。 |
| REQ-UX-004 | 视觉 + 协议 | 右栏 project/memory | proposal、confirmed、disputed 与来源；写入只在 ACK/event 后生效。 |
| REQ-UX-005 | 视觉 + 权限 | Settings drawer | Human invitation 与 Agent assignment 分流，角色/participation/availability/grants。 |
| REQ-UX-006 | 视觉 + 失败恢复 | J-01 | restore/login/catalog/no Room/offline/revoked/degraded/fatal，不闪现未授权 cache。 |
| REQ-UX-007 | 视觉 + 协议 | J-02 / 状态分支 | idle/submitting/success/retryable/nonretryable，匹配 requestId 后才成功并保留输入。 |
| REQ-UX-008 | 视觉 + 协议 | J-07 通知 | durable flat center、badge、来源、read/handled、多 session 收敛；无 OS push。 |
| REQ-UX-009 | 视觉 + 可访问性 | FT-16 可访问性矩阵 | 键盘/焦点、缩放、对比度、非颜色、VoiceOver、reduced motion 与最小窗条件。 |
| REQ-NFR-001 | 非视觉部署协议 | 窗口标题 / 工程交接 | 单租户私有服务与 SQLite authority；renderer/cache/preview 均标明非事实源。 |
| REQ-NFR-002 | 非视觉事务协议 | J-02 / 工程交接 | domain/event/outbox/idempotency 原子提交和 30 天 replay 由服务端 spec/test 验证。 |
| REQ-NFR-003 | 非视觉同步协议 + UI | J-07 / repair | at-least-once、eventId 去重、outbox backoff/dead-letter 与 cursor sync。 |
| REQ-NFR-004 | 视觉 + 同步协议 | J-07 repair/repair failed | 连续 cursor；固定 watermark 全投影重建；失败保留旧完整 cache。 |
| REQ-NFR-005 | 视觉 + 运行协议 | J-03 / fatal/repair failed | 有界 queue/timeout/retry/recovery；所有路径有终态，无永久 spinner。 |
| REQ-NFR-006 | 非视觉 secret 协议 | J-01 Provider 披露 / 诊断说明 | 单 Provider/模型、无 BYOK/fallback；secret 仅服务端且审计不含值。 |
| REQ-NFR-007 | 视觉 + 协议 | J-07 offline | 只读完整加密 cache；不接受离线 writes，重连后显式重试。 |
| REQ-NFR-008 | 视觉 + 安全协议 | J-01 revoked/fatal | 租约过期锁 cache；撤权清 Room cache；maxOfflineReadLease 值由 FT-14 冻结。 |
| REQ-NFR-009 | 非视觉隐私协议 | fatal 诊断 / 状态分支 | 日志/trace/诊断不含 raw content、credential、secret、hidden reasoning。 |
| REQ-NFR-010 | 视觉 + 协议 | 全部失败态 / 三栏原子切换 | 禁止重复、回退、串 Room、永久 spinner、伪成功；错误含对象与恢复动作。 |
| REQ-NFR-011 | 非视觉安全协议 | Settings/J-05/J-07 可见拒绝 | 每个执行点重验权限；UI 隐藏不是授权。 |
| REQ-NFR-012 | 视觉 + 数据治理 | 归档状态 / Settings export | Room 生命周期保留、无永久删除 UI、owner 可完整导出。 |
| REQ-NFR-013 | 非视觉 Electron 安全 | 工程交接 | context isolation、禁 renderer Node、最小 preload/IPC 与安全预览由实现 spec/test 验证。 |
| REQ-NFR-014 | 视觉 + 安全协议 | 归档状态分支 | 可逆审计只读、业务冻结、安全 expiry 继续、撤权命令立即生效。 |

## 完整性规则

- 本表应与 PRD 的规范性 Requirement 集合严格相等：103 条、无遗漏、无额外 `REQ-*`。
- 设计稿页面中的范围写法只用于场景导航，不作为逐项覆盖证据；审阅与实现计划应引用本表中的具体 ID。
- 若后续产品 Requirement、批准延期或冲突处置改变，必须先更新并重新批准 PRD，再同步本表和设计稿。
- `prototype-only` 点击不能被当成权威 command 已成功；成功只来自匹配 requestId 的 ACK、stable event 或 projection。
