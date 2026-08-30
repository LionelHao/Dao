# FT-10 Tool Safety · Stage 12 production addendum

> 本文以 2026-08-30 的 v25 生产基线补充 2026-08-18 已批准设计。冲突时按 PRD、protocol、正式 UI 基线与根 `AGENTS.md` 处理；当前没有冲突。

## 1. 冻结合同

1. external adapter catalog精确三项；internal source/project seams使用不同discriminant和不可互赋type。
2. `ToolConfirmationState = pending | confirmed | rejected | expired`；`ToolGrantState = active | claimed | revoked | expired`；`ToolDispatchState = prepared | claimed | dispatched | known_succeeded | known_failed | outcome_unknown | reviewed`；`ToolReviewResolution = known_succeeded | known_failed | compensated | accepted_risk`。
3. side-effect prepare只建立toolCall、server safe preview、AES-GCM sealed payload和pending confirmation；不签grant。
4. Human confirm与唯一active grant issue同一AuthorityWorker transaction；confirmed是immutable decision。
5. confirmation consumption、grant claim、dispatch claim与execution phase/version CAS同一transaction；adapter只接受commit后的opaque permit。
6. claim commit后不能证明adapter未进入时保守unknown；不重发permit、不自动retry、不恢复原toolCall。
7. review只记录Human结论，证据为bounded safe summary/hash；不调用adapter。
8. compensation创建新的invocation/execution/toolCall/confirmation/grant/dispatch；原dispatch/history不改写。

## 2. Canonical parameter profile

- 每adapter exact parser；拒绝extra/duplicate key、NaN/Infinity、非NFC、非法Unicode、过深/过宽、超限、credential/token/header、unknown tool和version漂移。
- versioned RFC 8785-compatible profile；hash输入为domain-separated `toolId + schemaVersion + canonicalizerVersion + canonicalParameters`。
- key order不改hash；任意语义字节变化改hash。
- ToolCallBinding绑定toolCall/invocation/execution/attempt/executionVersion/room/agent/tool/hash/schema+canonicalizer/sourceSnapshot/Profile revision/Assignment revision/access revision。
- ConfirmationBinding另绑定principal/sessionFamily/bindingGeneration/expiresAt。
- safe preview由server从parsed parameters产生并≤2KiB默认、8KiB hard ceiling；不展示content、credential、URL secret、header、root、raw output或sealed payload。
- sealed payload使用AES-256-GCM、key version、AAD=完整ToolCallBinding、默认≤256KiB/hard≤1MiB、expiry不晚于confirmation；缺key只使side-effect readiness fail closed，read-only可独立ready。

## 3. Adapter physical boundary

### 3.1 HTTP JSON

部署配置credential-free HTTPS origin/path template和closed slots；固定GET/headers；redirect error；拒绝credential URL、IP literal和private/loopback/link-local/multicast；resolve结果与实际连接地址绑定，防DNS rebinding；connect/body/total deadline；streaming decoded byte和encoding/decompression budget；invalid UTF-8/JSON/depth/shape为known read failure；body/header不持久化、不进summary/log。

### 3.2 Repository Git status

固定absolute git binary、fixed repository root和启动identity；fixed argv为`status --porcelain=v1 --untracked-files=no`，cwd由trusted composition设置，使用`execFile`、无shell、allowlisted env。Agent不能传binary/cwd/argv/env。调用前复核root identity和no symlink swap；stdout/stderr分别及合计有界，timeout/abort kill；只向model返回bounded parsed porcelain records+omission marker；raw output释放且不持久化。

### 3.3 Sandbox file write

配置root下normalized NFC relative UTF-8 path；拒绝absolute/`..`/`.`/empty/backslash/alias；descriptor-relative no-follow traversal或目标平台等价安全原语；拒绝parent/target symlink、prepare→claim swap与hardlink；bounded preimage/content、expected-current hash fence；atomic temp+file fsync+rename+parent fsync；posthash；bounded sealed compensation；abort before/after rename分义。compensation前复核posthash，避免覆盖后续用户修改。若平台不能证明race关闭，startup fail closed。

Adapter返回typed `known_succeeded | known_failed | ambiguous`。gateway不能从任意throw猜副作用事实。

## 4. 资源与关闭

- pending confirmation：per execution 1；per Room 64。
- confirmation TTL：default 5m；hard 15m。
- grant TTL：default 60s；hard 5m且不晚于confirmation。
- canonical/sandbox/HTTP：default 256KiB；hard 1MiB。
- Git stdout+stderr：default 128KiB；hard 1MiB。
- preview/evidence summary：default 2KiB；hard 8KiB。
- adapter timeout：HTTP15s、Git10s、write10s；hard30s。
- recovery batch：default100；hard500。
- per-Room claimed side-effect：1。
- shutdown：default15s；hard30s。

0、负数、NaN、Infinity、超ceiling均startup fail closed。stream/buffer/preimage/payload/model input/queue/timer/close wait实时计预算。

Shutdown顺序：停止新prepare/claim → 持久化pending/active/claimed合法终态或review → commit cancel/unknown → abort → bounded all-settled → AuthorityWorker最后关闭。不得留zombie、permit replay或spinner。

## 5. Public commands与J-05

public输入只用对象ID、expectedVersion、closed decision/resolution/evidenceSummary；ACK不代表adapter success。stable event/projection是唯一可见事实。legacy宽松命令固定410。

J-05实现pending/rejected/duplicate/params-changed/principal-revoked/confirmed/grant-revoked/dispatched/known-succeeded/known-failed/outcome-unknown/reviewed/expired及compensation proposed/pending/terminal。compensation文案固定为“新的副作用动作”，不称undo/撤销。正式设计偏离：无。

## 6. Rollout与rollback

rollout：readers/guards → v26/backfill/quarantine → internal producers → runtime/adapter → public commands → repair/replica → Desktop。rollback只停止新producer/claim/public command并保留新schema/事实/repair read；不降schema、不删除事实、不恢复旧confirm/direct compensation/generic unknown retry。

