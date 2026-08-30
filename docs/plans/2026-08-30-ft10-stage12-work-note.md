# FT-10 Tool Safety · Stage 12 work note

> 日期：2026-08-30  
> 状态：实现已合入远端 `main`；证据 PR 与 Stage 12 worktree 清理进行中。owner 尚未验收，未标记 verified。

## 1. 起始核验

- `origin/main`: `6cce90b8c61c03a0f7e0be0a613e08461a3d8236`
- schema: v25
- open PR: 0
- 原工作区：`codex/ft02a-delivery-trace-fix@979863e...`，四个protected untracked文件hash全部匹配owner给定值。
- 实现worktree/branch：`/Users/leo/code/Dao-ft10-stage12` / `codex/ft10-stage12-tool-safety`
- Blueprint：只读取了owner要求的 `grand-blueprint` skill说明；未读写Blueprint文件或状态。

## 2. 实施批次与文件所有权

| 波次 | owner | 范围 | 共享文件禁区 |
| --- | --- | --- | --- |
| 1A | Core/canonicalizer Agent | closed catalog/internal split、state/binding types、canonical parser/hash/preview、type/Requirement tests | schema/protocol/WS/Desktop root |
| 1B | Adapter security Agent | HTTP/Git/Sandbox security/fault/bounds与typed outcome | schema/Authority/public flow |
| 1C | Runtime integration Agent | gateway permit/latch、permission matrix、retry/restart/project seam窄模块 | schema/protocol/WS/Desktop root |
| 2 | 总Agent | v26 schema/backfill/quarantine、worker contracts/handler/client/store、archive transaction | 所有hotspot串行 |
| 3 | 单一Protocol/repair/Desktop Agent | vNext frames/legacy410/WS/registry/replica/J-05 | 等Core/Authority contracts稳定后开始 |
| 4 | 总Agent | composition整合、real Worker/WS/Electron、sentinel/capacity、全量门禁 | 独占composition roots |
| 5 | independent read-only reviewers | adapter、principal、schema、dispatch/race、review/repair/Desktop/scope | 不修改代码 |

## 3. TDD顺序

每片遵循RED → minimal GREEN → focused regression → fault/race → integration。不得删除/放宽existing tests、延长默认timeout或把physical/Worker tests替换为fake。

1. Core exact three、internal split、state unions、canonicalizer、safe preview、brands、11 Requirement trace。
2. Adapter URL/DNS/redirect/encoding/body；Git fixed process/root/output；sandbox path/no-follow/hardlink/atomic/abort/compensation。
3. v26 fresh/history/fault/backfill/quarantine与physical invariants。
4. Authority prepare/decide/handoff/issue/claim/settle/review/compensation transaction和idempotency。
5. Runtime zero-call矩阵、permit once、archive/recall/revoke/cancel/expiry双顺序、crash/restart/shutdown。
6. Protocol/WS/repair/replica、legacy410、fixed W、多client。
7. Desktop J-05全部状态、offline/error/focus/ARIA/zoom/reduced-motion和真实Electron链。
8. sentinel/capacity、全量workspace门禁。

## 4. 交付追踪

- implementation PR: [#75](https://github.com/LionelHao/Dao/pull/75)，148 files，+15,342 / −607。
- implementation ready head: `67c87a4f3426a5a701c8d128ee07484cb5120c58`。
- implementation CI: [quality 33316611639](https://github.com/LionelHao/Dao/actions/runs/33316611639)；Node 22.13.1 job `99271114499` success，Node 22.x job `99271114606` success。
- implementation merge SHA: `1913218519c1cdbc968e60e6e2a3db8e448dbbab`。
- evidence PR: 本证据分支创建后回填真实编号；最终 required checks 和 merge SHA 由 GitHub PR 记录。
- evidence CI: PR创建后回填已完成的真实 run；最终 head checks 以 PR 页面为准。
- evidence merge SHA / final origin main: 证据 PR 合入后由 GitHub/`origin/main` 记录，当前不预填未来值。
- exact test counts: 255 files（252 passed + 3 live skipped）；2693 tests（2690 passed + 3 skipped）；Core 13/116，Desktop 74/624，Server 168 files / 1953 tests。
- migration statement/invariant/rollback/backfill/quarantine counts: v26 74/27/74；2 legacy grants + 2 confirmations；1 quarantine；migration adapter/event/outbox/repair=0。
- live OpenAI smoke: 3个suite因flag+secret未同时存在而安全skip；未读取secret属性，不把skip写成pass。
- independent reviewer conclusion: schema、runtime、Desktop 三方向最终 P0=0、P1=0，无交付 blocker。

## 5. 不变量

- 不修改PRD、protocol历史输入、正式设计、v1-v25 migration或Blueprint。
- 不扩大到FT-12/13/14完整实现、发布包、新工具平台或BYOK。
- 不在事实产生前填写PR/CI/SHA/测试数/reviewer结果。
- 实现合入后从最新main创建独立evidence worktree；证据PR合入后按根AGENTS清理所有Stage12临时worktree并复核四个protected hash。
