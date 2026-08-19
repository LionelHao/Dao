# Cross-FT Shared Contract Spine 工作记录

> 日期：2026-08-18
>
> 分支：`codex/shared-contract-spine`
>
> worktree：`/Users/leo/code/Dao-shared-contract-spine`
>
> 基线：`origin/main@8425ffb659bcba02f1929b59a8b284da3f88f0f8`

## 1. 开工审计

- 开工前执行了 `git status --short --branch`、`git worktree list --porcelain`、`git fetch --prune origin` 和 `git log`。原 `/Users/leo/code/Dao` 工作区存在 4 个未跟踪的 FT-09/FT-10 设计文件；本任务未修改、移动或纳入这些文件。
- 最新 `origin/main` 已包含 FT-07、FT-09、FT-10 design/implementation plan，FT-02B/FT-02C sliced implementation note，FT-03、FT-08、FT-13 设计，以及 FT-02A delivery。
- `AUTHORITY_SCHEMA_VERSION = 13`。最后 migration 为 `v13 room-governance-foundation`，checksum 为 `0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e`，schema fingerprint 为 `037df6a2818f2a90b7394240a4cf71d77949faf31df6534c5546c9ed6b7e7191`。
- 本任务未修改 `schema.ts`、任何 v1-v13 migration statement、checksum 或 fingerprint，未创建 v14。

## 2. 权威映射与范围

| 合同面 | Requirement / FT | 本次实现 | 未启用事项 |
| --- | --- | --- | --- |
| departure final recheck seam | `REQ-ROOM-003`；FT-02B、FT-09、条件性 FT-10 | branded transaction view、departure 与 pending-confirmation contributor、closed result guard | leave/remove command、FT-09/10 SQL/reducer |
| archive atomic settlement seams | `REQ-ROOM-004`、`REQ-AGT-010`、`REQ-AGT-012`、`REQ-AGT-013`；FT-02C、FT-03/08/10 | message gate、timer、tool settlement、runtime fence 的固定接口与注册校验 | archive/reopen command、timer/tool/runtime 状态机 |
| assignment access reduction | `REQ-ID-004`、`REQ-AGT-004`；FT-07 | assignment security reduction closed participant | Profile/Assignment SQL、reducer、路由成功路径 |
| repair/cache/offline lease | `REQ-ID-005`；FT-13/14 | lifecycle descriptor 独立 gate、cache/lease 独立 composition gate | repair assembly、cache purge、lease issuance/revocation |

UI / 交互映射：本任务没有 public Core、protocol、WebSocket、preload、renderer 或 Desktop 可见状态，不触及 J-01～J-07 的组件、loading、empty、401/403/409/410/429/503、offline/repair、焦点、键盘、非颜色识别、`aria-live`、缩放或 reduced motion 分支。可见状态权威来源不适用。设计偏离：无。

## 3. 固定合同与边界决定

生产代码只新增于 `packages/server/src/room-governance/private-participant-contracts.ts` 和 `private-participant-registry.ts`：

1. `AuthorityTransactionView` 使用 private unique-symbol brand、WeakSet provenance 和 non-enumerable identity；JSON 只能得到 `{}`，反序列化对象不能通过 guard。
2. `ParticipantRegistration` 固定 exact runtime keys、`version: 1`、closed feature union。`enabled: false` 时禁止携带 participant；因此不能用空数组或 no-op callback 冒充 production provider。
3. feature manifest 必须完整且 exact-key，显式覆盖十个固定 feature，不接受未知 key。
4. transaction registry 只拥有七个固定 transaction participant slot。`LifecycleRepairDescriptor` 使用独立 registration gate；`RoomCacheInvalidationPort` / `OfflineLeaseInvalidationPort` 使用独立 composition gate。全量 startup assertion 只组合三类验证，不提供动态 discovery、plugin lifecycle 或第二 registry authority。
5. command invoker 在调用 participant 前再次验证 manifest、registration、version、duplicate ID/feature、transaction provenance 与 Room；participant throw、malformed envelope、sensitive/extra key 或 cross-Room result 均转成新的 closed 503，原异常 message/cause/SQL/stack 不进入 safe envelope。
6. participant 结果只允许固定 ID、revision/generation、枚举、计数和 approved safe summary 字段；exact guards 拒绝 raw message/body、attachment、tool params、secret、token、SQL、stack 等额外字段。
7. spine 不包含 SQL、migration、业务 reducer、状态机、event bus、transaction manager、writer、默认 participant、production fake 或 public export。

## 4. TDD 记录

按要求先添加：

1. public/internal type rejection test；
2. exact registration/manifest/envelope guard test；
3. enabled-missing、duplicate registration ID、version 与 manifest mismatch matrix；
4. participant throw、malformed、sensitive 与 cross-Room result test；
5. command pre-validation zero-call 与 deep transaction rollback seam test；
6. package root / Core / protocol / WebSocket / preload / renderer boundary test；
7. 最小生产合同和 validator/invoker。

初次 RED 在生产模块不存在时得到 2 个 failed suites；补入最小实现后 focused suite 为 3 个测试文件、13 个测试通过。deep transaction seam 只在 `.test.ts` 内存在，没有从 package root 或生产模块导出。

## 5. 共享文件与 schema 证明

未修改以下共享文件：

- `packages/server/src/persistence/schema.ts`
- `packages/server/src/persistence/authority-database-handler.ts`
- `packages/server/src/persistence/authority-worker.ts`
- `packages/server/src/protocol.ts`
- `packages/server/src/websocket.ts`
- `packages/server/src/persistence/snapshot-worker.ts`
- `packages/desktop/src/renderer/app.ts`

因此没有文件所有权冲突需要 owner 裁决，也没有机械接线之外的共享窗口变更。本任务不启用 leave/remove/archive/reopen 或任何 FT-07/09/10/13 production success path。

## 6. 验证记录

最终全仓命令、测试文件数与测试数记录在 `docs/deliveries/Shared-Authority-Participant-Spine-交付说明.md`。本记录不改变 Blueprint，也不声明 FT-02、FT-07、FT-09、FT-10 或 FT-13 完成或 verified。
