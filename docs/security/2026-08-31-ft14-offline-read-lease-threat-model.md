# FT-14 Offline Read Lease Threat Model 与发布策略

> 日期：2026-08-31  
> 状态：Stage 14 发布安全输入；不是 owner 验收或 verified 声明  
> 直接 Requirement：`REQ-ID-005`、`REQ-NFR-008`；交叉：`REQ-NFR-001`、`REQ-NFR-003`、`REQ-NFR-005`、`REQ-NFR-013`

## 1. 结论

Stage 14 冻结以下发布值：

| 策略 | 值 | 安全语义 |
| --- | ---: | --- |
| release default | **8 小时** | 发布配置模板必须显式写入；server 不在配置缺失时暗中补值 |
| hard minimum | **5 分钟** | 更短请求拒绝，避免持续签发/刷新造成资源滥用与不可运营行为 |
| hard maximum | **24 小时** | 任何部署配置或客户端请求都不能超过；不是代码中的隐式 fallback |
| clock skew tolerance | **0 ms** | `notBefore` 前与 `expiresAt` 精确边界均 fail closed；不以时钟宽限延长数据暴露 |
| previous-key overlap | **24 小时** | 只允许一个 previous verification key；停止签发后最多保留一个 hard-max lease 周期 |
| previous-key issuance cutoff | 新 key 激活时刻 | previous key 从该时刻起绝不再签发新 lease |
| previous-key verification cutoff | issuance cutoff + 24 小时 | 精确截止即拒绝；旧 key 不可无限延长 lease |

实现常量与解析器位于
`packages/server/src/privacy-operations/offline-lease-policy.ts`；key 窗口合同位于
`packages/server/src/privacy-operations/offline-lease-keyring-policy.ts`。生产 server composition 已把
deployment ceiling 接入签发入口，并强制显式 active signing key、activation time 与至多一个 previous
cutoff；缺失或不一致时启动 fail closed。Desktop verifier 只接受成组的 active/previous public metadata；
客户端不能提交或上调 policy。signing private key 的部署来源仍是 server-private 配置，不进入 Authority
SQLite、repair、renderer、diagnostics 或 Room export。

## 2. 资产、主体与信任边界

受保护资产包括 Room 完整派生 cache、Room 名称和投影元数据、wrapped data key、offline bearer lease、server signing private key、session/family/device/installation binding，以及 membership/lifecycle/access/lease generation。

信任边界：

1. AuthorityWorker / server SQLite 是业务事实源，但不保存 signing private key 或 bearer token；
2. server-private signing backend 保存 key material，只把 `keyId` 和签发结果交给闭合 lease 端口；
3. Electron main process 使用系统 safeStorage 解包 data key、验证 lease 并控制解密；
4. renderer 只能接收闭合 projection/status，不能获得 key、token、lease signer、DB path 或通用 crypto/fs；
5. 纯离线设备无法接收远端 revoke，因此服务端只能把最坏残余暴露限制在已签 lease 的绝对到期时间。

## 3. 签发与刷新合同

- 发布配置模板显式采用 release default 8 小时；生产 server policy 缺失或配置值不是 5 分钟至 24 小时的 canonical 正整数毫秒时拒绝启动；空串、0、负数、NaN、Infinity、小数、空白或超 hard max 均不得获得 fallback；
- 客户端可以省略请求值或请求更短时长，但不能低于 hard minimum，也不能超过部署 ceiling；
- 最终 `expiresAt` 取所选 lease 时长、session/credential refresh horizon 与所有更早授权边界的最小值；现有 FT-13 issuer 已把 session refresh expiry 纳入最早边界；
- issue/page/complete 前继续复核 Human session、membership、Room lifecycle、access revision 和 lease generation；
- lease 仅授权读取已完整提交的 active cache generation，不授权任何 message/project/confirmation/tool/管理命令；offline mutation transport 调用必须为 0；
- reconnect 必须先认证和重验 catalog/revoke，再决定 purge 或 sync/repair；不得先闪现旧 Room 内容；
- archive 不延长 lease；仍有资格的 Human 只可在有效 lease 内读取 archived Room 历史。

## 4. 威胁与处置

| 威胁 | 攻击/故障 | 发布处置 | 残余风险 |
| --- | --- | --- | --- |
| lost device | 合法设备丢失后持续离线 | 绝对 expiry、session/device/installation/Room generation 绑定；最坏 8h 默认、绝不超过 24h | 到期前无法远程擦除；由 finite lease 明示承担 |
| stolen encrypted cache | 攻击者复制 DB/WAL/temp | AES-256-GCM record encryption、safeStorage-wrapped random data key、AAD 与 generation binding；磁盘 plaintext sentinel | 已解锁进程或 OS 账户被攻破不由静态磁盘加密完全解决 |
| stolen wrapped key | 同时取得 cache 和 wrapped key | safeStorage 绑定 OS 用户/设备；`basic_text`/不可用 backend fail closed | OS credential compromise 仍可能解包，需端点安全措施 |
| stolen bearer lease | token 被复制到另一环境 | tenant/account/actor/family/device/installation/server/Room/revision/generation 精确绑定与签名 | 同一被攻破设备上下文内仍可用至 expiry |
| safeStorage unavailable | Linux basic_text、keychain locked、unwrap failure | locked/fatal，不回退 plaintext，不把 corruption 当 cache miss | 可用性降低；需要重新认证/修复系统 keychain |
| long-offline device | 设备数日不联网 | 8h 默认、24h hard max 后立即锁定；不能本地续签 | 超过上限无法离线读是有意安全取舍 |
| local clock backwards | 试图延后 expiry | verifier 使用绝对 signed timestamp；时钟异常导致 fail closed/重新联网校时；不增加 grace | 错误时钟可能提前锁定，优先保密性 |
| local clock forwards | 提前超过 expiry | 立即锁定；重新联网校时后取得新 authority lease | 可用性降低，不扩张权限 |
| downgrade/replay | 重放旧 token、旧 key 或旧 generation | canonical claims/signature、keyId、exact expiry、lifecycle/access/lease generation、双 event ledger；previous key exact cutoff | active key material 泄露需要紧急全量 generation revoke |
| signing-key rotation | 无限保留旧验证 key | 仅 active + 最多一个 previous；previous issuance cutoff=激活时刻，verification cutoff=+24h | 部署必须从server-private durable source重建同一key/cutoff；composition本身不持久private key |
| restart recovery | restart 后错用旧 active key | 启动时重验显式active/previous metadata；未知、重复、cutoff不一致即fail closed | 依赖部署私有key source在重启后提供一致key material/metadata |
| deployment misconfiguration | 值缺失/非法/超上限 | 发布模板必须显式写入 8h；生产配置缺失或非法均拒绝启动；没有隐式 8h/24h fallback | 运维需理解缩短 ceiling 会影响离线体验 |
| archive/revoke race | archive、remove 或 revoke 与签发并发 | AuthorityWorker 单 writer transaction 与 generation CAS；安全 revoke/expiry 不因 archive 冻结 | 已离线 token 仍仅在旧绝对 expiry 前有残余暴露 |
| malicious renderer | renderer 请求延长、获取 key/token/path | preload closed API；policy/main verifier 不暴露通用 IPC；请求超过 server ceiling 拒绝 | main/preload 漏洞需由 Electron boundary test 持续防守 |

## 5. Key rotation 时序

1. 生产 key backend 创建新 active candidate；key material 不进入 Authority SQLite、日志或 renderer；
2. 在激活时刻记录新 active `keyId`，旧 key 的 issuance cutoff 同时生效；
3. 新签发只能使用 active key；previous key 只用于验证激活前已签且尚未到期的 lease；
4. previous verification key 在激活后 24 小时精确失效并从 verifier map 移除；
5. restart 从 durable backend/key metadata 重建 active/previous/cutoff；未知、重复、超过一个 previous 或超长 overlap 均 fail closed；
6. 紧急 compromise 不等待 overlap：提升 Room/session/lease generation、清相关 cache，并撤销被攻破 key；离线残余仍由当时已解锁设备风险决定。

## 6. UI / 交互映射

- J-01 restore：校验 session 与离线 lease 前不显示 Room 内容；safeStorage/key/policy 错误进入 locked/fatal；
- J-07 offline：只读最后一个完整、仍授权的 cache generation，显示 `asOf` 与 lease expiry；所有写操作 zero transport；
- J-07 repair：重连后固定 watermark 重建；失败保留旧完整且仍获授权的 cache，不提交半快照；
- revoked/expired：立即锁定并移除可见 Room 内容；状态以文字、图标和 `aria-live` 表达，不只靠颜色；
- 840×560、100/125/150/200% zoom、键盘、焦点与 reduced motion 继续采用正式设计基线；本 threat model 不新增 UI 信息架构。设计偏离：**无**。

## 7. 自动化证据

`offline-lease-policy.test.ts` 覆盖 default/min/max、缺失与非法配置、客户端 over-max/under-min、精确选择；`offline-lease-keyring-policy.test.ts` 覆盖 active/previous、停止签发、exact verification cutoff、duplicate/foreign/非法时钟与 overlap 上限。生产 server composition 要求 signing 配置显式携带 `activatedAtMs` 与至多一个 previous cutoff metadata，并在启动时用同一 keyring policy fail closed；Desktop previous verifier 只接受成组的 `NATIVE_IM_OFFLINE_LEASE_PREVIOUS_KEY_ID`、`NATIVE_IM_OFFLINE_LEASE_PREVIOUS_PUBLIC_KEY_SPKI_BASE64`、`NATIVE_IM_OFFLINE_LEASE_PREVIOUS_ISSUANCE_CUTOFF_MS`、`NATIVE_IM_OFFLINE_LEASE_PREVIOUS_VERIFICATION_CUTOFF_MS`，且 overlap 必须精确为 24 小时。FT-13 的 issuer/verifier、encrypted generation store、restart/revoke/sentinel 测试继续作为机制证据。
