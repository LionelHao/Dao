# FT-01 Identity & Session 交付说明

> 日期：2026-08-18
> 交付口径：FT-01 Identity/Session 可执行切片
> 实施计划：[`2026-08-18-ft01-identity-session-implementation-plan.md`](../plans/2026-08-18-ft01-identity-session-implementation-plan.md)
> 验收矩阵：[`2026-08-18-ft01-identity-session-acceptance-matrix.md`](../plans/2026-08-18-ft01-identity-session-acceptance-matrix.md)

## 一、交付结论

本轮把 Human 密码登录从既有服务端能力接到真实 Electron Desktop，并完成同一 Human 的独立设备 session family、设备列表、定向撤销、在线终止、重启恢复、access refresh、logout 与 preload/IPC 安全边界。

可交付声明是“FT-01 Identity/Session 切片完成”，不是“完整 FT-01 全部完成”。邀请绑定建密、Tenant Administrator、Global Agent Profile、Room 加密缓存/离线租约、生产账号配置与发行签名仍是明确依赖，见第七节。

## 二、实现内容

### 2.1 权威身份与设备会话

- 保留 scrypt 密码校验、dummy scrypt、opaque bearer、15 分钟 access / 30 天 refresh、refresh rotation/replay 整族撤销与 Human-only actor 约束。
- Authority schema 升至 v12，新增 `session_families`：内部 `family_id`、独立 opaque `public_id`、Human principal、设备 ID/标签/平台、创建时间、refresh horizon 与 family 撤销时间。
- `sessions` 继续是一行一个 token generation；数据库只保存 token hash，不保存明文 access/refresh token。
- 新增 list-owned-sessions 与 revoke-owned-target-family。caller access 复核、ownership 判断、family/generation 撤销、稳定 identity event 与 outbox 在同一个 `BEGIN IMMEDIATE` 事务内完成。
- foreign 与 unknown public ID 使用相同 404；重复撤销幂等；refresh/revoke race 无法复活已提交撤销的 family。
- 每个 account/Human 最多 96 个 active、未过期 family；第 97 次有效密码登录在一个事务内撤销确定性的最旧 family 并签发 replacement，避免所有旧设备丢失后的恢复死锁。SQLite eviction 使用正常 terminal event/outbox。异常 legacy/直接篡改状态若超过 96，会在 migration/import/list 明确以容量错误失败，绝不静默隐藏设备。Authority response guard 与 Desktop parser 同为 96，最坏 128-byte ID/label 的 list 仍处于 64 KiB frame budget 内。
- 显式 logout、定向撤销、容量淘汰、refresh replay 与并发 rotation loser 都只在权威事务提交后立即 preempt 对应 family 的 repair/snapshot lease；回滚不产生 terminal 事实或内存 preempt，旧 family 不会以 `snapshot_busy` 阻塞仍有效的设备。
- 旧 JSON family 使用域分离 SHA-256 派生 opaque public ID；v11→v12 使用独立随机 opaque ID，不把内部 family ID 返回给 renderer。新格式 JSON→SQLite import 保留 public/device/createdAt，真正旧格式才生成 Legacy device 元数据。

### 2.2 Closed WebSocket contract

Desktop 登录必须发送闭合的 `device` 描述；缺字段、多字段、空值、错误类型或超过 UTF-8 上限均在调用 auth service 前拒绝。

新增请求：

```text
auth.sessions.list
auth.session.revoke { sessionId }
```

新增响应：

```text
auth.sessions { sessions }
auth.session.revoke.ack { sessionId, revoked: true }
```

`auth.authenticated` 返回当前 public session ID。定向撤销 ACK 只表示 authority transaction 已提交；目标连接仍通过既有 `auth.session-revoked` terminal frame 收敛，并在发送 terminal 后关闭。

登录或 refresh 已提交但随后发生二次 authority 安装失败、ACK 发送失败或 socket 提前关闭时，服务端会用刚签发的 access token best-effort 撤销该 family，并保留原始脱敏错误；这避免正常故障路径持续占用不可达的 active family。

### 2.3 Desktop main / preload / IPC / renderer

- Electron main 独占 WebSocket、access/refresh credential、safeStorage 与本地设备身份；renderer 不直接联网，也不能选择 endpoint。
- credential vault 使用 safeStorage ciphertext，保存严格执行临时文件 write/fsync → 原子 rename → 父目录 fsync；清除凭据后也 fsync 父目录。任何无法确认 durability 的路径都 fail closed。Unix 权限收紧，Windows 走 userData ACL/safeStorage 策略而不伪用 POSIX mode 位。
- Linux 只接受受支持的 keyring safeStorage backend；`basic_text` 或未知 backend fail closed，不回退明文。
- 普通断网会把已认证 controller 锁到 `unavailable`；protocol violation fail closed；远端 terminal 按 transport close → vault clear → authorized-state invalidation → public revoked 的顺序处理。
- refresh 已在服务端 rotation 但本地原子保存失败时，Desktop best-effort 撤销新 generation 所在 family，再进入安全失败状态。
- preload 只暴露冻结的 `window.dao.identity` 六方法 allowlist；IPC 校验 sender/main frame、字段集合、类型和长度，不暴露 raw `ipcRenderer`、channel、token、fs、shell 或 endpoint。
- BrowserWindow 开启 context isolation、sandbox、web security，关闭 Node integration；navigation、new window、permission 默认拒绝；renderer CSP 禁止网络、eval 与 object embedding。
- renderer production entry 由 esbuild 打包，构建会拒绝残留的 bare `@native-im/core`、Node/Electron runtime 依赖；Electron smoke 在打印成功前会从真实页面验证六个 preload 方法、bridge-missing DOM 不存在，并完成一次 `identity.getState` IPC round trip 到有限 closed DTO。
- renderer 提供 starting/restoring/login/authenticated/unavailable/revoked/fatal 有限状态，Human-only 登录、可访问标签/焦点/`aria-live`、设备区分、远端撤销与当前设备 logout。

### 2.4 可运行监听接线

authoritative composition 默认绑定 `127.0.0.1:8787`，与 Desktop 默认 Identity endpoint 一致；测试与嵌入式调用显式传 `listen: { port: 0 }` 使用临时端口。服务端拒绝空 host、非 loopback bind 与越界/非整数 port，并正确格式化 IPv6 loopback URL。非 loopback 明文 `ws://` 也被 Desktop 拒绝；远端部署必须通过受信 TLS 终止层提供 `wss://`。

## 三、关键自动化证据

服务端到 Desktop controller 的跨层用例使用真实 scrypt adapter → worker-owned SQLite → authoritative WebSocket → 三个隔离 `IdentitySessionController`，但 vault/device 是隔离的内存 port，便于精确观察清理与重启语义。另有独立的 production vault/device/runtime/IPC/preload/renderer 测试，以及 built sandbox preload/renderer 的 Electron startup smoke。这里是可组合的分层证据，不把它冒充成单条 packaged Electron→server E2E。

它证明：

1. A/B/C 使用同一 Human 账户登录并得到三个独立 public session；
2. A 列出三台设备并定向撤销 B；
3. B 的全部在线连接收到 terminal、清 vault、invalidator 执行，后续 access/refresh/resume 均失败；
4. A 与 C 保持登录且仍可列会话；
5. 关闭并重启同一 SQLite authority 后，A 的原 access 过期，Desktop 经真实 WS refresh rotation、原子保存后恢复；
6. A logout 后新 controller 无法恢复旧 credential；同一 installation 再登录时 device ID 稳定、session credential 全新；
7. public state、SQLite projection、持久化目录、应用日志和 renderer 完成态 DOM 不含密码/access/refresh canary。

另外，AuthorityWorker 的提交前故障注入证明 targeted revoke 对 family、generations、identity stream、event 与 outbox 全量回滚；revoked/expired caller 的 list/revoke 均在权威操作内失败且零写。

## 四、最终门禁

以下命令均在 `/Users/leo/code/Dao` 的最终工作树执行：

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm typecheck` | PASS；workspace project references、core/server type-test 与根 Vitest config 类型检查全部通过 |
| `corepack pnpm lint` | PASS；ESLint zero warnings |
| `corepack pnpm test` | PASS；core/desktop boundary 均通过；53 个测试文件通过、2 个环境门控文件跳过；980 项通过、2 项跳过 |
| `corepack pnpm --filter @native-im/desktop test` | PASS；16 个文件、180 项测试全部通过 |
| `corepack pnpm build` | PASS；core、server、desktop production build 全部通过，Desktop 同时构建 sandbox preload 与 bundled renderer |
| `corepack pnpm --filter @native-im/desktop smoke` | PASS；built Electron 页面确认六方法 bridge、无 bridge-missing fallback，并完成一次真实 `identity.getState` IPC round trip |
| `git diff --check` | PASS |

两项 skip 是显式环境门控的 OpenAI live smoke：`openai-responses-provider.live.test.ts` 与 `openai-router-provider.live.test.ts`。它们只在 `DAO_OPENAI_LIVE_SMOKE=1` 且存在 `OPENAI_API_KEY` 时运行，不是 FT-01 验收依赖。Node 22 的 `node:sqlite` 会输出上游 `ExperimentalWarning`；本轮没有隐藏该警告，且 authority E2E 专门验证只过滤已知 SQLite warning、不会吞掉无关 warning。

## 五、迁移与兼容说明

- Authority schema version：`11 → 12`。
- v12 migration 在单事务内创建/backfill/校验 `session_families`，migration checksum 与 schema fingerprint 已更新。
- v11 access token 在迁移后仍可 authenticate；v11 refresh token 仍可 rotate；新 generation 继续使用同一个迁移后 public session ID。
- 若历史 v11/JSON 同一 principal 在迁移时仍有超过 96 个 active、未过期 family，升级/import 会在 staging/transaction 内明确失败且不激活部分数据库；运维方需先让多余 family 撤销或过期后重试。不会静默截断或改写其 credential validity。
- legacy importer 同时支持无设备字段的旧 JSON 与带 FT-01 family metadata 的新 JSON，且不会改变新格式 vault 所持 public session ID。
- 历史 identity event payload 未偷偷扩字段；设备 metadata 只存在 family projection / public list DTO。

## 六、安全与故障语义

| 场景 | 结果 |
| --- | --- |
| 账户不存在 / 密码错误 | 同样的 401 `invalid_credentials`，无 session/event/outbox |
| Agent 或 stale Human 映射 | 403 `identity_forbidden`，无持久化 |
| access 过期 | restore 只尝试一次 refresh；成功先落盘再发布 authenticated |
| refresh 无效/过期 | 清 credential，回到有限登录状态 |
| 当前 family 被撤销 | 立即停止业务投递，清 credential/authorized memory，进入 revoked |
| foreign / unknown target | 相同 404，不泄露 ownership，不改变任何 family |
| 活跃设备达到 96 | 有效密码登录原子淘汰最旧 family 并创建 replacement；异常 `>96` 状态 fail closed，不截断列表 |
| socket 普通断开 | `unavailable`，保留加密 credential 供显式重试，不显示授权内容 |
| safeStorage 不安全/不可用或 vault 损坏 | `fatal`，不发猜测请求、不回退明文 |
| renderer/IPC malformed input | 在 controller/transport 前拒绝，状态不变 |

## 七、明确未在本切片冒充完成的依赖

- Human invitation、披露与显式接受后绑定建密：FT-01 后续，与 FT-02/16 共用。
- Tenant Administrator bootstrap/audit、Global Agent Profile、provider credential governance：FT-01/07/14。
- Room 加密缓存、在线逐 Room purge、有限期 service-signed offline read lease：FT-13/14。
- Room archive/reopen 治理并发：FT-02/10/13。
- 生产 server launcher、账号 provisioning CLI/API、TLS termination、打包签名/notarization 与发行 CI。当前交付提供 composition listener 与 Desktop 接线，但不硬编码生产账户或 TLS secret。

## 八、审查关注点

- `family_id` 永远是内部 authority routing ID；对 renderer 只使用独立 opaque `public_id`。
- target ownership 校验不可移出 AuthorityWorker transaction，避免 list→revoke TOCTOU。
- `auth.session.revoke.ack` 与 unsolicited terminal frame 语义不能合并。
- safeStorage backend、Windows ACL/Unix mode 分支与 preload sandbox bundle 是发行平台必须保留的边界。
- active device-session 上限、Desktop parser session 数和最大 server frame 必须保持闭合；修改任何一侧时同步更新协议测试。
- 本轮实现已通过 PR #21 合入 `main`；仍未由实施者自行标记 `verified`，也未修改 Blueprint 权威状态。
