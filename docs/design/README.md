# Agent IM 设计基线索引

本文是项目内 UI / 交互设计输入的稳定入口。后续 PRD、feature spec、implementation plan 和验收说明应链接本文或下方的正式审阅稿，不再引用下载目录或 ZIP 文件。

## 当前设计基线

- **正式审阅稿（自包含）**：[2026-08-agent群聊协作模式-UI交互设计稿.reconstructed.html](./2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.reconstructed.html)
- **可编辑 DC 源稿**：[2026-08-agent群聊协作模式-UI交互设计稿.dc.html](./2026-08-agent群聊协作模式-UI交互设计稿/2026-08-agent群聊协作模式-UI交互设计稿.dc.html)
- **源稿运行时**：[support.js](./2026-08-agent群聊协作模式-UI交互设计稿/support.js)
- **103 条 Requirement 逐项覆盖矩阵**：[design-requirement-coverage.md](./design-requirement-coverage.md)

交付状态：2026-08-18 由 owner 作为已交稿设计基线接入，并在同日按已批准 PRD 完成缺口修补。设计稿页头标识为“PRD 证据重建版 v0.1 已批准基线 · FT-16 Design Contract”。原始 ZIP 的 SHA-256 为 `a4da7afaef5e7af5082b12ff1832464534a3c80dab0493056132318200237891`；修补前 `.dc.html` / `.reconstructed.html` SHA-256 分别为 `77eccff014b7e430c261770094f9140b95c6ccefedf22414c72a373c6231af55`、`2b461d50b8436233fe8d9ae44a457977eb475f89273f7326899ce30c10f5215f`。当前两份 HTML 是可追溯的修补后基线；`support.js` 未改写，SHA-256 仍为 `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe`。

## 覆盖范围

设计稿包含：

1. J-01 登录 / 入群 → Room；
2. J-02 发消息 → ACK / 失败重试；
3. J-03 `@Agent` → execution → final；
4. J-04 `@Human` → Request → 接受 / 转交；
5. J-05 副作用 → 精确确认 → 结果；
6. J-06 proposal → Human 确认 → 项目事实；
7. J-07 通知深链 / 离线 → repair；
8. 状态分支、设计令牌、组件状态、Requirement 覆盖矩阵和工程交接。

2026-08-18 基线修补补齐了 J-01 首次无 Room / degraded / fatal、J-02 附件完整生命周期、J-05 confirmation 拒绝与撤权分支、J-07 repair failed 与多 session read/handled 收敛，以及 FT-16 键盘/焦点、缩放、对比度、reduced motion 验证矩阵。以上状态均可通过对应旅程的“上一步 / 下一步”实际到达，不是静态覆盖声明。

## PRD、spec 与实现如何应用

权威关系按以下顺序理解；不同文档负责不同问题，不应互相越权：

1. [当前产品 PRD](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)定义产品语义、权限、不变量和 Requirement；
2. `docs/protocols/` 和 feature spec 定义服务端事实、命令、ACK、事件、错误与恢复合同；
3. 本设计稿把上述 Requirement 和事实合同映射为 Desktop 信息架构、组件、状态、操作与视觉；
4. 生产代码与测试证明实现，不反向修改 PRD 或设计基线。

后续任何涉及 UI / 交互的 spec 至少应写明：

- 对应的 `REQ-*` 与 FT 编号；
- 对 103 条产品 Requirement 的逐项分类以 [design-requirement-coverage.md](./design-requirement-coverage.md) 为准；场景级范围缩写仅作导航，不作为覆盖证据；
- 对应的旅程 `J-01`～`J-07`、设计稿分区或组件状态；
- UI 中每个状态的权威来源：本地暂态、server ACK、stable event 或 projection；
- loading、empty、401 / 403 / 409 / 410 / 429 / 503、offline / repair 等适用分支；
- 键盘、焦点、非颜色识别、reduced motion 与可访问通告要求；
- 与设计稿不一致时的具体偏离、理由、审批人和替代验收证据。

可在新 spec 中直接使用：

```md
## 设计基线

- 产品要求：`REQ-...`；后续任务：`FT-...`
- 交互旅程：设计稿 `J-...`；组件/状态：`...`
- 权威状态来源：local / ACK / event / projection
- 失败与恢复：...
- 可访问性：...
- 偏离：无；如有，记录原因与批准。
```

设计稿中的步进按钮、路径选择和演示数据只用于表达状态迁移。没有服务端命令、ACK、事件或 projection 支撑的效果仍是 `prototype-only`，不得仅凭前端变化宣称业务已生效。

## 维护规则

- 保留 `.dc.html` 与 `support.js` 同目录；前者依赖 `./support.js`。
- `.reconstructed.html` 是评审和跨环境传递的首选入口，不应在后续 spec 中链接 `/Users/leo/Downloads`。
- 新版本放入新的日期/版本目录；不要原位覆盖本次基线。PRD Requirement 或产品边界发生变化时，先完成可审计的产品变更，再同步设计。
- 历史任务文档仍描述当时采用的设计依据，不因本次交稿被追溯性改写；新任务及以后修改的 UI spec 应采用本基线。
