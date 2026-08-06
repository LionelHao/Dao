# T-0007 GBP 权威版本与 protocol 去重 · 工作笔记

## 验收标准（逐条抄录）

1. 明确指定根目录 `protocol.md` 与 `references/protocol.md` 中哪份为准。
2. 两份差异逐条列出，合并后两处文件内容一致（md5 相同）或其中一份改为指向另一份的引用。
3. 「文档维护宪法」与数据契约所在的文件在协议入口处显式声明，接入方可从单一入口找全规范。

## 事实与判定

- 本任务的文件属于 GBP 上游：`/Users/lionel/project/prompt-hub/docs/proposals/2026-08-04-grand-blueprint/`；当前蓝图的 `context/` 是只读快照，不能在快照上再造副本。
- 上游根 `protocol.md`（1115 bytes，MD5 `93b507fc01d7ae1c250db345b0b9267c`）是非正文指针；唯一语义权威是 `skill/grand-blueprint/references/protocol.md`（41064 bytes，MD5 `ea104b15146bb51d752bd7644db29632`）。
- 根指针列出三个规范入口：`references/protocol.md`（宪法与语义）、`references/format-html.md`（数据契约）与 `SKILL.md`（操作手册）。本地 `context/协议-规范位置说明.md`、`协议-protocol.md`、`协议-format-html.md` 与对应上游文件逐字一致。

## 本轮边界

- 这是上游 owner 已完成的去重，当前工作是验证并补录；不重写、移动或修改任何上游/快照协议正文。
- 产物应给出两文件的逐项差异、单一权威结论、可重复的存在性/一致性检查，以及 T-0008 / T-0009 的解锁关系。
