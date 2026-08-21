---
name: worktree-workflow
description: 本地 git worktree 工作流纪律——每个实现任务在独立工作树进行，主树保持基线
type: rule
---

# Worktree 工作流规则

适用：本项目所有实现任务（参见 CODEBUDDY.md §3）。

## 规则

1. 本地必须维护 git 仓库；主工作树为 `d:/project/自动化测试`（分支 `master`）。
2. **任何实现任务都必须在独立 worktree 中进行**，禁止在主工作树长期开发。
3. 工作树存放目录：`.codebuddy/worktree/<name>`，由 `git worktree add` 创建（已 gitignore）。
4. 标准动作：
   ```bash
   git worktree add -b feat/<x> .codebuddy/worktree/<x> master
   cd .codebuddy/worktree/<x>
   # 开发 + 自测
   cd /d/project/自动化测试
   git merge feat/<x>
   git worktree remove .codebuddy/worktree/<x>
   ```
5. 合并前工作树必须通过测试与 code-review；主树始终保可编译/可测试基线。
6. 并行任务 → 各自一个 worktree。
7. 当前工作区在主树执行一次 `/init` 完成项目上下文初始化。
