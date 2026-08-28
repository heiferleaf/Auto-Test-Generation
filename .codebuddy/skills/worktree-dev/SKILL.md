---
name: worktree-dev
description: 在本项目用 git worktree 开展实现任务。接到功能/修复、需要并行隔离开发时使用。创建独立工作树、共用根 node_modules、非交互合并；不要自动删除 worktree。
---

# Worktree 开发

用于在本项目启动一个实现任务的工作流。适用：接到任何实现/修复任务需隔离开发，或需并行多个任务。

主工作树：`d:/project/自动化测试`（分支 `master`）
工作树目录：`.cursor/worktree/`（已被 gitignore）
不要和 Cursor 产品目录 `~/.cursor/worktrees` 混用。

## 步骤

1. 确认主树在 `master` 且工作区干净。
2. 创建并进入工作树：

```bash
git worktree add -b feat/<name> .cursor/worktree/<name> master
cd .cursor/worktree/<name>
```

3. 按 `test-first-dev` 先写测试再实现，直到 `npm test` 全绿。
4. 回到主树非交互合并：

```bash
git merge feat/<name> --no-ff -m "merge(feat/<name>): <why>"
```

5. 合并前确保已过 test、code-review、runtime-runnability 三角色校验。
6. 合并后**保留 worktree 与分支**，直到用户明确要求清理。仅在用户明确说"删除/清理"时才执行 `git worktree remove` + `git branch -d`。

## 共用 node_modules

只在主树执行一次 `npm install`。根 `.npmrc` 已设 `node-linker=hoisted`，各 worktree 沿目录树向上复用根 `node_modules`，不要再装。
仅当根 `node_modules` 缺新依赖时在主树装一次，所有 worktree 立即可用。若某 worktree 内误装了独立 `node_modules`，删掉它退回根共享。

## Windows 避坑：交互确认卡死（本仓库反复踩过）

`git worktree remove` / `git merge` 在 Windows 下常卡在交互确认，导致命令挂起或被超时杀掉：

1. `git worktree remove` 遇文件锁（npm/tsc 占用）会提示 `Deletion of directory ... failed. Should I try again? (y/n)`。
2. `git merge --no-ff` 可能弹出编辑器或确认。
3. `npx <pkg>` 未安装时提示 `Need to install ... Ok to proceed? (y)`。

正确做法：

- 合并加超时保护：`timeout 60 git merge feat/<name> --no-ff -m "merge(...)"`。
- 删除 worktree 先 `git worktree prune`，再喂入 y 跳过确认：`printf 'y\n' | git worktree remove .cursor/worktree/<name> --force`。
- 删分支：`git branch -d feat/<name>`（已 prune 后才可删被 worktree 引用的分支）。
- 装依赖用 `npm install --silent` 或 `npx --yes vitest run`，避免 npx 交互询问。
- 若命令返回 "Running in background" 且长时间无输出，多半卡在交互提示——用 TaskStop 终止，改用上述非交互写法重跑，**不要反复在原命令上等待**。

**文件锁残留**：被占用的 worktree 物理目录无法 `rm -rf`，需重启 shell/进程释放句柄。但 `git worktree prune` 已将其从 git 元数据移除，仅磁盘残留，不影响 git 操作。
