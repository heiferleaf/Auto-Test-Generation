---
name: worktree-dev
description: 在本项目用 git worktree 开展实现任务的技能——创建独立工作树、开发自测、合并清理。复用 CODEBUDDY.md §3（工作流规则）。
type: skill
---

# Worktree 开发技能

用于在本项目启动一个实现任务的工作流。

## 何时使用
- 接到任何实现/修复任务，需要在隔离环境开发。
- 需要并行多个任务（每个一个 worktree）。

## 步骤
1. 确认在主工作树 `d:/project/自动化测试`，分支 `master` 干净。
2. 创建并进入工作树：
   ```bash
   git worktree add -b feat/<name> .codebuddy/worktree/<name> master
   cd .codebuddy/worktree/<name>
   ```
3. 按测试先行规则（见 `rules/test-first.md`）：先写测试方案/骨架，再实现，迭代至 `npm test` 全绿。
4. 自测通过后回到主树合并并清理：
   ```bash
   cd /d/project/自动化测试
   git merge feat/<name>
   git worktree remove .codebuddy/worktree/<name>
   ```
5. 合并前确保已过 test 与 code-review 双角色校验。

## 注意
- worktree 目录已被 `.gitignore` 忽略，不会误提交。
- 并行任务各自独立 worktree，避免共享文件冲突。
- 主树始终保持可编译/可测试基线。
