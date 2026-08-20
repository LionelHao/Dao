# FT-05 Room Memory Authority & Steward · 第七阶段总交付说明

> 日期：2026-08-21
> 状态：可执行代码已通过受保护CI交付远端`main`；本文随最终documentation-only PR交付，不表示owner已验收，不改变Blueprint状态。
> predecessor：`origin/main@65d92f56f6b7426d2c65c4a6f0e3def5b07b60fe`，authority schema v17
> FT-05可执行代码交付基线：`origin/main@c2f38a432a008ecbec93aac706ac19164e4289f8`，authority schema v18

## 1. 一句话结果

FT-05已形成每Room唯一Memory Steward、全量可重放corpus/source authority、五类important memory、Context争议/重评、单调watermark与post-watermark raw delta、受限OpenAI structured extraction、degraded/noauth运行边界、fixed-watermark repair和Desktop Memory面板的生产闭环，并以真实SQLite、AuthorityWorker、WebSocket、restart、三认证客户端、Electron边界与联合敏感数据sentinel证明其一致性、恢复性和不泄露性。

## 2. 十一个直接Requirement与横切要求

| Requirement | 本阶段完成语义 | 主要证据 |
| --- | --- | --- |
| `REQ-PRIM-008` | Human active message revision/recall进入version/tombstone source链；Agent final原记录不可改，memory只消费现有不可变lineage | `room-memory/corpus-database-authority*`、FT-03 transaction hooks、revision/recall E2E |
| `REQ-PRIM-014` | 每Room恰一内建steward，处理全量corpus并维护五类memory和source index；不再把“最近64条”当作memory事实 | schema v18 steward/source约束、runtime-context snapshot+delta tests |
| `REQ-MSG-005` | revision以`source kind + stable ID + revision/generation`新增版本；旧source不被原位覆盖，冻结mention/reply/attachment由FT-03保持 | corpus authority tests、source revised/review-required投影 |
| `REQ-MSG-006` | recall同事务写body-free tombstone与operational exclusion；pending/running fence仍归FT-03，FT-05同步失效source与关联attachment | Authority DB、real-process recall/history/repair/sentinel |
| `REQ-MSG-010` | 当前有权Room source默认进入AI可见corpus；没有逐消息排除开关；recalled raw仅Human audit/export域可见 | closed source eligibility、public/source query guards、sentinel |
| `REQ-MEM-001` | accepted messages、revision/tombstone、attachment metadata/provenance与memory版本通过SQLite、restart、sync/repair无损重建 | v18 schema、Authority restart、repair descriptor/三端E2E |
| `REQ-MEM-002` | 唯一非participant steward异步抽取、去重/合并、source索引；message ACK不等待；exact replay/CAS幂等 | actor rejection trigger、FIFO runtime、jobs/attempts/idempotency tests |
| `REQ-MEM-005` | 只有Context可由steward自动active；Goal/Decision/NextAction/OpenQuestion-Blocker只能proposal | Core guard、DB trigger、provider candidate与commit tests |
| `REQ-MEM-006` | 任一current Human可dispute Context；同步排除注入；原争议人或owner/admin在重评+reason后产生replacement version | public protocol/DB authority/CAS/race/Desktop dialog tests |
| `REQ-MEM-007` | invocation读取`confirmed/current injectable snapshot @ W + ordered eligible delta (W,H] + trigger/source`，watermark不跳跃 | `runtime-context-authority*`、provider input、real runtime tests |
| `REQ-MEM-010` | steward failure不阻塞Human chat或explicit invoke；semantic/risk proactive暂停，健康确定性信号仍可继续 | `runtime-readiness*`、route runtime 14 tests、production noauth test |

横切完成`REQ-NFR-001`～`005`、`007`～`012`、`014`：唯一writer、事务/CAS、closed protocol、bounded资源、idempotency、restart/repair、最小权限、secret/raw不泄露、可观测错误闭集和双Node CI。UX完成`REQ-UX-004/007/009`；正式旅程映射为J-04 `@Human Request`责任不由memory ACK推断、J-06 proposal→Human confirmation→project fact边界、J-07 notification/offline/fixed-watermark repair。设计输入、状态事实源和补充设计决策见`docs/plans/2026-08-19-ft05-room-memory-authority-design.md`；设计偏离：**无**。

## 3. 五类Memory与权威边界

| 类别 | Steward输出 | active/confirmed权威 | 本阶段约束 |
| --- | --- | --- | --- |
| Goal | proposal | Human确认的project authority；同一时间最多一个active目标的最终规则归FT-09 | FT-05不创建第二Goal aggregate |
| Decision | proposal | Human确认/supersede的project fact | source revision/recall只标stale/review，不改写已确认fact |
| Context | 可auto-active | FT-05 memory version state；current Human可dispute | 唯一允许steward直接active的类别 |
| NextAction | proposal | named Human对责任/截止/承诺的确认，归FT-09 | memory ACK不等于责任接受，不迁移Ball |
| OpenQuestion/Blocker | proposal | Human/project workflow确认；作为一个第五类closed kind | 单owner/transition产品闭环继续由FT-09消费 |

`room_memory_records`与append-only `room_memory_versions`是memory authority，不是project aggregate。Steward不是Actor、Room participant或可发言Agent；schema trigger禁止把`room-memory-steward:*`插入actors。FT-05只提供safe memory projection与未来confirmed-project-reference表示，不能发project command。

## 4. Corpus、source、watermark与raw delta

- `room_memory_sources`使用`(room_id, source_kind, source_id, source_revision)`稳定identity与每Room连续`corpus_seq`；五种source kind、eligibility/availability和server order均由closed Core guard验证。
- accepted message/revision/recall和ready+bound attachment在现有FT-03/04 `BEGIN IMMEDIATE`事务内调用FT-05 helper；renderer cache、history或原“最近64条”均不是corpus authority。
- 每Room`memory_watermark`只在validated memory records、source edges、attempt/job终态、event/outbox同一AuthorityWorker事务成功后前进；provider malformed/timeout/noauth/late generation不前进、不跳洞。
- server-private raw delta page最多64项、256 KiB metadata，按`corpus_seq`严格递增，包含stable identity、revision/generation、speaker/source metadata、occurred time和opaque authorized read ref；不复制message body、extracted attachment body、path、URL、token或Provider payload。
- invocation seam固定为current injectable snapshot @ W，加完整eligible `(W,H]` ordered source representation及trigger/source；FT-06负责未来token budget、excerpt/digest/index和最终context compiler，FT-05不把raw-delta伪装成编译完成的prompt。

## 5. Context状态机、争议与测试

Context版本闭集覆盖`active`、`disputed`、`resolving`（客户端transient）、`resolved`、`superseded`和source-driven `review_required`。任一current Human在事务执行时可dispute；客户端actor/role字段不参与授权。dispute ACK与stable event之前，DB事务已把该Context从新invocation、search/proactive eligibility中排除；已经冻结的旧execution保持冻结，不被事后静默改写。

resolve只允许原disputing Human，或owner/admin在steward reevaluation后提交reason。expected version/CAS决定唯一winner；loser得到409并repair。resolution记录operator/reason/time、生成replacement version，保留原content/source/dispute chain；late/duplicate worker result由attempt/recovery generation拒绝。reevaluation失败保持disputed。自动化覆盖exact replay、changed payload conflict、concurrent winner、removed Human、archive mutation 410、401/403/404/409/429/503映射，以及争议后下一次runtime snapshot零注入。

## 6. Proposal与Project分离

- 非Context四类永远以proposal落memory；Provider contract没有confirmer、responsible、deadline、project command或active/confirmed字段。
- `room_memory_project_checkpoint`默认`mode='disabled'`，因此当前生产不会用fake/no-op adapter制造confirmed fact。未来enabled必须同时有真实participant/checkpoint/version/health；缺adapter/readiness时fail closed 503。
- FT-09启用后，FT-05只读`ConfirmedProjectFactCheckpoint`引用；memory ID/version/state与project fact ID/state分别持久化。memory dispute不撤销project fact，project supersede/source revision只触发memory review。
- 正式J-04 Request接受/拒绝/转交与Ball迁移不由FT-05实现；J-06 Human confirmation是唯一project authority入口。

## 7. Schema v18、checksum与历史兼容

- 唯一追加migration：v18 `room-memory-authority-steward`，migration checksum `5096ee7199877a73cd480a474669c2af2a9e409c44824b8a4dc2f137a7c0721e`；physical fingerprint `d1344ba94d7dd4253f2dcc9e392c3bc4b8b1ec5b4fbba614e3fe2a10392797e5`。
- 12张表：stewards、sources、source transitions、jobs、attempts、records、versions、source edges、disputes、resolutions、idempotency、project checkpoint。
- fresh与每个v1～v17实际历史schema都升级到v18并close/reopen幂等；v1～v17 statement/checksum/fingerprint未修改，legacy Room自动backfill一个steward和disabled checkpoint，不伪造memory/project事实。
- 61/61 meaningful statement fault injection都回滚到完全相同的已填充v17 tables/data/history/`user_version`。future schema、migration history checksum tamper和physical trigger tamper均fail closed。
- FK/UNIQUE/CHECK/trigger关闭cross-Room edge、非连续source seq、late generation、非Context active、Context proposal、旧version原位更新/删除、未授权dispute/resolve和伪steward Actor。

## 8. Steward、Provider、structured output与健康状态

- per-Room FIFO，跨Room并发上限8，in-memory queue上限32，溢出只置recovery scan，不把message ACK变成429。durable batch最多32个连续source；Provider timeout 60 s，最多3 attempts，retry delay 1 s/4 s。
- noauth在claim/attempt前判定，零fetch、零attempt、零watermark；secret恢复后重新wake。timeout、429和dependency unavailable按closed retryability处理；malformed、extra/duplicate key、cross-Room/stale source、oversize和late generation零落库。
- OpenAI Responses使用共享`EnvironmentSecretProvider`与production endpoint/model，HTTPS credential-free base、`store:false`、strict JSON schema；没有新增dependency、fake/noop fallback或第二API key配置。
- 输出闭集为schema v1 candidates；最多32 candidates、每text最多4096 UTF-8 bytes、每candidate最多16 source refs、outer/output最多64 KiB。bounded recursive parser在`JSON.parse`前拒绝重复object key；response后重新验证每个source与replacement target。
- health闭集：`healthy`、`catching_up`、`noauth`、`degraded`、`failed/recovery-required`。状态由server-private事实推导，不能被客户端写成参与档位；重复noauth报告是零写/零event幂等操作，避免无业务变化的repair checksum漂移。

## 9. Revision、recall、attachment与checkpoint

- revision新增source revision并保留旧edge/version；依赖旧revision的memory进入`source_revised/review_required`，由新steward结果生成replacement/supersede链。confirmed project fact只标stale，不能被FT-05改写。
- recall由FT-03同事务写body-free tombstone、取消pending intents并fence running source；FT-05立即把message及绑定attachment从corpus query、snapshot、raw delta、proactive、outbox projection、repair和cache的operational eligibility排除，不等待async steward。
- multi-source support set按完整source identity/version保存；任一支持source失效会使旧memory不可注入并进入review，而不是从剩余source泄漏原合成正文。replacement保留旧版本与source chain。
- attachment只有FT-04判定`ready + bound + active + current authorization + valid extraction provenance`后才进入corpus。FT-05读取复用bounded、read-before/after reauthorization原则，不伪造executionId，不存object key、raw extraction或长期token。
- checkpoint/watermark、source invalidation和fixed-watermark repair共享同一authoritative ordering；W后recall/revoke能以closed transition使W内旧projection不再inject。

## 10. Runtime explicit与proactive degraded行为

- explicit `agent.invoke`不会因steward noauth/degraded在入口被拒绝；runtime构建current injectable memory snapshot及完整post-watermark raw delta，随后由既有Agent runtime继续执行。当前Stage不宣称FT-06 token compiler完成。
- proactive route在claim后、semantic Provider调用前读取memory readiness。`noauth/degraded/failed`时semantic/domain/risk Provider call=0、authority.fail/retry=0，使用无provider plan进入既有deterministic evaluation。
- direct mention、Agent structured help和健康Ball deterministic intent继续；未来deterministic due只有在FT-09健康confirmed project source可读时才能继续。project/context authority不可读时同样暂停并通知。
- Human chat永远继续；degraded是readiness事实，不重新引入`silent`参与模式。400/401/403/404/409/410/429/503只返回closed code、retryability/retryAfter与safe IDs。

## 11. Sync、repair、restart与三设备收敛

- Core唯一`RoomRepairRecord`和`PersistedRoomEvent`union纳入memory；event复用连续`streamSeq`、`eventId` dedupe和Room/cursor invariants，拒绝raw body/provider extras。
- FT-05 repair descriptor为`dao.repair.memory.v1`、order 17，注册到FT-13唯一central registry；不存在第二registry。status stable key先于projection，record ID按UTF-8 bytes稳定keyset分页。
- materialized/streaming repair在固定Room watermark的同一SQLite read transaction取snapshot；checksum覆盖closed safe projection。Desktop staged generation完整校验后原子切换，再补`W+1` delta。
- 三个独立密码登录客户端覆盖live accepted event、delta/history、expired cursor、materialized repair、streaming fallback、clear-cache与server/AuthorityWorker真实restart；同一Room的memory/attachment/recall结果最终checksum/watermark一致。
- 生产事件ID统一带`room-memory:`前缀，确定性回归覆盖裸base64url digest以`-`开头的输入，保证event/outbox Core stable identifier始终合法。

## 12. Desktop Memory、source navigation与a11y

- production链为WebSocket→main IPC→closed preload bridge→renderer controller/cache/surface；renderer没有Node/Electron、token、path、raw corpus、provider payload或写authority能力。
- 可到达状态覆盖loading、empty、healthy、catching-up、active/disputed/resolving/resolved/superseded/review-required、proposal、project-ref unavailable、source active/revised/recalled/unavailable、noauth/degraded/recovery-required、offline/repairing/repair-failed、archived read-only、revoked及400/401/403/404/409/410/429/503。
- source navigation exact映射message、message tombstone、attachment与只读project fact；recalled source不显示body，unavailable/forbidden不伪造deep-link成功。archived Room允许current authorized Human只读query/sync/repair，禁止dispute/resolve、新steward work和Agent业务执行。
- keyboard顺序为filter→memory card→source→dispute/resolve/retry；dialog focus trap，Esc关闭后回触发器。状态用文字/图标/结构而非仅颜色；只有accepted action、低频health变化和repair完成进入bounded polite `aria-live`。
- `DESIGN_CONTRACT.md`与DOM tests覆盖VoiceOver labels、1440×900、840×560、200% zoom、reduced motion；production Electron smoke验证真实app bridge加载。视觉/语义设计偏离：**无**。

## 13. Secret、raw与Provider联合sentinel

联合sentinel使用彼此不同的canary覆盖raw message、raw attachment/extraction、recalled body、provider body/header/output、prompt、hidden reasoning、secret、path/URL/token和validated derived memory。扫描范围包括：

1. SQLite所有表/列、运行中main/WAL/SHM以及checkpoint+close后的DB；
2. job/attempt/idempotency、event/outbox/delta/history、materialized/streaming repair、snapshot/cache；
3. public/private Worker frames、WebSocket、Desktop bridge/cache/DOM、真实captured logs/errors/metrics和child stdout/stderr。

允许域只有：raw Human message留在FT-03 message/audit authority，raw attachment/extraction留在FT-04 artifact authority，validated `derivedText`留在closed memory version/projection。FT-05 source/job/outbox/repair/diagnostic中禁区canary命中为0；noauth与malformed provider均证明零fake result、零watermark。Provider不读取或记录错误body/header，raw response/prompt/reasoning不持久化。

## 14. PR、ready head、双Node CI与squash

| PR | 范围 | Ready head | 最终受保护CI | Squash merge |
| --- | --- | --- | --- | --- |
| [#54](https://github.com/LionelHao/Dao/pull/54) | Core/schema/provider/design foundation | `dae7ea9fd7c4272ed4b04617cf7e7388b82eb9fa` | [32371872606](https://github.com/LionelHao/Dao/actions/runs/32371872606)：Node 22.13.1 job `96434081136`、Node 22.x job `96434080729` success | `a820a65493bdf283d8cad7760b01dc6f541395ba` |
| [#55](https://github.com/LionelHao/Dao/pull/55) | corpus/DB authority/steward/protocol/repair/runtime | `06fbc6085c910703985623969c680b19b1cb1c5b` | [32377138394](https://github.com/LionelHao/Dao/actions/runs/32377138394)：jobs `96451163400`/`96451163641` success | `c7879d0de8728fe859d7a0b4e7d8ea724a333175` |
| [#57](https://github.com/LionelHao/Dao/pull/57) | transient Authority operation recovery | `cd8e975a85d9132edf46383aaf0b0e8de7258aaf` | [32388081790](https://github.com/LionelHao/Dao/actions/runs/32388081790)：jobs `96487348507`/`96487348795` success | `1ae46ab66421681266184648d9d4d859b2d5ae7f` |
| [#56](https://github.com/LionelHao/Dao/pull/56) | Desktop Memory与三端E2E | `d462b82977d49ed472721e3b68adf487ba5adbf3` | [32389497440](https://github.com/LionelHao/Dao/actions/runs/32389497440)：jobs `96491924728`/`96491924931` success | `db1d3af96c158e0443a97568e651121da2989df0` |
| [#58](https://github.com/LionelHao/Dao/pull/58) | invocation/degraded/sentinel/archive/runtime hardening | `ca891898917b6ceafc4089bf03d9324b619efb62` | [32399055191](https://github.com/LionelHao/Dao/actions/runs/32399055191)：jobs `96522621298`/`96522621709` success | `c2f38a432a008ecbec93aac706ac19164e4289f8` |
| 最终documentation-only PR | 本文与Stage 7工作记录 | 待创建后回填 | Node 22.13.1 / 22.x必须双绿后才squash | 待最终回读 |

所有代码PR依赖序为foundation→authority→recovery→Desktop→runtime hardening。没有绕过失败check、把draft当交付、直接推送或force push `main`。PR #58最终CI前的失败暴露了真实事件identity/idempotency和测试静稳问题；均有生产修复、确定性回归与最新双绿，未靠blind rerun结案。

## 15. 命令、精确测试计数与门禁

可执行代码基线同一完整HEAD运行：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
corepack pnpm verify:desktop-boundary
corepack pnpm --filter @native-im/desktop smoke
git diff --check
```

| Evidence | Result |
| --- | --- |
| 全仓Test Files | 158 passed / 3 skipped / 0 failed（161） |
| 全仓Tests | 1796 passed / 3 skipped / 0 failed（1799） |
| Core | 6 files / 77 tests passed；negative type tests和zero-I/O boundary通过 |
| Server | 95 passed / 3 skipped files；1286 passed / 3 skipped tests |
| Desktop | 57 files / 433 tests passed；renderer boundary扫描20个production sources |
| schema v18 | 1 file / 8 tests；61 meaningful statements / 61 rollback |
| real AuthorityWorker/WebSocket/restart E2E | 1 file / 24 tests passed；event-ID修复后连续5轮120/120 |
| Electron-related Vitest | 4 files / 7 tests passed |
| production Electron smoke | 1/1 command passed |
| typecheck/lint/build/boundaries/diff | 全部退出0；lint 0 warnings |

三个skipped都是显式opt-in的OpenAI live suites；不是删测、only/focus或FT-05规避项。最终documentation-only PR双Node CI和合入后远端`main` clean worktree复验会在本任务最终回读中记录。

## 16. Live smoke状态

- 已运行：真实Node child/temp filesystem/SQLite/AuthorityWorker/WebSocket、三个认证client、process crash/restart、materialized/streaming repair、production Desktop IPC/preload/renderer和Electron app bridge smoke。
- 未运行：真实OpenAI Memory/Responses/Router live calls。当前环境没有同时显式设置`DAO_OPENAI_LIVE_SMOKE=1`与真实secret，因此三个live suites安全skip；不声称Provider live成功。
- 已证明的production noauth行为：公开composition缺secret时零fetch、零fake candidate/record、零attempt、watermark不变；Human chat和explicit invocation边界仍按closed readiness运行。

## 17. 已知风险与建议reviewer

- schema/persistence reviewer：复核v18 61/61 rollback、one-steward trigger、append-only version/source transition、generation fencing与single AuthorityWorker writer。
- memory/product reviewer：复核五类中仅Context auto-active、multi-source invalidation、dispute/resolve authority，以及memory/project双aggregate禁止边界。
- provider/security reviewer：复核duplicate-key parser、strict schema/size budget、pre/post source reauthorization、secret/error body不读取和联合sentinel域。
- runtime/route reviewer：复核explicit snapshot+delta与proactive degraded矩阵；FT-06/07/08/09接线时不得用旧64窗口、fake checkpoint或重新引入silent。
- sync/reliability reviewer：复核memory descriptor只注册到FT-13唯一registry、fixed W/checksum、W+1 delta、event ID命名空间和三设备restart收敛。
- Desktop/accessibility reviewer：用VoiceOver及真实840×560/1440×900/200%窗口再做人工视觉验收；自动化证明合同与可到达DOM，不代替owner主观验收。
- release reviewer：部署前用真实OpenAI secret显式运行live smoke并审计模型/endpoint/配额；当前required workflow只覆盖frozen install、boundary、typecheck、lint和full test，不自动运行build/Electron/live provider。

## 18. 远端main SHA与不可自指的文档载体

`c2f38a432a008ecbec93aac706ac19164e4289f8`是包含全部FT-05可执行行为、且五个代码PR已经squash后的`origin/main`代码交付基线。本文通过后续documentation-only squash PR交付；Git commit无法在自身正文中预先包含尚未生成的未来squash SHA，因此最终文档载体PR、其merge SHA和届时实际`origin/main` SHA以GitHub PR及本任务完成后的远端回读为准。这与仓库既有FT-04交付记录采用相同、可审计的非自指处理。

## 19. Worktree、原始状态与Blueprint边界

- 原始用户worktree`/Users/leo/code/Dao`始终保留原branch`codex/ft02a-delivery-trace-fix`；四份未跟踪FT-09/FT-10文档未被clean、stash、reset、移动、覆盖、暂存或提交。
- 所有审计/实现slice使用独立worktree、branch、base和文件所有权；integration owner逐提交审阅/cherry-pick并串行处理共享文件。
- runtime hardening worktree在ready head push后clean；delivery worktree`/Users/leo/code/Dao-stage7-ft05-delivery`从代码基线`origin/main@c2f38a4...`创建，只承载本文与工作记录。
- 最终docs PR合入后将从最新`origin/main`创建新的clean validation worktree运行全部门禁；最终SHA与两个worktree status由最终回读给出。
- 未修改Blueprint HTML/JSON或任务状态；未使用`verified`，未声称owner已验收。

## 20. 明确后续FT边界

- FT-06拥有最终context compiler、token budget、frozen manifest、excerpt/digest/index和公开Room-memory read tool；FT-05只交付memory snapshot与source-addressable raw delta authority。
- FT-07拥有Agent profile/routing policy；FT-08拥有invocation/scheduler执行语义。两者只能消费FT-05 readiness，不能将其改成参与开关或silent。
- FT-09拥有Goal/Decision/NextAction/OpenQuestion-Blocker的Human confirmation、project aggregate、责任/截止/承诺与Ball迁移；FT-05 checkpoint当前明确disabled。
- FT-10拥有通用Tool Safety；本阶段没有新增任意URL/path/shell/tool能力。
- FT-11拥有全产品Desktop shell/root集成；本阶段只交付feature-owned Memory panel及受控host adapter。
- FT-12拥有proactive通知产品；本阶段只提供degraded readiness gate，不自行创造通知策略。
- FT-14拥有retention/export/release operations；recalled raw的Human audit/owner export、永久删除与跨Room搜索不在本阶段实现。

**第七阶段 FT-05 已达到交付条件并交付远端 main，等待 owner 验收。**
