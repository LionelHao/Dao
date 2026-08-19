# FT-03 Stage 5 工作说明：Message Authority vNext

日期：2026-08-19

状态：生产实现、集成、自动化与代码 PR 已完成；等待 owner 验收，不得标记为 verified

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
| 1A | `codex/ft03-stage5-core` | `packages/core/src/message-authority*`、必要的 Core export/type tests 与显式 build include | exact guards/type negative tests RED→GREEN |
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

## 8. 未改生产代码的基线证据

- 必须使用仓库 `packageManager` 声明的 `corepack pnpm@10.14.0`。Codex fallback pnpm 11.19.0 会把现有
  Electron/esbuild build allowlist 误判为 ignored builds；该工具链失败发生在编译前，不是产品测试失败。
- `corepack pnpm typecheck`：通过。
- `corepack pnpm lint`：通过。
- `corepack pnpm test`：84 files passed、2 skipped；1234 tests passed、2 skipped。
- `corepack pnpm build`：Core、Server、Desktop 全部通过。
- `corepack pnpm --filter @native-im/desktop smoke`：`Electron Identity smoke passed`。
- fallback pnpm 造成的临时 node_modules 缺少 Electron binary 已通过执行锁定版本包自身的 install script 修复；
  `pnpm-workspace.yaml`、lockfile 与 dependency version 均无最终改动。

## 9. 最终生产实现

- Core：新增 Human submit、UTF-16 mention entity、逐 target outcome、revision、Agent final/correction、tombstone、timeline event/repair 的 exact closed contract；public payload 不能携带 author/principal/session/capability/runtime/provider/model。
- schema：从 v15 追加唯一 immutable v16 `message-authority-vnext`；message envelope/revision/mention/outcome、Human/Agent intent、execution link、reply/attachment、recall fence、Agent source/correction 全部 closed；v1～v15 statement/checksum/fingerprint 未改。
- Authority：`message.send.v2` 在一个 `BEGIN IMMEDIATE` 中重验 session/Room/member/target，写 message、revision 1、每 target 唯一 outcome、accepted intent、event、outbox、receipt 与 ACK；任一系统错误整笔 rollback。
- revision/recall：author-only/current-revision CAS；revision append-only且冻结 targets/reply/attachments/outcome/intent lineage；recall 投影 body-free tombstone，先 durable cancel/fence，再向 exact source runtime 传播 abort。
- Agent final/correction：仅 server-internal opaque capability；重验 Agent、intent、execution、attempt/generation、source revision/fence 与 terminal CAS；public WS 无对应命令。
- operational projection：history、stable event、delta、outbox、materialized/streaming repair、Desktop replica/timeline 共用 message-specific canonical seam；recalled raw 不进入 operational surface。
- Desktop：closed five-operation-plus-subscribe bridge；main-only session/token/socket；structured mention/reply/target outcome/revision/recall/final/correction、offline/repair/revoked/410 与 accessibility 状态全部按 DESIGN_CONTRACT 接入真实 ACK/event/projection。

## 10. RED→GREEN 与竞态证据

- 每个切片先以缺失模块、旧 schema、旧 parser、旧 renderer 状态或真实 SQLite 反例取得 RED；没有删除、skip 或弱化既有测试。
- 真实 SQLite 覆盖 member removal/Agent assignment reduction vs send、target/domain/outcome fault、two-device revision、revise vs recall、recall vs claim/create/final、Agent/Human route source fence、exact replay/change conflict。
- 真实 child-process 覆盖三客户端、同 author 两设备、ACK 未消费后新 requestId replay、outbox stable event、restart、cursor expiry、clear-and-restore、revise/recall 与 Desktop 收敛。
- preview sentinel 经过 provider chunk、durable recall、SIGKILL、restart、reconnect；SQLite operational columns、DB/WAL/cache bytes、event/outbox/history/repair/runtime context/Desktop input 均零命中。completed final 与 succeeded dispatch 保留。
- recalled raw 仅保留于受限 authority revision/audit；旧/full message event、pending outbox、sync、route/calibration、runtime context 与 pre-recall snapshot cache 均被 tombstone/fence/invalidation 收敛。

## 11. 最终计数与门禁

- 全仓：101 files passed、2 live suites skipped、0 failed（103）；1430 tests passed、2 skipped、0 failed（1432）。
- real Authority/process：23/23；SQLite authoritative store：84/84；snapshot worker：70/70；schema v15/v16/general：69/69；Desktop：33 files / 308 tests。
- focused safety matrix：6 files / 207 tests；archived repair watermark：1/1。
- `corepack pnpm typecheck`、`lint`、`test`、`build`、`verify:core-boundary`、`verify:desktop-boundary` 与 `git diff --check` 全部通过；lint 0 warnings。
- 两个 skipped 是既有 opt-in OpenAI live smoke，不是本阶段回避项。

## 12. PR 与合入顺序

| PR | Ready head | Squash merge | GitHub quality |
| --- | --- | --- | --- |
| [#42 · Core closed contracts](https://github.com/LionelHao/Dao/pull/42) | `c63e685300172c13328e47a4312e573bcd197429` | `f768accac1266fc891e3f09a4f46daa7464e4bd9` | [32224440190](https://github.com/LionelHao/Dao/actions/runs/32224440190)，Node 22.13.1 / 22.x success |
| [#43 · schema v16](https://github.com/LionelHao/Dao/pull/43) | `28f990c7b6a410f90e057a1cffe333a426270c94` | `2b775156adcfaf06bbb6fe33bcc71fd58023154d` | [32231268177](https://github.com/LionelHao/Dao/actions/runs/32231268177)，Node 22.13.1 / 22.x success |
| [#44 · closed protocol](https://github.com/LionelHao/Dao/pull/44) | `499f6bdc6eede7b7221a91e26126e2b5f1d013a9` | `d7b64d1d5dff84bb16340805e08305fb0f36b555` | [32235419770](https://github.com/LionelHao/Dao/actions/runs/32235419770)，Node 22.13.1 / 22.x success |
| [#45 · Authority lifecycle](https://github.com/LionelHao/Dao/pull/45) | `f4ed9bc8f6340fc8586fb983474f10b92686adde` | `ec3bb653e803064cd62f2b6f6fae8ed47705140b` | [32237011304](https://github.com/LionelHao/Dao/actions/runs/32237011304)，Node 22.13.1 / 22.x success |
| [#46 · Desktop loop](https://github.com/LionelHao/Dao/pull/46) | `069e1f72affeddc598d0c84f21c4bc6c57fec6d1` | `4ca050a22422814a42600813ead006a708d62721` | [32237833927](https://github.com/LionelHao/Dao/actions/runs/32237833927)，Node 22.13.1 / 22.x success |
| [#47 · race/leakage/E2E](https://github.com/LionelHao/Dao/pull/47) | `299a3d795c80c98b647eef4917e1529a8a6a9193` | `326f72d082b4e008946989d13380deb923dc70a3` | [32239461206](https://github.com/LionelHao/Dao/actions/runs/32239461206)，Node 22.13.1 / 22.x success |

## 13. 边界与后续 owner

- attachment reference 只保留 closed seam；`attachments: []` 可用，非空值在 FT-04 validator 合入前 fail closed。
- FT-05 memory lifecycle、FT-08 完整 scheduling、FT-09 完整 Request lifecycle、FT-11 完整产品壳、FT-14 audit/export/retention 仍由各自 FT owner 负责；本阶段没有把 seam 描述为完整产品。
- 建议 persistence reviewer 复核 v16 immutable DDL、逐 statement rollback、source/execution/final CAS 与 snapshot physical deletion；runtime/tool reviewer 复核 dispatched/outcome_unknown truthfulness；sync/Desktop reviewer 复核 fixed-watermark retry、revoked purge 与 renderer authority boundary。
- 未修改 Blueprint HTML/JSON，未自行更改任何 FT/Blueprint 状态；原工作区四份未跟踪 FT-09/FT-10 文档保持原样。
