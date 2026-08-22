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
4. 自测通过后回到主树合并：
   ```bash
   cd /d/project/自动化测试
   git merge feat/<name>
   ```
   > **⚠️ 不要自动删除 worktree / 分支**：合并完成后**保留 worktree 与分支**，直到用户明确要求清理。
   > 反复增删 worktree 会触发 Windows 文件锁残留（见下「Windows 文件锁残留」），且不利于用户就地验收。
   > 仅在用户明确说"删除 worktree/清理"时才执行 `git worktree remove` + `git branch -d`。
5. 合并前确保已过 test 与 code-review 双角色校验。

## 注意
- worktree 目录已被 `.gitignore` 忽略，不会误提交。
- 并行任务各自独立 worktree，避免共享文件冲突。
- 主树始终保持可编译/可测试基线。

## ⚠️ 避坑：交互确认卡死（本仓库反复踩过的坑）

**问题**：在 Windows（Git Bash）下执行 `git worktree remove` / `git merge` 等命令时，常因以下原因卡在交互确认，导致命令长时间挂起甚至被超时杀掉：
1. `git worktree remove` 删除目录时遇 Windows 文件锁（npm/tsc 进程占用），会提示 `Deletion of directory ... failed. Should I try again? (y/n)`。
2. `git merge` 带 `--no-ff` 可能弹出编辑器或确认。
3. `npx <pkg>` 未安装时会提示 `Need to install ... Ok to proceed? (y)`。

**正确做法（务必遵守）**：
- 合并用非交互 + 超时保护：`timeout 60 git merge feat/<name> --no-ff -m "merge(...)"`。
- 删除 worktree 前先 `git worktree prune`，再用 `printf 'y\n' | git worktree remove .codebuddy/worktree/<name> --force`（喂入 y 跳过确认）。
- 删分支：`git branch -d feat/<name>`（已 prune 后才可删被 worktree 引用的分支）。
- 跑测试装依赖用 `npm install --silent` 或 `npx --yes vitest run`，避免 npx 交互询问。
- 若命令返回 "Running in background" 且长时间无输出，多半是卡在交互提示——用 TaskStop 终止，改用上述非交互写法重跑，**不要反复在原命令上等待**。

**Windows 文件锁残留**：被占用的 worktree 物理目录（如 `.codebuddy/worktree/m1-exec`）无法 `rm -rf` 删除，需重启 shell/进程释放句柄；但 `git worktree prune` 已将其从 git 元数据移除，不影响 git 操作，仅磁盘残留，可忽略或重启后清理。

**权限**：`.codebuddy/settings.json` 已对 `git worktree:*` 与 `git:*` 设 `permissions.allow`，跳过权限申请弹窗。

## ⚠️ 避坑：docs 是 symlink，合并会误删

**背景**：本仓库 `docs/` 是指向笔记目录（`D:\Harvey Note\自动化测试平台`）的 **symlink**，只通过笔记同步维护，**不纳入 git 版本控制**（已在 `.gitignore` 忽略）。

**问题**：若 worktree 内曾对 `docs` 做过 `rm -rf docs` 或提交过删除 symlink 的操作，合并回 master 时 git 会把 master 上的 `docs` symlink 一并删掉（显示为 `delete mode 120000 docs`），导致本地文档入口丢失。

**正确做法（务必遵守）**：
- `docs` 已在 `.gitignore` 中忽略，正常情况下 master 合并不会触碰它；但不要在任何 worktree 里提交对 `docs` 的增删。
- 若合并后误删了 symlink，用 **PowerShell** 重建（Git Bash 的 `ln -s` 在 Windows 上常退化成建目录而非真 symlink）：
  ```powershell
  Set-Location "D:\project\自动化测试"
  if (Test-Path docs) { Remove-Item -Recurse -Force docs }
  New-Item -ItemType SymbolicLink -Path "D:\project\自动化测试\docs" -Target "D:\Harvey Note\自动化测试平台"
  ```
- 验证：`ls -ld docs` 应显示 `docs -> /d/Harvey Note/自动化测试平台`，且 `git status` 中 `docs` 应为 `?? docs`（被 gitignore 忽略的未跟踪项），而非被跟踪或被删除。
- **绝不要用 `git checkout master -- docs`** 来恢复 symlink——master HEAD 已不含 docs，该命令无效。

## ⚠️ 共享根 node_modules（避免每个 worktree 重复安装）

本仓库所有 worktree 共用同一份依赖是最省事的做法，避免每个 worktree 各自 `npm install` 导致磁盘膨胀与版本漂移。

**推荐配置（项目根 `.npmrc`）**：
```ini
# 让 npm 在 worktree 中向上查找并使用根 node_modules（hoisted 模式）
node-linker=hoisted
```

**做法**：
- 在**主工作树** `d:/project/自动化测试` 执行一次 `npm install`，生成根 `node_modules`。
- 各 worktree 创建后**不单独 `npm install`**；npm 会沿目录树向上找到根 `node_modules`（同一 git 仓库的 worktree 共享 `.git`，依赖解析一致）。
- 仅当根 `node_modules` 缺新依赖（如新增 devDep）时，在主树 `npm install` 一次即可，所有 worktree 立即可用。
- 若某 worktree 内误装了独立 `node_modules`，删除它让其回退到根共享：`rm -rf .codebuddy/worktree/<name>/node_modules`。

**注意**：`node-linker=hoisted` 需写入根 `.npmrc`（已被 `.gitignore` 忽略或纳入版本控制均可，建议纳入版本控制以便团队一致）。不要在每个 worktree 内各放一份 `.npmrc`。
