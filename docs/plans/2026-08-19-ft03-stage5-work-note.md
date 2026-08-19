# FT-03 Stage 5 工作说明：Message Authority vNext

日期：2026-08-19

状态：实施中；不得标记为 verified

前置交接：T0040、T0041、Shared Stage 3、Stage 4 delivery/work note

基线：`origin/main@7659690b748dd651d43fbdb5f0980e21e1c3e81b`，authority schema v15

## 1. 权威映射

本阶段以产品 PRD、`docs/protocols/`、已批准 FT-03/FT-08/FT-09/FT-13 设计与计划、
以及 `docs/design/README.md` 当前指向的正式自包含审阅稿为权威。生产代码和测试只用于证明实现。

- FT：FT-03 Message Authority vNext；依赖 FT-08 的 intent/execution 解耦与 scoped cancellation、
  FT-09 的 Human Request pending lineage、FT-13 的 canonical projector/fixed-watermark repair。
- Requirements：REQ-ID-001、REQ-PRIM-006/007/008/010/011/012、REQ-MSG-001～008、
  REQ-UX-007、NFR-002/003/004/005/007/010/011/012/014。
- 设计旅程：J-02 结构化发送与重试；J-03 逐 Agent target 独立执行；J-04 Human Request 与责任接收；
  J-07 offline/repair/固定 watermark 收敛。J-01/J-05/J-06 只作为身份、路由与治理边界，不扩张本阶段功能。
- 设计分区与组件：Room header/status、message timeline、structured composer、mention picker、
  attachment placeholder、reply context、target outcome/activity、revision/recall controls、offline/repair banner、
  accessibility live region。
- 设计偏离：无。附件非空值按 FT-04 未开放能力 fail closed；设计中的 preview 只显示 transient activity，
  不进入稳定 timeline。任何没有协议命令、ACK、stable event 或 projection 的展示均不得伪装为成功。

## 2. 可见状态与权威来源

| 可见状态 | 权威来源 | 允许的客户端行为 |
| --- | --- | --- |
| draft / reply draft / mention picker | local transient | 可编辑、可取消；不得改变服务端事实 |
| submitting / retrying | local transient，绑定 requestId + messageId | 保留正文与结构化 target；不可显示“已发送” |
| message accepted / revision / recall | matching server ACK | 只在严格解析通过后更新操作状态 |
| target rejected/accepted | durable ACK + stable event/projection | 逐 target 展示；一个 target 失败不得回滚其他 target |
| invocation pending/running/terminal | stable execution event/projection | pending 不等于执行，preview 不写稳定 timeline |
| Human Request pending/accepted | 与 human message 同事务的 intent/projection | target 接收前不得显示责任已经转移 |
| Agent final/correction | internal capability + stable event/projection | 仅内部 authority 路径可创建；public WS 不可序列化 capability |
| tombstone | recall ACK + stable projection | 保留消息位置、reply 可解析、隐藏正文，保留已完成事实 |
| offline | local connection state + last complete replica | 只读；提交在 bridge 前失败，不能排队伪装成功 |
| repairing | server fixed watermark + staged replica | 继续显示旧完整视图；校验成功后原子切换 |
| repair failed | server/validation error | 保留旧完整视图并提供重试；不得部分提交 repair |

## 3. 分支与错误状态覆盖

- loading：首次 history/repair 使用有文本的 busy state；旧完整投影存在时不得清空 timeline。
- empty：房间无稳定消息时显示空 timeline，composer 仍取决于 active room/current membership。
- 401：会话无效；清理 authority capability，回到重新认证边界。
- 403：非当前成员/非作者/能力不足；不做本地乐观持久化。
- 404：跨房或不可见 reply/source fail closed，不泄露对象存在性。
- 409：idempotency payload mismatch、revision CAS、source/execution/fence/generation CAS 冲突；刷新权威投影后重试。
- 410：unsafe legacy reader、已撤回/过期且协议定义为 gone 的入口；timeline tombstone 本身仍可投影。
- 429：有界 backoff，保留草稿和同一 business idempotency scope。
- 503：依赖/repair unavailable；保留旧完整状态并提供显式重试。
- archived：读取按 authority policy，所有 message/message-intent 写入 fail closed；逐 target race 可产生
  `target_room_archived` outcome。
- attachments：`[]` 为当前唯一可接受值；非空数组返回 feature unavailable/validation error。

## 4. 可访问性与响应式合同

- 键盘：composer、mention picker、reply、revision、recall、retry、target details 全部可顺序聚焦；
  picker 支持方向键、Enter、Escape，焦点关闭后返回触发点。
- 识别：状态必须有文字/图标/语义，不依赖颜色；duplicate display name 始终携带稳定 actorId 辅助信息。
- 通告：发送、逐 target outcome、revision conflict、recall、offline、repair 成败通过有界 `aria-live` 通告；
  不重复播报同一 eventId。
- 缩放：1440×900 主基线；最小 840×560 和 200% zoom 不丢失主要操作，右栏按设计下沉为 timeline/project segment。
- reduced motion：禁用非必要位移动画，preview/repair 只用稳定文本与无动画状态也能辨认。

## 5. 不变量与测试哨兵

- `authorActorId` 仅由已认证 session 注入；public payload 不含 author/capability/runtime kind。
- `message.send.v2` 的 business scope 固定为 `(principal, command, roomId, messageId)`；requestId 不是幂等键。
- UTF-16 range、exact keys、ISO timestamp、唯一 target/range/attachment 全部 strict parse。
- human message envelope、revision 1、逐 target outcome/intent、event、outbox、idempotency、ACK 在一个事务中提交。
- revision/recall 为 author-only CAS；recall 先 durable cancel/fence，再 best-effort abort；late final 必须 CAS 拒绝。
- Agent final/correction 只接受不可序列化内部 capability；source/execution/attempt/generation/fence 全部重验。
- legacy `message.send` 不解析 mentions、不建 intent；unsafe reader 返回 410。
- history/event/sync/snapshot/repair/replica/Desktop 共用 canonical operational projector，不能形成双重事实来源。
- schema v16 仅新增 immutable migration；v1～v15 SQL/checksum 不修改；逐 statement fault injection 必须原子回滚。
- real E2E 必须经过 renderer → closed preload/main bridge → loopback WS → server → AuthorityWorker → SQLite →
  stable event → replica → renderer，禁止 in-memory fake authority 冒充生产链路。

## 6. Wave 所有权与集成顺序

| Wave | 分支 / Agent | 独占文件范围 | 交付门槛 |
| --- | --- | --- | --- |
| 1A | `codex/ft03-stage5-core` | `packages/core/src/message-authority*`、必要的 Core export/type tests | exact guards/type negative tests RED→GREEN |
| 1B | `codex/ft03-stage5-schema` | `packages/server/src/persistence/schema.ts`、schema tests（含把历史冻结测试显式固定到 v15 的最小改动） | v15→v16/backfill/fingerprint/fault rollback RED→GREEN |
| 1C | `codex/ft03-stage5-desktop` | 新增 `packages/desktop/src/renderer/message-authority/**` | DESIGN_CONTRACT、view model/component contract RED→GREEN；无 fake transport |
| 1R | integration root | 本工作说明、只读审计、共享接口裁决 | 不与子 Agent 同时改共享文件 |
| 2 | 复用空闲 Agent | server authority、protocol/WS、projector/repair、Desktop bridge/E2E 分片 | 每片先 RED、review 后 cherry-pick |
| 3 | integration root | 共享 composition、冲突修复、全仓验收、delivery/PR | 全命令通过，ready-for-review PR，CI green，squash merge |

所有子分支从上述 `origin/main` SHA 建立，先报告 `git status --short --branch` 与 base SHA；只编辑分配范围，
提交后报告 commit SHA、文件、RED/GREEN 命令、共享 API 需求与风险。集成分支逐提交 review/cherry-pick，
不得整棵目录覆盖。原工作区 4 份未跟踪 FT-09/FT-10 文档不在本阶段所有权内，保持未修改、未暂存。

## 7. 外部依赖审计

- Core 继续保持零 runtime dependency；strict guards 使用 TypeScript/JavaScript 标准能力。
- Server 继续使用 Node.js 22 内建 `node:sqlite` 作为单写 authority，`ws@8` 作为 loopback WebSocket；
  两者已在当前生产路径和测试路径中使用，无需引入 ORM、event bus、mention parser 或 retry library。
- Desktop 继续使用 Electron 37、现有 closed preload/main IPC、`ws@8` 和 `@native-im/core`；renderer 不新增网络依赖。
- 测试继续使用 Vitest/jsdom 和现有 Electron smoke harness；不新增 production/dev dependency。
- 风险：Node `DatabaseSync` 事务仍需保持 worker-thread 单写；WebSocket 消息必须继续执行 exact parse 和 bounded frame；
  Electron bridge 必须是显式 allowlist，不能把 socket、session token 或内部 Agent capability 暴露给 renderer。
- 结论：本阶段不需要外部依赖升级或新增。若后续实现发现必须新增依赖，应先补充维护状态、license、版本固定、
  Electron/Node 兼容性和供应链风险证据，再等待 owner 裁决。
