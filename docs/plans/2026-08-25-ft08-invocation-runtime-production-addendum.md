# FT-08 Invocation Runtime production addendum

> 本 addendum 以 Stage 10 `origin/main@82ef223`、schema v21、FT-03/06/07 已交付事实补充 2026-08-18 设计；不改变已批准状态机。

## 冻结的生产合同

1. intent与execution分离；一个intent可产生多个有单调ordinal的execution；automatic/crash retry留在同execution，Human retry创建新execution，纠正/新上下文创建新intent/turn/snapshot。
2. 用户状态闭集只有 `accepted/running/completed/failed/cancelled`。`queued/retry_scheduled/recovery_queued/awaiting_capacity`属于accepted phase；`claiming/snapshot_frozen/model_generation/read_tool/waiting_confirmation/side_effect_claimed/final_committing`属于running phase。
3. 同 turn Agent fan-out可并发，global active=8，Room durable admission=32；authority顺序与capacity扫描不能以Room全串行替代。
4. public vNext仅为 `invocation.cancel { executionId|intentId, expectedVersion, requestId }` 与 `invocation.retry { executionId, expectedVersion, requestId }`；客户端不提供reason、Agent、origin、provider/model、snapshot、attempt、grant或role。legacy `agent.invoke/interrupt/retry` handler固定410且零runtime/DB/Provider/Adapter调用。
5. scoped cancel在唯一AuthorityWorker事务写fence并收敛parent/attempt/pending confirmation/unclaimed grant；confirmed事实不改写，claimed dispatch不回滚。commit成功后才传播closed AbortSignal cause和`preview.reset`。
6. final transaction必须检查execution/attempt/version/generation/current status、无fence、snapshot/Room/Profile/Assignment/membership/access eligibility及无unresolved side-effect review；final message、citation、completed、event/outbox同事务。late final/checkpoint/tool prepare/continuation零写。
7. timeout先持久化 retry-scheduled或failed再abort；3 attempts、1s/4s，绝不换Agent/model/provider或fallback。dispatch claim后异常转known result或outcome_unknown/review，不普通retry或replay原toolCall。
8. recovery为keyset+lease的drain-until-empty；poison隔离、queue-full rescan、bounded shutdown、terminal/fenced不可复活。diagnostic只含closed code/ID/hash级安全metadata。
9. preview不进入SQLite/WAL/message/event/outbox/history/repair/memory/search/context snapshot/diagnostic/Desktop durable cache/stdout/stderr；每publish复核execution/attempt/session/membership/subscription generation/authority epoch与buffer上限。
10. FT-09 project-boundary port只接受stable boundary ID并exactly-once；真实project authority未交付时返回 `dependency_unavailable|suppressed`，Provider 0且execution 0。旧`open-item.propose`不再是production新工作入口。

## repair 与 Desktop

fixed-watermark repair统一投影intent outcome/status、execution five-state+safe phase、lineage/retryOf/current attempt、source revised/recalled、confirmation/grant/dispatch/review、final reference、safe fence reason与project-boundary unavailable/suppressed；明确排除preview与raw bodies。

Desktop严格实现正式J-03/J-05/J-07：双Agent独立卡，旧terminal与retry child并存，waiting confirmation位于running，retrying位于accepted，failed/cancelled非颜色区分，source recall禁旧retry，outcome_unknown聚焦review，claimed dispatch不显示“已撤销”。pending command不改stable card；ACK只表示authority commit；terminal只来自event/repair。offline禁写；401/403/409/410/429/503均有闭合恢复动作。preview `aria-live=off`，无typing animation；键盘/focus、200% zoom、840×560、reduced motion按FT-16矩阵验证。偏离：无。

