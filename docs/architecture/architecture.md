
# 技术选型手册

## 1 总原则

| 原则        | 含义                                       |
| --------- | ---------------------------------------- |
| 控制面与智能面分离 | CDP/执行器负责「做」；Agent 负责「想与生成」；脚本负责「固化」     |
| 一种步骤模型打通  | 录制、Agent 轨迹、导入导出、MCP Tool 共用同一 JSON 步骤结构 |
| 触发与执行解耦   | 版本监听只负责发事件；执行器消费「脚本任务」或「Agent 任务」        |
| 先稳后慧      | P0 脚本闭环可上线；Agent 与自愈作增强                  |

---

## 2 分层架构

text

```
┌─────────────────────────────────────────┐
│  触发层：版本监听 / 手动 / CI            │
├─────────────────────────────────────────┤
│  任务层：脚本任务 | Agent 任务模板        │
├─────────────────────────────────────────┤
│  Skill：测试场景策略、如何快照/导出/修复   │
├─────────────────────────────────────────┤
│  MCP Server：Tool（连接/录制/执行/导入…） │
├─────────────────────────────────────────┤
│  执行器：步骤解释器 + 断言                │
├─────────────────────────────────────────┤
│  CDP 适配层：Playwright / connectOverCDP │
├─────────────────────────────────────────┤
│  目标：Electron 客户端（Chromium 渲染）   │
└─────────────────────────────────────────┘
```

### 2.1 可视化蒙版 UI 壳（M3.3）

UI 壳是「人操作界面」，与内核（CDP 适配层 / 录制 / 执行器）解耦，遵循 DIP：只依赖 `UiKernel` 抽象接口
（`CdpAdapter & VisualCapable & Recordable & { playback }`），不感知 `PlaywrightCdpAdapter` 具体实现。

```
┌─ 浏览器面板 (src/ui/index.html + app.ts) ─────────────┐
│  UiShell（内核编排 + DOM 渲染，src/ui/shell.ts）         │
│    ├─ 演示模式：DemoKernel（浏览器内，无需真机）          │
│    └─ 真机模式：WsKernel ──WS(/kernel-ws)──┐            │
└────────────────────────────────────────────┘            │
                                                          ▼
                                 Node 宿主 (src/ui/serve.ts + bridge-server.ts)
                                         持有 PlaywrightCdpAdapter（真机内核）
                                                          │
                                                          ▼
                                              Electron 客户端（CODEBUDDY 9222）
```

要点：
- **浏览器无法直接运行 `PlaywrightCdpAdapter`**（依赖 Node 原生模块），故真机经 WebSocket 桥：页面 `WsKernel` 把 `UiKernel` 调用序列化为 RPC，Node 侧 `bridge-server` 代理到 `PlaywrightCdpAdapter`。
- **演示模式** `DemoKernel` 让 UI 形态/交互可在无真机时查看（供 UI 设计）。
- **录制/回放能力上提至内核**：`UiKernel.playback(script)` 由 `PlaywrightCdpAdapter` 实现（内部 `runCli`），UI 壳不 import 执行器/playwright 链——满足 §4 SOLID/DIP 基线。
- 关键修复：adpater 连接统一用 `127.0.0.1`（避免 `localhost` 解析 `::1` IPv6 导致 `ECONNREFUSED`）。
- **跨进程截图序列化**：`screenshot()` 返回 Node `Buffer`，经 WS 会变成 `{type:'Buffer',data:[...]}`（浏览器无法解码）。修复：`bridge-server.ts:serializeBuffers` 把结果中的 Buffer 递归转 base64（`{__base64}`），`ws-kernel.ts` 还原为浏览器可用的 base64 字符串；`UiShell.startFrameStream` 据此渲染到舞台 `<img>`，解决"蒙版看不到软件页面"。截图流数据路径由 `scripts/verify-ui-live.mjs` 硬断言保护（base64 长度 < 1000 即失败）。

### 2.2 可视化蒙版范式与 CFG + Git 融合模型（正式设计）

> 来源：用户明确要求"嵌入靶机实时交互生成步骤"（pass 掉回头看）、"以顺序/选择/循环三种控制结构组织步骤、参考 CFG"、"Git 式版本管理仅在最外层顺序组支持切分支"。
> 完整交互规格见 `docs/design/visual-mask-ui-spec.md`。本文档为架构单一真相源，须与其同步。

**范式**：蒙版**嵌入靶机叠加层**，用户在软件内直接操作 → 交互经 WS 回传 → **实时追加步骤到 UI 列表**（非停止后批量）。截图流仅用于单步/运行态高亮查看。

**步骤模型（CFG 树，加法式升级 `src/types/step.ts`）**
- `Step` 增加可选递归字段：`children?: Step[]`、`control?: { kind: 'sequence'|'if'|'while'; condition?: Assertion; loopCount?: number }`。
- 叶子步骤 = 现有 8 个 `StepType`（click/fill/select/wait/assert/hover/eval/snapshot）。
- `assert` 复用为"选择组"的判断条件；`wait` 分 `wait(waitMs)` 与 `waitUntil(assertion,timeoutMs)`；`repeat` 由 `control.kind='while'` + `loopCount` 表达（循环体=children）。
- `Script.steps` 仍为 `Step[]`（元素自身可带 children），旧脚本向后兼容。
- schema 升到 `v2`（`SCRIPT_SCHEMA_V2`），`io.ts` 兼容 v1 扁平导入。

**执行器（递归 `runNode`，`src/executor/executor.ts`）**
- `runScript` 改为对每元素调用新增递归 `runNode(node)`：sequence 遍历 children、if 求值 `condition` 后分支、while 按 `loopCount` 回退 children。
- 单叶子步骤逻辑（`selectTarget` + 断言/动作分发）原样复用；`actions.ts`/`assert.ts` 注册表不动（OCP）。

**WS 桥主动推送通道（§2.3 关键设施）— 已实现（R1 录制增量 / R3 运行进度）**

`bridge-server.ts` 原为纯 req/res，现已新增服务端主动推送消息类型 `{ type:'event', event, data }`（与 req/res 同信道但可区分），由 `pushEvent(event, data)` 向全部已连接客户端广播；浏览器侧 `ws-kernel.ts` 以 `on(event, cb)` / `off(event, cb)` 订阅退订。两类事件已落地：

| 事件 | 产生方 | 用途 | 阶段 |
|---|---|---|---|
| `recording` | `adapter.startRecording(onEvent)` 增量回调 | 边操作边追加步骤（实时生成） | R1 |
| `step-progress` | 执行器 `runScript(…, onStep)` 逐叶子上报 | 运行全部时逐步 running/pass/fail 回显 + 高亮跟随 | R3 |

**关键架构约束：进度源必须在 Node 进程内产生，`UiKernel.playback` 必须保持单参数。**
`UiKernel` 有跨 WebSocket 实现（`WsKernel`），**函数无法 JSON 序列化** —— 若把进度回调放进 `playback(script, cb)` 的参数位，真机上回调 100% 丢失，且 `tsc` 与单测（Mock 内核不过 WS）全绿，属 CODEBUDDY.md §4.1 盲区（R3 首版曾因此被打回）。故数据流固定为**单向下行**：

```
executor.runScript(adapter, script, onStep)   ← 进度在 Node 进程内产生（进程内传函数合法）
  → cli.runCli({ onStep })
  → adapter.playback(script, onStep)
  → bridge-server 的 playback 专用分支注册回调
  → pushEvent('step-progress', { stepId, status })   ← 跨 WS 只传可序列化数据
  → ws-kernel.on('step-progress')
  → UiShell.runAll() 消费（更新步骤态 + 高亮跟随）
```

- **`playback` 走专用分支**（同 `startRecording`），不落通用反射转发 `fn.apply`，因需在桥端注册进度回调。
- **运行态不入 `Step` 模型**：`StepRunStatus`（pending/running/pass/fail）存于 `UiShell` 内的 `Map<stepId, StatusI>`。理由 SRP —— `Step` 会被持久化（导出 / 版本 diff），运行态是瞬时 UI 态，混入会污染脚本产物。
- **向后兼容（OCP）**：老内核不发 `step-progress` 时，`runAll` 依 `{ok, failedStepId}` 回填状态（`backfillStatus`），行为不退化。
- **边界兜底**：桥端反射转发 `fn.apply(adapter, sanitizeArgs(req.args))`，`sanitizeArgs` 把 JSON 产生的 `null` 还原为 `undefined`，杜绝服务端默认参数失效的 `null` 陷阱（§4.1）。
- **跨 WS 脚本递归深度校验**：`assertRunnableScript` 在桥边界（不可信 JSON 的唯一入口）一次性递归校验 steps 及每层 `children`（元素形状 / `id` / `type` / `control.kind`），错误带 `steps[i].children[j]` 路径。不校验时坏数据会在执行器抛不带 stepId 的 TypeError，被 `runCli` 吞成 `failedStepId:undefined`，UI 只能显示"(未知)"——静默误提示比崩溃更难排查。执行器 `childrenOf` 作双保险（覆盖 CLI 文件导入 / 未来 MCP Tool 等非 WS 入口）。
- **`StepType` / `ControlKind` 单一真相源**：以 `src/types/step.ts` 的运行时常量数组 `STEP_TYPES` / `CONTROL_KINDS` 为准，类型由 `typeof ARR[number]` 反推。因 TS 联合类型在运行时不存在，而边界校验必须有运行时值可查；若两处各自列举则新增类型时必然漂移（OCP 风险）。
- **桥的 adapter 可注入（DIP）**：`attachKernelBridge(server, port, adapter?)` 第三参可注入，缺省构造 `PlaywrightCdpAdapter`。此前桥内部直接 `new`，导致「真实 WS 线路」必须有 9222 靶机才能测，`step-progress` 跨 WS 这段（恰是 §4.1 出事点）长期无测试覆盖 —— 不可测本身即设计缺陷，故开放注入点，由 `test/bridge-ws-progress.test.ts` 以真 http server + 真 WS 守住该线路。

**已知限制（P3，M4 修）**：`pushEvent` 向所有客户端广播，无 runId/客户端过滤。多标签页同时运行会串扰（各自看到对方进度）。M3 单客户端场景可接受，已记于 `docs/plan/plan.md`。

**Git 式版本层（与 CFG 融合）**
- **版本节点 = 最外层顺序组**（Sequential Group），非单个 Step；仅最外层顺序组支持切分支（选择/循环组内不可切，保控制流合法）。
- 一个 Script = 一条分支链（含嵌套控制结构）；整个脚本库 = 一个仓库。
- 功能 7 项：commit / branch / switch / cherry-pick / history(CFG 融合图) / tag / diff；砍 reset / merge / rebase。
- 落点：新增 `src/script/version-store.ts`（提交树 + 不可变更新），UI 壳 `src/ui/version-panel.ts`（SRP）；`UiKernel` **不**上提版本操作（保持 DIP，版本状态在 UI 侧/本地）。

**增量渲染**：`UiShell.render()` 当前全量 `innerHTML=''`，实时生成与逐步状态会带来高频重渲染；须改为增量 DOM 更新（按 stepId diff）或视图虚拟化，避免步骤多时卡顿（CODEBUDDY.md §4.1 清单 7）。

#### 2.2.1 CFG 图形化视图（M3-R4，新增模块）

> 来源：docs/design/visual-mask-ui-spec.md §2.7「控制流图」；测试规格 `test/cfg-view.test.ts`（47 例，纯 UI 壳内验证，不依赖内核/执行器）。

**组件职责（SRP）**：新增 `src/ui/cfg-view.ts`，对外导出两样：
- `buildCfgGraph(script): CfgGraph` —— 纯函数，把 `Script` 递归转为图模型 `{ nodes, edges }`（`nodes` 为顶层节点、嵌套经 `node.children` 递归；`edges` 为各层级扁平汇总）。与 DOM 解耦，便于单测。
- `class CfgView` —— DOM 渲染组件。只负责画图与上报点击（`onSelect(stepId)`），不决定联动（由 `UiShell` 编排，符合 SRP/DIP）。仅依赖 `Script`/`Step` 类型，**不 import 执行器/playwright/内核**（DIP）。

**图模型约定（与执行器 `runNode` 严格一致，不可自行发明）**：
- `if` 组：`children[0]=then`（边 `kind:'true'`）、`children[1]=else`（边 `kind:'false'`）。依据 `src/executor/executor.ts`：
  `const chosen = result.passed ? branches[0] : branches[1]`。若画反则用户所见流向与真实执行相反——最危险的 UI 谬误。只有一个 child 时不得臆造 false 边。
- `while` 组：循环头→首子 `flow`，末子→循环头 `loop`（回环）；`loopCount` 暴露在节点上供「×N」显示。
- 顺序/顶层兄弟：`flow` 链式边。

**`if` 约定依据的执行器引用**：`src/executor/executor.ts` 的 `runNode`（`chosen = result.passed ? branches[0] : branches[1]`）。图模型以此为准，保证可视化与真实执行一致。

**边界安全（§4.1）**：`buildCfgGraph` 对 `children` 含 `null` 的坏数据跳过而非抛错（渲染路径崩了会白屏）；`setStatus` 对未知 stepId 静默跳过。

**`setStatus` 原地更新（避免高频重渲染，§4.1 清单 7）**：`CfgView` 缓存 `stepId → DOM 节点` 映射，`setStatus` 只改已有节点的 `data-cfg-status`/`class`，**不整树重建**（测试断言前后 `querySelector` 返回同一 DOM 引用）。`update` 幂等（先清再画，同脚本重复 update 不产生重复节点）。

**选中态真相源在 `UiShell`（兄弟视图互不依赖）**：
- `UiShell` 新增 `selectedStepId`，暴露 `selectStep(stepId)` / `getSelectedStepId()` 作为唯一真相源。
- 列表项（`data-step-selected`）与 CFG 节点（`data-cfg-selected`）都订阅它；二者互不耦合。
- 点击列表项 / 点击 CFG 节点都在 `UiShell` 内部挂事件委托触发 `selectStep`（不依赖 `app.ts`）；选中不存在的 id 不产生任何选中态。

**运行态同步（同一真相源）**：`runAll` 的进度回调除更新列表 `stepStatus` Map 外，经 `CfgView.setStatus` 同步到图节点；`render()` 重建 CFG 后用 `stepStatus` Map 回填，保证图节点与列表项状态始终一致、不各算一套。

**状态分发顺序（先落视图、再广播钩子）**：`setStepStatus` 内部先 `cfgView.setStatus(...)` 更新 DOM，**之后**才 `onStepStatusChange?.(...)` 广播。钩子是对外可观测点，订阅者会在回调里读 DOM；若先广播后更新，订阅者读到的是上一步的旧状态（滞后一步）。R3 的高亮占位框曾踩同一个坑。

**以下为 code-review / 可运行性审查打回后的收口（记录以免复发）**

- **禁止在生产路径嗅探测试夹具**：曾有一版为让测试通过，在 `shell.ts` 里判断 `kernel.listeners` 是否存在来走不同订阅分支（mock 走直接增删集合、真机走 `on/off`）。这造成「单测走 A 路径、真机 WsKernel 走 B 路径」，真机分支从未被任何测试执行——正是 CODEBUDDY.md §4.1 盲区的成因。已整段删除：CFG 状态本就由 `setStepStatus` 单点分发，无需第二个 WS 订阅。
- **DOM 查询不拼接选择器**：按 stepId 找 DOM 一律走「属性精确比对」（`shell.findStepItemEl` 遍历 `[data-step-id]` 比对，`CfgView` 用 `Map<stepId, HTMLElement>`），**不用** `querySelector(\`[data-step-id="${id}"]\`)`。原因：stepId 由脚本自由命名，可能含 `"` `\` `]` 空格等 CSS 特殊字符，拼接后在真实 Chromium 抛 `SyntaxError` 使整页 JS 中断，而 jsdom 下只是静默选空（单测用安全 id 时完全看不见）。
- **点击走 mount 级单一事件委托 + `closest`**：不逐节点绑监听、也不用「仅当 `e.target === e.currentTarget` 才响应」。后者会导致点击节点内部文字（真实用户的落点，此时 `e.target` 是 label 子元素）无反应；而测试里的 `el.click()` 恰好 `target === el`，会把该缺陷完全掩盖。委托同时避免大脚本下累积成百上千个监听器。
- **控制流分发用穷尽性检查守 OCP（三处统一）**：按 `control.kind` 分发的**全部三处**（`buildCfgGraph` 建边、`renderNode` 建 DOM、`nodeLabel` 取文案）统一以 `assertNeverControlKind(kind)` 收尾，**不写运行时兜底**。若 `CONTROL_KINDS` 新增类型而某处未补 `case`，该处**编译期报错**；若写成 `default:` 当顺序组处理，新类型会被静默错渲为顺序流向（图与真实执行不符）。已实测：临时给 `CONTROL_KINDS` 加 `'switch'` → `tsc` 在 `cfg-view.ts` 的 3 处分别报 `Argument of type '"switch"' is not assignable to parameter of type 'never'`。
  - 配套：`CfgNode` 设计为**判别联合**（`CfgLeafNode | CfgGroupNode`，以 `isLeaf` 为判别位）。原先单一形状 `kind: StepType | ControlKind` 迫使每处分发 `as ControlKind` 强转，而**强转会破坏 TS 收窄，使穷尽性守卫静默失效**——守卫写了却不生效比没写更危险。
  - 分发时对 `kind` 取局部变量再 `switch`（而非直接 `switch (node.kind)`）：让收窄落在**值**上，`default` 分支里 `kind` 才是 `never`；若对整个对象取 switch，`default` 里 `node` 变 `never`，反而读不出 `node.kind`。
- **编译期守卫 ≠ 运行时安全（三层防护，缺一不可）**：`never` 穷尽性只拦"开发者新增类型忘了改这里"，拦不住**运行时脏数据**。故按"边界拦截 + 渲染降级"分层：
  1. **导入期硬失败**：`src/script/io.ts` 的 `validateSteps` 递归校验 `control.kind ∈ CONTROL_KINDS`，非法抛 `ScriptError`。
  2. **桥边界硬失败**：`bridge-server.assertRunnableScript` 对 WS 传入脚本做同等校验（`CONTROL_KINDS` 单一真相源，两侧自动跟随）。
  3. **渲染层降级（不抛错）**：`CfgView` 的三处分发点遇未知 kind 时 `console.warn` + 渲染为「未知控制结构」占位节点（`data-cfg-kind="unknown"` + `is-unknown` 虚线样式），子节点照画。
  - **为何渲染层必须降级而非 throw**：上述 1、2 只覆盖"本地文件导入"与"WS 传入"两条路径；**录制直接构造 Script、Agent 经 MCP 构造、R5 版本层还原旧数据**都能绕过它们直达渲染层。若渲染层 throw，异常在 `render()` 同步栈内爆开 → **整页白屏**，等于把"静默错渲"升级成"彻底不可用"，更糟。降级后：问题可见（不伪装成"顺序 sequence"误导用户）、页面可用（不白屏）、硬失败留在数据入口。
  - 若未知 kind 流到执行器，`runNode` 的 switch 会跳过该节点（步骤"看起来通过了"其实没执行）——这也是必须在数据入口拦截的原因。
- **选中态：属性与 class 必须同设**：列表项选中经 `markStepItemSelected` 单一入口同时设 `data-step-selected`（程序/测试可查）与 `is-selected` class（CSS 挂点，用户能看见的那一半）。此前只设属性而 `index.html` 无对应规则 → 真机点 CFG 节点时列表侧零视觉反馈，而只断言属性的测试完全看不出来。**只断言 `data-*` 属性无法证明用户看得见**。
- **`CfgView.update` 自行保留选中项**：重建 DOM 会丢选中态，但"当前选中哪一步"属 `UiShell` 层语义，不应因视图内部重建而丢（否则 `resetRunStatus` 后出现"列表有选中、图上没有"的兄弟视图分叉）。`update` 记住旧 `selectedId` 并在重建后恢复；该步已被删除则自然不恢复。
- **展示文案单一真相源**：新增 `src/ui/step-label.ts` 收敛 `TYPE_LABEL` / `describeLocator` / `describeStepBrief`。此前步骤列表与 CFG 视图各存一份 `TYPE_LABEL`，改一处另一处不跟随，会导致同一步骤在列表与图上显示不一致。
- **运行态类型定义位置**：`StepRunStatus` / `StepProgressEvent` 定义在 `src/types/step.ts`（与 `StepType`/`ControlKind` 同处），`shell.ts` 仅 re-export 保持既有引用可用。原因：`cfg-view` 是与列表**同级**的视图组件，若从 `./shell` 引入类型会形成「子组件反向依赖编排者」，与本节声明的 DIP 约定自相矛盾。

---

### 2.3 模块边界与改动面（实现架构）

| 模块 | 文件 | 职责 | 本次改动 |
|---|---|---|---|
| 步骤类型 | `src/types/step.ts` | CFG 递归字段 + v2 schema | 加法扩展（兼容 v1）；**R3**：`STEP_TYPES`/`CONTROL_KINDS` 改为运行时常量，类型由其反推（单一真相源） |
| 执行器 | `src/executor/executor.ts` | 线性→递归 `runNode` | 新增递归调度，复用 `runStep`；**R3**：新增 `StepProgress` 逐叶子进度上报（控制流节点自身不报）+ `childrenOf` 坏子节点守卫 |
| CLI | `src/cli.ts` | 汇总运行结果 | **R3**：`onStep` 透传给 `runScript` |
| CDP 适配层 | `src/cdp/adapter.ts` | 真机控制 | **R3**：`playback(script, onStep?)` 进程内可选进度回调（跨 WS 不传，函数不可序列化） |
| 脚本 IO | `src/script/io.ts` | schema 校验 + 往返 | 增 v2 常量、children 递归校验；**R4**：递归校验 `control.kind ∈ CONTROL_KINDS`（本地导入路径的边界门槛，与桥边界 `assertRunnableScript` 对等，防未知 kind 静默错渲 / 被执行器跳过） |
| 录制内核 | `src/recorder/recorder.ts` + `inject.ts` | 产出扁平叶子 | 不改（仍产叶子）；增量推送在桥/UI 层 |
| UI 壳 | `src/ui/shell.ts` | 编排 + 增量渲染 + 选中态真相源 | 增量 append + CFG 视图挂载；**R3**：`runAll()` + 运行态 `Map`（不入 Step 模型）+ 高亮跟随 + generation token 作废迟到定位；**R4**：新增 `selectedStepId`/`selectStep`/`getSelectedStepId` 选中态唯一真相源，内部事件委托双向联动列表项与 CFG 节点，进度回调经 `CfgView.setStatus` 同步图节点状态（同一 `stepStatus` Map） |
| CFG 视图 | `src/ui/cfg-view.ts`（已实现，M3-R4） | 图形化控制流 | 新增组件（SRP）：`buildCfgGraph` 纯函数（图模型，与 DOM 解耦）+ `CfgView` DOM 渲染（只画图与上报点击，DIP 不 import 执行器/内核）；`setStatus` 原地更新避免高频重渲染；坏数据（`children` 含 null）跳过不抛错 |
| 展示文案 | `src/ui/step-label.ts`（已实现，M3-R4） | Step→人话文案 | 新增（SRP）：`TYPE_LABEL`/`describeLocator`/`describeStepBrief` 单一真相源，步骤列表与 CFG 视图共用，避免两处各存一份而显示不一致 |
| 版本面板 | `src/ui/version-panel.ts`（新） | Git 式版本操作 | 新增组件（SRP） |
| WS 桥 | `src/ui/bridge-server.ts` + `ws-kernel.ts` | RPC + 推送 | 加 event/push 消息类型 + `sanitizeArgs` 兜底；**R3**：`playback` 专用分支 + `pushEvent('step-progress')` + `assertRunnableScript` 递归深度校验 + adapter 可注入（DIP，使 WS 线路可测） |
| 页面 | `src/ui/index.html` | 四区→加 cfg/version 区 | CSS 扩展；**R3**：步骤运行态 class + 失败提示 + 待定位高亮样式 |

**依赖方向**（DIP 不变）：`cfg-view` / `version-panel` / `shell` 仅依赖 `UiKernel` 抽象与 `Script`/`Step` 类型，不 import 执行器/playwright。

**影响**：属架构变更（步骤模型 + 执行器 + 桥协议），code-review 角色须核查本小节同步性（CODEBUDDY.md §5.1/§5.2）。

---

## 3 选型对照

### A. 应用控制

|方案|适用|建议|
|---|---|---|
|**CDP + Playwright（connectOverCDP / _electron）**|Electron 渲染 UI|**主选**|
|agent-browser 等 CLI|Agent/Skill 快速集成|可作 Agent 侧辅路|
|Computer Use（截图+键鼠）|原生菜单、系统框、无 CDP|**降级辅路**|
|纯 UIAutomation 坐标|不推荐作主路径|仅兜底|

**端口**：统一可配置，默认 9222；与 HTTP 代理无冲突（本地入站 vs 出站代理）。

**多应用靶机（方案 C 通用性）**：CDP 适配层以 `webSocketDebuggerUrl` 为唯一入口，`WebviewCdpTarget` 不绑定任何具体应用。因此 CodeBuddy CN 与 WorkBuddy 等 Electron 应用共用同一套 Target 抽象，仅需各自一份靶机配置（端口 + 启动脚本），无需新增 Target 类。靶机清单集中维护于 `scripts/targets.json`，启动脚本（如 `scripts/launch-workbuddy.cmd`）负责以 `--remote-debugging-port` 拉起应用并自检 exe 存在。

### B. Agent 与 Skill

|能力|选型建议|
|---|---|
|浏览器/Electron 操作 Skill|基于现有 Electron/browser Skill 裁剪为「测试向 Skill」|
|现场执行|宿主：Claude Code / Cursor / Codex 等 + 自研 MCP|
|导出脚本|Skill 约定轨迹 → 标准步骤 JSON，禁止只留自然语言日志|

### C. MCP Server

**自研 MCP**（推荐），Tool 最小集：

- app.connect / app.disconnect / app.list_targets
- page.snapshot
- actions.execute_steps（执行脚本）
- record.start / record.stop / record.get_steps
- script.import / script.export / script.update_step
- assert.run
- （P1）agent.suggest_steps / agent.repair_steps

实现语言：TypeScript（与 Playwright/MCP 生态一致）或 Python（与现有自动化栈一致），二选一主栈即可。

### D. 步骤模型（概念）

每步建议字段：id、type（click/fill/select/wait/assert/…）、locator（优先 role/name/text/testid）、params、expect（可选）、source（manual|agent|repaired）、meta（窗口/时间）。

### E. 版本更新触发

|组件|选型|
|---|---|
|文件/版本监听|Python watchdog / Node chokidar；版本号可读 exe 或应用自有 version 文件|
|防抖与「更新完成」|延迟确认 + 进程状态 + 可选「连续 N 秒版本不变」|
|触发 Agent|调用宿主 API/CLI 创建任务（传入任务模板 ID、新版本号、连接参数）；或向队列投递任务由 Worker 拉起 Agent|
|触发脚本|直接调 MCP actions.execute_steps 或本地执行器 CLI|

**结论**：更新触发 Agent **可行**，关键是产品上提供「Agent 任务模板」与「脚本」两种可绑定对象，触发器只发事件。

### F. 录制与润色 UI

|阶段|建议|
|---|---|
|MVP|独立控制台：步骤列表编辑 + CDP 高亮元素；不强制应用内重蒙版|
|增强|透明叠加层显示序号；点选步骤定位|
|数据|全程步骤 JSON，导入导出与 MCP 一致|

**录制实现要点（M3，适配器层）**
- `PlaywrightCdpAdapter` 实现 `Recordable`：`startRecording` 向**全部已枚举 target**（主 page + 每个 webview）注入交互监听（`RECORD_INJECT`，累积于各 target 的 `window.__recBuf`），并开启浏览器级 CDP 监听 `Target.targetCreated`。
- **动态 webview 自动覆盖**：录制中途应用若动态新增 webview，浏览器广播 `Target.targetCreated` → 适配器重新枚举（`refreshTargets`）并将录制监听器注入新 target，新 target 的交互同样被录到（事件按 `target` 标注来源）。`startRecording` 先排空上一轮残留缓冲，避免跨会话串扰；`injectedTargets` 守卫保证不重复注入。
- 层级约束：部分 Electron 构建的浏览器级 target 不支持 `Target.createTarget`（"Not supported"），即测试/外部进程无法凭空铸造新 target；动态新增只能由应用自身运行时触发，走同一套 refresh+inject 路径。
- 该能力已由 `test/integration-dynamic-webview.test.ts`（LIVE 门控，真机验证监听激活 + 注入覆盖全部已枚举 target）覆盖。

### G. 覆盖性与可靠性（回应两大顾虑）

|顾虑|产品+技术对策|
|---|---|
|能否识别全部可交互能力|UC-02/11：可交互集合可导出、可与历史 Diff；业务完整性用断言与抽检，不承诺纯 AI 穷尽业务逻辑|
|更新后如何让 Agent 跑|UC-04：版本事件 → Agent 任务模板；与脚本触发同一管道|
|可靠性未验证|强制保留导出脚本 + 人工润色 + 脚本回放为主路径；Agent 用于生成/探索/辅助修复|

### H. 存储与报告

- 脚本版本库（按应用版本或语义版本打标签）
- 运行记录：日志、逐步截图、失败快照
- **截图落盘**：`CdpAdapter.screenshot` 支持 `savePath` 选项，截图字节直接写入磁盘（目录递归创建），用例以 `existsSync(savePath)` 校验产物真实存在，可被人工打开查看。报告（`./reports/*.md`）汇总步骤与实际结果，与 `fixtures/*-expected.md` 预期契约对照。
- （P2）成功基准快照用于 Diff

---

## 4 推荐实施路线

|阶段|交付|验证问题|
|---|---|---|
|**M1** ✅|CDP 连接 + 步骤执行器 + 断言 + 脚本导入导出 + 简易编辑|脚本能否稳定控目标 App|
|**M2** ✅|可视化能力层 + 真实靶机接入（CodeBuddy/WorkBuddy）|对真机能否做看得见、跨 webview 的集成测试|
|**M3**|可视化 UI 编辑壳（高内聚组件）：脚本导入/编辑/录制/导出 + 对目标软件触发并响应|脚本能否在组件内闭环管理并被目标软件执行|
|**M4**|MCP 全量 Tool + 测试向 Skill|脚本能力能否经 MCP 对外暴露|
|**M5**|Agent 生成全覆盖步骤 + 参考脚本改写（为版本更新后改脚本准备）|脚本能否由 Agent 生成/演化|
|**M6**|版本更新检测 + 更新触发 Agent 任务|版本更新后能否自动驱动脚本维护|

---

## 5 风险清单（产品需知情）

1. 正式安装包关闭 remote debugging → 需测试通道或启动参数策略。
2. 多窗口/webview → 步骤必须带 target。
 Agent 覆盖「业务逻辑」不等于覆盖「全部可点击节点」→ 用结构覆盖率指标，避免过度承诺。
3. Agent 任务触发依赖宿主（CLI/API）能力与配额，需在方案里写清集成方式。