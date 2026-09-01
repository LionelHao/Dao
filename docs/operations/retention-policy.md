# 数据保留与清理策略（FT-14）

> 直接 Requirement：`REQ-AGT-009`、`REQ-AGT-013`、`REQ-MSG-006`、`REQ-NFR-005`、`REQ-NFR-009`、`REQ-NFR-012`

## 1. 分类

| Category | 保留/清理合同 |
| --- | --- |
| Room lifecycle facts | message/project/memory/audit/archive/reopen chain随Room生命周期保留；MVP无永久删除UI |
| recall | operational retrieval/context排除raw；tombstone/version与授权Human audit/owner export保留 |
| Provider raw | 永不持久化；不能依赖janitor事后删除 |
| context snapshot payload | active/in-use/recovery_required保留；terminal到`retainUntil`后清payload，metadata/provenance分离 |
| sealed side-effect payload | `dispatch_claimed/outcome_unknown/needs_review/cannot_undo`保留恢复证据；review/expiry/policy terminal后清理 |
| notification fact | 随Room authority保留；revoke停止披露；不复制raw corpus |
| diagnostics artifact | closed无raw；生成后最多24h |
| server Room export temp | 最多1h；用户native保存副本由owner管理 |

Archive不是delete，不冻结session/access/security expiry、diagnostics/export temp或retention cleanup。Recall不是物理删除；不得把清理operation payload写成删除权威审计链。

## 2. Janitor运行合同

- 唯一写者：AuthorityWorker；adapter本身不直接持有SQLite handle，也不建第二scheduler/event bus。
- host在startup recovery与periodic tick调用；一次host tick最多处理100 candidates，返回`hasMore/needs_reschedule`，不得在进程内hot-loop尾部。
- 同一worker最多一个active batch；并发tick返回`already_running`。
- batch timeout 30s hard max；cooperative AbortSignal到期后置位。底层Authority操作必须在statement/transaction边界检查取消。
- retry最多8 attempts；`outcome_unknown/review`类安全状态不进入普通purge retry。
- terminal失败进入durable dead-letter和closed alert；一个坏candidate不能阻塞后续keyset tail。
- shutdown停止接收新batch、abort active并最多drain 30s；超时产生closed critical alert，不能静默退出。
- metrics只允许workerId、queue depth、oldest age、attempt、count、duration、state；不含candidate payload、Room正文、secret或path。

## 3. 时间边界

时间使用server authority clock和canonical非负整数毫秒。`now == retainUntil`时允许purge；之前必须retain。非法/缺失boundary默认retain而非猜测删除；Provider raw例外是在persist入口直接reject。

## 4. 故障恢复

- restart：startup scan从durable keyset/candidate state继续；不得依赖进程内cursor。
- stale CAS：计为retained/stale，重新扫描最新权威状态；不强删。
- purge failure：increment attempt并安排bounded retry；第8次dead-letter。
- batch tail：host看到`needs_reschedule`后按既有AuthorityWorker调度继续，不递归同步循环。
- dead-letter：先确认category/state/recovery义务；只有权威状态已允许purge时才requeue。`outcome_unknown`不得由运维跳过Human review。
- archive：继续security/retention cleanup，不唤醒Agent、project reminder或notification业务producer。

## 5. 变更门

新增category必须同步closed type、decision table、Authority candidate query、capacity/restart/archive/outcome_unknown测试、worker inventory与本策略。扩大24h/1h artifact边界或物理删除Room事实会改变批准产品/隐私模型，必须先取得owner决策。
