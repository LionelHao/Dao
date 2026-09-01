# FT-14 Privacy & Operations：生产工程设计

> 日期：2026-08-31  
> 状态：Stage 14 实施设计；credential backend 仍等待 owner 架构决策；不是交付、验收或 verified 声明  
> 基线：[Stage 14 rebaseline](./2026-08-31-stage14-notifications-privacy-operations-rebaseline.md)

## 1. 结果与直接范围

FT-14 直接覆盖 `REQ-AGT-004`、`REQ-AGT-009`、`REQ-AGT-013`、`REQ-ID-004`、`REQ-ID-005`、`REQ-MEM-010`、`REQ-MEM-012`、`REQ-MSG-006`、`REQ-MSG-010`、`REQ-NFR-001`、`REQ-NFR-003`、`REQ-NFR-005`、`REQ-NFR-006`、`REQ-NFR-008`、`REQ-NFR-009`、`REQ-NFR-012`、`REQ-NFR-013`。

目标是冻结 Provider/credential、offline lease、diagnostics/export、retention、worker operations 与 Electron 边界；不改变单租户/单Provider/单模型、Room ACL、无 BYOK/fallback、无永久删除 UI 等批准产品合同。

## 2. Credential rotation 与生产 backend

### 2.1 不变量

- 只有认证 Tenant Administrator 可发起配置/轮换；该角色不产生 Room read/export权。
- secret只进入 server-private backend；绝不进入 Authority SQLite/WAL/cache/event/outbox/audit/message/WS/renderer/log/stdout/stderr/diagnostics/export/error/repair。
- audit只含 actor/time/provider/model/generation/keyVersion/readiness transition/result classification；不含值、长度、前后缀、hash或可识别派生。
- running execution冻结 provider/model/credential generation；新 execution仅使用 active generation；失败不换Provider/模型。

### 2.2 状态机与 crash recovery

```text
requested
  → backend.stage(target keyVersion)
  → staged
  → activation_pending
  → backend.activate(target)
  → active

failure before activate → failed / discard target
failure after backend activate before authority persist → restart observes target active → persist_active
foreign/mismatched backend version → readiness blocked, Human operational recovery
rollback_pending → previous active + target discard → rolled_back
```

Authority只保存不含 secret 的 rotation metadata。backend必须提供 durable versioned observe/stage/activate/discard，支持 restart reconciliation；一份 one-shot server-private material在stage后zeroize。old generation overlap、activation与rollback/forward recovery有界；active metadata与backend不一致时 fail closed为noauth/blocked，而不偷用旧值。

### 2.3 已确认阻塞与候选

当前唯一 backend 是只读环境变量 provider，无写/版本/recovery；生产 mutation仍unsupported。候选对比：

| 候选 | 优点 | 风险/架构变化 | 状态 |
| --- | --- | --- | --- |
| 部署平台 Vault/KMS/Secrets Manager | 原生version/audit/ACL/rotation/recovery | 引入外部服务、身份与运维依赖 | 需 owner指定实际平台 |
| 单机系统 credential store/keychain | 适合owner控制主机，不进Authority DB | headless Linux/私有云可用性与service account权限需定义 | 需 owner批准平台矩阵 |
| encrypted local secret file | 可自行实现 | key来源、backup/restore、权限与“普通文件”风险会改变安全模型 | 未批准，禁止采用 |
| SQLite/process.env/in-memory/mock | 实现简单 | 直接违反PRD/Stage14安全与恢复合同 | 明确禁止 |

真实 production composition 在 owner批准 backend前阻塞；本阶段其余合同、port、TDD与sentinel可继续。

## 3. Provider no-retention inventory 与披露

closed production inventory仅三项：OpenAI runtime responses、router、memory steward。全部固定 `providerId=openai-responses`、启动时明确模型、`store:false`、无 fallback/model switch、raw body/header/hidden reasoning不记录，并有 request/response/SSE/timeout/body/shutdown上限。

- runtime输入仅 frozen compiled snapshot；router仅 summary/closed route input；memory仅当前 eligible frozen sources。
- recalled/disputed/revoked source在每次build/invoke前重验并排除；Provider error body映射closed classification，不能回显。
- 用户披露仅 `providerId/modelId/readiness/retentionDisabled/selectionPolicy/disclosureRevision/disclosedAt`；不含 credential generation/keyVersion/endpoint token/deployment path。
- future adapter若不能证明`store:false`或等价no-retention，readiness fail closed。

## 4. Offline read lease threat model 与 release policy

### 4.1 冻结值

| Policy | 值 |
| --- | ---: |
| release default | 8 hours |
| hard minimum | 5 minutes |
| hard maximum | 24 hours |
| clock skew grace | 0 ms（expiry exact，客户端时钟异常不延长暴露） |
| issue horizon | `min(selected duration, deployment max, refresh session horizon)` |
| previous-key verification overlap | 24 hours，恰等hard max |
| old-key issuance cutoff | 新key activation exact time |
| old-key verification cutoff | issuance cutoff + 24h，exact boundary失效 |

发布配置模板必须显式写入8h release default，生产部署缺失该配置时拒绝启动。部署可把max下调到 `[5m,24h]`；客户端可请求更短但不得低于5m或高于deployment max，客户端请求缺失时才使用已通过启动校验的server default。0/负数/NaN/Infinity/非整数/超24h启动fail closed。不会重新引入任何隐式时长fallback。

### 4.2 威胁与结论

| 威胁 | 控制/残余风险 |
| --- | --- |
| revoked user offline | 服务端无法遥控断网设备；残余暴露≤已签lease，default 8h、绝对≤24h；重连先purge |
| lost/stolen device/cache | cache AES-GCM + safeStorage wrapped key；lease exact expiry锁定；OS账户已被攻破时残余≤lease |
| stolen wrapped key | 仍需system credential store解包并匹配account/device/family/generation；否则fail closed |
| safeStorage unavailable/basic_text | cache locked/fatal，不回退plaintext |
| long-offline device | lease到期即不可读；必须联网重新auth/repair/issue |
| clock rollback/skew | claims用absolute server time；0 grace；可疑本机时间不延长，online重新校时 |
| replay/downgrade | Ed25519、tenant/server/account/actor/family/device/room/lifecycle/access/lease generation、keyId全绑定；unknown/old cutoff拒绝 |
| key rotation | 新key activation后旧key立即停止签发；previous key只验证未过期旧lease，24h后删除 |
| restart | active/previous metadata与private backend重载；无key/unknown key fail closed |
| deployment misconfiguration | closed schema + startup validation；无policy/key/pinned verifier只允许online repair，offline locked |
| support/recovery | 轮换runbook要求先发布verifier、再activate signer、观察≤24h、最终移除old key；不允许无限overlap |

## 5. Diagnostics bundle

diagnostics是closed allowlist、deterministic、checksummed、safe filename、≤10,000 entries且≤1MiB的NDJSON。允许 category：authority/cache/configuration/context-manifest/environment capability/error classification/outbox/repair/schema/worker；entry仅opaque stable ID、state/code、size/duration/queue/attempt和closed scalar metadata。

禁止 raw message/revision/recalled body、attachment content/extracted text、prompt、Provider body/header、tool body、password/token/secret、hidden reasoning、DB absolute path、cache key、sensitive stack。server与Desktop均用canary scan；生成权限不复用Room owner export，也不读取Room corpus。

## 6. Owner Room data export

完全独立于diagnostics。当前 Room owner的authenticated Human session显式发起；服务端在authorize/begin/每page/finalize复核session、Human principal、membership owner、lifecycle、access revision与export policy。Tenant Administrator若非Room owner/member为403且输出字节=0。

fixed authority watermark的streaming NDJSON categories：message/current+history、message revision、recall audit+Human-authorized original、project fact（Goal/Decision/Request/NextAction/Blocker/Ball）、memory/provenance、attachment inventory/hash/MIME/size/source、membership/governance audit、execution/tool review metadata、source link。每record≤1MiB、page≤256、total≤1M records/2GiB；不把Room全量放内存。header/records/final manifest与SHA-256；audit只记requester/room/watermark/manifest digest/start/end/result。

禁止 credential/session token/password/hidden reasoning/HTTP header/encryption key/unrelated Room/其他租户；本体不写普通log/event/outbox/repair。server temp artifact≤1h。Desktop renderer只提交domain intent；native main save dialog选择路径，renderer不提交path/不获得generic fs。

## 7. Retention

| 分类 | Policy |
| --- | --- |
| Room lifecycle facts/message/project/memory/audit/archive chain | 随Room生命周期保留；archive非delete；无永久删除UI |
| recall | operational retrieval排除raw；授权Human audit/owner export保留version/original |
| Provider raw | 永不持久化 |
| context snapshot | active/recovery所需payload保留；terminal按retainUntil bounded purge；metadata/provenance分离 |
| sealed side-effect payload | outcome_unknown/needs_review/cannot_undo/claimed期间保留；terminal review/expiry/policy后清理 |
| notification | 随Room authority保留；revoke停止披露；不复制raw corpus |
| diagnostics artifact | 最多24h，closed无raw |
| server Room export temp | 最多1h；用户native保存副本由owner管理 |

janitor由AuthorityWorker单writer operation驱动，100/batch、startup+periodic、keyset tail、yield、timeout、最多8attempt、dead-letter/alert、shutdown drain；archive不冻结security/retention cleanup。

## 8. Worker operations

closed inventory：agent runtime、route、memory steward、project reminder、notification、outbox、idempotency janitor、retention janitor、Room export、diagnostics、repair/snapshot。每项明确max queue/active/batch、timeout、8-attempt或适用终态、startup recovery、shutdown、oldest age、60s warning/5m critical、dead-letter/review、archive behavior和safe metrics。复用FT-13 mechanisms，不建第二scheduler/event bus。

## 9. Electron / IPC / attachment / external content

- 保持context isolation、renderer Node off、sandbox/webSecurity、CSP default none、connect none、object none、base/form/frame-ancestors none。
- preload只暴露closed domain bridge；handler校验trusted main frame、exact arg count/guard并sanitize error；无generic channel/token/fs/shell/URL/path/binary/cache key/DB handle。
- main window拒绝new window/navigation/permission；external link默认deny，只有未来closed source resolver+allowlist+Human明示动作可打开。
- attachment native picker/save path仅main决定；preview分区隔离、CSP/network/navigation/window/download/permission全deny；MIME/magic/size/malware/authorization/grant/chunk/revoke复核。
- renderer production sources继续通过`verify:desktop-boundary`，不import Node/Electron authority。
- 自动化覆盖CSP、path traversal、malicious URL/channel/binary、wrong main frame、malware/oversize/MIME mismatch、revoked preview。

## 10. Schema与验收门

FT-14不为secret建表。v29仅持久化 `privacy_retention_attempts` 的 corpus-safe retry/dead-letter metadata，使一个坏清理候选不会永久阻塞 batch 尾部，并支持 startup recovery；表中不含 secret、raw corpus 或 export bytes。v1-v27 immutable，v28通知迁移保持不变；v29执行 fresh/history、v28→v29、future/unknown、checksum/fingerprint、逐 statement fault rollback、restart/legacy importer与 invariant 覆盖。

只有17条Requirement、真实production backend、threat policy、no-retention、diagnostics/export/retention/worker/Electron、测试/reviewer/PR/evidence全部闭合后才可形成交付证据。
