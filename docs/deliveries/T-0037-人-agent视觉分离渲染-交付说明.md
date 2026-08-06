# T-0037 人 / agent 的视觉分离渲染 · 交付说明

## 1. 做了什么

将桌面消息时间线的人与 agent 渲染为类型驱动的两套视觉原语，并提供可运行的 `?visual-review` 审查样本、响应式截图和自动化覆盖。

## 2. 逐条对照验收标准

1. **满足** — `renderMessage()` 先按已校验 `actor.kind` 分派到仅接收 `HumanActor` 或 `AgentActor` 的渲染函数；没有形状参数。human 使用 `.message-avatar--human`（圆形），agent 使用 `.message-avatar--agent`（圆角方形）。数据不一致时才按 `Message.authorKind` 安全回退，避免把 agent 降格为人消息。
2. **满足** — human 使用 `.message-bubble`，agent 使用 `.message-role-rail` 和无气泡正文；静态审查样本在 `?visual-review` 同屏展示两者。见 [桌面](../../screenshots/t0037-visual-separation-desktop-1280.png)、[平板](../../screenshots/t0037-visual-separation-tablet-768.png)、[手机](../../screenshots/t0037-visual-separation-mobile-375.png) 截图与 [设计审查](../../DESIGN_REVIEW.md)。
3. **满足** — `packages/desktop/src/renderer/app.test.ts` 的 `renders the same text as different DOM forms for a human and an agent` 使用同一正文，断言 human 是 `.message--human` + `.message-bubble`，agent 是 `.message--agent` + `.message-role-rail`。
4. **满足** — 五个角色色槽为 `#175cd3`、`#5b21b6`、`#a21caf`、`#0e7490`、`#344054`，并有运行时保护拒绝与成功 `#027a48`、警示 `#b54708`、危险 `#b42318` 重叠。第六个不同 agent 复用色槽时添加 `.message-avatar--agent-overflow` 斜纹，同时保留首字；六-agent 测试断言五个槽位和第六位的 `pattern-and-initial`。

### 原语三层落地

本次覆盖 PRD 2.3 #1「在场」的视觉物理分离；消息形态也遵循律一“语义不同的原语不共用视觉”。

| 层次 | 证据 | 状态 |
| --- | --- | --- |
| 数据层 | T-0036 已定义不可互赋的 `HumanActor`（`reachability`）与 `AgentActor`（`readiness`、`toolPermissions`）；本任务的渲染函数以这两个窄化类型接收 actor。 | 满足 |
| 接口层 | T-0011 已在服务端拒绝 `Message.authorKind` 与 actor kind 不符；本任务不暴露“手工传头像形状”的接口，渲染分派由身份类型决定。 | 满足 |
| 渲染层 | 圆形气泡与圆角方角色色轨为不同 DOM / CSS 结构；同文案测试、三种断点截图和设计审查均验证一眼可辨。 | 满足 |

本任务不新增或假装实现已读、@、编辑、撤回等其他原语；它们保留给各自的类型与 API 任务。

## 3. 参照与偏离

- **参照什么** — Buzz 的客户端边界：Desktop / Web / Mobile 可以各自增加视图，但服务端的事件 kind、权限与可见性仍是规范源。
- **怎么翻译** — 在 Electron / TypeScript 渲染层只消费已有的 `Actor` 与 `Message`，以 DOM 结构呈现身份差异；它不复制或重新实现服务端的身份校验。
- **为何偏离** — Buzz 虽把 agent 作为一等参与者，但没有拆分人 / agent 的原语视觉。本产品按 PRD 律一将圆形气泡与方形色轨固定为不同形态，避免把 agent 重画成“会说话的人”；也不引入 Nostr 身份、多租户或其他 Buzz 运行时能力。

## 4. 解锁了什么

T-0014「人撤回 / agent 负反馈」的硬依赖已经满足：它可以在已分离的消息形态上增加不同动作，而不会退回共享消息卡片。

## 自检

- [x] 五条命令在隔离干净克隆 `/tmp/native-im-t0037.aWi1lK` 上全过：install / typecheck / lint / test / build（38 tests）
- [x] 新增行为都有测试；无 `.skip` / `.only`；无 `any` 或未解释的 `@ts-expect-error`
- [x] 触及的原语已按数据层 / 接口层 / 渲染层对照 PRD 2.3 与设计稿 T-01、C-01
- [x] Buzz 参照、TypeScript 翻译与偏离已说明
- [x] 四段交付说明齐全；截图与设计审查已保存
- [x] `gbp.py check --links` 在交付前为零违规、零死链
- [x] 未改动自己认领任务的验收标准；蓝图写入均通过 `gbp.py`
