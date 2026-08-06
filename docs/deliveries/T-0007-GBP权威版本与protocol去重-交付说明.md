# T-0007 GBP 权威版本与 protocol 去重 · 交付说明

## 1. 做了什么

核验并补录 GBP 上游已经完成的 protocol 去重：根目录 `protocol.md` 是唯一入口指针，`skill/grand-blueprint/references/protocol.md` 是语义与文档维护宪法的唯一权威正文。

## 2. 逐条对照验收标准

1. **满足** — 上游根目录 `protocol.md` 第一段明确声明“本文件不是规范正文”，其表格指定 `skill/grand-blueprint/references/protocol.md` 为文档维护宪法、语义、状态机与评测闭环的唯一正文。根文件本身不是第二份权威规范。
2. **满足** — 差异逐条如下：

   | 项目 | 根 `protocol.md` | `references/protocol.md` |
   | --- | --- | --- |
   | 体量与 MD5 | 1115 bytes；`93b507fc01d7ae1c250db345b0b9267c` | 41064 bytes；`ea104b15146bb51d752bd7644db29632` |
   | 角色 | 非正文的规范位置指针 | 唯一语义规范正文 |
   | 正文内容 | 三个权威文件的路径和职责、历史去重说明 | §0 文档维护宪法、语义、状态机、球在谁手里、计划生长与评测闭环 |
   | 合并结果 | 取消旧正文，不再复制条款 | 保留唯一正文 |

   因此两文件不是“应相同的双副本”，而是验收标准允许的第二种完成形态：根文件改为指向唯一正文。`context/README.md` 中对应的三份快照与当前上游逐字一致（`cmp` 均为 0）。
3. **满足** — 根入口的同一张表显式写明：`references/protocol.md` 包含**文档维护宪法（§0）**，`references/format-html.md` 包含**数据契约**；`SKILL.md` 为操作入口。接入方从根入口可找到完整规范，不再需要猜测条款落点。

## 3. 参照与偏离

- **参照什么** — 本任务只处理 GBP 的文档治理，不涉及 Buzz 的模块或架构。
- **怎么翻译** — 不适用：没有把 Buzz 的实现翻译到 TypeScript 或产品代码。
- **为何偏离** — 有意不引入 Buzz 参照，避免把产品协作系统的架构基线误写成 GBP 协议去重的依据；这里的唯一事实来源是 GBP 上游根指针与其三个规范文件。

## 4. 解锁了什么

- T-0008 可在唯一 `protocol.md` / `format-html.md` 入口上起草字段扩展提案，不再有条款号歧义。
- T-0009 可按同一份协议的 journal 分类与反馈闭环补录接入摩擦。

## 自检

- [x] 已核验上游三份权威文件存在，根指针到 `references/protocol.md`、`references/format-html.md`、`SKILL.md` 的职责分工明确。
- [x] 已用 `md5` 与 `cmp` 记录根 / 正文差异和 `context/` 快照一致性。
- [x] 未修改只读快照或上游已正确的正文，避免制造第三份副本。
- [x] 已在独立干净克隆运行 `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`：全部通过（5 个测试文件、38 个测试）。
- [x] `gbp.py check --links` 已复核为零违规、零死链；现交付给 @lionel 验收。
