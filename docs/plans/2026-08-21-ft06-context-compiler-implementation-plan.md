# FT-06 Context Compiler 实施计划

状态：**本地实现与独立审阅完成，等待远端 PR/CI/merge。** 基线 `origin/main=c0dc4421b3b5d5c00c4676e86bd205c482aa332c`，Node >=22.13，pnpm 10.14，schema v18，158 passed/3 skipped test files、1796 passed/3 skipped tests。实现候选为 schema v19；独占全量复跑为172 passed/3 skipped test files、1927 passed/3 skipped tests。

## 1. 交付切片与依赖

1. **Contract/Compiler**：closed core types、server-private pure compiler、canonical encoder/hash、budget/degradation、golden/property/negative type tests。不得修改schema或Blueprint。
2. **Persistence/Recovery**：只追加v19；snapshot/manifest/body/binding/lineage/read receipt/citation表；AuthorityWorker操作、CAS、retry/crash/manual/supersede/invalidation和migration/restart测试。不得修改v1-v18。
3. **Provider/Source Tool**：compiled-only OpenAI input、trusted/group layering、`room-memory.read` adapter、reauthorization/cursor/bounds、citation declaration/receipt、privacy sentinel。不得增加任意读取面或fake project。
4. **Integration**：composition、runtime service、final citation atomic commit、protocol/history/repair/必要Desktop现有状态、cross-package E2E、文档与完整验证。
5. **Adversarial review**：独立检查64窗口、retry漂移、recall后重发、system injection、citation伪造、跨Room cursor、raw leak、migration改写、mock fallback、FT-09 fixture、UI越界、worktree遗漏。

每个实现切片从同一基线创建独立worktree/branch；先提交失败测试再最小实现。集成以cherry-pick/rebase解决共享类型依赖，不允许多个写Agent共享worktree。

## 2. 文件所有权

- Contract：`packages/core/src/context-compiler.ts`、对应tests/type-tests、`packages/core/src/index.ts`的最小export；如需server pure实现则限`packages/server/src/context-compiler/`。
- Persistence：`packages/server/src/persistence/schema.ts`及tests、`authority-database-handler.ts`、runtime authority protocol/worker facade/tests。
- Provider/source：`packages/server/src/agent-runtime/openai-responses-provider.ts`及tests、新source adapter/tests、tool descriptor/gateway最小扩展、privacy tests。
- Integration由主Agent处理共享`collaboration.ts`、`agent-runtime-service.ts`、`authoritative-server.ts`、sync/protocol/WebSocket/Desktop与交付文档。

四个用户未跟踪FT-09/FT-10计划文件只存在原工作区，任何切片不得删除、移动、stage、commit或格式化。任何Blueprint HTML/JSON不得修改，不得标记verified。

## 3. TDD 顺序

### 3.1 Compiler

先加入compile determinism、canonical order、manifest dispositions、speaker/relation、no-full-history、budget boundary和content-too-large失败测试；再实现closed types/guards、estimator、selection与canonical hash。property tests固定报告seed/runs。

### 3.2 v19 authority

先扩展migration matrix/fault tests，再追加migration与physical invariants；先写snapshot ensure/reuse/CAS/restart失败测试，再实现operation。首次snapshot必须在Provider之前；automatic retry/recovery必须只读binding body。manual retry生成新binding；supersede写lineage。final message+citation+terminal同事务。

### 3.3 Provider/source/citation

先写request-shape测试证明不再接受`visibleConversation`且trusted/group/tool roles正确；再改Provider。先写权限/cursor/limit/zero-call矩阵，再实现read adapter。citation只接受closed declaration并在authority校验，不解析任意source id。

### 3.4 Integration

删除production最近64条Provider路径；composition用Authority snapshot ensure→revalidate→Provider。接入tool descriptor、receipt continuation和final citation。仅在正式projection已有支撑时加Desktop server-confirmed citation/unavailable；否则保留server contract并明确FT-16/09后续接线边界。

## 4. 必须验证

相关包测试通过后，集成分支依次运行：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm verify:core-boundary
git diff --check
```

另行记录schema fresh/v1-v18/future/rollback/equivalence、compiler golden/property、Provider shape、secret sentinel、source rejection/zero-call、retry/crash/supersede/invalidation、citation anti-forgery、real worker/SQLite restart/WebSocket/history/repair、Desktop/Electron、bounded queue/body/buffer/timeout/close与重复flake probe的精确计数。

live suite仅在显式flag和server-side secret同时存在时运行；否则按批准文案记录安全skip，绝不输出secret任何派生信息。

## 5. PR与完成顺序

实现分支先本地review并集成；必要时创建子PR但不得把单切片完成当Stage完成。集成分支全量通过后push并创建Stage 8 PR，处理review/CI，squash merge到远端main。merge后`git fetch --prune`，以GitHub PR状态和远端main核实，检查各worktree staged/unstaged/untracked，确认无有价值未交付内容后remove/prune。最终只保留`/Users/leo/code/Dao`。

## 6. 退出门

九条Requirement均有production代码和测试；Provider只消费compiled envelope；snapshot/retry/crash不漂移；budget可解释；source read真实且每次授权；citation闭合且atomic；v19全部历史迁移通过；privacy、worker/restart/WebSocket/Desktop/CI通过；交付文档与清理完成；用户四文件和Blueprint保持不变；结论只使用owner规定文案。
