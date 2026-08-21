---
name: agent-team-collaboration
description: 多 Agent / Agent team 协作与双角色校验规则——可并行任务并行推进，每任务带 test & code-review 角色
type: rule
---

# 多 Agent 协作与校验规则

适用：存在可并行子任务时（参见 CODEBUDDY.md §4）。

## 规则

1. 需求存在 **可并行执行** 的子任务 → 采用 **多 Agent** 或 **Agent team** 并行推进。
2. 每个任务完成 **必须经过两个独立校验角色**：
   - **test 角色**：确认对应测试方案/测试代码存在且通过。
   - **code-review 角色**：审查是否符合 CODEBUDDY.md、设计文档与测试要求。
3. 并行拆分原则：
   - 子任务无强数据依赖 → 并行（各自 worktree + 各自 Agent）。
   - 子任务共享同一模块/文件 → 串行或单一 Agent 负责，避免冲突。
4. 测试代码与实现可由同一 Agent 在同一 worktree 完成，但 test / code-review 校验须由独立角色执行。
5. 协作产物（worktree、测试、review 结论）需可追溯，便于主树合并决策。
