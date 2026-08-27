# 总体实施计划

> 配套：`requirements/requirements.md`、`architecture/architecture.md`、`design/design.md`、`AGENTS.md`
> 纪律基线：任何实现前先有测试方案/测试代码；实现后以通过测试为迭代目标（详见 `AGENTS.md` §5）。

---

## 0 工程纪律（贯穿所有阶段）

1. **测试先行**：每阶段/每任务动手前，先确定测试方案或在 `test/` 落地测试骨架。
2. **通过测试才算完成**：实现以让测试通过为第一目标，未通过不得合并。
3. **Worktree 隔离**：每个实现任务在 `.cursor/worktree/<name>` 独立工作树进行（`AGENTS.md` §3）。
4. **双角色校验**：每个任务完成须过 **test**、**code-review**、**runtime-runnability** 三个角色（`AGENTS.md` §4）。
5. **并行用 Agent team**：可并行子任务用多 Agent / Agent team，各自 worktree + 各自校验。
6. **知识沉淀**：重复任务总结进 `.cursor/skills/`；短约束在 `.cursor/rules/`；完整纪律在 `AGENTS.md`。

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

**端到端主链路验收（jsdom，CODEBUDDY.md §4.1 强制门槛）**
> 动机：M3 曾"渲染能出、单测全绿"但用户打开无任何功能可用。故 UI 改动除单测外，必须有 jsdom 驱动 `app.boot()`（或等价入口）→ 模拟 `[data-action]` 点击的 e2e 测试，证明**用户真实路径**跑通（禁止只信内部 API 直调）。
> 落地：`test/ui-core-e2e.test.ts`（jsdom 环境）。

交互验收清单（逐条比对 `docs/design/visual-mask-ui-spec.md` §2.x，code-review 须核对）：
1. **布局（§2 核心范式）**：render 后存在 `.ui-shell-body` 包裹 `[data-stage][data-steps][data-cfg]`（4 栏横向生效，截图流不再独占竖向）。
2. **插入 4 类（§2.3.1）**：点「插入步骤」展开菜单仅含 `wait/waitUntil/assert/repeat`；选 `wait` → 列表 +1；选非法类（click/fill）被拒（菜单不提供）。
3. **真实编辑区（§2.6）**：选中步骤 → 渲染 `[data-edit-area]` 真实表单（非 alert）→ 改参数 → 点保存 → `getScript()` 该步不可变更新。
4. **建组（§2.3.0）**：多选 ≥2 步 → 点「包成选择组」→ 顶层塌缩为 1 个 `control.kind='if'` 节点（children=[选中步]）；CFG 视图出现 `true/false` 两枝。点「包成循环组」→ `control.kind='while'`，CFG 出现回环边（↻）。
5. **运行失败标红（§2.3.4/§2.4）**：`运行全部` 失败 → 该步 `data-step-status="fail"` + 顶部 `[data-run-notice]` 提醒条。
6. **Git 面板默认隐藏**：主体流程 `render` 不挂载 `[data-version]`（解耦可选插件，opt-in `enableVersionPanel` 才挂载）。

**架构同步（§5.1）**：UI 壳新增 `src/ui/` 目录（UiShell 组件 + 宿主 serve 入口），属新增模块边界，需在 `architecture.md` 补「UI 壳」小节（组件职责、与内核依赖方向）。

---

## M4 详细计划（MCP 全量 Tool + Skill）

### M4.1 范围
- 自研 MCP Server 全量：connect/listTargets/snapshot/execute_steps/record/import/export/update_step/assert
- 测试向 Skill（如何快照/导出/修复）

### M4.2 测试方案（先于实现）
- MCP Tool 契约测试：每个 Tool 的输入输出与执行器对齐。
- record Tool 复用 M3 的 Recorder；update_step 复用 M3 的 ScriptEditor。

### M4.3 第一刀状态（feat/pick-record，2026-08-27）
- **已交付**：stdio MCP（`npm run mcp` / `.cursor/mcp.json`）1:1 包装内核。契约测试 `test/mcp-*.test.ts`：Tool 名、null 入参、`script.open`→`loadScript`、`launch-target` 不写死 9222、`waitUntil textContains`。
- **已注册原子**：`launch-target` / `target.stop` / `workbench.start|stop`、`app.connect|disconnect|list_targets`、`page.snapshot|click|fill|wait|waitUntil|screenshot`、`actions.execute_steps`、`script.import|export|open`、`assert.run`、`record.start|stop|get_steps`。
- **未做（故不称全量完成）**：Skill 正文（另 Agent 在改）、`script.update_step`、`agent.suggest_steps`、视觉断言专用 Tool、多标签页 `runId`（P1）。P2 的 UI「手动选连接目标」仍未做（本刀不改 `src/ui/**`）。

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

## M3 工作台对照原型（2026-08-26）

验收以 `docs/design/m3-visual-panel-prototype.html` 时序为准，不以 mock 绿代替产品可用。测试入口：`test/spec-workbench.test.ts` + `test/ui-core-e2e.test.ts`（`app` 路径仍走 `data-action`）。

| 时序 | 验收 |
|---|---|
| 布局 | CFG + 舞台 + 详情；无步骤列表 |
| 输入 | 同一 locator 连续 fill 一条，值为最终文本 |
| 组 | 一步一组可命名；仅打包提示组名；拆包；选中组设 if/while |
| 点选 | 点选横幅；点击不写入录制步；详情显示封装名 |
| 运行 | 未连接禁用运行全部；清空需确认；选中步舞台高亮 |

---

## M3 UI 重构（feat/pick-record，CFG 连线 + 定位展示）

> 用户已批准开工。本回合只改渲染层，不改 schema、不封装 MCP。

### 验收清单（先于实现）

**A CFG 连线与执行一致**
1. if/else：图模型 true/false 边只连到同层分支头；True 与 False 之间没有 flow。
2. 分支 SVG 从条件头底边出发，不从组外框底边倒插入子节点（`isInwardVIntoGroup` 为假）。
3. 循环：回环边 `data-to` 是循环头；路径从末步右侧绕出组框，不穿过 body。
4. 画布无 `[data-cfg-minimap]`。
5. 仍走 `[data-action]` / `[data-cfg-node]`；`test/ui-core-e2e.test.ts`、`test/workbench-ux.test.ts` 保持 `app.boot()` 或等价 `render()` + 模拟点击。

**B 步骤卡片 / 详情定位**
1. 卡片与详情显示 `role + [name] + 截断 css`。
2. 空 name 不渲染成只有 `<textbox>`。
3. 详情 css 可展开、可编辑、保存写回 `locator.css`。

---

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
| M3-R3 运行全部 + 步骤态 + 高亮跟随 | ✅ 已合并 | `feat/run-all` | 见合并记录 | `ui-shell-run-all` 22 + `executor-progress` 11 + `bridge-ws-progress` 7（真 WS）+ `bridge-push` 25 通过 |
| M3-R4 CFG 图形化视图 | ✅ 已合并 | `feat/cfg-view` | `883fe1e` | `test/cfg-view.test.ts` 47 通过（含特殊字符 id / 点击内部子元素 / OCP 穷尽性 / 导入期 kind 校验 / 未知 kind 不白屏） |
| M3-R5 Git 式版本层 | ✅ 已合并 | `feat/git-version` | `11dcb6d` | `version-store` 23 + `version-panel` 8 + `version-shell` 4 通过（共 35 例） |
| M3 工作台补齐 | 进行中 | `feat/pick-record` | — | 录制注入全部窗口、导入 JSON 带 shots、if 夹具与 jsdom 运行全部 |

> **测试代码权威性纪律（新增，因本轮违规而补）**：既有测试文件（含其 mock 基建，如 `test/ui-shell.test.ts` 的 `makeMockKernel`）**不得为迁就新实现而修改**。新能力需要新的 mock 行为时，新建独立测试文件并自带 mock，不动既有基建。

#### 导入配图 + 录制不切窗口 + if 夹具（本轮）

验收：

1. 开始录制注入全部 target；下拉在录制中隐藏；步骤带事件所在 `target`。手动 snapshot 仍看当前窗口。
2. 未连接导入带 `shots` 的 JSON：`getStepShots()` 有图，点步骤舞台 `<img>` 出图，不调 `screenshot`。无配图则仍为空。
3. 已连接导入无配图：仍按叶子补拍（highlight / 整页）。
4. `exportScript` 在根上写可选 `shots`（data URL），步骤对象没有 png。schema 仍是 v1。
5. `scripts/fixtures/agent-generated-if.json`：条件为资源管理器 treeitem `settings.json` 是否存在（不是菜单「文件」）。jsdom 导入/`loadScript` + 点运行全部；9246 活着则 `adapter.playback`。True=点击该文件，False=等 200ms。
6. 内核 `loadScript` + 桥 RPC：jsdom 推进 CFG；WS `loadScript` 广播 `load-script`。将来 MCP `script.open` 调这一行。导入按钮仍保留。
7. `npm test` + `npm run typecheck`。

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

### 阶段 M3-R3：运行全部 + 步骤态 + 高亮跟随（P1）— ✅ 已完成
- **worktree**：`feat/run-all`
- **测试先行**（均为新建/追加，未改既有测试断言与 mock 基建）：
  - `test/ui-shell-run-all.test.ts`（22 例，jsdom + 自带 `makeRunAllKernel`）：按钮改名、状态流转 pending→running→pass/fail、running 中间态可观测、重跑重置、状态 CSS class、失败提示带步骤描述、高亮跟随 running 步并在结束后清理、无 locator 步跳过定位、`locateVisual` 抛错不中断、老内核无进度事件时回填（OCP）、**`playback` 单参调用回归守卫**、generation token 竞态（慢定位 vs 快速后续步、幽灵高亮框）、CFG children 命中、订阅解绑、畸形载荷忽略。
  - `test/executor-progress.test.ts`（11 例）：`runScript`/`runCli` 进度钩子（进程内函数传递合法）+ `runNode` 坏子节点守卫。
  - `test/bridge-ws-progress.test.ts`（7 例，**真 http server + 真 WebSocket**）：`step-progress` 经真实 WS 端到端送达、失败步 `failedStepId` 不为 undefined、CFG 循环按真实次数上报、载荷跨 JSON 往返完好、`null` script 与 `children:[null]` 被桥端拦截且不进执行器、多次运行不串台。
  - `test/bridge-push.test.ts`：**仅追加** `assertRunnableScript` 递归深度校验用例（共 25 例）。
- **实现（最终架构，与首版不同 — 见下方踩坑）**：
  - 按钮"回放"→**"运行全部"**（`app.ts` action `run-all` → `shell.runAll()`）。
  - 运行态 `StepRunStatus` 存 `UiShell` 内 `Map<stepId, status>`，**不入 `Step` 模型**（SRP：`Step` 要持久化，运行态是瞬时 UI 态）。
  - 进度通道：`executor.runScript(…, onStep)` 逐叶子上报 → `cli.runCli` 透传 → `adapter.playback(script, onStep?)` → `bridge-server` 的 `playback` 专用分支 → `pushEvent('step-progress')` → `ws-kernel.on/off` → `shell.runAll()` 消费。**`UiKernel.playback` 保持单参**。
  - 高亮跟随用 generation token（`highlightGen`）作废迟到/乱序的 `locateVisual` 结果；`runIndex` 一次性 Map 化避免每步 `flattenSteps()` 的 O(n²)。
  - 边界：`assertRunnableScript` 递归深度校验（含 children 各层）+ 执行器 `childrenOf` 双保险；`STEP_TYPES`/`CONTROL_KINDS` 收敛为 `types/step.ts` 运行时常量单一真相源；`attachKernelBridge` 第三参可注入 adapter（DIP，使 WS 线路可测）。
- **踩坑记录（4 轮可运行性打回 + 1 轮 code-review 打回，全部为 §4.1 同族问题）**：
  1. **首版把进度回调放进 `playback(script, cb)` 参数位** —— `UiKernel` 有跨 WS 实现，函数不可 JSON 序列化，真机回调 100% 丢失，而 `tsc` + 单测（Mock 不过 WS）全绿。裁定重构为事件推送通道（进度源必须在 Node 进程内）。
  2. 桥端 `req.args[0] as Script` 无守卫 → `playback(null)` 崩在 `null.steps`，被 `runCli` 吞成 `failedStepId:undefined` → UI 显示"(未知)"，静默误提示。
  3. 只校验 `steps` 是数组不够 → `steps:[null]` 仍崩。
  4. **`children:[null]` 与 `steps:[null]` 是同源递归缺陷** —— 只补顶层是治症不治因。收口为一次性递归深度校验，错误带 `steps[i].children[j]` 路径。
  5. code-review 打回：①架构文档未同步（§5.2 阻断）；②`STEP_TYPES`/`CONTROL_KINDS` 在 bridge-server 重复列举，与 `types/step.ts` 双源漂移（OCP）；③`step-progress` 经真实 WS 这段无测试（只测了两岸未测桥），而这正是 §4.1 出事点 —— 根因是 `attachKernelBridge` 内部直接 `new PlaywrightCdpAdapter()` 使其不可测，**不可测本身即设计缺陷**，故开放注入点。
- **校验**：`npm test` 164 通过 / 17 跳过；`npm run typecheck` 干净；runtime-runnability 第 5 轮**通过**（含 8 类坏数据实测 + 4 突变点）；test 角色**通过**（4/4 突变被捕获，无假绿；确认既有测试为纯追加）；code-review 3 项已修。
- **未做**：真机端到端冒烟（需 9222 靶机）—— 见下方待办。

### 阶段 M3-R4：CFG 图形化视图（§2.7）— ✅ 已合并（`883fe1e`）
- **worktree**：`feat/cfg-view`
- **测试先行**：**新建** `test/cfg-view.test.ts`（38 例，jsdom + 自带 mock kernel，未改任何既有测试）。实现前确认为红（模块不存在 → 解析失败）。分五组：①`buildCfgGraph` 图模型（顺序链式边 / if 真假两枝 / while 回环 / 嵌套 / 空脚本 / 坏数据不崩 / isLeaf 标注）；②DOM 渲染（`.ui-shell-cfg`、`data-cfg-node/kind/branch/loop`、嵌套包含、空态）；③双向联动（图↔列表、唯一选中、组节点可选、脏 id 不选中、**stepId 含 CSS 特殊字符**）；④运行态（running/pass/**fail 标红**、与列表状态一致、循环体内嵌套步、重跑重置）；⑤组件边界（可独立挂载、`update` 幂等、`onSelect` 上报、`setStatus` 原地更新不重建）。
- **实现**：
  - 新 `src/ui/cfg-view.ts`（SRP）：`buildCfgGraph(script)` 纯函数产图模型（与 DOM 解耦）+ `class CfgView` 渲染（只画图与上报点击，DIP 不 import 内核/执行器）。
  - 新 `src/ui/step-label.ts`：展示文案单一真相源（`TYPE_LABEL`/`describeLocator`/`describeStepBrief`），步骤列表与 CFG 共用。
  - 改 `src/ui/shell.ts`：选中态 `selectedStepId` + `selectStep()`/`getSelectedStepId()`（UiShell 为唯一真相源，两个兄弟视图都订阅它）；内部挂列表点击委托；`render()` 挂载 CFG 区；`setStepStatus` 单点分发状态到列表 + 图。
  - 改 `src/ui/index.html`：`.ui-shell-cfg` 系列 CSS（竖向/分叉/回环/状态色/选中描边），无新依赖。
  - `src/ui/app.ts`：未改（shell 内部自挂委托）。
- **关键约定**：`if` 的 `children[0]=then`、`children[1]=else`，**依据执行器** `runNode` 的 `chosen = result.passed ? branches[0] : branches[1]`。画反则图与真实执行相反，属最危险的 UI 谬误。
- **踩坑记录（审查打回项，均已收口并写入架构文档）**：
  1. **实现者为让测试通过，在生产代码里嗅探 mock 夹具属性**（`if (kernel.listeners) 走 A 分支 else 走 on/off`），造成「单测走 A、真机 WsKernel 走 B 且 B 从未被测」——§4.1 盲区成因。已整段删除（CFG 状态本就由 `setStepStatus` 单点分发，不需要第二个订阅）。
  2. 删除后暴露真实缺陷：`setStepStatus` 先广播 `onStepStatusChange` 再更新 CFG DOM，订阅者读到滞后一步的状态（与 R3 高亮占位框同款顺序 bug）。已改为**先落视图、再广播**。
  3. **我自己的测试掩盖了一个真 bug**：节点点击原实现要求 `e.target === e.currentTarget`，而真实用户点的是节点内部文字（`e.target` 是 label 子元素）→ 点文字无反应；`el.click()` 的合成事件恰好 `target === el`，把缺陷完全掩盖。已补「点击节点内部子元素」测试并改为 mount 级单一委托 + `closest`。
  4. **DOM 查询拼接选择器**：`querySelector(\`[data-step-id="${id}"]\`)` 在 stepId 含 `"`/`\`/`]`/空格时于真实 Chromium 抛 `SyntaxError` 中断整页 JS，jsdom 下只静默选空（单测用安全 id 看不见）。已改为属性精确比对（`findStepItemEl`），并补特殊字符用例。
  5. **`switch(ctrl.kind)` 的 `default:` 兜底掩盖 OCP 缺口**：新增控制流类型会被静默错渲为顺序组。已改为穷尽性检查 `const exhaustive: never = ctrl.kind`；实测给 `CONTROL_KINDS` 加 `'switch'` 后 `tsc` 确实在 `cfg-view.ts` 报错。
  6. `cfg-view` 从 `./shell` 引入 `StepRunStatus` 形成「子组件反向依赖编排者」，与架构文档声明的 DIP 自相矛盾。已把类型迁至 `types/step.ts`，shell 仅 re-export。
  7. 空态提示在空→非空 `update` 后残留；重复注册的列表点击委托（复制粘贴）。均已修。
  8. **`never` 穷尽性只是编译期守卫，运行时脏数据照样漏过**：本地导入含未知 `control.kind` 的脚本时（`io.ts` 原先只校验 schema + steps 数组），CFG 会静默错渲（边全空、子节点不挂载、误标"顺序 sequence"），执行器 switch 也会跳过该节点（"看起来通过了"其实没执行）。已在 `io.ts` 的 `validateSteps` 递归校验 `control.kind ∈ CONTROL_KINDS`，与桥边界 `assertRunnableScript` 形成本地/WS 双路同等门槛。
  9. **只修了一处 OCP 缺口**：`buildCfgGraph` 改了穷尽性检查，但 `renderNode` / `nodeLabel` 仍是 `if/else` + 兜底 else，新增控制流类型同样会被静默按顺序组渲染。已把三处统一为 `assertNeverControlKind`；并把 `CfgNode` 改为**判别联合**（`isLeaf` 判别位），因为原先 `kind: StepType | ControlKind` 迫使每处 `as ControlKind` 强转，而强转会破坏 TS 收窄、令守卫失效。实测：给 `CONTROL_KINDS` 加 `'switch'` → `tsc` 在 cfg-view 的 **3 处**分别报错。
  10. **只断言 `data-*` 属性掩盖了"用户看不见"**：列表项选中只打 `data-step-selected`，而 `index.html` 无对应 CSS 规则 → 真机点 CFG 节点时列表侧零视觉反馈。已把属性 + `is-selected` class 收敛到 `markStepItemSelected` 单一入口并补 CSS，测试同时断言 class。
  11. `resetRunStatus` 调 `cfgView.update()` 会清掉图内部选中态而 `UiShell.selectedStepId` 未变，两视图分叉。已让 `CfgView.update` 自行保留并恢复选中项（步骤已删则自然不恢复）。
  12. **我为修第 9 项引入的 `throw` 本身成了新缺陷**：`assertNeverControlKind` 运行时抛错，而导入期校验只覆盖 `importScript`（本地文件）一条路径 —— 录制直接构造 Script、Agent 经 MCP 构造、R5 版本层还原旧数据都能绕过它直达渲染层，异常在 `render()` 同步栈爆开即**整页白屏**，等于把"静默错渲"升级成"彻底不可用"。已改为**渲染层降级**：`console.warn` + 画「未知控制结构」占位节点（`data-cfg-kind="unknown"` + 虚线样式），子节点照画；硬失败只留在数据入口（io.ts / 桥边界）。补了 3 个「未知 kind 直达渲染层不白屏」用例。**关键**：改 `throw`→`warn` 后**仍保留 `kind: never` 参数类型**，实测新增 `'switch'` 时 tsc 仍在 3 处报错 —— 编译期守卫与运行时降级两者并存，不是二选一。
- **校验**：`npm test` 211 通过 / 17 跳过；`npm run typecheck` 干净；三校验角色结论见合并记录 `883fe1e`。
- **未做**：真机端到端冒烟（需 9222 靶机）。

### 阶段 M3-R5：Git 式版本层（§2.2/§6）— ✅ 已合并（11dcb6d）
- **worktree**：`feat/git-version`
- **测试先行**（**先写** `test/git-version.test.ts` + `test/version-panel.test.ts` + `test/version-shell.test.ts`，再写实现；未改任何既有测试）：
  - `version-store`（23 例）：`isVersionNode` 仅顶层 sequence 为真（嵌套/if/while/叶子均否）；`commit` 不可变（入参 Script 引用不变、history 倒序）；`branch` 派生 + 同名报错 + 不改源；`switchTo` 还原脚本 + 不存在分支报错；`cherryPick` 跨分支摘节点、源不变、改参落新提交而非改写源、不存在节点报错；`tag` 列出 + 重复报错 + 空名报错；`diffScripts` 递归展平比对（增/删/改）、相同脚本空差异不崩；边界硬失败（§4.1）入口抛 `VersionStoreError` 而非 UI 白屏。
  - `version-panel`（8 例，jsdom）：渲染分支/标签/历史；点击 chip 内部文字经 mount 委托上报 `onSwitch`；点击历史 cherry-pick 按钮上报 `onCherryPick`；`canCherryPick` 控按钮显隐；`update` 幂等；空/单提交不崩。
  - `version-shell`（4 例，jsdom）：render 后面板挂载含 main chip；`versionBranch` 后新 chip 出现；点 chip 经 shell 切回 store 并刷新高亮；`versionCommit` 后历史 +1。
- **实现**：新 `src/script/version-store.ts`（纯数据，无 UI/内核依赖，提交树 + 不可变更新，版本节点=最外层顺序组，`VersionStoreError` 入口硬失败，`diffScripts` 递归展平）；新 `src/ui/version-panel.ts`（SRP，仅消费 store + 回调，mount 委托，DIP 不 import 内核）；`shell.ts` 持有 `versionStore` 并编排（接回 version-store 纯函数），暴露 `versionCommit/versionBranch/versionTag`；`index.html` 补版本面板 CSS；`UiKernel` 不上提版本（保 DIP）。
- **校验**：test 全绿(246/17 skip) + typecheck 干净；code-review 查 DIP/架构同步（§5.2 已同步 architecture.md §2.2 + §2.3）；runtime-runnability 真机版本操作冒烟（需靶机则 skip）。

### 合并纪律
- 各阶段在 worktree 内过三角色校验后合并 master（保留 worktree 目录，用户要求不删）。
- 每阶段若触及 `src/types/step.ts`/桥协议/模块边界，须同步 `architecture.md §2.2/§2.3`（§5.2）。

---

## M3 spec 迭代:CFG 图示渲染规则(文档,worktree `feat/m3-cfg-graph-spec`)

> 触发:用户确认 Figma 原型后指出「步骤多时 CFG 要能以图示形象表现步骤运行的结构」。
> 现状:`visual-mask-ui-spec.md` §2.6 只给树状文本骨架,未规定图形渲染规则与规模可读性。
> 范围:**仅改文档**,不改 `src/`/`test/` 产品逻辑(§0 状态行仍为待确认后冻结)。
> 纪律:测试优先 —— 文档即被测对象,下列清单先写,spec 改动须逐条满足,code-review 据此核对。

### 验收清单(先于 spec 改动)
1. §2.6 明确 CFG 是**图形化控制流图**(节点 + 有向边),不是树状文本:顺序=竖向链边;选择=条件分叉到 True/False 两枝;循环=回环边并标 ×N。
2. 新增 §2.6.1 CFG 图示渲染规则:节点形态(叶子步 / 顺序组 / 选择组 / 循环组)、边语义(顺序边 / 分支边 / 回环边)、运行态图上高亮(当前步、pass、fail 标红)、选中态、点击联动详情+截图。
3. 规模可读性:步骤多时图示仍可读 —— 组可**折叠**为一个节点、画布**缩放/平移**、minimap 或滚动定位;明确「一步一组」在图上的折叠粒度(默认叶子展开,打包组可折叠)。
4. 与 §2.5 一致性:选择组 `children[0]=True` / `children[1]=Else` 在图上画反属缺陷;循环体回环边回到循环头而非末步。
5. 不引入新 schema:仍用 `Step.children` + `control.kind`;图是**渲染层**,不改数据模型(§5 D6)。
6. §0/§1 展示行、§3 场景、§5 决策表同步:新增 D11「CFG 图示渲染」决策,建议值=图示为主视图、不再并排可编辑线性列表。
7. 与 `architecture.md` 一致:CFG 视图属 UI 渲染层,不新增内核概念;`buildCfgGraph` 图模型与渲染分离的约定写入。
8. 不改 `src/`/`test/`;状态行保持「待用户确认后冻结,确认前不得改产品逻辑」。

### 校验角色
- test(test-first-dev):确认验收清单先于 spec 改动存在;spec 改动后逐条可勾。
- code-review(code-review-standard):产品符合度(对照 Figma 原型 12 画板 + 确认稿/补充)+ 架构同步(architecture.md)+ §2.x 交互一致性。
- runtime-runnability:本次无代码改动,仅确认未误改 `src/`/`test/`、未引入新 schema 契约漂移。

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
- **状态**：第一刀已交付 `launch-target`（包装 launch-*.cmd，返回实际端口，不写死 9222）与 `app.connect`（port 来自 launch-target / 内核探测）。UI 壳手动选目标（P3）仍待做，本刀不改 `src/ui/**`。未称 P2 全量完成。
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

### MVP：端口自探 + 运行全部反馈 + 录制 locator 可回放（worktree `feat/pick-record`）

> 产品约束：面向任意 Electron（CDP），不是某一款 IDE 的驱动。用户反馈：工作台默认连 9222，「运行全部」未连接时零反馈；录制把无障碍帮助文案当 locator，连续 fill 膨胀且回放点不中真实输入。
> **不改** `docs/design/visual-mask-ui-spec.md`。P1 高亮/CFG 箭头本轮不做。禁止把某 App 的 class / 端口号段写进 locator 或 playback。

#### 验收清单
1. 首选端口 `connectOverCDP` 失败时，并行探测 `/json`：本次端口、上次成功口、`CDP_PROBE_PORTS`、本机调试号段 9222–9260（须有 `webSocketDebuggerUrl`），连第一个活口；不必手输 `?cdp=`。
2. 「运行全部」未连接时**不禁用**。用户点击 `[data-action=run-all]` 出现 `[data-run-notice]`（文案含「未连接靶机」），不调用 playback。
3. 已连接时点击运行全部：失败步 `data-cfg-status=fail` 且出现 run-notice（主链路走按钮点击，见 `test/ui-core-e2e.test.ts`）。
4. 录制从事件目标走到最近可交互节点（button/link/input/textarea/contenteditable/role=textbox 等；**不含** presentation/none/generic）。`aria-hidden` / `inert` / 零尺寸 overlay 跳过；看起来像屏幕阅读器帮助的 name 不写入 locator.name（保留 css/role）。负例：某段 overlay 长文案不得成为 name，但实现不得做成该 App 的中文词表。空 fill 丢弃；同一 locator 连续 fill 只留最新非空值。
5. 同一 locator 连续 fill：keydown 不立刻灌 `__recBuf`，`RECORD_DRAIN` / blur / idle 只出一步最新值。
6. `fillOnPage`：可见 input/textarea/contenteditable 走 Playwright fill；否则点看得见的节点再 insertText；隐藏节点点最近可见祖先。不硬编码某 App 的编辑器/聊天 class。`clickOnPage`/`fillOnPage` 不 `getByRole('presentation')`，装饰 role 走 css 再点可交互祖先。
7. Agent 回复用通用 `waitUntil`（element exists / text appears），不是专用聊天面板 API。真机夹具可点通用 `role+name`（如 treeitem），不得依赖 App 专用 css fill。
8. 网页级验收：工作台 `5173/?live=1&cdp=` 开始录制 → 靶机输入并发送 → 停止录制 → CFG 无空 fill、无 presentation 步 → 点 `[data-action=run-all]` → 靶机内步骤跑完。

### UX 抛光（worktree `feat/pick-record`，本轮）

交互优先；主链路仍走 `test/ui-core-e2e.test.ts` 的 `boot()` + `[data-action]`。

1. 详情点「保存」后出现 `[data-save-notice]`（或按钮「已保存」），jsdom 可断言。
2. 顶栏可见 **测试步骤中台** + **已连接/未连接**；完整靶机窗口 title 只放 tooltip，禁止把 `1.txt - cursor - Visual Studio Code` 当主文案。网页 `document.title` = 测试步骤中台。`listTargets().length <= 1` 时隐藏目标下拉；多目标时保留并标「当前窗口」。
3. 舞台**没有**「预览不可操作靶机」横幅/遮罩，截图整张可见。该说明只在 Skill。
4. CFG 栏标题 **步骤流图**；提示只留「拖拽调序 · 框选打包」。框选后紧凑浮动簇（`[data-pack-menu][data-pack-float][data-pack-anchor=bbox]`）贴在选区包围盒**右侧**（不够则上方），按节点 `getBoundingClientRect` 相对画布重算，不钉画布左上/底栏。点空白取消选区并隐藏浮动钮。点打包**立刻**以默认名建组，**不得** `window.prompt`、也不得内联组名确认；改名走详情组名。
5. 详情是锚在选中节点旁的紧凑叠加层（`[data-detail-anchor=node]`），180ms opacity+translate；不盖预览、不占半幅抽屉、不制造画布中缝原生滚动条。弹层内 `[data-inspector-scroll]` 可滚；右上角 `[data-inspector-close]` 扇形 X，无取消钮。组节点不显示点选「尚未选取」。预览栏没有「编辑」。点节点=查看截图；点 `[data-action=edit]` 才打开详情。Esc / 点舞台或 CFG 空白关闭详情。保存后详情仍在。
6. 壳根 `data-layout="flow"|"shot"`：录制中 / 详情打开 / 框选打包 → `flow`（流图主栏）；查看某步截图 → `shot`（截图主栏）。双栏宽度用 `grid-template-columns` 过渡，不要瞬切。`shot` 下点**单步**也在该步包围盒旁弹出同一组打包钮（顺序/分支/循环）。
7. 第一步节点不得贴齐 CFG 树 (0,0)：树有 padding，jsdom 断言首个 `[data-cfg-node]` 的 offset/padding。`.ui-shell-cfg` / 画布 **不得** `overflow:auto`；详情弹层内部可以 `overflow:auto`。图靠 padding + 滚轮/拖拽平移（`overflow:hidden` + transform）。壳根 padding 在 shot/flow、有无选中时相同。
8. 出现/消失约 180ms opacity/transform。页面壳是跟指针的雾块（`[data-app-field]` 内 2–4 个 `[data-fluid-blob]`）；**点阵铺满步骤流图画布**（`[data-cfg-dots]` 世界尺寸 ≥ 画布，间距约 22px、低透明），禁止只铺左上小补丁，禁止整页 16px 密点。if 枝列只有一个 True / 一个 False，枝内 sequence 包装不得再印 True/False 头。

### 排期建议
- P1（高亮跟随）：M3 UI 壳后续子阶段，独立 worktree。
- P2+P3（MCP Tool + 手动连接 UI）：并入 M4 MCP 全量 Tool。
- P4（Git 式版本管理）：独立设计阶段（M3.x），先更架构/需求文档再实现。
