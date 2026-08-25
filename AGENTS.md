# AGENTS.md

本文件是 Cursor Agent 的项目共识基线（由原 `CODEBUDDY.md` 迁入）。详细清单在 `.cursor/skills/`，短约束在 `.cursor/rules/`。

产品需求：`docs/requirements/requirements.md`  
技术选型：`docs/architecture/architecture.md`  
M1 设计：`docs/design/design.md`  
M3 UI 规格：`docs/design/visual-mask-ui-spec.md`  
实施计划：`docs/plan/plan.md`

---

## 1 项目简介

面向 **Electron 桌面客户端** 的测试/操作自动化平台：底层用 **CDP** 控制应用，对外以 **Skill + MCP** 提供能力，支持 **Agent 驱动** 与 **脚本回放** 双模式且互通。

当前代码停在 **M3 可视化 UI 壳**。已知实现与需求/规格有大量偏差，**在用户整理完功能元素与操作逻辑之前，不要改 M3 业务代码，也不要开始封装 MCP Server。**

后续方向（先记在这里，等需求冻结再做）：

- 封装为**本地 MCP Server**，给任意 Electron 桌面应用生成测试脚本。
- Agent 可扫描页面、分析功能点、设计脚本；用户可导入/编辑脚本，或自己设计脚本。
- 能力全部做成 MCP Tool，再配 Skill 指导 Agent，最后打成插件。
- 真机靶机：CodeBuddy / WorkBuddy / **VS Code**（本机通用 Electron 靶机，见 `scripts/launch-vscode.cmd`）。

---

## 2 技术栈

| 维度 | 规定 |
|---|---|
| 主语言 | TypeScript |
| 应用控制 | CDP + Playwright（`connectOverCDP`），调试端口可配置，默认 `9222` |
| MCP | 自研 MCP Server（计划 M4），Tool 语义对齐 `docs/design/design.md` §6 |
| 测试 | 单测 `vitest`；真机集成用环境变量门控 |
| 包管理 | npm |
| 运行时 | Node.js 18+ |

禁止未达成共识就换主栈。

---

## 3 Git Worktree

实现任务在独立 git worktree 里做，不要在主工作树长期开发。

- 主工作树：`C:\Users\20443\Desktop\Auto-Test-Generation`（分支 `master`）
- 工作树目录：`.cursor/worktree/`（已被 gitignore）
- 不要和 Cursor 产品自己的 `~/.cursor/worktrees` 混用

```bash
git worktree add -b feat/<name> .cursor/worktree/<name> master
```

合并用非交互写法。**不要自动删除 worktree / 分支**，等用户明确要求再清理。Windows 上 `git worktree remove` 容易撞文件锁，见 skill `worktree-dev`。

主树只做 `/init` 与合并后的可编译基线。各 worktree 共用根目录 `node_modules`（`.npmrc` 已设 `node-linker=hoisted`），不要在 worktree 里再装一份。

---

## 4 三个校验角色（有代码改动就必须跑）

| 角色 | Skill | 看什么 |
|---|---|---|
| test | `test-first-dev` | 先有测试，再实现；`npm test` / `npm run typecheck` 通过 |
| code-review | `code-review-standard` | 设计/SOLID/架构文档同步；**用户可见功能必须做产品符合度审查** |
| runtime-runnability | `runtime-runnability-review` | 真实路径会崩的盲区 + 跨边界 undefined→null；接口/功能不变前提下的执行性能与时间/空间复杂度审查（优化须先有测试守住功能） |

产品符合度：对照 `docs/design/visual-mask-ui-spec.md` §2.x 交互逻辑逐条验收，不要只看代码质量。UI 主链路必须走 jsdom 里 `app.boot()` + 模拟 `[data-action]` 点击（`npm test -- test/ui-core-e2e.test.ts`），禁止只用内部 API 直调冒充用户路径。

注释必须写「这段代码做什么 / 为什么」，禁止只写需求/设计编号。

### 4.1 从需求到代码的方法论（`spec-driven-impl`）

接到功能/修复任务、需要从需求产出设计与实施计划时，走 `spec-driven-impl` 链路：需求冻结 → **时序对齐**（可动手的标志是执行时序对齐，不是功能清单对齐）→ 差距分析（A 缺陷 / B 计划 / C 决策点）→ 决策点确认（schema/协议变更必须显式问用户，不默默改）→ 测试先行 → 三方一致 → 边界兜底。详见 skill `spec-driven-impl`。Windows/编码环境坑（终端乱码、`Select-String` 截断、PS 不支持 `&&`、fnm symlink 噪音）见 `.cursor/rules/engineering.mdc`。

---

## 5 测试先行

接到实现任务 → 先写/更新 `docs/plan/plan.md` 测试方案或 `test/` 骨架 → 实现以满足测试为目标 → 全绿才算完成。

固定命令（命令本身不变，只加参数/环境变量）：

| 命令 | 作用 |
|---|---|
| `npm test` | `vitest run` |
| `npm run typecheck` | `tsc --noEmit` |

```bash
npm test -- test/cdp.test.ts
npm test -- -t "webview"

scripts/launch-codebuddy.cmd
scripts/launch-workbuddy.cmd
scripts/launch-vscode.cmd

set CODEBUDDY_LIVE=1 && npm test -- test/integration-codebuddy.test.ts
set WORKBUDDY_LIVE=1 && npm test -- test/integration-workbuddy.test.ts
set VSCODE_LIVE=1 && npm test -- test/integration-vscode.test.ts
```

`VSCODE_LIVE` 对应的集成测试文件尚未落地；当前先用 `http://localhost:9244/json` 验证调试端口。无环境变量时真机用例必须 skip。

架构有变时同步 `docs/architecture/architecture.md`。缺文档更新则 code-review 不通过。

---

## 6 配置对照（CodeBuddy → Cursor）

| 原 CodeBuddy | 现在 Cursor |
|---|---|
| `CODEBUDDY.md` | 本文件 `AGENTS.md` |
| `.codebuddy/skills/` | `.cursor/skills/` |
| `.codebuddy/agents/` | 并入对应 skill（Cursor 按 skill 触发角色） |
| `.codebuddy/settings.json` | Cursor 权限模型不同，不迁移 allow/deny 列表 |
| `.codebuddy/worktree/` | `.cursor/worktree/` |
| `.codebuddy/rules/`（CLI 不加载） | `.cursor/rules/`（会加载，只放短约束） |

原 `.codebuddy/` 保留作归档，运行时以本文件和 `.cursor/` 为准。
