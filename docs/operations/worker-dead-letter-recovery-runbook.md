# Worker backlog / dead-letter 恢复手册（FT-14）

> 直接 Requirement：`REQ-MEM-010`、`REQ-NFR-003`、`REQ-NFR-005`、`REQ-NFR-009`

## 1. Closed inventory

机器清单位于 `packages/server/src/privacy-operations/worker-inventory.ts`，覆盖：agent runtime、route、memory steward、project boundary/reminder、notification、outbox、idempotency janitor、retention janitor、Room export、diagnostics generation、repair/snapshot。新增生产worker若未登记queue/active/batch/timeout/retry/recovery/shutdown/alert/archive合同，readiness必须fail closed。

共同告警阈值：oldest age在60s进入warning、5min进入critical；第8次terminal failure进入dead-letter或该worker批准的failed/Human review。指标与告警只含stable opaque ID（若该worker合同允许）、worker family、count、age、attempt、state和closed reason；不得含payload、message、prompt、attachment body、Provider body/header、secret、token、stack或path。

## 2. 初步处置

1. 识别workerId、queueDepth、oldestAge、attempt、terminal state，不打开或复制业务payload到ticket/chat/log。
2. 检查AuthorityWorker/storage/provider/readiness与Room lifecycle；区分容量、外部依赖、权限revoke、poison candidate。
3. 验证worker仍在startup/periodic scan；若只有第一批反复出现，检查keyset cursor、CAS与tail reschedule。
4. 对provider `noauth` 不重试第二Provider/模型；先按credential runbook恢复approved backend/readiness。
5. 对memory degraded保持聊天与显式invocation批准降级；暂停依赖陈旧语义memory的proactive route。健康project authority的deterministic due可继续并绑定具体source。

## 3. Worker-specific恢复

- outbox：复用FT-13 250ms起始/30s封顶full-jitter、8attempt、durable dead-letter与peer isolation；send-before-mark允许同eventId重放，客户端去重。
- agent runtime/route/memory：保持原execution/attempt/snapshot/model binding；timeout后必须terminal/retry-scheduled/review，不能永久running。
- project reminder/notification：archive冻结新业务producer；reopen不重放旧boundary；dedupe/claim由authority unique binding控制。
- retention/idempotency janitor：AuthorityWorker单writer、bounded keyset batch、tail reschedule；archive继续cleanup。
- Room export/diagnostics：失败不得把artifact回落日志；清partial temp，重新authorize并创建新job。
- repair/snapshot：不提交半snapshot；失败保留旧完整且仍有权的cache，revoke抢占。

## 4. Requeue / review

只有在根因修复且当前authority仍允许动作时requeue；使用原stable job identity与CAS/idempotency，不复制新业务fact。以下必须Human review，禁止普通requeue：side-effect `outcome_unknown`、`needs_review`、`cannot_undo`，以及任何可能已dispatch但结果未知的tool call。review闭合后若需再行动，创建新invocation/toolCall。

poison candidate需单独dead-letter，后续tail继续。禁止通过提高无限attempt、移除timeout、全队列串行等待或吞掉异常来“消除”告警。

## 5. Shutdown / restart

正常shutdown先停止claim新工作，再在各worker bound内drain；超时写closed critical classification。restart执行recovery scan，对durable queued/running/retry/dead-letter状态按worker合同收敛；不能把旧进程内busy永久投影为事实。

host-driven retention adapter一次只处理一个≤100 batch，不创建第二timer/scheduler；返回`needs_reschedule`由现有AuthorityWorker host安排下一tick。timeout后AbortSignal置位且在底层settle前保持single-active，避免重叠写。

## 6. 发布检查

- inventory exactly-once且所有bound finite positive；
- 60s/5min、8 attempts exact boundary测试；
- startup/restart、batch+1 tail、timeout、poison item、shutdown timeout、archive矩阵；
- alert/diagnostics canary无raw/secret/path；
- real AuthorityWorker composition复用现有outbox/dead-letter/alert，不新增第二writer、DB或event bus。
