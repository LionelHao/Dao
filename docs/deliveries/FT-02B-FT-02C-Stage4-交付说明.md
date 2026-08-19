# FT-02B / FT-02C · 第四阶段总交付说明

> 日期：2026-08-19
> 状态：交付条件已满足，等待 owner 验收；本文不宣布任何 FT、阶段或 Blueprint verified。

## 1. 一句话结果

FT-02B Human departure 与 FT-02C archive/reopen 已通过 closed protocol、AuthorityWorker 单 writer transaction、sync/repair/cache/lease、真实 Desktop bridge 和跨进程 SQLite 自动化形成完整生产闭环。

## 2. 交付范围

- FT-02B：conflict preflight、self-leave、owner/admin Human remove、transfer-before-leave、final responsibility recheck、atomic membership/access/audit/event/outbox/receipt。
- FT-02C：archive/reopen、八项 production lifecycle dependency、timer continuity、archived allow/deny、repair/cache/offline lease invalidation、bounded rescan。
- Core/protocol：closed lifecycle events、CAS commands、requestId-correlated ACK、closed errors/details、strict missing/extra/wrong/oversized/injection refusal。
- Desktop：Governance permission matrix、conflict sheet、archive/reopen/read-only/revoked/repair/offline 状态、closed main/preload bridge、authority cache 与 ClientSyncReplica projection。
- process evidence：renderer → preload/main → WebSocket → authoritative server → AuthorityWorker → SQLite → stable event → replica → renderer。

## 3. Authority 不变量

- AuthorityWorker 是唯一 writer；没有第二 DB、writer、event bus 或 registry。
- accepted mutation 在一个 `BEGIN IMMEDIATE` 内提交 fact、immutable audit、stable event、outbox、idempotency receipt、closed ACK result。
- departure final collect 紧邻 membership mutation；blocked/unauthorized/stale/dependency failure 全部零写。
- archive participant 顺序严格固定；任一步失败整笔 rollback；reopen 只恢复合法 business timers，commit 后 bounded rescan 重验 generation/revision。
- cache、offline lease、Desktop local state 都不是业务事实源。

## 4. Closed transport

| Operation | Request contract | Result / error |
| --- | --- | --- |
| governance get | exact room + requestId | closed governance projection |
| departure conflicts | exact room + target | room/target-scoped closed conflict list；无 receipt |
| leave/remove | governance CAS；remove closed target | `room.governance.ack` + event IDs + replayed；409 final conflicts |
| archive/reopen | governance CAS | lifecycle governance ACK；already-state inert |

401/403/404/409/410/429/503 均 fail closed；client 不能提交 actor、role、principal、session family、grant 或 transaction capability。Legacy `member.remove` 与 archive empty payload 不供新 transport 使用。

## 5. Schema 与 durability

- predecessor v14 保持 immutable；新增唯一 v15 `truthful-room-lifecycle-audit-vocabulary`。
- checksum `41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9`；fingerprint `e8010dc3c03c71d51f20ef4054a815d3580abdcbd0762791508226a68918b426`。
- fresh/history/future/tamper/每 statement rollback 全覆盖；schema 49/49。
- crash-before-commit 保持零写；commit-before-ACK、send-before-dispatch-mark 与 restart exact replay 返回唯一 stable event/ACK。

## 6. Sync / repair / cache / lease

- lifecycle 进入 summary、stable event、delta/full repair；duplicate event apply once。
- materialized/streaming 共用 registry 与 effective access revision；archive/remove/revoke 触发正确 scope preemption与 staging discard。
- current Human archived read 保持；nonmember/removed/Tenant Administrator-without-membership 拒绝。
- invalidation intent durable、commit 后 bounded replay；旧 access/lifecycle/lease generation 立即 fail closed。

## 7. Desktop 与设计覆盖

- Requirement：`REQ-ROOM-001/002/003/004`、`REQ-ID-003/005`、`REQ-PRIM-003/005`、`REQ-UX-003/005/006/007/009` 及相关 NFR/PRJ/AGT 横切项。
- FT：FT-02B、FT-02C、FT-11 窄 bridge、FT-13 replica/cache seam、FT-16。
- Journeys：J-01、J-04、J-07；分区包括 Room list、Settings/Governance、departure sheet、archive confirmation、archived Room、repair/revoked/fatal。
- state source：输入/选择/submitting 为 local；accepted 为 ACK；transition 为 stable event；最终 role/revision/lifecycle/repair 为 projection。
- accessibility：keyboard、focus return、non-colour text、`aria-live`、VoiceOver contract、100%-200% zoom、reduced motion。
- 设计偏离：**无**。

## 8. Real process 与 sensitive sentinel

- `authority.e2e.test.ts` 的 production Desktop journey 使用真实 loopback TCP/WebSocket、authoritative child、AuthorityWorker 与 SQLite，不是 contract fixture。
- archive/reopen 后断言 DB room/audit/event/outbox/idempotency 行、ClientSyncReplica applied IDs 与 renderer projection 同 revision。
- issued access token 不进入 renderer IPC traffic 或 DOM；private signing/key material、participant/transaction capability、raw socket/generic IPC 不从 package root/renderer 暴露。

## 9. 最终门禁与计数

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
git diff --check
```

| Evidence | Result |
| --- | --- |
| 全仓 Test Files | 84 passed / 2 skipped / 0 failed（86） |
| 全仓 Tests | 1234 passed / 2 skipped / 0 failed（1236） |
| real Authority/process | 18/18 |
| Desktop | 23 files / 232 tests |
| schema | 49/49 |
| typecheck/lint/build/boundaries/diff | 全部通过；lint 0 warnings |

两个 skipped 是既有 opt-in OpenAI live smoke，不是本阶段回避项。

## 10. PR、head、merge 与 CI

| PR | Ready head | Squash merge | Quality run |
| --- | --- | --- | --- |
| [#38 · foundation](https://github.com/LionelHao/Dao/pull/38) | `3747933e0eea51ef117bb380dbd9a553c39b91b4` | `19da638cd8b368d6fea32bc9a0c5e7296e8d4250` | [32219031006](https://github.com/LionelHao/Dao/actions/runs/32219031006)，Node 22.13.1 / 22.x success |
| [#39 · Authority](https://github.com/LionelHao/Dao/pull/39) | `9a5a86f38a3e73dcdd407c7c77f65eae17ad68ad` | `e382c6737cc5f784cf56585d6de8850b400e4c1a` | [32219411941](https://github.com/LionelHao/Dao/actions/runs/32219411941)，Node 22.13.1 / 22.x success |
| [#40 · Desktop/live E2E](https://github.com/LionelHao/Dao/pull/40) | `9b357451d53b100371c4f567beb0c514aec963d0` | `ea03bab84f805a1ab8e34972a6f2ff46862b126d` | [32219777436](https://github.com/LionelHao/Dao/actions/runs/32219777436)，Node 22.13.1 / 22.x success |

## 11. 已知风险与建议 reviewer

- persistence：复核 v15 immutable DDL、truthful audit vocabulary、target access uniqueness 与 fault rollback。
- FT-09/FT-10：复核 departure conflict closure、final collect 相邻性、tool dispatched/outcome truthfulness。
- timer/runtime：复核 archive participant order、absolute expiry、reopen timer continuity 与 late generation CAS。
- sync/access/Desktop：复核 bounded post-commit purge/rescan、target preemption、repair-before-ACK race 与 renderer credential boundary。
- 完整 FT-11 shell、FT-13 offline product、FT-10 review UI 不在本阶段；没有用 Stage 4 seam 冒充这些后续产品。

## 12. 边界声明

- 未修改 Blueprint HTML/JSON，未自行修改 FT/Blueprint 状态。
- 用户原始工作区的四份未跟踪 FT-09/FT-10 文档未被纳入本阶段提交。
- 本交付结论等待 owner 独立验收；执行者不使用 verified 表述。

**第四阶段已达到交付条件，等待 owner 验收。**
