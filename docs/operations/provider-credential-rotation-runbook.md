# Provider Credential Rotation Runbook（FT-14）

> 状态：**生产 backend 阻塞**。本文冻结安全合同和恢复流程，但当前仓库没有可写、可版本化、可跨重启恢复的生产 secret backend，因此不得执行在线轮换或宣称该能力已交付。  
> 直接 Requirement：`REQ-ID-004`、`REQ-AGT-004`、`REQ-AGT-009`、`REQ-NFR-006`、`REQ-NFR-009`

## 1. 当前审计结论

当前唯一生产实现是
`packages/server/src/agent-runtime/environment-secret-provider.ts`：它只从 server process environment 同步读取 `OPENAI_API_KEY`。`SecretProvider` 合同只有 `getSecret`；Tenant Administration 仍以 `rejectUnsupportedCredentialMutation` 返回 `configuration_unsupported`。依赖清单中没有 keychain、Vault、KMS 或 cloud secret manager client，也没有 versioned activation/recovery port。

因此当前**不存在**同时满足以下条件的 backend：server-private、可写、版本化、原子/可恢复激活、restart 可观察、可撤回 staged version、不会把值写入 Authority SQLite/WAL/普通文件/日志。以下都不是可接受替代：

- 把 credential 写进 Authority SQLite、WAL、event、outbox、audit 或 repair；
- 写入普通 JSON/.env/config 文件；
- 在线修改 `process.env` 或只保存在进程内；
- 让 renderer、普通 Room WebSocket 或通用 IPC 接收 secret；
- production 选择 fake/in-memory backend 或失败时换 Provider/model。

这是会改变部署和安全架构的真实 blocker，需要 owner 选择并提供生产 backend 后，shared integration owner 才能接通 credential configure/rotate transport。

## 2. 候选方案对比

| 候选 | 满足点 | 新依赖/决策 | 结论 |
| --- | --- | --- | --- |
| HashiCorp Vault / 等价私有 secret service | versioned secret、CAS、审计、revoke、restart recovery | 需要部署额外服务、认证和 HA/备份策略 | 适合私有部署，但属于明确架构扩张，需 owner 批准 |
| 云 Secret Manager/KMS | 托管版本、IAM、审计与原子 alias/version | 绑定 AWS/GCP/Azure 等部署环境，改变单租户私有部署假设 | 仅在部署目标已冻结为对应云时采用 |
| OS keychain/keyring（server host） | secret 不落普通文件，可绑定 service identity | 多平台/headless service 可用性、备份和 version activation 语义需补实现 | 单节点可行候选，仍需 owner 批准及真实 production adapter |
| sealed encrypted file + 外部 wrapping key | 可本地部署、可版本化 | wrapping key 必须来自 HSM/KMS/keychain；否则只是把 secret 问题转移到另一个普通文件 | 只有外部 root-of-trust 已批准时才可采用 |
| environment variable | 当前已有、启动简单 | 只读、无在线 stage/activate/recovery、管理 API 无法安全写回 | 可继续作为 immutable startup source，不满足 FT-14 rotation |

## 3. 冻结状态机

私有 closed metadata 位于
`packages/server/src/privacy-operations/credential-rotation-contract.ts`：

```text
requested → staged → activation_pending → active
    │          │              │
    └──────────┴──────────────┴→ failed
               └→ rollback_pending → rolled_back
```

metadata 只允许：rotationId、provider、model、generation、previous generation、key version、previous key version、state、started/updated time、result classification。credential 值、长度、前后缀、hash 或可识别派生值都不在合同中。

backend 必须提供：

1. `observe(provider)`：返回 active/staged key version，不返回 secret；
2. `stage(rotationId, provider, keyVersion, one-shot server-private material)`；
3. `activate(...)`：以 backend 原子/CAS 语义切换 active version；
4. `discard(...)`：安全删除未激活 staged version；
5. restart 后观察结果稳定，且任何操作幂等或有可对账 operation identity。

## 4. 正常轮换步骤（backend 阻塞解除后）

1. 认证当前 Human session，并在执行点确认其是 Tenant Administrator；Room owner/admin/member 身份本身无权；
2. 限流、限制 payload，并在进入任何普通日志/trace 之前把 secret body 交给 server-private backend；
3. Authority transaction 创建不含 secret 的 `requested` metadata；
4. backend stage 新 key version；成功后 Authority metadata 进入 `staged`；
5. readiness 继续使用旧 active generation；新 execution 不能使用 staged generation；
6. metadata 进入 `activation_pending`，backend 原子 activate；
7. Authority metadata 进入 `active`，readiness 由 backend active observation 重算；
8. 新 execution 冻结 Provider、model、credential generation/key version；运行中 execution 保持原 binding，不中途偷换；
9. old generation overlap 仅服务已冻结的运行中 execution，达到 bounded drain/timeout 后撤销；失败不调用第二 Provider或换模型；
10. 写入 secret-free audit，并安全清除请求 buffer/临时 material。

## 5. Crash / restart 恢复矩阵

| Authority metadata | backend observation | 动作 |
| --- | --- | --- |
| requested | old active，无 staged | 重试 stage |
| requested | old active，target staged | forward-recover 为 staged |
| requested/staged/activation_pending | target 已 active | forward-recover 为 active |
| staged/activation_pending | old active，target staged | activate target（幂等/CAS） |
| staged/activation_pending | old active，staged 丢失 | persist failed；保持旧 active，不 fallback |
| active | target active | 无动作，readiness 可 ready |
| active | backend 仍为 old/foreign | readiness=`noauth`/blocked，禁止新 execution，告警并人工恢复 |
| rollback_pending | old active，target staged | discard target 后 persist rolled_back |
| rollback_pending | target 已 active | 不伪造 rollback；forward-recover active |
| 任意非 terminal | foreign version | fail closed + alert；不得猜测或覆盖 backend |

`reconcileCredentialRotation` 已把上述判断做成纯函数并有 crash-window 测试。共享集成必须把 metadata transition、audit、stable readiness event/outbox/idempotency 放入 AuthorityWorker 单 writer transaction；secret backend 操作不在 SQLite transaction 内，通过 state machine 对账而不是把 secret 塞入数据库换取“原子性”。

## 6. Audit 与披露

credential audit 只记录 actor、time、provider、model、generation/key version、readiness transition 与 result classification。不得记录 credential、长度、前后缀、hash、header、request body、backend endpoint/path 或错误正文。

普通 Room 用户只看到 providerId、modelId、ready/noauth、retention disabled 与 disclosure revision/time；不能看到 generation、key version、backend 名称/路径或管理入口。Tenant Administrator 不因管理 credential 获得任何 Room history/sync/context/export 权限。

## 7. 故障处置

- `backend_unavailable`：保持旧 active（若可验证）或 readiness=`noauth`；停止新 execution；运行中 execution按冻结 generation 收敛；
- `active_backend_mismatch` / foreign version：立即 fail closed，禁止自动覆盖，保存 secret-free alert，人工核对 backend version；
- Provider 401/403：closed `provider_authentication`，不得记录 body/header，不自动换 Provider/model；
- 管理 transport timeout：通过 rotationId/idempotency 对账，不盲目再次提交 secret；
- 无法确认 stage 是否发生：先 `observe`，按上表 forward recovery；
- 无法在 bounded window 恢复：保持 noauth，报告 backend/metadata version classification，不输出值。

## 8. 验收门

在解除 blocker 前，`configuration_unsupported` 必须继续 fail closed。解除后至少补：真实 backend configure/rotate/restart；每个 crash window；Tenant Administrator ACL 与非成员零 Room 读取；运行中 execution generation freeze；新 execution only-active；noauth/ready 跨重启重算；adapter/DB/WAL/event/outbox/audit/log/diagnostics/export/repair/Desktop sentinel；无 fallback；管理 transport 的 400/401/403/409/410/429/503 与 zero-write/zero-provider-call 拒绝断言。

