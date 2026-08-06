# Design Review: T-0037 人 / agent 视觉分离渲染

Reviewed against: 设计稿 T-01、C-01；PRD 2.3 #1

Philosophy: 功能主义协作台——颜色只表达 agent 角色，形状与版式表达人与 agent 的不同语义。

Date: 2026-08-06

## Screenshots Captured

| Screenshot | Breakpoint | Description |
| --- | --- | --- |
| `screenshots/t0037-visual-separation-desktop-1280.png` | Desktop (1280×800) | 人气泡、五个角色槽和第六位条纹 agent 同屏。 |
| `screenshots/t0037-visual-separation-tablet-768.png` | Tablet (768×1024) | 紧凑宽度下仍保持色轨和气泡的结构分离。 |
| `screenshots/t0037-visual-separation-mobile-375.png` | Mobile (375×812) | 单列窄屏的消息布局。 |

## Summary

人消息以圆头像和有边框的气泡呈现；agent 消息以圆角方头像、角色色轨和无气泡的记录正文呈现，扫读时的结构差异明显。第六位 agent 同时保留首字与斜纹，颜色重用时不会失去身份线索。

## Review checklist

- **视觉层级与一致性：通过。** 标题、说明和时间线采用 4px/8px 的节奏；色轨只用于 agent，未用于人或状态语义。
- **原语保真：通过。** 设计稿 T-01 的圆形 / 圆角方头像与 C-01 的气泡 / 色轨同时可见。
- **响应式：通过。** 运行时测得 `scrollWidth === viewportWidth`：1280、768、375 三种宽度均无横向滚动；375px 时预览与时间线均为 343px。
- **可访问性：通过本任务范围。** `main` 与时间线均有中文可访问名称；头像为装饰性内容并设为 `aria-hidden`。本视图无可交互控件。
- **深色模式：通过。** 截图运行在系统深色外观，文本、气泡边界、色轨和条纹都保持可辨。

## Must Fix

无。

## Should Fix

无。

## Could improve

后续成员模型拥有独立的 agent 角色字段后，可将当前由 `displayName` 承载的角色标签替换为正式角色元数据；这不影响本任务的视觉分离。
