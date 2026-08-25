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

**强制要求**：完成任何任务，都必须经过三个校验角色（缺一不可，顺序可并行）：
- **test 角色**：确认对应测试方案/测试代码存在且通过（见 §5）。
- **code-review 角色**：审查实现是否符合本文件约定、设计文档、测试要求，以及下列设计质量基线；**并须做「产品符合度审查」**（见下方），逐条比对 spec 交互验收清单，而非只看代码质量。
- **可运行性审查（Runtime-Runnability Review）角色**：专盯"编译/单测全绿、但真实运行路径会崩"的盲区（详见 §4.1）。**只要有代码修改，就必须运行本角色**，不可跳过。

**产品符合度审查（Product-Conformance Review，code-review 角色必做子项）**
> 设立动机（血泪教训）：本项目 M3 可视化蒙版曾"编译全绿、单测全绿、演示页能渲染"，但用户打开后**功能零可用**——根因是"设计文档只写模块职责、没写组件级交互；测试只覆盖纯函数、不覆盖用户路径；review 只查代码质量、不查产品符合度"。三层各自合格，叠加却产出不可用产品。

**强制规则**：凡是实现**用户可见功能**（UI / Agent 交互 / 脚本回放入口）的任务，code-review 角色除既有设计质量基线外，还须：
1. 依据 `docs/design/visual-mask-ui-spec.md` §2.x（或对应功能 spec）的**交互逻辑**列，逐条生成**交互验收清单**（如："插入步骤仅暴露 wait/waitUntil/assert/repeat 4 类"、"选中步点编辑出现真实表单而非 alert"）。
2. 核对实现是否逐条满足清单；任一条不满足 → review 不通过（即使代码质量达标）。
3. UI 功能（见 §4.1 端到端门槛）：除单测外，必须有 jsdom 驱动 `app.boot()` + 模拟 `[data-action]` 点击的 e2e 测试，证明**用户主链路**（插入→编辑→建组→运行→失败标红）真实跑通，禁止只信"内部 API 直调返回正确"的 Mock 单测。

> 验收清单随 PR 一并提交，存于对应 worktree 或 `docs/plan/plan.md` 测试方案节，作为 review 的对照基线。

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

### 4.1 可运行性审查角色（Runtime-Runnability Review）

**身份定位**：独立于实现者与 code-review 的第三校验角色。**三重职责**：
1. **可运行性**：专门捕获"编译通过、单测全绿、但真实运行路径会崩"的盲区（见下方清单 1–4）。
2. **代码质量**：在可运行性确认通过后，补做代码质量审查（命名/重复/可读性/明显坏味道/**注释规范 §4.2**），但不与 code-review 角色重复架构级判定，聚焦"是否引入新的低效/脆弱写法"。注释若只写需求/设计编号而不写行为描述，视为坏味道，须要求实现者改写（见 §4.2）。
3. **运行效率与算法复杂度**：负责定位并优化运行效率瓶颈与算法时间复杂度（如 O(n²)→O(n)、冗余遍历、重复序列化、不必要的全量重渲染），**但性能优化必须先有测试守住功能不变，再动手优化**（见下方"性能优化纪律"）。

> 本角色与 code-review **互补不替代**：code-review 看"设计对不对/是否符合 SOLID 与设计文档"，本角色看"真实跑不跑得通 + 跑得够不够快/代码有无低效坏味道"。

**设立动机（血泪教训）**：本项目的 M3 可视化蒙版曾出现 `screenshot` 经 WebSocket 桥调用时崩溃——
根因是 `JSON.stringify` 把 `undefined` 参数序列化为 `null`，导致服务端函数的默认参数 `= {}` 失效，
`null.target` 直接抛错。该 bug **`tsc` 不报错、`vitest` 单测（MockKernel 不走 WS）全绿、`verify` 脚本（走 `args:[]` 不触发 `null`）也通过**，
仅在"浏览器 WsKernel 经真实 WS 传 `undefined`"时才暴露。编译与单测对此天然不可见，必须由一个独立角色在真实/近真实环境做端到端冒烟。

**强制触发条件（只要有代码修改就必须运行，不可跳过）**
- 任何 worktree 内的实现提交前；
- 任何涉及跨进程/跨网络调用、序列化、边界参数（null/undefined/空集合）、真实硬件或浏览器/Electron 调试端口的改动；
- 即使"只改了一行"也必须跑——本次 `opts.x` 漏改一处的崩溃即是例证。

**审查清单（必查，命中任一项即视为不通过）**
1. **跨进程/跨语言边界**：JSON-RPC / WebSocket / CDP 调用中，参数经 `JSON.stringify` 后 `undefined`→`null`、
   `Buffer`→`{type:'Buffer',data}` 等变形是否被正确处理（服务端函数体内用 `x = x ?? {}` 兜底，而非依赖默认参数）。
2. **边界参数冒烟**：对每个对外方法，验证 `null` / `undefined` / `''` / `[]` / 超大值是否真的被函数消纳，而非读到 `.target`/`.element` 等属性崩溃。
3. **真实路径不等于测试路径**：若单测用 Mock 实现，必须额外确认"真实实现（如 `PlaywrightCdpAdapter`、浏览器 `WsKernel`）"在
   真实/近真实环境（真机端口、浏览器 WS、Electron 调试端口）下能跑通一次端到端冒烟，不能只信 Mock。
4. **端到端冒烟证据**：UI / Agent / 脚本入口必须在目标真实环境启动一次并确认主链路无异常（如 M3 的 `?live=1` 截图流真实出图），
   而非仅依赖单元断言"有返回就算过"。

**UI 端到端主链路冒烟（专防"功能零可用"，强制门槛）**
> 动机：M3 可视化蒙版曾"渲染能出、单测全绿"，用户打开却**无任何功能可用、流程跑不通**。根因是测试只覆盖纯函数/内部 API 直调，不覆盖"用户经 `[data-action]` 按钮点击的真实路径"。

UI 改动（含新增/修改任何用户可见交互）**必须**满足：
1. 有 jsdom 环境驱动的 e2e 测试：真实调用 `app.boot()`（或等价入口）→ 用 `dispatchEvent` 模拟用户点击渲染出的 `[data-action]` 按钮 → 断言**用户主链路**端到端跑通：
   - 插入（`wait`/`waitUntil`/`assert`/`repeat` 4 类，非法类被拒）；
   - 选中步 → 编辑区真实表单 → 保存 → `getScript()` 该步不可变更新；
   - 多选步 → 包成 if/while 组 → CFG 视图出现对应分支/回环边；
   - 运行全部失败 → 该步标红 + 提醒条。
2. 禁止只用"内部 API 直调"（如直接 `shell.insertStep`）冒充用户路径测试——必须走 DOM 事件委托入口。
3. 复用固定命令（§5）：`npm test -- test/ui-core-e2e.test.ts`（命令不变，仅加参数）。

**失败处理**
- 不通过 → 打回实现者修复，修复后重新跑本角色，直到真实路径冒烟通过。
- 本角色与 code-review 互不替代：code-review 看"设计对不对"，可运行性审查看"真实跑不跑得通 + 跑得够不够快"。

**性能优化纪律（先保功能，再提速度）**
- 任何运行效率 / 算法复杂度的优化，**第一步必须先写/补测试**，断言"优化前后功能行为完全一致"（同输入同输出、同副作用）。
- 测试通过后才动手优化；优化后**重跑该测试 + 可运行性冒烟**，确认既不变功能、又不引入真实路径崩溃。
- 禁止为性能而牺牲可运行性清单 1–4 的边界安全（如为省一次遍历而去掉 `null ?? {}` 兜底）。
- 优化须可量化：用注释/报告标注优化前后的复杂度或实测耗时对比（如 `O(n²)·|steps|² → O(n)`）。

**代码质量 / 运行效率审查清单（在可运行性通过后追加）**
5. **明显坏味道**：重复代码块、超长函数、误导性命名、裸 `any` 滥用、魔法数字。
6. **算法时间复杂度**：对步骤数/元素数相关的循环，标注复杂度；发现嵌套遍历无必要则要求改为 hash 索引 / 单次遍历。
7. **运行效率瓶颈**：重复 RPC/序列化、每帧全量重渲染、未复用连接/句柄、O(n) 查询在循环内反复执行。
8. **优化前置证据**：凡提出"应优化"，须先确认已有对应测试守住功能；无测试则先补测试再评。

**落地载体**：技能文档 `.codebuddy/skills/runtime-runnability-review/SKILL.md`（含具体检查脚本与真机冒烟步骤）。

**并行拆分原则**
- 子任务之间无强数据依赖 → 并行（各自 worktree + 各自 Agent）。
- 子任务共享同一模块/文件 → 串行或指定单一 Agent 负责，避免冲突。
- 测试代码与实现代码可由同一 Agent 在同一 worktree 内完成，但 test / code-review 校验须由独立角色执行。

### 4.2 代码注释规范（可运行性审查角色须一并检查）

> **注释必须直接说明「这段代码在做什么 / 为什么这样写」，而不是写需求或设计文档的编号。**

理由：需求/设计文档会演进、会重构、会重新编号；把 `M3-R4`、`design.md §5` 这类编号当注释主体，
读者看到注释时仍要去翻文档才知道代码意图，注释失去自解释价值，且文档一改编号就全部失效。
注释应让人在**不离开代码**的情况下理解行为。

**强制规则**
1. 每条对外函数 / 非平凡的模块顶部注释，**第一句必须是行为描述**（这段代码做什么、为什么），
   而非「依据 design.md §X」「M3-R5 实现」这类编号引述。
2. 设计/架构文档的章节引用**只允许作为辅助上下文**（补充说明「更完整的设计见 §X」），
   且必须放在行为描述之后，不得取代行为描述。
3. 禁止把需求跟踪编号当作注释的唯一内容。例如：
   - ❌ `// M3-R4 CFG 图形化视图` 作为函数唯一说明
   - ❌ `// 设计依据：docs/design/design.md §5`
   - ✅ `// 构建控制流图模型：把 Script 递归转为节点+边（与 DOM 解耦，便于单测）。`
   - ✅ `// 校验 control.kind 合法性（边界门槛，与桥边界 assertRunnableScript 对等）。详见 architecture.md §2.2`。
4. 解释「为什么」优先于解释「是什么」：改过的历史坑、跨 WS 序列化陷阱、不可变约束的动因等
   是高质量注释；单纯复述代码语句（如 `// 循环遍历 steps`）是低价值注释，应省略。

**落地**
- 可运行性审查角色（§4.1）在代码质量审查中，**必须检查注释是否违反本规范**；
  发现「只写编号、不写行为」的注释，要求实现者改为「行为描述 + 可选文档引用」格式。
- 既有代码中已存在的「编号式」注释（如 `src/types/step.ts:1`、`src/script/io.ts:1` 等），
  在后续触碰该文件时顺手改写为规范格式，不要求一次性全量清理。

---

## 5 核心工程纪律：测试先行

> **在开展任何实现之前，都必须先有对应的测试代码或测试方案。**
> **实现之后以「通过测试」为迭代目标，未通过测试不得视为完成。**

落地方式：
1. 接到实现任务 → 先写/更新 `docs/plan/plan.md` 中该阶段的**测试方案**，或直接在 `test/` 下落地**测试代码骨架**。
2. 实现代码以满足测试为第一目标，反复迭代直至测试通过。
3. 提交时测试须为通过态；CI/本地 `npm test` 全绿才允许合并。

## 5.1 测试命令与执行（固定命令 + 参数控制）

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



### 5.2 架构方案同步（强制）

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
| 注释规范 | 注释直接说明「做什么/为什么」，禁止只写需求/设计编号（见 §4.2）；可运行性审查须查 |
| 产品符合度审查 | UI/交互任务须逐条比对 spec §2.x 交互验收清单（见 §4）；code-review 角色必做 |
| UI 端到端验收 | UI 改动须 `npm test -- test/ui-core-e2e.test.ts`（jsdom 跑 app.boot + 模拟 [data-action] 点击，主链路真实跑通，见 §4.1） |
| 纪律归属 | 统一在 CODEBUDDY.md（CLI 不读 `.codebuddy/rules/`） |
| 沉淀 | 重复任务→skills（`.codebuddy/skills/`），偏好/纪律→本文件 |
