# CODEBUDDY.md

本文件沉淀本项目的 **开发偏好、工作流与技术栈要求**，作为所有协作（含 Agent / Agent team）遵循的共识基线。

---

## 1 项目简介

面向 **Electron 桌面客户端** 的「可录制、可生成、可润色、可在版本更新后自动执行」的测试/操作自动化平台。
底层用 **CDP** 控制应用，对外以 **Skill + MCP** 提供能力，支持 **Agent 驱动** 与 **脚本回放** 双模式且互通。

- 产品需求：`docs/requirements/requirements.md`
- 技术选型：`docs/architecture/architecture.md`
- M1 设计：`docs/design/design.md`
- 总体实施计划：`docs/plan/plan.md`

---

## 2 技术栈要求

| 维度 | 规定 |
|---|---|
| 主语言 | **TypeScript**（与 Playwright / MCP 生态一致，方案.md 首选） |
| 应用控制 | **CDP + Playwright**（`connectOverCDP` / `_electron`），调试端口默认 `9222` |
| MCP | 自研 MCP Server（M3 接入），Tool 语义对齐 `docs/design/design.md §6` |
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
- **code-review 角色**：审查实现是否符合本文件约定、设计文档、测试要求，以及下列设计质量基线。

**code-review 设计质量基线（除语法/对齐外，必查）**
1. **SOLID**
   - SRP：一个模块只承担一类职责（如执行器管控制流、动作管转发、断言管判定）。
   - OCP：新增步骤类型 / 断言 kind / target 类型时，应尽量扩展而非修改既有核心逻辑。
   - LSP：抽象（如 `CdpAdapter`）的实现可被无差别替换（mock 与真实实现等价）。
   - ISP：接口不应强迫实现方提供用不到的方法。
   - DIP：高层模块（执行器）依赖 `CdpAdapter` 抽象，不依赖具体 Playwright 细节。
2. **GoF 模式恰当性**（参考而非硬套）：适配器（CDP 适配层）、策略（断言 kind 分发）、工厂（adapter 创建）、命令（步骤模型）是否合理运用。
3. **可扩展性 / 适配性**：评估"接入 MCP Tool、新增 Electron 原生降级、多窗口扩展"时的改动面；避免硬编码与脆弱耦合，保证系统稳定可靠、易适配新场景。
4. 偏离设计文档或上述基线时，review 须明确指出并给出改进建议，未解决不得视为通过。

> 详细清单见 `.codebuddy/skills/code-review-standard/SKILL.md`。

**并行拆分原则**
- 子任务之间无强数据依赖 → 并行（各自 worktree + 各自 Agent）。
- 子任务共享同一模块/文件 → 串行或指定单一 Agent 负责，避免冲突。
- 测试代码与实现代码可由同一 Agent 在同一 worktree 内完成，但 test / code-review 校验须由独立角色执行。

---

## 5 核心工程纪律：测试先行

> **在开展任何实现之前，都必须先有对应的测试代码或测试方案。**
> **实现之后以「通过测试」为迭代目标，未通过测试不得视为完成。**

落地方式：
1. 接到实现任务 → 先写/更新 `docs/plan/plan.md` 中该阶段的**测试方案**，或直接在 `test/` 下落地**测试代码骨架**。
2. 实现代码以满足测试为第一目标，反复迭代直至测试通过。
3. 提交时测试须为通过态；CI/本地 `npm test` 全绿才允许合并。

## 5.2 测试命令与执行（固定命令 + 参数控制）

> **核心约束：测试命令本身保持固定不变，用参数/环境变量控制「跑哪些、是否真机」，禁止为不同测试项另起新命令。**

### 固定命令

| 命令 | 作用 | 是否变化 |
|---|---|---|
| `npm test` | 运行全部测试（`vitest run`） | **永远不变** |
| `npm run typecheck` | 类型检查（`tsc --noEmit`） | **永远不变** |

### 用参数控制测试项（命令不变，只加参数）

`npm test` 后加 `--` 把参数透传给 vitest，按文件 / 名称 / 标签筛选：

```bash
# 1) 只跑某个测试文件
npm test -- test/cdp.test.ts

# 2) 按用例名筛选（匹配标题含 "webview" 的 it）
npm test -- -t "webview"

# 3) 跑某目录下全部（vitest 接收目录）
npm test -- test/

# 4) 只看失败（不新增命令，用 vitest 自带参数）
npm test -- --reporter=verbose
```

### 真机集成测试的门控（参数 = 环境变量）

日常 `npm test`（不带环境变量）时，真机用例**自动 skip**：

- `test/integration-codebuddy.test.ts`（靶机：CodeBuddy CN，端口 9222）
- `test/integration-workbuddy.test.ts`（靶机：WorkBuddy，端口 9233）

要触发真机，先启动靶机调试端口，再用环境变量开启（命令本身不变）：

```bash
# 启动靶机调试端口（以管理员运行对应 cmd）
scripts/launch-codebuddy.cmd      # 开启 9222
scripts/launch-workbuddy.cmd      # 开启 9233

# 启用真机后跑（命令仍是 npm test，仅多一个环境变量）
set CODEBUDDY_LIVE=1 && npm test -- test/integration-codebuddy.test.ts
set WORKBUDDY_LIVE=1 && npm test -- test/integration-workbuddy.test.ts
```

### M2 完成后需要你（人工）执行的测试

M2（方案 C：沙箱 webview 可达 + 截图落盘）已合入，但**真机验证必须由你触发**——CI/默认跑不到真机。请按以下顺序人工验证：

1. **CodeBuddy 真机回归**
   - 双击 `scripts/launch-codebuddy.cmd` 拉起 CodeBuddy（端口 9222）。
   - 浏览器打开 `http://localhost:9222/json` 确认目标列表可见。
   - 运行 `set CODEBUDDY_LIVE=1 && npm test -- test/integration-codebuddy.test.ts`。
   - 关注：枚举出 page + webview；`reports/codebuddy-main.png` 已生成且非空白；侧栏 `locateVisual` 可见且在视口内。
2. **WorkBuddy 通用性验证（方案 C 跨应用）**
   - 双击 `scripts/launch-workbuddy.cmd` 拉起 WorkBuddy（端口 9233）。
   - `http://localhost:9233/json` 确认可见。
   - 运行 `set WORKBUDDY_LIVE=1 && npm test -- test/integration-workbuddy.test.ts`。
   - 关注：含 `[role=textbox]` 的 webview 能被定位（证明方案 C 不绑定具体应用）。
3. **人工核对截图产物**
   - 打开 `./reports/*.png` 与 `./reports/*-run-*.md`，对照 `test/fixtures/*-expected.md` 预期契约，确认 UI 表现符合预期。
4. **日常提交前**：直接 `npm test` + `npm run typecheck` 全绿即可，无需真机。

> 以上人工步骤无法通过默认 `npm test` 自动覆盖，是 M2 完成后的必做验证项；未做真机验证不得视为 M2 已"端到端验证通过"。

## 5.1 架构方案同步（强制）

> **当实现影响了既有架构、或新增/变更了架构方案（如新增 Target 类型、引入新的传输层/协议、改变模块职责边界、新增 Adapter/工厂分支等）时，必须同步更新 `docs/architecture/architecture.md`（技术选型与架构方案）。**

理由：
- `docs/architecture/architecture.md` 是架构决策的单一真相源，下游（MCP Tool 接入、Agent 驱动、回放脚本、新成员 onboarding）都依赖它与代码保持一致。
- 架构漂移（代码已改、文档未动）会让后续任务基于错误前提设计，代价远高于同步成本。

落地方式：
1. 实现涉及架构变更 → 在实现/合并前或同时，更新 `docs/architecture/architecture.md` 对应章节（新增小节或修订图示/职责表）。
2. 若变更较大，同步在 `docs/design/design.md` 或 `docs/design/` 下补设计说明（如已落地 `docs/design/m2-webview-cdp.md` 模式）。
3. code-review 角色须检查：本次改动若触及架构，是否已有对应 `docs/architecture/architecture.md` 更新；缺失则 review 不通过。

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
| 测试命令 | 固定 `npm test`（全量）/ `npm run typecheck`；用 `--` 参数或 `CODEBUDDY_LIVE`/`WORKBUDDY_LIVE` 环境变量控制测试项（命令不变） |
| 完成标准 | 测试通过 + code-review 通过 |
| 架构同步 | 影响/新增架构方案时须同步 `docs/architecture/architecture.md`（见 §5.1） |
| 并行 | 多 Agent/team + 每任务带 test & review 角色 |
| 架构同步 | 影响/新增架构方案时须同步 `docs/architecture/architecture.md`（见 §5.1） |
| 纪律归属 | 统一在 CODEBUDDY.md（CLI 不读 `.codebuddy/rules/`） |
| 沉淀 | 重复任务→skills（`.codebuddy/skills/`），偏好/纪律→本文件 |
