# Design Review: T-0039 真人邀请与 Agent 配置入口

Reviewed against: `DESIGN_BRIEF.md`、产品 PRD 2.3 #6/#13、桌面端设计稿 S6

Philosophy: 克制的功能主义协作台——等待真人回应与立即配置 Agent 使用不同结构、控件和视觉表面。

Date: 2026-08-10

## Screenshots Captured

| Screenshot | Breakpoint / state | Description |
| --- | --- | --- |
| `screenshots/review-join-desktop-1280.png` | Desktop 1280x800 | 默认双列入口，真人虚线面与 Agent 实线角色面并列。 |
| `screenshots/review-join-tablet-768.png` | Tablet 768x1024 | 紧凑双列仍保持完整字段、说明和 44px 控件。 |
| `screenshots/review-join-mobile-375-top.png` | Narrow 375x812, top | 单列上半部与真人邀请路径。 |
| `screenshots/review-join-mobile-375-bottom.png` | Narrow 375x812, bottom | 单列下半部与 Agent 配置路径；页面无横向滚动。 |
| `screenshots/review-join-error-desktop-1280.png` | Desktop error/focus | 空真人 ID 的可见焦点、错误状态和控件关联。 |
| `screenshots/review-join-success-desktop-1280-viewport.png` | Desktop success/focus | 两类回调成功态、工具勾选和 Agent 主动作焦点。 |

> 截图均位于 `.design/t0039-room-join/screenshots/`，运行环境为系统深色模式。

## Summary

两条加入路径在扫读层面即可区分：真人模块以蓝色虚线、等待文案和单一 Actor ID 输入表达社会邀请；Agent 模块以实线角色轨、参与度和工具授权表达即时配置。1280px、768px 和 375px 运行预览均无横向溢出；深色默认、错误、成功和键盘焦点状态均清晰。

## Review checklist

- **视觉层级：通过。** 页面标题先说明这是两条不同路径，随后进入并列模块；两个主动作均无需寻找。
- **一致性：通过。** 间距、圆角、字体和状态区复用既有 token；未引入装饰动画或渐变。
- **语义保真：通过。** 真人使用 pending / accept / reject 语言，Agent 使用 participation / tool grant / immediate 语言，不共用载荷或回调。
- **响应式：通过。** 1280px 和 768px 为双列，375px 重排为单列；实测 `scrollWidth === viewportWidth`。
- **可访问性：通过。** landmark、标题、label、fieldset、legend、aria-live、aria-invalid、aria-errormessage 和可见焦点齐全；控件最小高度 44px。
- **对比度：通过。** 深色 success 9.26:1、danger 7.23:1、warning 9.08:1；控件边界在相邻明暗表面为 3.07:1 至 4.76:1。
- **深色模式：通过。** CSS token 和原生 `color-scheme` 同步，checkbox/select 不再出现亮色伪影。

## Must Fix

无。

## Should Fix

无。

## Could Improve

接入真实 API 后，为两个提交动作增加独立的 loading、失败重试和服务端错误映射；当前 callback 预览已覆盖本任务范围内的同步成功与错误反馈。

## Verdict

PASS。Task 5 的代码、交互和视觉实现可进入 T-0039 总体验收；本结论不代表 Blueprint `verified`。
