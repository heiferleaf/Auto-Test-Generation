# 总体实施计划

> 配套：`requirements/requirements.md`、`architecture/architecture.md`、`design/design.md`、`CODEBUDDY.md`
> 纪律基线：任何实现前先有测试方案/测试代码；实现后以通过测试为迭代目标（详见 CODEBUDDY.md §5）。

---

## 0 工程纪律（贯穿所有阶段）

1. **测试先行**：每阶段/每任务动手前，先确定测试方案或在 `test/` 落地测试骨架。
2. **通过测试才算完成**：实现以让测试通过为第一目标，未通过不得合并。
3. **Worktree 隔离**：每个实现任务在 `.codebuddy/worktree/<name>` 独立工作树进行（CODEBUDDY.md §3）。
4. **双角色校验**：每个任务完成须过 **test 角色** 与 **code-review 角色**（CODEBUDDY.md §4）。
5. **并行用 Agent team**：可并行子任务用多 Agent / Agent team，各自 worktree + 各自校验。
6. **知识沉淀**：重复/有要求的任务总结进 `.codebuddy/skills`（技能文档）；工作流/纪律类约束统一维护在 `CODEBUDDY.md`（CLI 不加载 `.codebuddy/rules/`）。

---

## 阶段总览（对标architecture/architecture.md §4，已按计划调整优先级）

> **2026-08-21 调整**：可视化能力层（截图/视觉断言/叠加蒙版手动触发）与真实靶机接入（CodeBuddy / WorkBuddy）
> 提升为 **P0**，前移至 M2。原因：无可视化则只能做代码级单测，无法做集成/系统测试（用户明确要求）。
> 被测对象：`CodeBuddy CN` 路径 `C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe`；
> `WorkBuddy` 同类 Electron 应用。两者均可经 exe + `--remote-debugging-port=9222` 启动以开放 CDP。

| 阶段 | 范围 | 测试要求（先于实现） | 验收 |
|---|---|---|---|
| **M1** ✅ | CDP 连接 + 步骤执行器 + 断言 + 脚本导入导出 + CLI + 示例靶机 | 步骤模型单测、执行器/断言测试、脚本 IO、CLI 测试、真实连接冒烟（demo app） | 脚本稳定控目标 App |
| **M2（P0 前移）** ✅ | **可视化能力层** + **真实靶机接入 CodeBuddy/WorkBuddy** | 集成测试（写文件说明预期结果）、截图采集测试、视觉断言测试、多 webview 连接测试、启动脚本验证 | 对 CodeBuddy 真机做集成/系统级测试，界面"看得见" |
| **M3** | **可视化 UI 编辑壳（高内聚组件）**：脚本导入/编辑/录制/导出 + 对目标软件触发并响应 | Recorder 录制采集单测、ScriptEditor 增删改单测、触发编排（复用 runCli）单测 | 脚本可在 UI 壳内闭环管理并被目标软件执行 |
| **M4** | MCP 全量 Tool + 测试向 Skill | MCP Tool 契约测试 | 脚本能力经 MCP 对外暴露 |
| **M5** | Agent 分析生成全覆盖步骤 + Agent 参考已有脚本修改（为版本更新后改脚本做准备） | 轨迹→脚本转换测试、参考脚本改写测试 | 脚本可由 Agent 生成/演化 |
| **M6** | **版本更新检测** + 更新触发 Agent 任务（原"版本监听触发脚本"整体并入，版本相关需求放最后） | 版本检测单测、更新事件→Agent 任务触发端到端 | 版本更新后自动驱动脚本维护 |

---

## M1 详细计划

### M1.1 目标
形成「脚本可稳定控制目标 Electron App」的最小闭环。

### M1.2 范围（P0）
- CDP 连接与 target 枚举/选择
- 步骤执行器（click/fill/select/wait/hover/eval/snapshot）
- 断言引擎（exists/visible/textContains/titleIs/urlMatches/expr）
- 脚本导入/导出/简易编辑
- 示例脚本 `scripts/demo-login.json`

### M1.3 并行拆分（M1 内可并行）
| 子任务 | worktree | 依赖 | 验收角色 |
|---|---|---|---|
| A. 步骤模型 + 脚本 IO | `m1-model` | 无 | test + review |
| B. CDP 适配层 | `m1-cdp` | A（类型） | test + review |
| C. 执行器 + 断言引擎 | `m1-exec` | A、B | test + review |
| D. CLI 入口 + 示例脚本 | `m1-cli` | A、C | test + review |

> A 先产出 `types/step.ts`（稳定契约），B/C/D 并行消费；合并顺序 A → (B∥C) → D。

### M1.4 测试方案（先于实现）
- **A（模型/IO）**：`test/model.test.ts` —— Step/Locator/Assertion 类型合法；`script.io` 导入非法 schema 报错、导出再导入往返一致。
- **B（CDP）**：`test/cdp.test.ts` —— mock CDP 下 connect/listTargets/selectTarget 行为；真实连接用示例 Electron App（debug 端口）做冒烟。
- **C（执行器/断言）**：`test/executor.test.ts` —— 用 mock adapter 驱动一组步骤，断言各 type 调用正确；`test/assert.test.ts` 覆盖各断言 kind。
- **D（CLI）**：`test/cli.test.ts` —— 给定 mock adapter，跑 `demo-login.json` 全流程返回成功；断言失败路径输出结构化错误。

### M1.5 迭代目标
`npm test` 全绿 + 对示例 Electron App 跑通登录主路径即视为 M1 完成。

---

## M2 详细计划（P0 前移：可视化能力层 + 真实靶机接入）

### M2.0 背景与目标
- **为什么前移**：无可视化能力，平台只能做代码级单测（操作 DOM/可访问性树），无法验证"界面看起来对不对"，即做不了集成/系统测试。用户要求提升可视化优先级。
- **被测对象**：`CodeBuddy CN`（`C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe`）、`WorkBuddy`（同类 Electron 应用）。两者经 exe + `--remote-debugging-port=9222` 启动开放 CDP。
- **目标**：打通 单元→集成→系统 测试层级；在真实 IDE 上做到"看得见、可断言、可手动触发"。

### M2.1 范围（P0）
- **可视化能力层**（详见 `docs/可视化测试architecture/architecture.md`）：
  - 截图采集（整窗/指定 webview/指定元素 bounding box）
  - 元素视觉定位（bounding box / 坐标，补 DOM 树之不足）
  - 视觉断言（截图比对 / 多模态大模型判定"看起来对不对"）
  - 叠加蒙版 + 手动触发 UI（在界面上显示步骤序号/可交互框，人工浏览并触发脚本——对应终态"可视化 UI 中手动调用脚本"）
- **真实靶机接入**：以 CodeBuddy 为被测对象，验证多 webview（编辑器/侧栏/终端/AI 面板）连接、步骤执行、截图与视觉断言。
- **启动脚本**：提供 `scripts/launch-codebuddy.cmd`（或 .ps1），以调试端口启动 CodeBuddy 供验证。

### M2.2 测试要求（严格测试先行）
- **集成测试（写文件说明预期结果）**：`test/integration-codebuddy.test.ts`
  - 以文件（`./test/fixtures/codebuddy-expected.md` 或同目录 README）**说明每一步操作的预期结果**（连接成功、窗口枚举含 N 个 webview、某按钮可见、截图非空白、文案包含 X）。
  - 测试本身：启动/连接 CodeBuddy → snapshot → 断言多 webview → 截图 → 视觉断言（截图非空 / 关键元素 bounding box 在视口内）→ 输出结果到报告文件。
  - 真机测试默认 `@slow` / 条件跳过（无 exe 或端口占用时 skip），但**测试代码与"预期结果说明文件"必须先存在**。
- **截图/视觉断言测试**：用 mock adapter 验证截图采集与视觉断言接口；真机部分在集成测试中跑。
- **多 webview 连接测试**：验证 `listTargets` 能区分多个 webview 并 `selectTarget` 切换。
- **启动脚本验证**：提供启动命令，由用户在本地验证 9222 端口是否监听（`http://localhost:9222/json` 返回目标列表即成功）。

### M2.3 验收
- 对 CodeBuddy 真机：连接成功、多 webview 可枚举、能截图、能做视觉断言、能输出"预期结果 vs 实际"报告。
- 叠加蒙版手动触发 UI 有最小可用原型（MVP：控制台列出步骤+高亮元素，非强制应用内重蒙版——见 可视化测试architecture/architecture.md）。
- 集成测试文件含明确的"操作预期结果"说明。

---

## M3 详细计划（可视化 UI 编辑壳）

### M3.0 设计定位
M3 是一个**高内聚组件**：对内管理 Script（导入 / 编辑 / 录制 / 导出），对外通过 `CdpAdapter` 对目标软件触发并响应。
- **录制**是该组件的内置功能之一（非独立模块）：连接态下拦截真实交互 → 生成结构化 `Step`。
- 该组件是 M4/M5 的**底座**：Agent 生成的脚本、Agent 改写的脚本，最终都落到同一个「可导入 / 可编辑 / 可触发」的 Script 对象上（复用 M1 统一步骤模型，schema `electron-auto-test/step/v1`）。
- 复用：导入导出用 `src/script/io.ts`；执行用 `src/executor/executor.ts` + `src/cli.ts#runCli`；步骤类型扩展用 `src/executor/actions.ts` 的策略注册表（OCP）。

### M3.1 范围（P0）
- **Recorder（录制采集器）**：基于 CDP/Playwright 事件捕获交互，转化为 `Step[]`（含 `source:'recorded'`、`target`、语义化 `locator` 优先）。
- **ScriptEditor（脚本编辑操作）**：内存中 Script 的增 / 删 / 改 / 重排；导入 JSON 校验（复用 `importScript`）；导出（复用 `exportScript`）。
- **触发编排**：选脚本 → 连靶机 → `runCli` 执行 → 逐步结果反馈（复用 `runScript`/`runCli`）。
- （图形 UI 为后续子阶段；M3 先交付**可单测的核心逻辑组件**，可视化外壳建立在核心逻辑之上。）

### M3.2 测试方案（先于实现，严格遵守 §5）
- `Recorder` 单测：喂入模拟交互事件序列 → 断言产出的 `Step[]` 字段（type/locator/target/source）与 `types/step.ts` 模型一致；语义化 locator 优先于 css/xpath。
- `ScriptEditor` 单测：插入/删除/修改/移动步骤；非法导入 JSON 抛 `ScriptError`（复用 io 校验）；导出往返一致（import(export(s)) === s）。
- 触发编排单测：用 mock `CdpAdapter` 注入，验证脚本被逐步执行、失败返回 `failedStepId`（复用 M1 cli 测试桩模式）。
- 集成（真机，LIVE 门控）：连接 CodeBuddy → Recorder 捕获一次点击+填充 → 生成的脚本可被 `runCli` 回放成功。
- **M3 集成层（真实录制监听，LIVE 门控）**：
  - `Recordable` 派生接口（ISP）：`startRecording()` / `stopRecording(): InteractionEvent[]`，仅录制能力实现，不强迫所有 adapter。
  - 真实监听：在当前 target 注入 JS（监听 `click`/`input`/`change`/`submit`），经 `exposeFunction` 回传，转 `InteractionEvent`（语义化 locator 优先 aria-label/data-testid/name/textContent）。
  - 集成测试（LIVE）：连 CodeBuddy → `startRecording` → 用 adapter 触发一次 `fill`+`click`（模拟交互）→ `stopRecording` → 断言 `InteractionEvent[]` 非空且能被 `Recorder` 转 `Step` 并经 `runCli` 回放。
  - **边界**：M3 集成层先聚焦主 page（currentTarget）；webview 内录制注入为后续子阶段（方案 C 已证明可达，跨 webview 注入为独立复杂度）。

### M3.3 UI 壳（图形面板）测试方案（先于实现，严格遵守 §5）

> UI 壳是 M3 核心逻辑的可视化外壳：独立面板（控制台样式），中间展示被测软件实时视图（截图流），
> 侧边以用户友好形式展示每一步 step（点击位置/填充文本/其他操作），并支持录制/编辑/回放/高亮。
> 形态：原生 TS + 轻量 DOM（不引框架）；宿主用最小本地 HTTP 服务托管页面（浏览器打开即面板）。
> 复用内核：`PlaywrightCdpAdapter`（connect/listTargets/selectTarget/screenshot/locateVisual/Recordable）、
> `Recorder`、`ScriptEditor`、`runCli`（runScript）。

**单元测试（默认全跑，用 mock 内核，不依赖靶机）**
- `UiShell` 构造与状态：传入 mock adapter/recorder/editor，断言初始渲染出连接区/步骤列表区/录制控制区/回放区四个工作区骨架。
- 连接流程：调用 `shell.connect(port)` → 断言向 adapter 发起 `connect` 且状态切到「已连接」、目标列表渲染。
- 录制流程：`startRecording()` → 断言 adapter `startRecording` 被调、UI 进入录制态；`stopRecording()` → 断言 `Recorder` 产物（InteractionEvent[]→Step[]）进入步骤列表渲染。
- 步骤列表渲染：给定一组 Step，断言列表项正确展示类型/定位/参数（用户友好文本，如「填充：rec-input = 你好」）。
- 编辑操作：调用 `shell.insertStep/removeStep/updateStep/moveStep` → 断言步骤列表 DOM 同步更新、且调用的是 `ScriptEditor` 的不可变操作（原脚本不被改）。
- 回放流程：`runPlayback()` → 断言 `runCli` 被调用；失败返回 `failedStepId` 时，UI 标红对应步骤并展示错误（断言失败步 DOM 带失败态）。
- 高亮：选中步骤 → 调 `locateVisual` 取坐标 → 断言视图层在对应坐标叠加标记（用截图+坐标叠加渲染，断言叠加元素被创建且坐标匹配）。
- 导入/导出：`importScript`/`exportScript` 经 UI 触发 → 断言文件内容正确载入/写出（可用内存桩或临时文件）。

**集成（真机，LIVE 门控）**
- 连 CodeBuddy → 面板「开始录制」→ 在软件真实操作后停止 → 步骤列表出现对应 step → 「回放」成功（复用 M3.2 集成闭环，但经 UI 壳触发而非 CLI）。
- 截图流视图：回放/试跑时中间视图区持续刷新靶机截图（断言截图非空白落盘或返回 Buffer 非空）。

**架构同步（§5.1）**：UI 壳新增 `src/ui/` 目录（UiShell 组件 + 宿主 serve 入口），属新增模块边界，需在 `architecture.md` 补「UI 壳」小节（组件职责、与内核依赖方向）。

---

## M4 详细计划（MCP 全量 Tool + Skill）

### M4.1 范围
- 自研 MCP Server 全量：connect/listTargets/snapshot/execute_steps/record/import/export/update_step/assert
- 测试向 Skill（如何快照/导出/修复）

### M4.2 测试方案（先于实现）
- MCP Tool 契约测试：每个 Tool 的输入输出与执行器对齐。
- record Tool 复用 M3 的 Recorder；update_step 复用 M3 的 ScriptEditor。

---

## M5 详细计划（Agent 生成与改写脚本）

### M5.1 范围
- Agent 分析目标软件，生成覆盖所有操作的步骤（对应 M3 同一步骤模型）
- Agent 参考一个已有脚本做修改（为 M6 版本更新后改脚本做准备）

### M5.2 测试方案（先于实现）
- 轨迹→脚本转换测试：Agent 轨迹可无损转 Script 且可回放（复用 M3 模型）。
- 参考脚本改写测试：给定基线脚本 + 修改意图，产出等价新脚本且可回放。

---

## M6 详细计划（版本检测 + 更新触发 Agent）

### M6.1 范围
- 版本更新检测：读 exe 版本 / 应用自有 version 文件 / 进程重启检测 + 防抖 + 「更新完成」判定
- 更新触发 Agent 任务（任务模板 ID 绑定；消费 M5 的「参考脚本改写」能力）
- （原"版本监听触发脚本"整体并入此处，版本相关需求放最后实现）

### M6.2 测试方案（先于实现）
- 版本检测单测：exe 版本读取、version 文件解析、进程重启判定、防抖窗口。
- 触发端到端：注入版本变更事件 → 验证 Agent 任务被触发且绑定基线脚本/版本号。

---

## 风险与对策（继承architecture/architecture.md §5）

| 风险 | 应对 |
|---|---|
| 正式包关闭 remote debugging | 仅支持调试可达包；错误明确提示测试通道/启动参数 |
| 多窗口/webview | 步骤带 target；适配器 listTargets/selectTarget |
| 定位脆 | 优先语义化 locator；失败提示降级 css/xpath |
| 并行冲突 | 按 §M1.3 拆分，共享模块单一 Agent 负责 |
| 过度承诺 AI 覆盖 | 仅做结构快照，业务完整性靠断言与人工抽检 |

---

## M3 重做实施计划（嵌入实时生成 + CFG + Git 版本）

> 基于 `docs/design/visual-mask-ui-spec.md` 与 `architecture.md §2.2/§2.3`。
> 纪律：每个子任务在独立 worktree；先测试骨架再实现；过 test + code-review + runtime-runnability-review 三角色。

#### 进度总览（每阶段开工/完成时必须同步本表 — CODEBUDDY.md §5 测试先行 + 计划维护）

| 阶段 | 状态 | worktree | 合并提交 | 测试证据 |
|---|---|---|---|---|
| M3-R0 CFG 步骤模型 | ✅ 已合并 | `feat/cfg-step-model` | `00895da` | `test/cfg-step.test.ts` 9 通过 |
| M3-R1 WS 推送通道 | ✅ 已合并 | `feat/ws-push-channel` | `bc13d86` | `test/bridge-push.test.ts` 6 通过 |
| M3-R2 嵌入实时录制 | ✅ 已合并 | `feat/ws-push-channel` | `a654faa` | `test/ui-shell-live-recording.test.ts` 4 通过 |
| M3-R3 运行全部 + 步骤态 + 高亮跟随 | ⏳ 进行中 | `feat/run-all` | — | 测试先写中 |
| M3-R4 CFG 图形化视图 | ⬜ 未开始 | `feat/cfg-view` | — | — |
| M3-R5 Git 式版本层 | ⬜ 未开始 | `feat/git-version` | — | — |

> **测试代码权威性纪律（新增，因本轮违规而补）**：既有测试文件（含其 mock 基建，如 `test/ui-shell.test.ts` 的 `makeMockKernel`）**不得为迁就新实现而修改**。新能力需要新的 mock 行为时，新建独立测试文件并自带 mock，不动既有基建。

### 阶段 M3-R0：CFG 步骤模型（内核，无 UI）— ✅ 已完成
- **worktree**：`feat/cfg-step-model`
- **测试先行**：`test/cfg-step.test.ts` 覆盖 `Step` 递归 children、control 三种、v2 schema IO 往返、v1 扁平兼容导入。
- **实现**：`src/types/step.ts` 加 `children?`/`control?` + `SCRIPT_SCHEMA_V2`；`src/script/io.ts` 兼容 v1；`src/executor/executor.ts` 加递归 `runNode`（sequence/if/while），复用 `runStep`；`actions.ts`/`assert.ts` 不动。
- **校验**：`npm test` + `npm run typecheck` + code-review（SOLID/OCP）+ runtime-runnability（executor 无 WS 边界，重点单测三控制流）。

### 阶段 M3-R1：WS 桥主动推送通道（基础设施）— ✅ 已完成
- **worktree**：`feat/ws-push-channel`
- **测试先行**：`test/bridge-push.test.ts` 用真 `WebSocket` 模拟：服务端主动推 event → 客户端 `onEvent` 收到；并对 `wait` 等方法传 `null` 入参断言桥端 `?? {}` 兜底不崩。
- **实现**：`bridge-server.ts` 增加 event/push 消息类型（非 req/res）；`ws-kernel.ts` 的 `onmessage` 加 event 分支并暴露订阅；反射转发 `fn.apply` 前对 `req.args` 逐项 `?? {}`（覆盖 `wait` 等未兜底方法）。
- **校验**：runtime-runnability 强制真机冒烟（`verify-ui-live.mjs` 扩展推流路径）。

### 阶段 M3-R2：嵌入实时录制（边操作边长步骤）— ✅ 已完成
- **worktree**：`feat/ws-push-channel`（与 R1 同树，因共享桥协议文件，避免并行冲突）
- **测试先行**：**新建** `test/ui-shell-live-recording.test.ts`（`// @vitest-environment jsdom` + 自带 mock kernel，不改 `ui-shell.test.ts` 的 `makeMockKernel`）——录制中每收到 `onEvent` 即断言 `script.steps` 实时 +1、DOM 增量追加、重复事件去重、未订阅时不插入。
- **实现落点**：`shell.ts` 增 `onRecordingEvent`/`appendStepEl`/`buildStepItem`（增量 DOM，非全量 render）+ `recordedKeys` 内容指纹去重；`recorder.ts` 抽 `toSingleStep`。
- **踩坑记录**：去重最初用 `step.id` 失败——实时推送路径与 `stopRecording()` 返回路径对**同一次交互**各自生成不同 id，必须改用内容指纹（type/locator/params/target）。
- **实现**：`shell.ts` 增 `appendStep(ev)` 增量路径（录制中每事件 `ScriptEditor.insert` + 增量 DOM 更新，非全量 render）；`bridge-server.ts`/`ws-kernel.ts` 复用 R1 推送把录制事件流下发；`app.ts` 录制开关默认边录边显。
- **校验**：runtime-runnability 真机冒烟（真实靶机操作→列表实时增长）；高频重渲染优化（增量更新，CODEBUDDY.md §4.1 清单 7）。

### 阶段 M3-R3：运行全部 + 步骤态 + 高亮跟随（P1）— ⏳ 进行中
- **worktree**：`feat/run-all`
- **测试先行**：**新建** `test/ui-shell-run-all.test.ts`（jsdom + 自带 mock kernel，不动既有基建），断言：逐步 `status` 流转 pending→running→pass、失败步标 fail 且后续不再执行、失败提醒可见、running 步自动高亮且上一步高亮清除、`playback` 无 `onStepResult` 时兼容旧行为。
- **实现**：操作栏加"运行全部"按钮；`Step` 加运行时 `status: pending|running|pass|fail`；`render` 据态加 class；高亮自动跟随当前步（P1）；`playback` 签名扩展流式但兼容旧。
- **校验**：runtime-runnability 真机跑"运行全部"闭环 + 中途失败提醒。

### 阶段 M3-R4：CFG 图形化视图（§2.7）
- **worktree**：`feat/cfg-view`
- **测试先行**：`test/cfg-view.test.ts` 用 mock `Script`（含 if/while 嵌套）断言图节点/边/高亮联动生成正确。
- **实现**：新 `src/ui/cfg-view.ts`（SRP）从 `Script` 构建控制流图（顺序竖向、选择分叉、循环回环）；与步骤列表双向联动；`index.html` 加 `.ui-shell-cfg` 区。
- **校验**：code-review 查 SRP/ISP；runtime-runnability 真机渲染无崩。

### 阶段 M3-R5：Git 式版本层（§2.2/§6）
- **worktree**：`feat/git-version`
- **测试先行**：`test/git-version.test.ts` 覆盖 commit/branch(仅最外层顺序组)/switch/cherry-pick/diff，断言版本树还原一致；跨分支 cherry-pick 后改参落新提交。
- **实现**：新 `src/script/version-store.ts`（提交树 + 不可变更新，版本节点=最外层顺序组）；新 `src/ui/version-panel.ts`（SRP）分支切换/cherry-pick/tag/diff（融合 CFG 视图）；`UiKernel` 不上提版本（保 DIP）。
- **校验**：code-review 查 DIP/架构同步；runtime-runnability 真机版本操作冒烟。

### 合并纪律
- 各阶段在 worktree 内过三角色校验后合并 master（保留 worktree 目录，用户要求不删）。
- 每阶段若触及 `src/types/step.ts`/桥协议/模块边界，须同步 `architecture.md §2.2/§2.3`（§5.2）。

---

## 待做需求（Pending Backlog）

> 以下为已完成 M3 主体后，用户明确提出的后续需求，按"先落到计划、再排期实现"原则登记。
> 涉及架构/需求变更的，实现前须同步 `docs/architecture/architecture.md` 与 `docs/requirements/requirements.md`（CODEBUDDY.md §5.1/§5.2）。

### P1 高亮自动跟随当前步骤
- **来源**：M3 UI 壳设计讨论。用户选定"改为自动跟随当前步骤高亮"（回放/试跑时，高亮标记自动跟随正在执行的步骤，而非手动选择）。
- **范围**：`UiShell` 回放/试跑流程中，步骤状态切到 `running` 时自动调用 `locateVisual` 取坐标并刷新叠加标记；完成后清理。
- **测试**：UI 单测断言"当前 running 步骤被高亮、上一步高亮消失"；真机冒烟确认叠加标记随步骤推进移动。
- **状态**：设计已定，待实现（M3 UI 壳后续子阶段）。

### P3 桥推送事件的多客户端隔离（runId 过滤）
- **来源**：M3-R3 可运行性审查第二轮复审发现。`bridge-server.pushEvent` 是**广播给所有已连接 clients**。
- **问题**：若浏览器开两个标签页同连同一桥，A 页点「运行全部」，B 页也会收到 `step-progress` 并错误更新自己的步骤状态（同理 R2 的 `recording` 事件）。
- **现状判定**：M3 为单用户演示场景，实测不崩、非功能断裂，审查结论「可接受，非阻塞」。
- **范围**：桥端为每次运行/录制生成 `runId`，事件载荷带上；客户端只消费自己发起的 runId。或改为按 client 定向发送而非广播。
- **状态**：已知限制，待 M4 多标签页/多用户场景前修复。

### P2 连接目标 + 启动调试端口 封装为 MCP Tool
- **来源**：用户指出 `app.ts` 中 `shell.connect({port:9222})` 写死、连接目标无手动选择；并明确要求将"连接靶机 + 拉起测试软件（暴露调试端口）"能力封装为 MCP Tool，而非在 UI 壳硬编码端口。
- **范围**：
  - 新增 MCP Tool：`launch-target`（以 `--remote-debugging-port` 启动指定 Electron 应用并返回端口）、`connect-target`（按用户选择的 host/port 连接，非写死 9222）。
  - UI 壳连接区改为"用户选择/输入目标"→ 调用 `connect-target`，去掉硬编码。
- **测试**：MCP Tool 契约测试（输入 host/port/exe 路径，输出连接句柄/端口）；UI 单测断言连接区不再写死端口。
- **状态**：需求已记录，待 M4（MCP 全量 Tool）一并实现；当前 UI 暂保留 `?live=1` 自动连 9222 的便利分支（用户暂缓手动连接 UI 改动）。
- **关联记忆**：`project_m3_tool_packaging.md`。

### P3 连接目标手动选择 UI（与 P2 配套）
- **说明**：P2 的 `connect-target` 需要 UI 入口让用户选择/输入靶机（当前仅自动连 9222）。与 P2 同批实现，避免 UI 硬编码。

### P4 Git 式脚本版本管理（可视化蒙版内）
- **来源**：用户提出"借鉴 git 的版本管理方式，在可视化蒙版中实现类似功能的脚本管理"。
- **核心思路**：
  - 每一个 **步骤（Step）** = 当前分支上的一次 **commit**。
  - 选定某一步骤后，可**迁出新分支**（从该行历史切出），在新分支上修改步骤。
  - 可 **cherry-pick** 其他分支上的步骤到当前分支。
  - 集成 git 的优秀思路：分支、提交历史、回滚、merge/rebase、tag、diff（步骤级差异对比）。
- **范围（建议落 M3 UI 壳后续子阶段 / 或独立 M3.x）**：
  - 脚本对象增加"版本层"：每个 Script 是一个有向提交图，节点 = Step 快照，边 = 先后/分支关系。
  - UI 提供：步骤历史时间线、从某步开分支、分支切换、cherry-pick 步骤、步骤 diff 视图。
  - 底层复用 `src/script/io.ts`（导入导出）+ `ScriptEditor` 不可变操作（每次编辑生成新提交而非覆盖）。
- **影响**：**涉及架构变更**——脚本模型从"线性 Step[]"升级为"带版本的提交图"。实现前**必须**在 `docs/architecture/architecture.md` 与 `docs/requirements/requirements.md` 同步新增"脚本版本管理"小节，code-review 角色将据此核查。
- **测试**：版本层单测（commit/branch/checkout/cherry-pick 后 Step[] 还原一致）；UI 单测（时间线渲染、分支切换后步骤列表同步）。
- **状态**：概念登记，待细化设计后排入实现。

### 排期建议
- P1（高亮跟随）：M3 UI 壳后续子阶段，独立 worktree。
- P2+P3（MCP Tool + 手动连接 UI）：并入 M4 MCP 全量 Tool。
- P4（Git 式版本管理）：独立设计阶段（M3.x），先更架构/需求文档再实现。
