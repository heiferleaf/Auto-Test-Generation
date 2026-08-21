---
name: knowledge-deposit
description: 知识沉淀规范——重复任务总结为 skills，纪律性约束维护为 rules，偏好维护为 CODEBUDDY.md
type: rule
---

# 知识沉淀规则

适用：项目长期维护（参见 CODEBUDDY.md §6）。

## 规则

1. **重复要执行的任务** 或 **特定任务开发要求** → 总结为 `.codebuddy/skills/` 下的技能文档（含可复用步骤、命令、注意事项）。
2. **工作流/纪律性约束**（worktree、测试先行、并行协作校验）→ 维护为 `.codebuddy/rules/` 下的规则文档。
3. **开发偏好、工作流、技术栈要求** → 维护为根目录 `CODEBUDDY.md`。
4. 任何新沉淀必须可被后续 Agent 直接读取复用，避免重复探索。
5. 技能/规则文档用 frontmatter（`name`/`description`/`type`）标注，便于索引。
6. 当某条规则被反复违反或某技能过时，及时更新或删除，保持知识库有效。
