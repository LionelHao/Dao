# FT-13 Stage 13 work note

> 日期：2026-08-31  
> 用途：实施日志、文件 ownership 和证据账本；不是验收声明。

## 1. 固定事实

- 内容分支：`codex/ft13-stage13-sync-reliability`
- 内容 worktree：`/Users/leo/code/Dao-ft13-stage13`
- 起点：`origin/main@e19c1492e52cdf399b440c7dc959a5607c888e32`
- 起点 schema：immutable v26
- 起点测试基线：255 files（252 passed / 3 skipped / 0 failed），2693 tests
  （2690 passed / 3 skipped / 0 failed）；最终以本分支真实完整运行结果覆盖。
- 受保护原始 worktree：`/Users/leo/code/Dao`；四个用户未跟踪文件不修改、不暂存、不提交。

## 2. 交付顺序

1. 只读 remote/authority/code rebaseline；提交本轮三份计划文档。
2. RED：registry/cursor、lease/cache、idempotency/outbox inventory 与 schema tests。
3. GREEN：唯一 registry/continuity；schema v27；30 天 janitor；bounded outbox；encrypted generation
   cache；signed lease production composition；J-01/J-02/J-07 closed states。
4. 真实 worker/SQLite/Desktop restart E2E、capacity、secret/plaintext sentinel 与 Electron smoke。
5. 全仓 typecheck/lint/test/build/boundary/diff-check；记录精确分组计数。
6. 新 Sol reviewer 只读独立审查；关闭 blocker/high；内容 PR 等待 CI 后合入。
7. 从新 `origin/main` 建 evidence-only worktree，只回填真实 PR/merge/CI/count，合并 evidence PR。
8. fetch/prune，核实远端合并，检查并移除两个临时 worktree，复核用户文件 SHA-256。

## 3. 唯一 ownership 与冲突控制

| Owner | 可写范围 | 禁止并行覆盖 |
| --- | --- | --- |
| 主 Agent | shared composition/schema/store/protocol/main/renderer/exports/delivery；最终集成 | 所有下列 shared hot files |
| Repair Agent | registry/cursor/canonical parity focused 文件与 tests | 不写 schema、authority-worker、server/ws、Desktop main/renderer |
| Persistence Agent | isolated inventory/policy/repository/outbox modules与 tests | 不写 schema、authority-worker/store、server/ws |
| Desktop Agent | isolated encrypted store/lease/state modules与 tests | 不写 server shared hot、Desktop main/renderer |
| Reviewer | 只读 diff 与证据 | 不承担开发者自我验收 |

Shared hot files 由主 Agent 独占：

`packages/server/src/authority-worker.ts`、`packages/server/src/authoritative-server.ts`、
`packages/server/src/websocket.ts`、`packages/server/src/persistence/schema.ts`、
`packages/server/src/persistence/sqlite-authoritative-store.ts`、`packages/desktop/src/main.ts`、
`packages/desktop/src/renderer/app.ts`、package root exports、最终 delivery 文档。

## 4. 已发现 blocker ledger

| ID | 事实 | 预定证据 |
| --- | --- | --- |
| B-01 | Agent Settings 断线时客户端伪造 +30s offline lease | 删除 fallback；断线无 signed lease 时 locked、server call=0 |
| B-02 | AuthorityWorker 缺 recovery policy 时回退 24h | production composition 缺失/非法值启动失败 |
| B-03 | Desktop 仅 safeStorage 整体加密 JSON | AES-GCM wrapped-key generation store、crash/disk sentinel |
| B-04 | event ledger 仅内存 eventId set | durable dual mapping 与同事务 cursor/projection |
| B-05 | idempotency/outbox family 分散且能力不一致 | closed inventories、参数化 all-family tests |
| B-06 | production repair/offline UX wiring 不完整 | J-01/J-02/J-07 headless+renderer boundary/E2E |

## 5. 计划证据索引

- Requirement：见 rebaseline §4 的 21 条逐项表。
- repair kinds：见 rebaseline §5 的 33 kind 清单（含 Stage 13 补齐的 `room-agent-assignment`）。
- UI/error/a11y：见 rebaseline §7；设计偏离为“无”。
- production contracts：见 production addendum §§2～7。
- schema：如需物理变更使用 immutable v27；不得修改 v1～v26。
- live smoke：无真实 OpenAI secret 时只记录安全跳过，不得 mock 冒充。

## 6. 运行记录

后续每个 focused/full 命令记录 command、commit、pass/skip/fail、duration 和 artifact；最终 delivery 使用
机器输出的精确数字，不沿用估算。当前尚未宣称任何 Stage 13 test、PR、CI、merge 或验收结果。

最终允许的状态文字仅为：“已达到交付条件，等待 owner 验收”。
