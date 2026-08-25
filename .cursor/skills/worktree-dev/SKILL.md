---
name: worktree-dev
description: 在本项目用 git worktree 开展实现任务。接到功能/修复、需要并行隔离开发时使用。创建独立工作树、共用根 node_modules、非交互合并；不要自动删除 worktree。
---

# Worktree 开发

主工作树：`C:\Users\20443\Desktop\Auto-Test-Generation`（`master`）  
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

合并后**保留 worktree 与分支**，直到用户明确要求清理。

## 共用 node_modules

只在主树执行一次 `npm install`。根 `.npmrc` 已设 `node-linker=hoisted`。worktree 里不要再装；若误装了，删掉该 worktree 的 `node_modules`。

## Windows 避坑

- `git worktree remove` / `git merge` 可能卡在交互确认。合并加超时；删除前 `git worktree prune`，再用非交互 `--force`。
- 不要反复等待挂起的交互命令。
- 文件锁导致物理目录删不掉时，`git worktree prune` 后磁盘残留可等重启再清。
- `docs/` 已是仓库内真实目录，纳入版本控制。不要再按旧 symlink 方案重建或提交删除 `docs`。
