# FT-02C Archive / Reopen 交付说明

> 日期：2026-08-19
> 状态：交付条件已满足，等待 owner 验收；不宣布 FT-02 或 Blueprint verified。

## 1. 结果

FT-02C 已把 archive/reopen、八个 lifecycle dependency、truthful lifecycle generation/audit/event、business timer continuity、archived authorized reads、repair/cache/offline lease invalidation、bounded rescan 与 Desktop read-only/recovery 闭合到真实 AuthorityWorker/SQLite 路径。

## 2. Archive / reopen transaction

Archive 固定顺序：

1. transaction 内 session reauth、owner/admin role、active lifecycle 与 governance CAS；
2. Room 转 archived、递增 lifecycle/archive generation 与 governance revision；
3. `ArchivedMessageGate`；
4. `BusinessTimerSuspensionParticipant`；
5. `ArchiveToolSafetyParticipant`；
6. `RuntimeArchiveFenceParticipant`；
7. `AssignmentSecurityReductionParticipant`；
8. lifecycle repair descriptor、Room cache invalidation、offline lease invalidation；
9. truthful audit、stable events、outbox、idempotency receipt 与 closed ACK。

任一 participant missing/disabled/throw/malformed/result generation mismatch 都让同一 immediate transaction 回滚。Reopen 保持 archive generation，只通过 production timer participant 恢复仍合法 timer，再写 lifecycle repair descriptor；commit 成功后才安排 bounded rescan，并在执行时重验 generation/revision。

## 3. 时间与状态真值

- business timer archive 期间暂停，reopen 只恢复仍 pending 且合法的 remaining duration。
- session、confirmation、grant、offline lease 继续按 absolute server clock 到期；archive 不延长安全期限。
- expired/rejected/revoked/done/outcome-review 不复活；已 claimed/dispatched/outcome_unknown side effect 不伪装 cancelled、rollback 或 success。
- fresh-key archive on archived 返回 `already_archived`；fresh-key reopen on active 返回 `already_active`；不新增 audit/event/outbox。
- exact key/payload restart replay 返回原 ACK/event IDs；changed payload 冲突；distinct-key concurrent transition 由 CAS 线性化。

## 4. Archived read / repair / cache / lease

- current Human member 可读 history、attachment metadata/read、project fact、audit，并可做 session revoke、member/Agent removal、capability reduction 与 reopen。
- new message/project mutation/invocation/assignment expansion/claim/dispatch/business escalation 在 archived generation fail closed 且零业务 work。
- materialized 与 streaming repair 共用 `ROOM_REPAIR_REGISTRY`；effective access revision 使用 `max(room access, membership access)`，每页/complete 重验 lifecycle、generation、membership/access、lease、family/account。
- archive preempt 旧 active repair/lease，随后允许 current member 建立新的 archived repair/read lease；member remove/revoke 只 preempt target。
- durable invalidation intent commit 后 bounded 重放；cache/lease 从不成为业务事实源。

## 5. Schema v15

- v14 无法 truthfully 表达 reopened/left audit 与 target member invalidation，故追加唯一 immutable v15；没有改写 v1-v14。
- migration checksum：`41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9`；fingerprint：`e8010dc3c03c71d51f20ef4054a815d3580abdcbd0762791508226a68918b426`。
- 覆盖 fresh v1→v15、每个 historical v1-v14→v15、future/tamper refusal 与每个 v15 meaningful statement fault rollback；schema suite 49/49。

## 6. Desktop 与真实 E2E

- archive confirmation 后不本地切状态；ACK 只到 acknowledged，matching `room.archived` event/projection 或 authoritative repair 后才 succeeded。
- persistent archived banner 保留 history/fact/audit read，禁用 composer/project/Agent business controls并给出文本原因；owner/admin 可 reopen。
- raw access token、WebSocket、SQLite、participant capability、cache encryption/lease signing material 均不进入 renderer。
- real process test 从 production renderer entry 经 preload/main、loopback authoritative server、AuthorityWorker、SQLite、stable `room.archived`/`room.reopened`、ClientSyncReplica 返回 renderer；同时检查 DB audit/event/outbox/receipt 与 token sentinel。

## 7. 证据与风险

- archive coordinator 12/12；archive/read/repair/access/cache/lease focused 8 files / 110 tests。
- schema suite 49/49；real process 18/18；Desktop 23 files / 232 tests。
- 最终全仓：Test Files 84 passed / 2 skipped / 0 failed（86）；Tests 1234 passed / 2 skipped / 0 failed（1236）。
- 代码经 [PR #38](https://github.com/LionelHao/Dao/pull/38)、[#39](https://github.com/LionelHao/Dao/pull/39)、[#40](https://github.com/LionelHao/Dao/pull/40) 合入，所有 Node 22.13.1 / 22.x quality checks success。
- 建议 timer/tool/runtime reviewer 复核 participant order、absolute expiry 与 dispatched truthfulness；sync/access reviewer 复核 post-commit bounded purge/rescan 与 target-only preemption。
