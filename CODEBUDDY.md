# CODEBUDDY.md

本文件沉淀本项目的 **开发偏好、工作流与技术栈要求**，作为所有协作（含 Agent / Agent team）遵循的共识基线。

---

## 1 项目简介

面向 **Electron 桌面客户端** 的「可录制、可生成、可润色、可在版本更新后自动执行」的测试/操作自动化平台。
底层用 **CDP** 控制应用，对外以 **Skill + MCP** 提供能力，支持 **Agent 驱动** 与 **脚本回放** 双模式且互通。

- 产品需求：`docs/需求.md`
- 技术选型：`docs/方案.md`
- M1 设计：`docs/设计文档.md`
- 总体实施计划：`docs/实施计划.md`

---

## 2 技术栈要求

| 维度 | 规定 |
|---|---|
| 主语言 | **TypeScript**（与 Playwright / MCP 生态一致，方案.md 首选） |
| 应用控制 | **CDP + Playwright**（`connectOverCDP` / `_electron`），调试端口默认 `9222` |
| MCP | 自研 MCP Server（M3 接入），Tool 语义对齐 `docs/设计文档.md §6` |
| 测试 | 单测用 `vitest`；集成/端到端用 Playwright Test 或自研执行器驱动真实/示例 Electron App |
| 包管理 | `npm`（或 `pnpm`，二者择一，默认 npm） |
| 运行时 | Node.js 18+ |

> 禁止在未达成共识时擅自切换主栈。如需变更，先更新本文件并经确认。

---

## 3 工作流（Git Worktree）

**本地必须维护 git 仓库**，采用 **git worktree** 隔离并行工作，避免在主工作树里来回切分支。

- 主工作树：当前 `d:/project/自动化测试`（分支 `master`），用于 `/init` 与总控。
- 工作树存放目录：`./.codebuddy/worktree/`（`git worktree add` 创建，已被 `.gitignore` 忽略）。

**标准动作**

```bash
# 1) 从 master 拉出新工作树（功能/修复）
git worktree add -b feat/m1-cdp .codebuddy/worktree/m1-cdp master

# 2) 在该工作树目录里开发、自测、提交
cd .codebuddy/worktree/m1-cdp
# ... 编码 + 跑测试 ...

# 3) 完成并回归通过后，回主树合并，再清理
cd /d/project/自动化测试
git merge feat/m1-cdp
git worktree remove .codebuddy/worktree/m1-cdp
```

**规则**
- 任何实现任务都应在独立 worktree 中进行，禁止直接在主工作树长期开发。
- 主工作树保持可编译/可测试基线；合并前工作树必须通过测试与 code-review。
- 并行任务 → 各自一个 worktree（见 §4）。

> 当前工作区执行一次 `/init` 以完成 CodeBuddy 对项目上下文的初始化（在 master 上）。

---

## 4 协作模式：多 Agent / Agent Team + 校验角色

当需求存在 **可并行执行** 的子任务时，采用 **多 Agent** 或 **Agent team** 并行推进。

**强制要求**：完成任何任务，都必须经过两个校验角色：
- **test 角色**：确认对应测试方案/测试代码存在且通过（见 §5）。
- **code-review 角色**：审查实现是否符合本文件约定、设计文档与测试要求。

**并行拆分原则**
- 子任务之间无强数据依赖 → 并行（各自 worktree + 各自 Agent）。
- 子任务共享同一模块/文件 → 串行或指定单一 Agent 负责，避免冲突。
- 测试代码与实现代码可由同一 Agent 在同一 worktree 内完成，但 test / code-review 校验须由独立角色执行。

---

## 5 核心工程纪律：测试先行

> **在开展任何实现之前，都必须先有对应的测试代码或测试方案。**
> **实现之后以「通过测试」为迭代目标，未通过测试不得视为完成。**

落地方式：
1. 接到实现任务 → 先写/更新 `docs/实施计划.md` 中该阶段的**测试方案**，或直接在 `test/` 下落地**测试代码骨架**。
2. 实现代码以满足测试为第一目标，反复迭代直至测试通过。
3. 提交时测试须为通过态；CI/本地 `npm test` 全绿才允许合并。

---

## 6 纪律与规则的单一真相源

> **CLI 模式不加载 `.codebuddy/rules/`。** 因此所有工作流与纪律性约束（worktree、测试先行、并行协作校验、知识沉淀）**统一在本 CODEBUDDY.md 维护**，不另设 `.codebuddy/rules/`，避免双源漂移。
> 本文件各节即"规则"：§3 工作流规则、§4 协作校验规则、§5 测试先行规则。

---

## 7 知识沉淀：skills

- 重复要执行的任务、特定任务开发要求 → 总结为 **`.codebuddy/skills/`** 下的技能文档（如 `worktree-dev`、`test-first-dev`）。
- skills 文档用 frontmatter（`name`/`description`/`type`）标注，便于索引；任何新沉淀都要可被后续 Agent 直接读取复用。
- 当某技能过时，及时更新或删除，保持知识库有效。

---

## 8 约定速查

| 主题 | 规定 |
|---|---|
| 主栈 | TypeScript + Playwright CDP |
| 仓库 | git，worktree 在 `.codebuddy/worktree` |
| 实现顺序 | 先测试（方案/代码）→ 再实现 → 过测试 |
| 完成标准 | 测试通过 + code-review 通过 |
| 并行 | 多 Agent/team + 每任务带 test & review 角色 |
| 纪律归属 | 统一在 CODEBUDDY.md（CLI 不读 `.codebuddy/rules/`） |
| 沉淀 | 重复任务→skills（`.codebuddy/skills/`），偏好/纪律→本文件 |
