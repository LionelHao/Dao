# FT-12 Notification Center · J-07 Desktop contract

> 范围：FT-12 feature-private Desktop replica/view-model/surface contract。这里不接管 shared repair assembly、Desktop main/preload、renderer app shell 或服务端 authority；不把 DOM、cache、回调或本地 badge 计算当成服务端事实。正式设计偏离：**无**。

## Requirement / FT / journey 映射

| Requirement | FT / 旅程 / 分区 | Desktop 合同 |
| --- | --- | --- |
| `REQ-PRIM-017` | FT-09/12；`J-07` due/escalation | Project due 与 `cannot_answer` 只消费 recipient-scoped notification projection；Desktop 不推导 recipient、ordinal 或 handled。 |
| `REQ-PRJ-010` | FT-09/12；Blocker/OpenQuestion | `cannot_answer_escalation` 明文、非颜色显示；handled 由 obstacle source terminal projection。 |
| `REQ-PRJ-012` | FT-09/12；DUE REMINDER | due ordinal/dedupe 不由 Desktop 产生；Room archive 后不伪造新 reminder。 |
| `REQ-UX-003` | FT-11/12；Room list | Room badge 与 flat center 来自同一 replica projection；无旧五分区跨 Room 工作台。 |
| `REQ-UX-008` | FT-12/16；`J-07` | flat、durable、recipient-scoped center；read/handled 分离；多 session 由 stable event/repair 收敛；无 OS push。 |

## 状态来源

| 可见状态 | 权威来源 |
| --- | --- |
| center open/closed、page、focus、scroll/highlight | local transient；打开 center 本身不提交 read。 |
| notification item、Room badge、unread/read、unhandled/handled | recipient-scoped stable event 或 complete repair projection。Renderer 不从 callback 推断成功。 |
| read submitting / ACK | local requestId transient / `notification.read.ack`；只有随后 stable event/repair 改变 replica read。 |
| handled | source terminal projection 经 `notification.handled`；无客户端 handled intent。 |
| source deep link | projection 中 closed deepLink；滚动、高亮与焦点是 local transient。 |
| offline | 最后一次完整、仍获有效 lease 的 encrypted cache projection；严格只读。 |
| repairing / repair failed | local sync state + server checkpoint/error；staging 不可见，失败保留旧完整且仍有权 projection。 |
| revoked / source inaccessible | `notification.revoked` 或 access-reducing authority；本地项移除。不会保留 redacted source metadata、标题或正文。 |
| archived | Room lifecycle projection；已有可访问项只读，停止 Desktop writes/new local notification。 |

## 错误、offline 与恢复

| 分支 | 恢复合同 |
| --- | --- |
| loading / empty | loading 是 local transient；empty 只在 complete projection 后显示。 |
| 401 | 清 recipient projection 并重新认证；零 read/deep-link transport。 |
| 403 | 移除无权 Room/notification，说明权限已变化；零内容泄漏。 |
| 409 | 保留 item，载入最新 projection；不把冲突伪装成功。 |
| 410 | source/Room gone：移除 item 或重新 repair；不显示 stale title/body/metadata。 |
| 429 | 使用 `retryAfterMs` 倒计时后显式重试；不自动循环。 |
| 503 | 保留旧完整 projection，提供显式 retry；没有永久 spinner。 |
| offline | 允许浏览 complete cache 与本地已缓存 deep link；mark-read、repair command 和远端 source resolution 的 transport 调用为 0。 |
| repairing | 保留旧完整 projection；read 写入禁用。 |
| repair failed | 保留旧完整 projection并提供完整 repair retry；旧 confirmation 不自动执行。 |

## Accessibility 与布局

- 1440×900：100/125/150/200%；840×560：100/125/150%。区域可滚动，禁止裁切核心动作或产生双轴页面滚动。
- 原生 button；center dialog 使用 `aria-modal=true`、可访问标题、可预测 Tab 循环；Esc 关闭并把焦点归还触发器。
- 未读/已读、未处理/已处理、offline/repair/error 同时使用文字/图标/结构，不只依赖颜色。badge 使用 VoiceOver-friendly label，overflow 显示 `99+` 但 accessible name 保留真实数量。
- 单一 `aria-live=polite` 低频通告；错误为 `role=alert`。不播报 preview/chunk，不模拟 typing。
- `prefers-reduced-motion: reduce` 下取消非必要位移/过渡。

## 范围排除

无 OS push、Electron system notification、旧 M4 五分区 inbox、全局搜索、Web/mobile、offline command queue、客户端 read/handled authority、source HTML/正文复制。共享接入必须把 Core closed projection/event/repair record 适配到本 feature-private seam；本目录不改 shared app shell/main/preload/repair registry。
