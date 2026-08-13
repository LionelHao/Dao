# T-0041 迁机恢复 checkpoint

更新时间：2026-08-13（Asia/Shanghai）

## 一句话状态

T-0041 的 closed fact、v6 AuthorityWorker、真实 Provider/Tool adapters、AgentRuntime、WebSocket/renderer/composition 等确定性实现已经落地并通过本地全量门禁，但任务仍为 `in-progress`：真实 OpenAI opt-in smoke 未运行，Task 8 的完整 real-process/sentinel 证据尚未收口，且部署密钥由缺失变为可用时的 `noauth` 动态恢复仍有冻结设计冲突。

## 云端恢复入口

- 仓库：`LionelHao/Dao`
- 分支：`codex/t0041-agent-runtime-impl`
- 基线：`7bc7699fc55eb695c6eb4411381f431f47d40473`（T-0041 冻结设计）
- 实现计划：`docs/plans/2026-08-13-t0041-agent-runtime-implementation.md`
- 冻结设计：`docs/plans/2026-08-12-t0041-agent-runtime-design.md`
- 协议：`docs/protocols/authoritative-sync.md`
- Blueprint 仍保持：`T-0041 = in-progress`，球在 `@claude`

迁机后建议：

```bash
git clone https://github.com/LionelHao/Dao.git agent-im
cd agent-im
git switch codex/t0041-agent-runtime-impl
npx --yes pnpm@10.14.0 install --frozen-lockfile
npx --yes pnpm@10.14.0 typecheck
```

## 已完成范围

- canonical AgentExecution/attempt/action closed facts、v6 schema/checksum/fingerprint/startup invariants。
- 单写 AuthorityWorker 的 invoke/claim/checkpoint/retry/dead-letter/interrupt/manual retry/recovery。
- tool grant、confirmation、dispatch/settlement、bounded tool result、compensation 与 crash durability。
- 进程级 room FIFO/global-8 scheduler、分页恢复、exact RPC correlation、root raw seam 隐藏。
- OpenAI Responses SSE adapter；HTTPS JSON、固定 Git status、sandbox file write 三种真实工具。
- sandbox SSRF、repo-config code execution、CAS/lock/symlink、bounded I/O、power-loss journal 等安全边界。
- Agent WebSocket 命令、ephemeral preview、renderer lifecycle card、生产 composition 与 provider context。
- missing-secret fresh-start：Agent 调用在持久化前以 `provider_not_configured` fail closed。

## 最近已通过的确定性证据

- Task 6 两个独立审查最终均为 `PASS — C0 / I0 / M0`。
- Task 7 focused：7 files / 389 tests PASS。
- standard full：29 files / 930 tests PASS，另 2 个 opt-in tests skipped。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、core-boundary、`git diff --check` PASS。
- Node `node:sqlite` ExperimentalWarning 是预期平台输出，没有全局抑制。
- Blueprint `gbp.py check --links`：`✓ 无违规`。

提交迁机 checkpoint 前必须重新运行实际命令；上面数字只描述本文件写入前的最后一个固定快照。

## 未完成与禁止误报

1. **真实 OpenAI live smoke 未运行。** 当前环境没有 `OPENAI_API_KEY`，也没有显式 live flag；验收标准 1/2 不能标为通过，T-0041 不能 delivered。
2. **Task 8 real-process 证据未闭合。** 仍需覆盖 queued/running/waiting restart、partial-provider crash、interrupt-commit crash、retry/dead-letter、read-only tool、side-effect unknown、confirmation replay 与 compensation。
3. **完整 sentinel scan 未闭合。** 仍需扫描 authority DB/WAL/SHM、snapshot cache、event/outbox/idempotency、WebSocket frame、stdout/stderr/error/diagnostic。
4. **`noauth` 动态恢复存在设计冲突。** 冻结设计要求 readiness 是运行时/room projection，不能覆盖注册 Actor 静态配置；当前 composition 在缺密钥 fresh-start 时把 runtime Agent 以 `readiness=noauth` 注册。之后补齐密钥并用静态 `ready` Actor 重启同库，会命中 persisted actor mismatch。继续实现前应先冻结正确合同：不要用 `identity.actor.registered` 冒充 readiness update，也不要只绕过 mismatch。
5. **RouteJob replacement seam 未实现。** `cancelForHumanFence` 已完成；terminal RouteJob/selected replacement 属 T-0016/T-0020 下游依赖，不能伪造数据库复核。
6. **不得执行 GBP delivered 写入。** 在真实 live smoke、七项验收证据和交付说明全部完成前，Blueprint 必须保持 `in-progress`。

## 推荐恢复顺序

1. 先从云端分支恢复并跑 `install/typecheck/lint/test/build/diff-check`。
2. 为 missing-secret -> secret-present 同库重启写 RED，先解决 readiness projection 合同，再继续 Task 8。
3. 补 compiled child real-process restart 矩阵与全介质 sentinel scan。
4. 在显式凭据/flag 下运行真实 OpenAI 与真实工具 live smoke；只保存 closed/hash/length 证据，不保存正文或 secret。
5. 写四段交付说明，逐条证明七项标准；最后才用 `gbp.py` 标记 delivered 并交给 `@lionel` 验收。

## 自测清单

- [ ] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm test`（29 files / 930 tests PASS，2 个 opt-in tests skipped）
- [x] `pnpm build`
- [x] core-boundary
- [x] `git diff --check`
- [x] `gbp.py check --links`（`✓ 无违规`）
- [ ] 真实 OpenAI live smoke（当前未满足）
- [ ] Task 8 real-process + sentinel（当前未满足）

## AI 审查摘要

- 改了什么：从 core fact、SQLite schema/AuthorityWorker 到 Provider/Tool、runtime scheduler、WebSocket、renderer 和 production composition 的整条 T-0041 主链。
- 影响面：公共 closed facts/sync event、server persistence/protocol、desktop renderer；不公开 raw worker capability、secret provider 或 fake adapter seam。
- 风险点：noauth 动态恢复、尚未执行真实 live smoke、Task 8 的跨进程与全介质证据缺口、后续 RouteJob 集成。
- 需要谁看：Authority/persistence 与 sandbox durability 需要后端 reviewer；WebSocket/renderer 需要客户端 reviewer；真实 OpenAI/工具 smoke 和最终 Blueprint delivered 需要 `@lionel` 验收。
