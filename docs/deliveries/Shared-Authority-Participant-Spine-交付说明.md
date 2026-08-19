# Shared Authority Participant Spine 交付说明

> 日期：2026-08-18
>
> 基线：`origin/main@8425ffb659bcba02f1929b59a8b284da3f88f0f8`
>
> 状态：等待 owner 验收

## 交付内容

- 新增 server-private branded `AuthorityTransactionView`；普通 JSON 和公开 package surface 均不能构造有效 capability。
- 新增 exact-key `ParticipantRegistration`、十项 exact feature enablement manifest，以及 version 1 校验。
- 新增 `DepartureResponsibilityContributor`、`PendingConfirmationDepartureContributor`、`ArchivedMessageGate`、`BusinessTimerSuspensionParticipant`、`ArchiveSettlementParticipant`、`RuntimeArchiveFenceParticipant`、`AssignmentSecurityReductionParticipant`、`LifecycleRepairDescriptor`、`RoomCacheInvalidationPort`、`OfflineLeaseInvalidationPort`。
- 新增 closed success/error envelope 与每个 participant result 的 exact runtime guard；503 error 只含 status、closed code、dependency、closed reason 和 retryability。
- 新增 startup/composition 与 command-time fail-closed validation。enabled-but-missing、duplicate registration ID/feature、version mismatch、manifest mismatch、invalid transaction、participant throw、malformed result 与 cross-Room result 均不能穿过 validation。
- transaction participant registry、repair descriptor gate、cache/lease composition gate 保持三类 owner 边界；未建立通用 plugin system。

## 边界证明

- `packages/server/src/index.ts` 不导出 transaction capability、participant、registration、manifest、registry 或 test seam。
- `packages/core`、public protocol JSON、WebSocket、preload 与 renderer 未新增相关构造或 import。
- test fake 仅位于 `private-participant-registry.test.ts` 的 deep transaction seam。
- 未修改 schema/migration、AuthorityWorker/handler、protocol/WebSocket、snapshot worker 或 renderer；未创建第二 writer、event bus、transaction manager。
- 未新增 FT-07/09/10 SQL、reducer、状态机；未启用 leave/remove/archive/reopen；未修改 Blueprint。

## 测试与验证

Focused contract regression：3 个测试文件、13 个测试。

全仓验证结果：

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm typecheck` | 通过 |
| `corepack pnpm lint` | 通过，0 warnings |
| `corepack pnpm test` | 通过；59 个测试文件、1010 个测试：57 文件 / 1008 测试通过，2 文件 / 2 测试按既有配置跳过，0 失败 |
| `corepack pnpm build` | 通过；Core、Server、Desktop 均完成 |
| `corepack pnpm verify:core-boundary` | 通过 |
| `corepack pnpm verify:desktop-boundary` | 通过；5 个 renderer production source 无 Node/Electron authority |
| `git diff --check` | 通过 |

全仓精确计数为 **59 个测试文件、1010 个测试**；其中 **57 个文件、1008 个测试通过**，**2 个文件、2 个测试跳过**。

本交付只证明 Cross-FT Shared Contract Spine 的 server-private 合同与 fail-closed guard，不声明 FT-02、FT-07、FT-09、FT-10 或 FT-13 完成或 verified。
