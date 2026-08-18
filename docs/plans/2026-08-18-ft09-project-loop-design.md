# FT-09 Project Loop 生产工程设计冻结稿

> 状态：**设计冻结 / implementation-ready candidate**。本文不表示 FT-09 已实现、已交付或已验证。
>
> 日期：2026-08-18
>
> 范围：FT-09 的生产工程合同、与相邻 FT 的事务 seam、Desktop 状态与验收边界；不修改生产代码或 Blueprint。

## 1. 权威输入与冻结结论

本文按仓库权威顺序读取并服从以下输入：

1. [仓库宪法](../../AGENTS.md)与[当前上下文](../../CONTEXT.md)；
2. [当前批准 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)与[evidence map](../reconstruction/agent-im-evidence-map.md)；
3. [设计入口](../design/README.md)、[103 条 Requirement 覆盖矩阵](../design/design-requirement-coverage.md)及入口指向的正式自包含审阅稿；
4. [approved PRD implementation map](2026-08-18-approved-prd-implementation-map.md)；
5. [FT-02 设计](2026-08-18-ft02-room-governance-design.md)、[FT-02 实施计划](2026-08-18-ft02-room-governance-implementation-plan.md)、[FT-02A work note](2026-08-18-ft02a-room-governance-foundation-work-note.md)与[FT-02A 交付说明](../deliveries/FT-02A-Room-Governance-Foundation-交付说明.md)；
6. [FT-03 设计](2026-08-18-ft03-message-authority-design.md)、[FT-03 实施计划](2026-08-18-ft03-message-authority-implementation-plan.md)、[FT-08 设计](2026-08-18-ft08-invocation-runtime-design.md)、[FT-08 实施计划](2026-08-18-ft08-invocation-runtime-implementation-plan.md)、[FT-13 设计](2026-08-18-ft13-sync-reliability-design.md)与[FT-13 实施计划](2026-08-18-ft13-sync-reliability-implementation-plan.md)；FT-05/06/07/10/12 尚无同级批准设计文件时，仅采用 PRD 和 implementation map 中已经批准的输入，不补造其内部合同；
7. T-0017/18/19 的计划、交付、代码与测试，以及当前 Core、AuthorityWorker/SQLite、protocol、WebSocket、ball-runtime 和 Desktop renderer 实现。

冻结结论如下：

- **Room 就是 Project**。`projectId === roomId` 是协议与存储不变量，不建立第二个 Project aggregate、第二套成员关系或第二套 archive lifecycle。
- FT-09 新建独立的 Project Loop 权威合同；旧 `OpenItem`、`LightTask`、`BallInCourt` 只能按本文列出的机制边界复用，不能改名、改 status 文案或补字段后宣称满足新 PRD。
- Project authority 只由闭合 command 经 AuthorityWorker 事务产生。消息正文、Agent 输出、Desktop local state、旧记录和 memory proposal 都不是 project fact。
- 一个 Room 至多一个 active primary Goal；Goal、Decision、Request、NextAction、Blocker、OpenQuestion、transfer 和 source boundary 均保留稳定 ID、版本与不可变审计链。
- Human 承诺必须由对应 Human 的接受或确认产生。Agent 不得代表 Human 接受 Request、确认 Goal/Decision、完成 Human-owned NextAction 或伪造 transfer。
- 本文与正式设计稿偏离：**无**。旧 Desktop preview 与正式设计不一致之处属于待替换的历史实现，不是设计偏离授权。

## 2. Requirement 与设计旅程映射

### 2.1 FT-09 直接 Requirement

| Requirement | 本文冻结的工程合同 |
|---|---|
| `REQ-AGT-005` | Agent 只可在授权 project boundary 内更新、交付或提出建议；不能确认 Human 承诺或验收 done。 |
| `REQ-AGT-006` | Project boundary invocation 只接收 FT-09 已确认且未消费的 source boundary。 |
| `REQ-MEM-005` | confirmed project fact 与 memory proposal/confirmed/disputed 分层并显式链接。 |
| `REQ-PRIM-003` | Room 同时承载通信、记忆、项目事实与 assignment；所有对象同一 `roomId`。 |
| `REQ-PRIM-010` | `@Human` 生成 pending acceptance Request，而非立即生成目标 Human 责任。 |
| `REQ-PRIM-015` | Goal/Decision 的 proposal、Human confirmation 与 supersede 权威分层。 |
| `REQ-PRIM-016` | NextAction 显式表达责任、期限、交付与验收，Human/Agent owner 分治。 |
| `REQ-PRIM-017` | Blocker 单 owner/升级，Ball 按 source 投影，due 驱动 Human reminder 或 Agent invocation。 |
| `REQ-PRJ-001` | Goal proposal、Human confirmation、replacement；同 Room 最多一个 active primary Goal。 |
| `REQ-PRJ-002` | Decision proposed/confirmed/rejected/superseded，记录 confirmer、source、time、version。 |
| `REQ-PRJ-003` | confirmed Decision 不原位改写；supersede 双向链并提示受影响对象。 |
| `REQ-PRJ-004` | Request pending acceptance/accept/reject/transfer/cancel；接受前无目标 Human 责任，接受后原子链接实际责任。 |
| `REQ-PRJ-005` | NextAction 必填字段、稳定状态、reassign/reopen 和唯一合法完成路径。 |
| `REQ-PRJ-006` | Human/Agent 均可 owner；Human 本人接受，Agent 由指定 Human principal 确认。 |
| `REQ-PRJ-007` | Agent 可更新/交付；只有具名 Human verifier 能把 Agent-owned action 验收为 done。 |
| `REQ-PRJ-008` | Human owner 可在无 verifier 时直接 done；有 verifier 时遵守验收合同；reopen 留理由。 |
| `REQ-PRJ-009` | Blocker/OpenQuestion 单一 owner、source、impact、due/reviewAt、transfer proposal 与不可变链。 |
| `REQ-PRJ-010` | deferred 与 cannot_answer 分离，分别产生 reviewAt reopen 与一次升级。 |
| `REQ-PRJ-011` | 每个 source boundary 只有一个 Ball holder；一个 Room 可同时存在多个 source。 |
| `REQ-PRJ-012` | due 即时提醒及未处理时每 24h 再提醒，Human/Agent 路径分治且跨重启去重。 |
| `REQ-PRJ-013` | Agent 可读 project fact，并且只能通过闭合 project command 做获准迁移；正文不能代替状态。 |
| `REQ-ROOM-001` | `projectId === roomId`，唯一 active primary Goal。 |
| `REQ-ROOM-003` | leave/remove 前同事务清理或拒绝所有活动责任、pending acceptance/confirmation/verification。 |
| `REQ-UX-004` | Desktop 展示来源、责任、状态、错误恢复、键盘与非颜色识别。 |

辅助但不归 FT-09 重复实现的边界包括 `REQ-MSG-005`、`REQ-MSG-006`（FT-03 structured target/source revision）、`REQ-AGT-007`～`REQ-AGT-011`（FT-08 execution/confirmation）、`REQ-NOTIF-001`～`REQ-NOTIF-004`（FT-12 recipient delivery/read/handled）、`REQ-SYNC-001`～`REQ-SYNC-009`（FT-13 repair）及 PRD 的审计、幂等、并发和恢复 NFR。

### 2.2 正式 Desktop 旅程

这里使用 `docs/design/README.md` 当前指向的正式设计旅程编号，不沿用 PRD 叙事章节中早期同名编号。

| 旅程 | Desktop 分区与组件 | 可见状态的权威来源 | 必须覆盖的恢复与可访问性 |
|---|---|---|---|
| `J-04` @Human Request | timeline 中的 Request card、Project panel 的 pending acceptance/owner/source/action | composer mention 仅 local transient；`message.accepted` 仅表示消息提交；Request 必须由 server ACK/stable event/projection 出现；accept/reject/transfer/cancel 以 CAS ACK 后事件收敛 | sending/creating、pending、accepted、rejected、cancelled、transfer pending/expired；401/403/409/410/429/503/offline/repair；键盘可达、焦点回到触发项、状态文字与图标双编码、低频 `aria-live` |
| `J-06` proposal → fact | Project panel Goal/Decision proposal card、source deep link、confirm/reject/supersede | 草稿与 optimistic shell 是 local transient；proposal/confirmed/rejected/superseded 全由 stable event/projection；消息正文不是 fact | stale source、conflict、source recalled/revised、权限变化、repair；confirm 默认聚焦且 Esc 返回来源；proposed/confirmed 不只靠颜色或虚实线 |
| `J-07` notification/offline | Room 内 Project panel/NeedsAction、通知入口的 Room-scoped deep link、offline/repair banner | reminder/outbox/recipient state 来自 FT-12；Desktop cache 只是 projection；read 与 handled 分开 | 429/503 retry、offline queued intent、reconnect catch-up、repair failed/clear cache；preview `aria-live=off`，权威低频状态才通告 |

布局与可访问性冻结：1440×900 基线；最小 840×560 时左侧收窄为 56px rail，右侧 Project panel 收入 timeline/project segment，核心动作不得藏进不可发现 overflow；支持设计稿规定的 1440 下 100%～200% 和 840 下 100%～150% 缩放；`Cmd+1/2/3`、`Cmd+K`、`Option+↑/↓`、Esc 焦点恢复有效；`prefers-reduced-motion` 下取消非必要位移动画；状态、owner、due 和错误不能仅靠颜色表达。

## 3. 旧实现审计：机制可复用，语义不可继承

| 旧对象/层 | 可复用机制 | 不符合新合同的语义；禁止的捷径 |
|---|---|---|
| `OpenItem` / T-0017 | Room-scoped ID、source message 引用、SQLite 权威写入、event/outbox、repair record、CAS/幂等测试形态 | 创建即把目标 Human 设为 owner；没有 pending acceptance；`answer` 不等于 Request handshake；`defer` 与 `cannot_answer` 落为同一 status；transfer 立即换 owner；owner/离场检查不完整。不得把 `awaiting` 改名为 `pending_acceptance`，也不得把 `answered` 改名为 `accepted`。 |
| `LightTask` / T-0018 | 明确 task ID、criteria 列表、claim/deliver/verify 的审计样式、SQLite/WS/restart 测试骨架 | 仅 Human claimant；没有显式 description/due/deliverable/owner kind；verifier 以 role 延迟解析而非创建时具名；`verified` 不等于新 `done`；没有 Agent-owned delivery、Human direct done、reopen/transfer/cancel。不得直接改名为 NextAction。 |
| `BallInCourt` / T-0019 | source boundary + 单 holder 投影、unread 分离、超时扫描与 claim 去重思路 | source union 只覆盖旧对象/Blueprint；deadline 来自全局 policy，不来自 project source；Human reminder 不是持久 recipient notification；旧 claim 只能触发一次，不能表达每 24h ordinal；旧 route 标记存在多 queued source 混淆风险；repair 无 Ball registry record。不得把旧 `BallInCourt` 直接扩大 union 后宣称完成。 |
| `primitives.ts` compatibility facade | closed guard 调用、facade 接口与单测组织 | 文件同时含 Authority facade 与早期 in-memory compatibility API；后者不是生产 authority，不能成为 FT-09 source of truth。 |
| `collaboration.ts` / `sync.ts` | closed discriminated unions、exact-key guard、type tests、repair record 模式 | 当前 closed unions 没有 Project Loop 对象；新增必须显式扩 union、guard、clone/freeze、snapshot/repair mapper，不能用 `unknown` 或 permissive fallback。 |
| protocol / WebSocket | exact field allowlist、requestId/idempotency 派生、ACK/error 路由、real WS tests | 当前只暴露 `open-item.*`、`light-task.*`、`ball.query`；这些帧继续是 legacy compatibility，不能承载新 project write。Agent message body 或普通 `message.send` 不能替代 project command。 |
| Desktop renderer | Room-scoped projection、NeedsAction 与 unread 分栏、DOM/a11y 单测形式 | 当前是静态旧 primitive preview，没有 J-04/J-06/J-07 权威状态、error recovery 或 Project panel production reducer。不能把 preview 文案替换后作为验收。 |

本次审计定位的最小生产证据集是 [Core collaboration](../../packages/core/src/collaboration.ts)、[Core sync](../../packages/core/src/sync.ts)、[server primitives facade](../../packages/server/src/primitives.ts)、[authority schema](../../packages/server/src/persistence/schema.ts)、[authority database handler](../../packages/server/src/persistence/authority-database-handler.ts)、[snapshot worker](../../packages/server/src/persistence/snapshot-worker.ts)、[ball runtime](../../packages/server/src/ball-runtime/ball-runtime-service.ts)、[protocol](../../packages/server/src/protocol.ts)、[WebSocket](../../packages/server/src/websocket.ts) 与 [Desktop renderer](../../packages/desktop/src/renderer/app.ts)，以及相邻的 Core/SQLite/ball/protocol/WS/Desktop tests。审计时生产 schema 常量为 13；这只是当前事实，不是 FT-09 的预留版本。

历史 backfill 只形成 `legacy compatibility` 记录：保留原 ID、状态、时间与可证明来源；`confirmerActorId`、`verifierActorId`、`acceptedBy`、新 source revision 不可推断。legacy 记录不得进入 active primary Goal、confirmed Decision、accepted Request、canonical NextAction 或 active Ball。Human 可通过新的显式 adopt/propose command 引用 legacy record，之后按新状态机确认；采用行为本身写审计，不回写历史事实。

## 4. Core 闭合合同

### 4.1 标识、来源与版本

所有对象包含 `id`、`roomId`、`revision >= 1`、`createdAt`、`updatedAt`、`source` 和 append-only audit reference。`projectId` 不存第二份自由值；API 如需输出，必须计算为 `roomId` 并由 guard 校验相等。

```ts
type ProjectActorRef =
  | { kind: "human"; actorId: HumanActorId }
  | { kind: "agent"; actorId: AgentActorId };

type ProjectSourceRef = {
  roomId: RoomId;
  kind: "message" | "attachment" | "agent_execution" | "memory" | "project_fact" | "legacy";
  sourceId: string;
  sourceRevision: number;
  visibility: "room"; // public projection never carries secret/raw corpus
};
```

source deep link 使用上述 reference 解引用；project event、departure conflict、notification 和 repair record 不复制消息正文、tool parameter、secret 或 raw corpus。

### 4.2 Goal 与 Decision

```ts
type GoalStatus = "proposed" | "active" | "rejected" | "superseded";
type DecisionStatus = "proposed" | "confirmed" | "rejected" | "superseded";
```

Goal proposal 必须包含目标陈述、proposer、source、proposal revision。任一当前 Room Human member 可确认首个 Goal；Agent 只能 propose。confirm 在同一事务内检查 Room active、source revision、proposal revision 和 `no other active primary goal`；如存在 active Goal，属于冲突 supersede，只能由 owner/admin 确认且必须携带 `replacesGoalId`，原 Goal 变 `superseded`、新 Goal 变 `active`，共同写入同一 immutable replacement edge。不能先关闭旧 Goal 再另事务创建新 Goal。

Decision 同样可由任一当前 Human confirm/reject；冲突结论的 supersede 由 owner/admin 决定。替代时 `supersedesDecisionId` 必须指向同 Room confirmed Decision，旧记录终态 `superseded`，新记录 `confirmed`，同时生成对受影响 Goal/NextAction/Blocker 的提示投影。双向链不可变。rejected/superseded 不可回到 proposed；需要变更时创建新 proposal 并链接前项。

### 4.3 Request handshake

```ts
type HumanRequestStatus =
  | "pending_acceptance"
  | "accepted"
  | "rejected"
  | "cancelled";
```

Request 固定 requester Human、current target Human、source 与 `acceptanceMode`（`next_action`、`open_question` 或 `blocker`）。FT-03 的 structured `@Human` target 在消息事务中创建 `pending_acceptance`；**此时 target 没有 project responsibility，也没有以该 Request 为 source 的 target Ball**。Request 的协调 Ball 仍由 requester 持有；目标 Human 收到 recipient-scoped pending-acceptance notification/action，但该可操作项不等于承诺或 Ball。target 离场时 pending acceptance 仍是必须明确 reject/cancel/transfer 的 departure conflict。

- target Human 可 accept/reject；requester 可 cancel；其他主体不可代办。
- accept 在一个事务中把 Request 置为 `accepted`，并按已冻结 payload 创建一个 `NextAction`、`OpenQuestion` 或 `Blocker`。Request 的协调 Ball 原子迁移到该 linked source；只有这个新对象产生目标 Human 责任。
- reject/cancel 是终态，不创建责任。
- Request 的 `transfer(target')` 由 current target 发起；target 不可用时 owner/admin 只能代为发起该 handoff。它在同一事务内结束旧 target 的 pending-acceptance notification、替换 current target、追加 immutable Request target chain，并让新 target 进入 `pending_acceptance`；新 target 仍须另行 accept/reject/transfer。因为责任尚未产生，这个 Request target handoff 不使用下节“已存在责任”的 TransferProposal，也不把 Ball 压给新 target。
- accepted Request 自身是 handshake 终态；其 linked responsibility 的完成、转移或 reopen 不回写 Request status。

### 4.4 NextAction

NextAction 必须有：`title`、`description`、单一 `owner`、`deliverable`、`acceptanceCriteria`、`source`。criteria 是显式列表；无 verifier 的 Human-owned 小任务允许为空，但创建时必须明确确认空验收合同。`dueAt` 是可选业务时限；省略时没有 due reminder，但责任 Ball 仍存在。`verifierActorId` 对 Agent owner 必填且必须是当前 Room 的具名 Human member；对 Human owner可选。Human-owned 一旦指定 verifier，就不能走直接 done 边。

```ts
type NextActionStatus =
  | "proposed" | "accepted" | "in_progress" | "delivered"
  | "done" | "rejected" | "cancelled";
```

- Human-owned：来自 accepted Request 时原子进入 `accepted`；由面板新建或 Agent 建议时先 `proposed`，owner Human 自己 accept/reject。无 verifier 时 owner 可 `in_progress -> done`，必须提交 completion note 与 criteria snapshot；有 verifier 时 owner 必须 `in_progress -> delivered`，再由既定 verifier验收。既定 verifier可将 `delivered -> done` 或以 reason 打回 `in_progress`；合法 principal 可 `delivered/done -> in_progress` reopen，并写 reopen reason。reopen 是新 revision/boundary，不删除完成历史。
- Agent-owned：仅有 project write 权限的 Human 可指派并具名 verifier；Agent 可 `accepted -> in_progress -> delivered`，交付必须引用 deliverable artifact/source。只有既定 verifier Human 可 `delivered -> done` 或 `delivered -> in_progress`（reject delivery with reason）。Agent 永远不能写 done。
- owner transfer 使用通用 TransferProposal。Human 目标接受后，subject 换 owner并回到 `proposed`，仍需新 owner 明示接受；Agent 目标由指定 Human principal 确认 assignment 与具名 verifier 后可原子进入 `accepted`。任何 pending transfer 不改变现 owner/Ball。
- `rejected`、`cancelled` 是终态；terminal responsibility 不因 Room reopen 复活。若要恢复工作，创建新 NextAction 并链接 `reopensActionId`，而不是逆转 terminal 状态。唯一例外是上段明确的 Human `done -> in_progress` reopen command，它是对象级显式动作，不由 Room lifecycle 隐式触发。

### 4.5 Blocker 与 OpenQuestion

二者使用一个闭合 discriminated contract，但保留独立 kind 与 guard：

```ts
type ProjectObstacle =
  | { kind: "blocker"; status: "open" | "resolved" | "deferred" | "cannot_answer"; /* ... */ }
  | { kind: "open_question"; status: "open" | "resolved" | "deferred" | "cannot_answer"; /* ... */ };
```

共同必填 `owner`（单一 Human/Agent）、`impact`、`source`；`dueAt` 可选，`reviewAt` 对 `deferred` 必填。Blocker 还需解除条件；OpenQuestion 还需可判定的问题文本。`deferred` 表示将在 `reviewAt` 原子回到 `open` 并产生新 boundary，保留 owner；`cannot_answer` 对两种 kind 都合法，必须包含 reason 并原子创建一次 escalation boundary。它不自动转移 owner；经获接受/确认的 transfer 可回到 open，或经治理处理进入 resolved。二者绝不能映射到同一 status。

resolve/answer 必须引用 result source；OpenQuestion 的 `resolved` projection 额外记录 answer source。reopen 是显式对象命令并创建新 revision/boundary。owner 变更只经 transfer acceptance 生效。

### 4.6 TransferProposal 与不可变链

```ts
type TransferProposalStatus = "pending" | "accepted" | "rejected" | "cancelled" | "expired";
```

该对象只用于已经存在责任的 NextAction、Blocker/OpenQuestion，不用于尚未接受的 Request target handoff。每个 proposal 固定 `subjectKind/subjectId/subjectRevision/fromOwner/toOwner/reason/proposedBy/proposedAt/expiresAt`。只允许一个 subject active proposal。目标 Human 接受、指定 Human principal 批准 Agent target 后，单事务 CAS：proposal `accepted`、subject owner/revision 更新、旧 Ball 终止、新 boundary/Ball 产生、immutable chain append、event/outbox 写入。拒绝、撤销、超时都不改变 owner；旧 owner 不可用时，Ball 暂投给发起转交并作出 durable claim 的 owner/admin。超时产生升级 boundary，不能自动转交。历史 transfer row 不 update/delete；状态以 append-only decision row 和 materialized latest projection表达。

### 4.7 Ball / NeedsAction 与 reminder

Ball 是责任 source boundary 的权威投影，不是新的业务 aggregate。一个 Room 可有任意多个 source，但唯一约束为 `(roomId, sourceKind, sourceId, sourceRevision, boundaryKind) -> one active holder`。来源至少覆盖：pending acceptance、pending confirmation、NextAction work/delivery verification、Blocker、OpenQuestion、transfer acceptance、due/review、FT-10 tool confirmation。accepted Request 不单独持球；它的 linked responsibility 持球。

`boundaryId` 必须由服务端持久生成并在 owner、due/reviewAt、status 或 source revision 改变时换代；同一 boundary 跨进程重启保持不变。NeedsAction 是按 viewer 过滤的 Ball projection，unread 不参与计算。

due/reminder 稳定键冻结为：

```text
unique(roomId, boundaryId, reminderKind, reminderOrdinal, recipientActorId)
reminderOrdinal = max(0, floor((now - dueAt)/24h))
scheduledAt(ordinal) = dueAt + ordinal * 24h
```

扫描只 claim 当前 eligible bucket，不补发多个历史 bucket；因此正常运行在 due 时产生 ordinal 0，长时间停机后恢复只产生当前 ordinal 一次，不形成通知风暴。claim、event/outbox 在同一 AuthorityWorker 事务中以唯一键写入；进程重启、重复 scan、多 worker 竞争只能产生一次。Human holder 交给 FT-12 recipient notification；Agent holder 交给 FT-08 project-boundary invocation intent。transfer、reopen、due revision 或 archive/resume 都生成新 boundary，旧 boundary 永不再次 claim；新 boundary 若已逾期，可立刻产生自身当前 ordinal。无 dueAt 的责任没有时间 reminder，但仍有 Ball。

### 4.8 confirmed project facts 与 memory

Goal active、Decision confirmed，以及 Project 对象的 confirmed/accepted/done 状态可产生只读 `ConfirmedProjectFactCheckpoint`：包含 project fact ID/version、source refs、confirming Human（如适用）和有效/被 supersede 状态。FT-05 只能通过 server-private read port 消费 checkpoint。

- memory proposal 不能创建或确认 Goal、Decision、Request、NextAction、Blocker/OpenQuestion。
- confirmed project fact 可作为 memory proposal 的依据；FT-05 后续可把 memory 标为 confirmed/disputed，但两者 ID 与状态机分离。
- memory disputed 会停止/降低该 memory 的注入资格，不会自动撤销 project fact。若争议实质挑战 project fact，Human 必须走 project supersede/reopen/cancel command。
- project fact superseded/recalled source 会向 FT-05 发事实版本变化；FT-05 决定对应 memory 的复核状态，不能反向静默改写旧 project audit。

## 5. 状态机与非法转换

| 对象 | 合法主路径 | 必须 409 的示例 |
|---|---|---|
| Goal | proposed → active/rejected；active → superseded（与 replacement confirm 同事务） | 第二个 active primary Goal；直接 proposed → superseded；终态回 proposed；跨 Room replace |
| Decision | proposed → confirmed/rejected；confirmed → superseded | Agent confirm；rejected → confirmed；跨 Room supersede；stale source/revision |
| Request | pending_acceptance → accepted/rejected/cancelled；`transfer(target')` 追加 target chain 并保持 pending_acceptance | 创建即 accepted；非 target accept/reject/transfer；handoff 后把责任压给新 target；accept 后 transfer/cancel；accept 未原子创建 linked responsibility |
| NextAction | proposed → accepted/rejected/cancelled；accepted → in_progress/cancelled；in_progress → delivered/cancelled/done（仅无 verifier 的 Human owner）；delivered → done/in_progress/cancelled；done → in_progress（显式 reopen）；reassign 后 Human target 回 proposed | Agent owner direct done；有 verifier 的 Human owner direct done；非 verifier验收；terminal rejected/cancelled reopen；pending transfer 先换 owner |
| Blocker | open → resolved/deferred/cannot_answer；deferred → open；cannot_answer → open（经已确认 transfer）/resolved；resolved 可显式 reopen | deferred 无 reason/reviewAt；cannot_answer 无 reason/escalation；非 owner代答；未接受 transfer 先换 owner |
| OpenQuestion | open → resolved/deferred/cannot_answer；deferred → open；cannot_answer → open（经已确认 transfer）/resolved；resolved → open（显式） | resolve 无 answer source；cannot_answer 无 reason/escalation；将 cannot_answer 写成 deferred；未接受 transfer 先换 owner |
| TransferProposal | pending → accepted/rejected/cancelled/expired | 终态重放不同结果；目标离 Room 后 accept；subject revision 已变；第二个 active proposal |

幂等重放相同 command 返回原 ACK 和同一 event IDs，不被视为非法转换；相同 idempotency key 不同 payload 返回 409。

## 6. principal / role / confirmation matrix

`Owner/Admin/Member` 均指当前 Room Human membership；Agent 的能力还受 Room 配置、project permission 和 FT-10 tool grant 限制。

| 动作 | Owner/Admin Human | Member Human | 目标/owner Human | Agent | 确认规则 |
|---|---|---|---|---|---|
| propose Goal/Decision | 是 | 是 | 是 | 仅 propose | 任一当前 Human 可 confirm/reject；不能由 Agent 确认 |
| replace Goal / supersede 冲突 Decision | 是 | 否；可提出 proposal | 同左 | 仅 propose | owner/admin confirm，CAS 同时关闭旧项 |
| 创建 `@Human` Request | 是 | 是 | 可作为 requester | 否 | FT-03 消息+pending Request 同事务；目标接受前无承诺 |
| accept/reject/transfer Request | target 不可用时 owner/admin 只可发起 target handoff，不能 accept/reject | 不得代目标执行 | 仅 current target 可 accept/reject/transfer | 否 | 新 target 回 pending acceptance；接受前仍无责任 |
| cancel Request | requester 或 Room owner 的治理取消 | requester | requester | 否 | 已 accepted 不可取消 handshake |
| create Human-owned NextAction | 是 | 可 propose | owner 自己 accept | 仅 propose | Human owner 明示接受；来自 accepted Request 时同一接受动作即授权创建 |
| create Agent-owned NextAction | 是；无明确 Human proposer 时为兜底 principal | 仅当本人是创建提议的 Human | verifier 必须具名 Human | 不能自指派 | 创建提议的 Human确认；无该 Human 时 owner/admin，且同时固定 verifier |
| update/deliver Agent action | 可治理取消/transfer | 否 | verifier 不能代 Agent 交付 | 仅自身 owned action | event 表示交付，不表示 done |
| verify Agent action done | 仅当本人是既定 verifier | 同左 | 仅具名 verifier | 否 | Human ACK/event；role 变化不自动换 verifier |
| Human action done/reopen | 仅当本人是既定 verifier；否则不能代办 | 同左 | 无 verifier 时 owner；有 verifier 时只交付 | 否 | done/reopen 遵守冻结 verifier；completion/reopen note 必填 |
| obstacle answer/resolve/defer/cannot_answer | owner/admin 只能发起 transfer/升级，不能代 owner 回答 | 仅自身责任 | owner | Agent 仅自身责任且不能产生 Human 确认 | source/result 与 reason/reviewAt 必填 |
| propose transfer | requester、current owner、Room owner（按对象规则） | 按对象规则 | current owner | 仅自身 owned object | pending 不换 holder；目标/授权 Human accept |
| project read | Room member | Room member | Room member | 仅授权 Room scope | FT-10 只读 tool 无副作用 |
| project write tool | 按以上动作矩阵 | 按以上动作矩阵 | 按以上动作矩阵 | 只能 propose/update/deliver 自身责任 | tool confirmation 不可提升 domain principal |

## 7. AuthorityWorker 事务、CAS、幂等、审计与 outbox

每个生产 write 必须由单一 AuthorityWorker SQLite transaction 完成以下顺序：

1. 鉴权 session、Room membership/lifecycle、principal 和 capability；
2. 以 `expectedRevision`/`expectedGovernanceRevision`/source revision 做 CAS；
3. 检查 closed invariant（唯一 active Goal、单 owner、具名 Human verifier、单 active transfer、boundary 唯一等）；
4. 写 domain row 和 append-only transition/confirmation/transfer/audit row；
5. 写 stable room event；
6. 写 recipient/project-boundary outbox 与 reminder claim（如适用）；
7. 写 idempotency response envelope；
8. commit 后才向 WS 返回 ACK/广播。

任一点 crash/rollback 后上述写入必须全为零；commit 成功但 socket 断开由同 idempotency key 返回原 ACK。project command 的 producer key 包含 command family + principal + roomId + caller idempotency key；FT-03/05/08/10/12 内部生产者使用各自稳定 intent/boundary/fact ID，不共享自然语言或时间戳作为 key。

audit 至少记录 actor/principal、command、subject revision before/after、source refs、reason code、confirmation/verifier、event IDs 和 timestamp；公开 event/repair/notification 只含最小投影，不含 credential、secret、tool raw parameters、raw model corpus 或不可见附件内容。

## 8. FT-02 server-private departure responsibility port

### 8.1 闭合合同

FT-09 提供 server-private、不可通过 protocol/WS 直接调用的只读端口：

```ts
type DepartureConflictKind =
  | "request"
  | "next_action"
  | "blocker"
  | "open_question"
  | "pending_acceptance"
  | "pending_confirmation"
  | "pending_verification";

interface DepartureResponsibilityPort {
  listInTransaction(
    tx: AuthorityTransactionView,
    input: { roomId: RoomId; targetHumanActorId: HumanActorId },
  ): readonly DepartureConflict[];
}
```

`DepartureConflict` 是 exact-key closed record：`conflictId`、`roomId`、`targetActorId`、`kind`、`subjectId`、`subjectRevision`、`responsibilityRole`（owner/target/verifier/confirmer）、`safeSummaryCode`、`allowedResolutions`、`sourceRef?`。不得含消息 body、附件正文、tool parameters、secret 或 raw corpus。`conflictId` 由 `departure-conflict-v1 + roomId + target + kind + subjectId + subjectRevision + responsibilityRole` 稳定导出；同一冲突跨查询稳定，责任 revision 改变时换 ID，始终 Room-scoped 且能 deep-link 到可操作对象。

覆盖范围至少包括：pending/active Request（含 requester 治理责任与目标 pending acceptance）、NextAction owner、Agent action 的 pending Human verifier、Blocker/OpenQuestion owner、pending transfer acceptance，以及 FT-10 pending confirmation principal。accepted Request 若 linked responsibility 已合法转移/完成，本身不形成伪冲突；collector 必须检查 linked canonical object，而不能仅按旧 Request status 猜测。

### 8.2 与 leave/remove 的同事务 final recheck

FT-02 的 leave/remove command 在**同一个 AuthorityWorker transaction 和同一个 SQLite connection**中：鉴权与治理 CAS → 调用 `listInTransaction` → 若非空返回 409 conflict list 并零写入 → 紧邻 membership mutation 前再次调用相同 port 做 final recheck → 仍为空才删除 membership、写 identity/room event/outbox/idempotency → commit。不得在事务外先查、随后另事务删除；不得缓存 conflict list 作为最终判断。

FT-10 的 pending confirmation collector 作为同 transaction 的 server-private participant 注册；功能已启用但 participant 缺失时 fail closed 为 503，不按“无冲突”处理。collector 自身只读，不接受、完成、取消或转移责任。

FT-02 只能观察以下合法终态后放行：目标 Human 自己 reject pending acceptance、requester cancel、Request target handoff 已把 pending acceptance 移到新目标、既定 responsibility transfer 被新目标接受、责任对象完成/取消、具名 verifier 被显式合法替换、pending confirmation 按 FT-10 规则拒绝/过期/撤销。FT-02 绝不能替目标 Human accept Request、写 done、伪造 verifier、自动接受 transfer 或把责任悄悄交给 Room owner。

## 9. 相邻 FT 的显式 seam

| 依赖 | FT-09 提供/消费的 seam | 事务与权限边界 |
|---|---|---|
| FT-03 structured `@Human` | 消费 `HumanRequestIntent` 的 closed target、source message ID/revision、requester、frozen payload；返回 Request ID/event IDs | message、intent、pending Request、event/outbox 同 AuthorityWorker transaction；消息 ACK 不等于 Request accepted；per-target invalid 不伪造 Request |
| FT-05 confirmed/disputed memory | 提供只读 `ConfirmedProjectFactCheckpointPort` 和 fact-version event；接收显式 memory source ref | memory proposal/confirmed/disputed 不改 project 状态；project supersede 只通知 FT-05 复核 |
| FT-07/08 project invocation | 提供 `{boundaryId,boundaryKind: checkpoint|due|blocker, roomId, subjectRef}`，仅 confirmed、active、unconsumed | Agent 不能从自由文本制造 boundary；FT-08 claim 后才建 invocation intent；取消按 source scope，不启动 autonomous chain |
| FT-10 project read/write tool | 提供 closed read queries 与 domain command dispatcher | read 只看 Room 可见 projection；write 复用同一 principal/CAS/confirmation matrix。Agent 仅 propose/update/deliver，不可 Human confirm/accept/done |
| FT-12 notification | 输出稳定 `(recipientActorId, boundaryId, notificationKind, ordinal)` 和 Room deep link；消费 read/handled projection | event/outbox 与 reminder claim 同事务；read 仅“看过”，handled 只由责任状态终结/转移产生；无跨 Room 五分区 inbox、无 OS push |
| FT-13 repair | 每个新 record/event 提供 closed guard、mapper、排序键与 descriptor，注册中央 registry | FT-09 不反向 import registry assembly；repair page 只含可见投影；checksum/三客户端/restart/sentinel 遵循 FT-13 checklist |

## 10. lifecycle、source、revoke 与 race

### 10.1 Archive / reopen

- archive 后禁止新的 project business mutation、接受、确认、transfer、完成和 reminder；pending FT-10 security confirmation 按 FT-10 规则 settlement，不保留可恢复授权。
- 非终态 project responsibility 原样冻结，记录 `suspendedAt` 与剩余 business duration；archive 不把它们标为完成/取消，也不转移 owner。
- reopen 恢复同一非终态责任并以剩余 duration 计算新 due/reviewAt，生成新 lifecycle generation 和新 Ball boundary；旧 reminder key 不复活。
- confirmed Goal/Decision 仍是历史事实；Room reopen 不自动重新 active 一个已 superseded Goal，也不复活 rejected/cancelled/expired/done 等 terminal responsibility。
- archive/reopen 期间的 projection、repair 与 UI 必须明确 suspended/archived，而不是把静态 cache 显示成 active。

### 10.2 Recall 与 source revision

- 未确认 proposal 的 pinned source 被 recall：proposal 变为不可确认的 `source_unavailable` projection；confirm 返回 410。保留 proposal/audit，不物理删除。
- source revision 在 confirm 前变化：旧 proposal confirm 返回 409 `source_revision_conflict`；Human 必须审阅新 revision 并创建/refresh 新 proposal。
- 已 confirmed/accepted 的 project fact 不因 source recall/edit 静默撤销；显示 source recalled/revised 标记，由 Human 显式 supersede/reopen/cancel。旧确认仍引用当时 source revision。
- FT-03 recall 与 Request 创建竞争由同一 worker ordering 决定：recall 先 commit 则不创建 Request；Request 先 commit 则 pending acceptance 被原子取消并终止 boundary，已 accepted 的 linked responsibility不被 recall 自动完成或删除。

### 10.3 Revoke、离场与并发

- session/membership revoke 在 command CAS 前可见时返回 401/403 且零写；若 project transaction 先 commit，已产生的事实与 audit 保留，后续 delivery/subscription/caches 按 identity lifecycle purge。
- accept vs cancel、verify vs reopen、transfer accept vs subject update、reminder scan vs completion 都以 revision CAS 和唯一键决定一个胜者；输家返回 409 并 repair，不做补偿式第二次状态变更。
- subject 删除不用物理 delete；terminal/superseded row 保留，避免 source deep link、audit、dedup 和 repair 失去锚点。

## 11. schema migration、backfill 与 rollback 原则

- migration 只能 append 到实施时实际生产 predecessor 之后；本文**不预占 schema version**。不得假设当前版本号在实施时仍为 13。
- 新表/索引/事件采用 project-specific 名称，与 `open_items`、`light_tasks`、`ball_boundary_claims` 并存。新 command 不双写旧表作为 authority；legacy UI 如需兼容只能读取显式 compatibility projection。
- backfill 是 immutable、可重复、带 migration provenance 的 compatibility import；不推断 confirmer/verifier/accepted target/source revision，不把旧 status 重命名为 Human confirmation，不参与 canonical invariant。
- destructive rollback 禁止。部署回退保留新表和事件，旧 binary 必须忽略未知 append-only schema 或通过 feature gate 停止新写；forward fix/repair mapper 恢复服务。任何 materialized projection 可重建，但 audit、confirmation、transfer、idempotency、event/outbox 不可删除。
- migration test 必须覆盖空库、旧生产 fixture、重复 migrate、部分 legacy 数据、未知较新 schema 拒绝、rollback 后再 forward，以及无伪造 authority 字段。

## 12. protocol、repair 与错误语义

新 Project protocol 使用独立 closed frame family（例如 `project.goal.*`、`project.decision.*`、`project.request.*`、`project.next-action.*`、`project.obstacle.*`、`project.transfer.*`、`project.query`），不得复用旧 `open-item.*`/`light-task.*` frame。每个 mutation 带 `requestId`、`roomId`、`expectedRevision` 和 `idempotencyKey`；ACK 返回 canonical projection、revision、event IDs、`replayed`。具体 frame 名在实现 slice 的 protocol fixture 中冻结，但不得改变本文 domain 语义。

错误边界：401 未认证/被 revoke；403 无 Room/project 权限或错误 principal；409 revision/状态/唯一 active Goal/active transfer/race conflict；410 Room archived、source recalled 或对象已不可操作；429 有界队列/速率限制，携带 retry hint；503 authority/registered participant/outbox/repair dependency unavailable。客户端只对 429、503、timeout 做同 idempotency key retry；401/403 进入权限恢复，409 拉取 subject/repair 后重放用户意图，410 返回来源或 Room 恢复路径。

FT-13 registry 至少加入 Goal、Decision、Request、NextAction、Blocker、OpenQuestion、TransferProposal、ProjectBoundary、ReminderClaim/recipient projection，以及对应 transition/confirmation events。每项都要 exact-key guard、type-level exhaustive test、authority-row mapper、snapshot/repair mapper、stable ordering/checksum 与 lifecycle visibility policy。

## 13. 验收不变量

实施只有同时证明以下条件，才能进入 FT-09 的 delivery/verification 流程：

1. Room/Project 同一 ID，数据库唯一约束阻止第二 active primary Goal；
2. `@Human` Request 接受前没有目标 Human responsibility，接受与 linked responsibility 同事务；
3. Agent 无路径确认 Human commitment 或写 Agent-owned action done；
4. deferred/cannot_answer、proposed/confirmed、delivered/done 在 Core、DB、event、repair、UI 全链路不合并；
5. transfer proposal 未接受不换 owner，接受后旧/新 Ball 同事务换代且链不可变；
6. 同 Room 多 source 并存，每 source boundary 单 holder；due 与 24h ordinal 跨 WS 重连、进程重启和竞争扫描不重复；
7. FT-02 departure collector 在 leave/remove 同事务 final recheck，冲突稳定、可操作且不泄露 raw corpus；
8. archive/reopen 不复活 terminal responsibility；recall/revision/revoke races 有确定 CAS 结果；
9. FT-03/05/07/08/10/12/13 seams 有 contract test，任一已启用 participant 缺失时 fail closed；
10. J-04/J-06/J-07 在 1440×900、840×560、规定 zoom、键盘、screen-reader/reduced-motion、offline/repair/error 分支均有证据；
11. real AuthorityWorker/SQLite/WS/三客户端/restart/crash-before-commit E2E 证明 ACK、event、outbox、repair 与 projection 收敛；
12. legacy backfill 没有伪造 confirmer、verifier、source revision 或 Human acceptance。

本设计只冻结工程合同；实施拆分、文件所有权、TDD 顺序和循环依赖解法见[实施计划](2026-08-18-ft09-project-loop-implementation-plan.md)。
