# FT-02B / FT-02C Stage 4 Implementation Work Note

> 日期：2026-08-19
> 状态：生产实现、集成、自动化与代码 PR 已完成；不声明 FT-02、阶段四或 Blueprint verified
> predecessor：`origin/main@2a505f934c160dfa9f476248083c96d7fb7ce3ba`
> integration branch/worktree：`codex/stage4-room-governance` / `/Users/leo/code/Dao-stage4-room-governance`

## 1. 开工审计与保护边界

- 开工前重新 fetch；实际 `origin/main` 与任务基线一致。
- 原工作区 `/Users/leo/code/Dao` 位于 `codex/ft02a-delivery-trace-fix`，包含四份未跟踪 FT-09/FT-10 文档。本阶段没有 clean、stash、reset、移动、覆盖或纳入这些文件。
- predecessor schema 为 v14；checksum `a0236646cdbc9d018e120caf8ccde012433e0d32fb7a011c2b4a2be34404085d`；fingerprint `b4f1034ce034203fd14f5bc32391cb8855f7d6eed64c0b01f75d41e331a8b5c5`。
- v14 `room_audit` 的 closed CHECK 不能表达 `room.member.left` / `left` 与 `room.reopened` / `reopened`，且 target-scoped member access reduction 不能 truthfully 复用 archive invalidation，因此追加唯一 immutable v15；v1-v14 statement、checksum、fingerprint 未修改。
- v15 migration：`truthful-room-lifecycle-audit-vocabulary`；checksum `41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9`；fingerprint `e8010dc3c03c71d51f20ef4054a815d3580abdcbd0762791508226a68918b426`。
- 没有修改 Blueprint HTML/JSON，也没有自行把任何 FT、阶段或任务标记为 verified。

## 2. Requirement、FT、设计旅程与状态来源

| 表面 / 合同 | Requirement / FT | 设计旅程与分区 | 权威状态来源 |
| --- | --- | --- | --- |
| Room list active/archived、selected、revoked | `REQ-ROOM-001/004`、`REQ-ID-005`、`REQ-PRIM-003/005`、`REQ-UX-003/006`；FT-02C/11/13/16 | J-01、J-07；Room list、startup/revoked/repair | catalog/room projection；stable lifecycle/access event；本地仅保存当前选择 |
| Settings → Governance 权限矩阵 | `REQ-ROOM-002/003`、`REQ-UX-005/007/009`；FT-02B/02C/11/16 | J-01、J-04、J-07；Settings drawer / Governance | governance + membership projection；success 需要 matching ACK 和 stable event/projection 或同 revision authoritative repair |
| ownership transfer、Human leave/remove | `REQ-ROOM-002/003`、`REQ-ID-005`、`REQ-PRIM-005`、`REQ-NFR-002/011/014`；FT-02B/09/10/13 | J-04、J-07；owner picker、departure preflight/conflict sheet | local selection/submitting；server preflight；transaction ACK/final 409；membership/governance event/projection |
| archive/reopen 与 archived read-only | `REQ-ROOM-004`、`REQ-AGT-010/012/013`、`REQ-PRJ-010/012`、`REQ-NFR-014`、`REQ-UX-007/009`；FT-02C/03/07/08/10/13/16 | J-07；archive confirmation、archived banner、reopen、repair/revoked/fatal | local confirmation；closed ACK；stable lifecycle event；governance/lifecycle/repair projection |
| offline / repair / retry | `REQ-ID-005`、`REQ-NFR-004/007/008/010/011`、`REQ-UX-006/007`；FT-11/13/16 | J-01、J-07 | only last complete finite-lease cache for offline read；repair staging atomic；access projection locks then purges |

设计偏离：**无**。演示按钮、静态 fixture 与 callback 返回均不作为业务成功来源。

## 3. 错误、恢复与 accessibility

- `401/403/404/409/410/429/503` 都有 closed renderer/server 分支；`departure_blocked` 仅允许 409 closed details，final 409 替换 preflight 列表。
- offline mutation fail closed；repair-failed 保留旧完整 projection 或锁定空状态，不显示半个 generation；removed/revoked 先锁 UI、丢 staging、清目标 Room cache。
- drawer、confirm、conflict sheet、source link、retry、reopen 全键盘可达并恢复焦点；owner/admin/member、archived、offline、repair 与 error 都有非颜色文本标识。
- `aria-live` 只播报有限提交/成功/失败/repair 结果；100%-200% zoom 保留动作；遵守 `prefers-reduced-motion`。

## 4. 多 Agent ownership 与 TDD

| Owner | branch / worktree | 第一波独占范围 |
| --- | --- | --- |
| FT-02B | `codex/stage4-ft02b-departure` / `/Users/leo/code/Dao-stage4-ft02b-departure` | `packages/server/src/room-governance/departure-governance*` |
| FT-02C | `codex/stage4-ft02c-archive` / `/Users/leo/code/Dao-stage4-ft02c-archive` | `packages/server/src/room-governance/archive-coordinator*` |
| Desktop | `codex/stage4-desktop-governance-red` / `/Users/leo/code/Dao-stage4-desktop-governance-red` | feature-local renderer governance surface/tests |
| Integration owner | `codex/stage4-room-governance` / `/Users/leo/code/Dao-stage4-room-governance` | schema、Core、AuthorityWorker/handler/store、protocol/WS、sync/repair、Desktop bridge、real process E2E |

- FT-02B RED：coordinator module 不存在；随后 departure focused 17/17，真实 aggregate + FT-10 contributor 组合证明非空冲突。
- FT-02C RED：archive coordinator、archived access 与 target revocation modules 不存在；随后 archive coordinator 12/12，archive/read/repair/cache/lease focused 8 files / 110 tests。
- closed transport RED：protocol/query/parser/WS 21 failures，既有 226 tests 仍通过；随后三文件 247/247。
- Desktop RED→GREEN：先固定设计/状态/authority seam，再接 main/preload/replica；最终 Desktop 23 files / 232 tests。
- 集成阶段先让真实 process test 暴露 subscription prelude、identity access event、archive preemption、effective access revision 等差异，再修正生产代码；没有把 contract fixture 称作 real authority E2E。

## 5. Transaction 与 participant 顺序

1. AuthorityWorker 仍是唯一 writer；accepted mutation 在同一 `BEGIN IMMEDIATE` transaction 内提交 domain fact、immutable audit、stable event、outbox、idempotency receipt 与 closed ACK result。
2. departure preflight 只读；fresh mutation 在同 transaction reauth/role/CAS 后 collect，final collect 紧邻 membership mutation；非空 conflict 或 participant 异常时所有写为 0。
3. archive：reauth → role/lifecycle/governance CAS → archived + generation → message gate → business timers → tool settlement → runtime fence → assignment reduction → lifecycle repair → cache invalidation → offline lease invalidation → audit/event/outbox/receipt。
4. reopen：reauth → role/lifecycle/governance CAS → active → production timer participant 只恢复仍合法 timer → audit/event/outbox/receipt → commit 后 bounded rescan。
5. business timer 暂停；session、confirmation、grant、offline lease 等安全期限仍按绝对 server clock 流逝；dispatched side effect 保留真实状态。

## 6. 最终实现证据

- FT-02B：closed `room.departure.conflicts`、self-leave、owner/admin Human remove、owner-transfer-before-leave、final responsibility recheck、target-only access reduction、subscription/repair preemption、restart/CAS/idempotency/ACK-loss/parallel remove。
- FT-02C：archive/reopen、ordered participant rollback、fresh terminal repeat、authorized archived reads、materialized/streaming repair parity、cache/offline invalidation、timer continuity、after-commit rescan descriptor。
- Core/transport：formal `room.archived`、`room.reopened`、`room.security.reduced` lifecycle events；strict CAS commands、requestId ACK、closed details/errors；拒绝 actor/role/principal/session/grant/capability 注入。
- Desktop：closed bridge 无 generic IPC/raw socket/token；ACK 只到 acknowledged，matching event/projection 或 authoritative repair 后才 succeeded；target access revoke 只锁/purge 对应 Room。
- real process：production renderer entry → preload/main IPC → loopback WebSocket → authoritative server → AuthorityWorker → SQLite → stable event → ClientSyncReplica → renderer projection；测试同时断言 access token 不进入 renderer traffic/DOM。

## 7. 验证与精确计数

最终代码树使用 pnpm 10.14.0：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
git diff --check
```

- Test Files：84 passed，2 skipped，0 failed，合计 86。
- Tests：1234 passed，2 skipped，0 failed，合计 1236。
- 两个 skipped 是既有 opt-in OpenAI live smoke，不是本阶段回避项。
- real Authority/process suite：18/18；Desktop suite：23 files / 232 tests；schema suite：49/49；最终双版本 GitHub quality checks 全部 success。
- typecheck、lint 0 warning、build、core boundary、desktop boundary、diff-check 全部通过。

## 8. PR 与 merge 顺序

| PR | Ready head | Squash merge | GitHub quality |
| --- | --- | --- | --- |
| [#38 · domain/schema/repair foundation](https://github.com/LionelHao/Dao/pull/38) | `3747933e0eea51ef117bb380dbd9a553c39b91b4` | `19da638cd8b368d6fea32bc9a0c5e7296e8d4250` | [run 32219031006](https://github.com/LionelHao/Dao/actions/runs/32219031006)：Node 22.13.1 / 22.x success |
| [#39 · Authority/protocol/process](https://github.com/LionelHao/Dao/pull/39) | `9a5a86f38a3e73dcdd407c7c77f65eae17ad68ad` | `e382c6737cc5f784cf56585d6de8850b400e4c1a` | [run 32219411941](https://github.com/LionelHao/Dao/actions/runs/32219411941)：Node 22.13.1 / 22.x success |
| [#40 · Desktop/live E2E](https://github.com/LionelHao/Dao/pull/40) | `9b357451d53b100371c4f567beb0c514aec963d0` | `ea03bab84f805a1ab8e34972a6f2ff46862b126d` | [run 32219777436](https://github.com/LionelHao/Dao/actions/runs/32219777436)：Node 22.13.1 / 22.x success |

## 9. 已知风险与 reviewer

- Node 22 `node:sqlite` 仍打印 ExperimentalWarning；建议 persistence reviewer 重点看 v15 immutable migration、target-scoped unique/CAS 与逐 statement rollback。
- target member 在同 lifecycle 被 remove→re-add→remove 的 future product loop 需要新的 access epoch/unique scope；当前 schema 对无法 truthfully 表达的第二次 invalidation fail closed。建议 identity/access reviewer 裁决后续 schema，而不是复用旧 intent。
- archive cache purge 是 commit 后 bounded eventual convergence；authoritative access revision 已立即失效，但外部 purge 故障会延迟物理删除。建议 sync/repair reviewer 检查 intent replay 与 targeted preemption。
- complete FT-11 shell、FT-13 offline product、FT-10 outcome review UI 仍不在本阶段；本阶段 bridge 只暴露 closed FT-02 governance DTO。
