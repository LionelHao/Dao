# FT-07 Agent Profile & Routing · Stage 9 rebaseline

> 日期：2026-08-24（Asia/Shanghai）
> 状态：生产实施基线；不代表 FT-07 已完成、已验收或 verified
> 实际 predecessor：`origin/main@5234b9a9a043ef03cb5ecf37f00a4671800612b8`
> Authority schema：v19；v19 migration 为 89 条 append-only statements

## 1. 权威、范围与设计基线

本阶段继续采用已经批准的 FT-07 三层权威架构，不重新设计产品：稳定 Agent Actor、部署级 Global Agent Profile、Room 级 Assignment。冲突时按 PRD → 协议/冻结 feature spec → 正式 UI 设计 → 生产代码/测试排序。旧 T-0016/T-0041 和现有代码只可复用机制，不能覆盖当前产品语义。

直接或共同负责的 Requirement 为：`REQ-AGT-001/002/003/004/005/007`、`REQ-ID-004`、`REQ-MEM-011`、`REQ-NFR-006`、`REQ-PD-004`、`REQ-PRIM-004/011/013`、`REQ-UX-005`。

设计旅程映射：J-01 的启动、Room catalog、Settings 与部署/Room 权限分离；J-03 的结构化多 Agent direct invocation、独立 execution 与失败；J-05 的 effective tool subset 与 revision gate（完整 confirmation/grant/dispatch 仍归 FT-10）；J-07 的 offline/repair/revoke/atomic projection。正式设计偏离：**无**。

## 2. 旧设计仍有效的冻结合同

- Agent Actor 只保留稳定 `actorId` 和 actor kind；改名不改变消息、mention、execution、audit 引用。
- Profile 一对一绑定 Agent actor，保存 displayName、全局职责、enabled/disabled、closed capability/tool ceiling、revision 与审计时间；仅 authenticated Tenant Administrator 可变更。
- Assignment 绑定 Room/Profile/actor，保存 Room 职责、`active/on-mention`、durable pause、closed subsets、revision/status/审计时间；仅 current Room owner/admin 可管理。
- `effectiveCapabilities = Profile ceiling ∩ Assignment subset ∩ current Room access policy`；tools 同理并保留 FT-10 membership tool policy seam。unknown、重复、非 canonical 集合 fail closed。
- availability 是 `ready/busy/paused/noauth` 只读 projection，显示优先级为 `paused > noauth > busy > ready`；安全逻辑读取独立事实。
- direct 只来自 FT-03 message transaction 的结构化 stable actor target；routed 只来自 terminal RouteJob decision；project-boundary 只来自 FT-09 confirmed fact。
- Router 只消费 Authority 生成的有界、revisioned closed candidate snapshot；displayName 不进入职责、排序、幂等或 Provider judgment key。
- Profile/Assignment/access reduction 在 route、claim、model、source read、tool prepare/claim/dispatch 和 final commit 复核；adapter 调用前失败必须为 0 次调用。
- stable event、outbox、idempotency result 与 mutation 同一 AuthorityWorker transaction；repair 按 deployment/Room scope 分离。

## 3. 当前基线已提前交付的 seam

- schema v14 已存在 `agent_profiles`、`room_agent_assignments`、subset/ceiling 物理约束、单 Room/Agent current 唯一索引和 archive reduction tables。
- `AssignmentSecurityReductionParticipant` 已进入 FT-02C archive composition；本阶段复用，不建立第二套 archive gate。
- FT-01 已交付 Human session family、每操作 reauthentication、revocation、Desktop closed auth bridge；Tenant Administrator governance 明确尚未交付。
- FT-02A/B/C 已交付 owner/admin/member、governance revision、archive/reopen 与 security-reduction participant transaction spine。
- FT-03 已交付 `message.send.v2` structured mention、每 target outcome、durable `message_target` invocation intent、source-scoped recall fence；public v2 submit 不接受 runtime origin。
- FT-05/FT-06 已交付 full corpus、memory health、immutable context snapshot、compiled-only Provider、server-confirmed citation 与 restricted source read。
- FT-06 envelope 已有 trusted `agent_identity`、`responsibility`、`room_goal`、`trigger_contract` block，但 FT-07 persona/assignment 仍使用 unavailable/fallback seam。
- 既有 route/runtime 有 bounded queue、closed Provider output、`store:false`、attempt/CAS、single server-side secret、tool claim/outcome_unknown 等可复用机制。

## 4. 必须关闭的生产冲突

1. Core、sync、legacy room lifecycle、Router closed types仍接受 `silent`，Router reason仍有 `participation_silent`。
2. `AgentActor` 仍承载 displayName、readiness 与 global toolPermissions；static `actors` options参与正常启动一致性判断。
3. v14 Profile/Assignment 表没有生产 CRUD、revision history、audit/event/outbox/repair/Desktop live producer。
4. 没有真实 Tenant Administrator bootstrap/add/remove/query、last-admin invariant和部署审计。
5. FT-03 direct target仍要求 `membership.participation === active`，错误拒绝被明确点名的 on-mention Agent。
6. public `agent.invoke` 仍接受 client-supplied kind/target，WebSocket直接创建 runtime execution。
7. route snapshot仍使用 static actor displayName/global permissions，接受 `structured_help/routed_candidate`旧语义。
8. Agent final 仍调用 `routeRuntime.notify`，造成 Agent-to-Agent cascade入口。
9. route complete 后逐 intent best-effort `invoke`，存在 terminal decision → execution/intention crash gap。
10. runtime/context/tool gates仍从 actor readiness/static permissions读取，Profile/Assignment/access revision未贯穿。
11. startup可因 options actor与DB配置差异拒绝或补种；正常重启仍依赖 static Agent 配置。
12. Profile/Assignment尚未进入 scope-correct event、outbox、repair、Desktop projection。
13. Provider/model没有面向有权 Room user 的安全只读披露；credential readiness尚未成为 noauth projection。
14. Desktop旧 Agent配置表单仍含 `silent / 静默待命`，同步 callback可制造本地成功。

## 5. schema v20 实际需要

继续使用同一 SQLite 与唯一 AuthorityWorker writer；v1-v19 statement、checksum、fingerprint字节不改。v20 追加：

- Tenant Administrator current registry、revision/CAS、bootstrap provenance和不可变 deployment audit；最后一个有效 admin不可删除，Agent actor不可绑定。
- Profile displayName、global responsibility、createdAt/updatedAt/lifecycle metadata、revision history与事件投影数据。
- Assignment Room responsibility、createdAt/updatedAt/lifecycle metadata、revision history、pause/remove/migration provenance。
- deployment Provider/model disclosure（只存公开配置/operation/readiness元数据，不存 secret）。
- route candidate snapshot/version/hash、terminal decision provenance、selected stable actorId、Profile/Assignment/access revisions，以及 durable routed intent linkage/outbox recovery事实。
- legacy `silent → on-mention + paused + migration-review`、legacy static actor/Profile/Assignment seed provenance。
- canonical set、one-current assignment、Agent-only binding、last-admin、revision monotonic、old-generation refusal等必要 CHECK/UNIQUE/trigger/validation。

迁移必须覆盖 fresh、v1…v19、future/unknown、checksum/fingerprint tamper、逐 statement rollback、fresh-v20与migrated-v20等价、v14 seam数据、silent/static seed、历史 actorId/displayName、restart/WAL和repair equivalence。

## 6. Requirement → 生产闭环覆盖矩阵

| Requirement | 准确语义与 FT-07 闭合责任 | Core / Authority / protocol-runtime | Desktop / test evidence | 后续边界 |
| --- | --- | --- | --- | --- |
| `REQ-AGT-001` | 每个结构化 Agent target有独立 durable intent/outcome；共享 room facts、独立 persona/tool envelope | stable IDs、Profile/Assignment revisions、FT-03 target eligibility、durable routed handoff | J-03多目标、partial rejection、crash/replay | FT-08闭合完整 execution lifecycle |
| `REQ-AGT-002` | public Human只能产生 direct意图；routed/proactive为server-private | 关闭public `agent.invoke`，internal branded origin/operation | forgery matrix/410 upgrade | FT-08控制命令继续public但不含origin |
| `REQ-AGT-003` | participation仅active/on-mention；on-mention direct有完整授权 | closed type、Assignment gate、Router exclusion | Settings无silent、direct tool/read测试 | 无 |
| `REQ-AGT-004` | availability与participation分离；pause durable，busy/noauth派生 | revision gate、credential/execution facts、restart derivation | ready/busy/paused/noauth只读状态 | FT-08最终busy queue；FT-14 credential ops |
| `REQ-AGT-005` | 只有Goal/职责/真实项目事实触发；Agent final不级联 | route suppression、no-final-notify、FT-09 dependency unavailable | trigger/source可见、quiet-room zero-call | FT-09交付真实 checkpoint/due/Blocker |
| `REQ-AGT-007` | Router基于Goal/职责/availability/assignment/Ball有界事实，非displayName | RouteCandidateSnapshot/hash/revision与Provider再校验 | displayName metamorphic/property tests | FT-09提供项目事实 |
| `REQ-ID-004` | Actor/Profile/Assignment分层；Profile仅Tenant Administrator；不越权Room | v20 + admin/Profile/Assignment commands、CAS/audit | Global vs Room管理分区 | FT-14最终credential rotation |
| `REQ-MEM-011` | Provider输入保留speaker/关系/Agent身份职责/Room Goal/trigger，正文不升权 | FT-06 compiled envelope接真实Profile/Assignment/effective sets | multi-Agent persona isolation/sentinel | FT-09 Goal available后替换unavailable |
| `REQ-NFR-006` | 单Provider/模型、server secret、披露、无BYOK/无fallback | disclosure query、SecretProvider readiness、noauth | 只读provider/model，无选择器/secret | FT-14最终rotation/ops |
| `REQ-PD-004` | 支持steward+至少participant并可扩Agent，不设数量门禁 | Profile/Assignment有界集合与fan-out | empty/multiple Agent states | FT-15真实试点 |
| `REQ-PRIM-004` | Human invitation与Agent configuration完全分轨 | 独立commands/events/projections | Settings两个分区 | 无 |
| `REQ-PRIM-011` | structured @Agent产生真实intent，不是UI假调用 | FT-03 transaction + eligibility/revisions | pending不改stable，ACK/event驱动 | FT-08完整终态 |
| `REQ-PRIM-013` | active/on-mention + ready/busy/paused/noauth | exact guards/availability calculator | 文本+图标、无颜色依赖 | FT-08共享busy闭合 |
| `REQ-UX-005` | Settings按viewer权限展示角色、participation、availability、职责/tools并处理全部错误 | closed WS DTO/ACK/event/repair | loading/empty/401/403/409/410/429/503/offline/repair/a11y | FT-11最终shell整合 |

## 7. UI 状态与权威来源

| 可见状态 | 权威来源 | 恢复/约束 |
| --- | --- | --- |
| 表单编辑、pending、焦点 | local transient | 禁重复提交；不改stable badge |
| mutation accepted | matching requestId server ACK | 只表示事务提交，等待event/projection收敛 |
| Profile/Assignment/availability/provider-model | stable event或repair projection | availability不可写；rename保留actorId |
| loading/empty | projection lifecycle | readiness推导完成前不显示ready；无fixture |
| 401/403 | session/ACL authority | reauth或保留只读；不泄露其他scope |
| 409/410 | current revision/lifecycle | 刷新权威事实、保留安全输入或关闭失效编辑态 |
| 429/503 | bounded capacity/dependency | 保留输入、显式重试；不fallback |
| offline/repair/revoked/archived | connection + stable projection + access/lifecycle | mutation禁用；repair原子替换；撤权purge；archived仅安全缩减 |

键盘/可访问性：Tab/Shift+Tab/Enter/Space操作全部控制；drawer焦点圈定并归还触发器；错误摘要先获得焦点；状态以文字+图标/线型表达；低频ACK/error/availability/repair使用节制`aria-live`；200% zoom和840×560不裁切核心动作；reduced motion无shimmer/位移/持续旋转。设计偏离：**无**。

## 8. FT-08/09/10/14 边界

- FT-08：本阶段交付trusted origin、revision gate和durable decision→intent事实；完整accepted/running/terminal、preemption、timeout/retry/recovery仍归FT-08。
- FT-09：当前所有checkpoint/due/Blocker/project-boundary producer在production返回`dependency_unavailable/suppressed`；不得借旧OpenItem/LightTask/Ball或消息冒充。
- FT-10：复用现有confirmation/grant/dispatch状态机；只注入Profile/Assignment/access revision gate，不创建第二套工具安全状态。
- FT-14：secret不进SQLite；当前环境SecretProvider只计算readiness。若无批准的在线rotation store，authenticated admin mutation port返回`configuration_unsupported`；最终rotation、retention、运营审计留给FT-14。

## 9. 文件切片、Agent ownership与合入顺序

| 切片 | branch/worktree | ownership | 共享约束 |
| --- | --- | --- | --- |
| Core + v20 | `codex/ft07-core-schema` / `Dao-stage9-ft07-core-schema` | closed types/guards/negative tests、schema v20/migration/invariants | 独占`schema.ts`；不碰worker/composition/Desktop |
| Administrator + Profile | `codex/ft07-admin-profile` / `Dao-stage9-ft07-admin-profile` | admin/Profile domain、SQLite authority module、ACL/audit/disclosure tests | 以新模块+port实现；共享worker由主集成 |
| Assignment + Router | `codex/ft07-assignment-router` / `Dao-stage9-ft07-assignment-router` | Assignment gates/availability、trusted origin、route snapshot/policy/handoff tests | 不碰shared handler/protocol/composition |
| Integration | `codex/ft07-stage9-integration` / `Dao-stage9-ft07-profile-routing` | rebaseline、AuthorityWorker/handler、protocol/WS、sync/repair、FT-06 envelope、Desktop、E2E | 串行接入所有共享文件 |

合入序列：rebaseline/Core → v20 → admin/Profile → Assignment/gates → Router/origin/handoff → protocol/sync/repair → Desktop/a11y → adversarial hardening → delivery evidence。每个切片先focused测试，再集成全量；不得依赖未合入worktree隐式文件。

## 10. 当前无 owner 决策阻塞

权威文档已经冻结必要产品选择。当前工程值（v20 statement组织、队列/fan-out边界、DTO字段机械命名）可在不改变产品边界的前提下由实现与测试决定。若后续发现协议/正式设计与PRD直接冲突，停止相关实现并提交具体Requirement/状态给owner裁决。
