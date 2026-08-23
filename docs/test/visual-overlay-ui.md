# 可视化蒙版（UI 壳）功能与交互逻辑规格

> 本文档描述「可视化蒙版 UI 壳」这一图形界面组件的**全部功能**与其**完整交互逻辑**，
> 供 UI 设计人员据此产出界面方案、供实现与测试人员据此验证。
>
> 蒙版是一个运行本地的图形面板（控制台样式），用来对目标软件（CodeBuddy / WorkBuddy 等 Electron 应用）
> 进行「连接 → 录制 → 编辑 → 回放 → 导出/导入」的可视化操作。所有步骤使用统一的 `Step` 结构，
> 脚本以 `.json` 形式保存（schema: `electron-auto-test/step/v1`）。
>
> **实现状态说明（与代码对齐）**：
> - 本章节中的功能按「✅ 已实现」与「📋 模型支持·UI 待补」标注，确保文档不与实现脱节。
> - 代码位置：`src/ui/shell.ts`（内核编排 + 渲染）、`src/ui/app.ts`（浏览器入口 + DemoKernel）、
>   `src/ui/serve.ts`（本地宿主 server）、`src/ui/bridge-server.ts`（真机 WS 桥）、`src/ui/ws-kernel.ts`（浏览器侧内核代理）、
>   `src/ui/index.html`（面板骨架）。
> - 单测覆盖：`test/ui-shell.test.ts`（28 用例，MockKernel 驱动，覆盖连接/目标选择/步骤编辑/断言封装/截图流/回放/高亮/导入导出）。
> - **截图流已落地并真机验证**：`UiShell.startFrameStream()` 定时 `captureFrame()` 拉真实截图渲染到舞台 `<img>`。
>   真机经 WS 桥时，Node 侧把 `Buffer` 序列化为 base64（`bridge-server.ts:serializeBuffers`），`ws-kernel.ts` 还原为字符串，
>   解决"蒙版看不到软件页面"问题。截图流数据路径由 `scripts/verify-ui-live.mjs` 的硬断言（base64 长度 < 1000 即失败）保护。

---

## 1. 总览：蒙版支撑的主链路

```
[连接目标软件] → [录制：在软件里真实操作，蒙版捕获为步骤]
              → [编辑：在步骤列表里增删改/排序]
              → [回放：把步骤打到软件里执行，高亮当前步]
              → [导出 .json 保存]  /  [导入已有 .json 继续编辑]
```

面板布局（控制台样式，已落地于 `index.html`）：
- **顶部状态栏**：应用名、连接状态（已连接/未连接）、录制态（录制中 + 红点指示）。✅ 已实现
- **中间舞台区**：被测软件视图。✅ 已实现 —— **截图流实时刷新 + 坐标高亮叠加层**（Electron 窗口无法被 DOM 真正嵌入，
  故以 `startFrameStream()` 周期拉取 `screenshot()` 真实截图渲染到 `<img>`，用 `locateVisual()` 返回的视觉坐标叠加高亮框）。
  默认 1s 一帧，连接后自动启动（`app.ts` `?live=1` 模式）。
- **右侧步骤列表区**：展示当前脚本所有步骤，用户友好形式（动词 + 定位 + 参数 + 作用目标）。✅ 已实现
  每条步骤自带操作按钮：**↑ 上移 / ↓ 下移 / ✎ 编辑 / ✕ 删除**，点击直接驱动 `UiShell.moveStep/updateStep/removeStep`（shell 自包含，可单元验证）。
- **底部操作栏**：插入步骤 / 加断言 / 开始-停止录制 / 回放 / 高亮示例 / 导出 / 清空。✅ 已实现（演示模式可点）

---

## 2. 功能清单（蒙版具备的全部能力）

### F1. 连接目标软件 ✅ 已实现
- 连接到正在运行且已开启调试端口的目标软件（指定端口，如 9222）。`UiShell.connect({port})` → `kernel.connect()`。
- 连接状态在顶部栏可视（已连接 / 未连接）。
- 真机模式（`?live=1`）：页面经 WebSocket 桥（`/kernel-ws`，Node 侧持有 `PlaywrightCdpAdapter`）连接真实 CODEBUDDY，
  已验证可枚举到多个目标（主窗口 page + 多个 webview）。
- 演示模式（默认）：`DemoKernel` 无需真机即可查看形态。
- 内核可枚举目标（主窗口 page、各 webview），接口为 `kernel.listTargets()`；**UI 壳顶部已渲染目标选择下拉**（连接后自动出现），
  选择即 `UiShell.selectTarget(id)` 并记录 `currentTargetId`，后续录制/断言默认作用于该目标（见 F6）。✅ 已实现

### F2. 脚本管理 ✅ 已实现
- **导入**：`UiShell.importScript(json)` → 经 `ScriptEditor.load` 校验 schema/steps，非法则抛错（明确错误）。✅
- **导出**：`UiShell.exportScript()` → 可读 JSON 字符串（含 schema/app/steps）。✅
- **清空**：`UiShell.removeStep` 逐条移除，或界面「清空」按钮。✅
- **新建**：从空白脚本开始（默认 `UiShell` 构造即空脚本）。✅

### F3. 录制（蒙版内置能力）✅ 已实现
- 点击「开始录制」→ `UiShell.startRecording()` → `kernel.startRecording()`，蒙版进入录制态（顶部红点 + "录制中"）。✅
- 录制期间用户在目标软件里的真实操作（点击/输入/选择/提交等）由内核注入监听器捕获，停止录制时 `kernel.stopRecording()` 返回 `InteractionEvent[]`，经 `Recorder` 转 `Step[]` 并插入脚本。✅
- 一次"填值"合并为一条步骤（内核 `inject.ts` 已做逐字符合并，不保留中间态）。✅
- 录制中软件新开 webview 时，内核 `Target.targetCreated` Watcher 自动把录制覆盖到新窗口（无需用户干预）。✅（内核能力，UI 壳无额外操作）
- 关键防脏数据：UI 壳仅在"确实 start 过录制"时才消费 stop 返回的事件，避免内核缓存事件被误插入。✅
- 每个捕获步骤自动带：操作类型、定位信息（优先语义标识 role/name/testId）、作用目标、参数。✅

### F4. 步骤列表编辑 ✅ 已实现（数据+逻辑+UI）
- **查看**：每步以用户友好文字呈现（`describeStep`：动词 + locator + 参数 + 目标）。✅ 已渲染
- **插入**：`UiShell.insertStep(step, index?)`，界面「插入步骤」按钮 → 弹出步骤类型选择（prompt）。✅ 已落地
- **删除**：每条步骤自带 **✕** 按钮 → `UiShell.removeStep(id)`。✅ 已落地（shell 自包含，可单元验证）
- **修改**：`UiShell.updateStep(id, patch)`；每条步骤 **✎** 按钮 → 触发 `onEditStep` 钩子（宿主 `app.ts` 弹窗编辑）。✅ 已落地
- **重排**：每条步骤 **↑ / ↓** 按钮 → `UiShell.moveStep(id, toIndex)`。✅ 已落地
- 全部编辑为**不可变更新**（返回新 Script），不破坏其他步骤，支持后续撤销/重做扩展。✅

### F5. 回放与验证 ✅ 整段回放已实现；单步/断点/重试为待补
- **整段回放**：`UiShell.playback()` → `kernel.playback(script)` → 内核按序驱动执行，返回 `{ok, failedStepId?}`。✅
  - 设计要点（DIP）：UI 壳**不直接依赖执行器/playwright**，回放交由内核 `playback` 能力编排。✅
- **失败可读**：失败时返回 `failedStepId`，界面可据此标红失败步。✅ 返回失败步标识已实现；
  现场快照/错误原因展示 📋 待补（内核 `screenshot()` 已可获取快照，UI 待接）。
- **单步试跑 / 从某步继续 / 重试该步**：📋 **当前未实现**（文档如实标注，不在本版 UI 壳范围）。
- **可视化高亮**：`UiShell.highlight(locator)` → `kernel.locateVisual(loc)` 返回视觉坐标矩形，
  叠加到中间舞台区（边框高亮）。✅ 手动高亮已实现（界面"高亮示例"/点击步骤项触发）；
  回放时自动跟随当前步高亮 📋 待补。

### F6. 目标（窗口 / webview）指定 ✅ 已实现
- 数据模型 `Step.target` 可指定步骤作用于哪个目标（主窗口或某 webview）。✅ 模型支持
- 内核 `listTargets()` / `selectTarget(id)` 已具备枚举与切换能力。✅ 内核支持
- **UI 壳顶部已渲染目标选择下拉**：连接后自动枚举并展示（标题 + 类型），选中即切换当前目标（`currentTargetId`）。✅ 已落地
- 录制时步骤的 `target` 由内核在捕获事件时自动带上；手动插入/断言时若已选目标则自动填入。✅

### F7. 断言友好封装 ✅ 已实现（用户核心诉求）
用户无需记忆内核断言 kind，以"在软件里某操作之后，验证某个结果"的产品语言表达断言。
- **界面入口**：底部「加断言」按钮 → 依次选择 断言类型(kind) / 定位(locator) / 期望值(value) / 检测前等待(waitMs) → `UiShell.insertAssertion(kind, locator, value?, waitMs)`。
- **用户友好 kind 映射**（`assertionKindLabel`，展示用产品语言）：
  | 用户说法 | kind | 含义 |
  |---|---|---|
  | 出现新元素 | `exists` | 操作后页面出现某元素 |
  | 元素可见 | `visible` | 元素从隐藏变可见 |
  | 值包含内容 | `textContains` | 元素内文本包含某串 |
  | 值等于特定值 | `titleIs` | 元素内文本等于某值 |
  | URL 匹配 | `urlMatches` | 地址栏/页面 URL 匹配正则 |
  | 元素在视口内可见 | `elementVisibleInViewport` | 元素滚动进入视口可见 |
  | 截图匹配 | `screenshotMatches` | 当前画面与基准截图一致 |
  | 表达式成立 | `expr` | 自定义表达式判定为真 |
- **检测前等待（关键）**：`waitMs` 字段让"在某操作之后、验证之前等待 N 毫秒"——用于 **Agent 模型推理/异步渲染留时间**（如点击后模型需数秒才返回结果，才能去断言结果文本）。`Assertion.waitMs` 已落地于 `src/types/step.ts`。
- **作用目标**：断言步骤若已选目标则自动带 `target`，与录制步骤一致。
- **渲染**：断言步骤在列表里以"断言 出现新元素 'xxx' (等 500ms)"形式呈现（`describeStep` 拼接 kind 标签 + 值 + 等待）。

---

## 3. 完整交互逻辑（各功能的使用流程）

### 3.1 连接目标软件 ✅
```
[顶部栏点击「连接」] → UiShell.connect({port:9222}) → kernel.connect()
   → 连接成功：状态栏显示"已连接"
   → 连接失败：内核抛 CdpError（带错误码与原因），UI 可据此提示
```
> 目标枚举（`listTargets`）已具备，目标选择 UI 待补（见 F6）。

### 3.2 录制（核心交互）✅
```
[点击「开始录制」]
   → UiShell.startRecording() → 进入录制态（顶部红点 + "录制中"）
   → 用户在目标软件里正常操作（点击/输入/切换等）
   → 内核注入监听器捕获每次操作（逐字符输入合并为一条 fill）
   → 若软件中途新开 webview：内核 Watcher 自动纳入录制
[点击「停止录制」]
   → UiShell.stopRecording() → 消费捕获事件（仅当确实录制过）→ Recorder 转 Step[] → 插入脚本
   → 退出录制态，步骤出现在右侧列表，可立即编辑/导出
```

### 3.3 步骤编辑 ✅（逻辑）/ 📋（部分交互）
```
选中/操作某步骤 → 调用对应 UiShell 方法：
   插入 insertStep / 删除 removeStep / 修改 updateStep / 重排 moveStep
   → 步骤列表重渲染（不可变更新，原脚本不被就地修改）
   → 可继续编辑或回放
```
> 当前演示页通过"清空"按钮与种子步骤展示列表形态；逐条增删改的按钮 UI 待补。

### 3.4 回放与验证 ✅（整段）/ 📋（单步类）
```
[点击「回放」] → UiShell.playback() → kernel.playback(script)
   → 全部步骤按序执行
   → 成功：返回 {ok:true}
   → 失败：返回 {ok:false, failedStepId}，UI 可标红该步
```
> 单步试跑 / 从某步继续 / 重试该步：📋 待补，不在本版范围。

### 3.5 高亮（视觉核心）✅（手动）/ 📋（回放跟随）
```
触发：点击步骤项 或 点击「高亮示例」
   → UiShell.highlight(locator) → kernel.locateVisual(loc) 返回 {x,y,width,height,visible}
   → 中间舞台区叠加高亮框（坐标来自渲染进程 bounding box）
目的：让用户直观确认"这一步作用在软件的哪个控件"
```
> 回放执行到某步时自动高亮：📋 待补（需在 playback 循环里逐步回调 highlight）。

### 3.6 脚本保存与复用 ✅
```
[导出] → UiShell.exportScript() → .json（演示页触发浏览器下载）
[导入] → UiShell.importScript(json) → 载入步骤列表（schema 错误抛错）
[清空] → 逐条 removeStep / 演示页「清空」按钮
```
导出的 `.json` 可再次导入、回放、或交付其他环节复用。

---

## 4. 运行与验证方式（供测试/实现人员）

- **单元验证**：`npx vitest run test/ui-shell.test.ts`（MockKernel，无需真机，28 用例，覆盖目标选择/步骤编辑/断言封装/截图流）。
- **本地查看面板形态**：`npm run ui` → 打开 `http://localhost:5173`。
  - 演示模式（默认）：使用 `DemoKernel`（浏览器内置演示内核）：无需真机即可查看完整交互形态、步骤渲染、高亮叠加、导入导出。
  - **真机模式**：打开 `http://localhost:5173/?live=1` → 页面经 WebSocket 桥（`/kernel-ws`，Node 侧 `PlaywrightCdpAdapter`）连接真实 CODEBUDDY（默认 9222，可用 `CDP_PORT` 改端口）。
    此时「开始录制 / 停止录制 / 回放」直接作用于真实软件。
- **真机录制端到端验证脚本**（无需人工点浏览器，等价于页面 `?live=1` 的录制路径）：
  先 `npm run ui` 起桥，再 `node scripts/verify-ui-live.mjs` → 走 connect→枚举→注入→录制→捕获→回放 闭环，打印证据。
- **LIVE 真机测试**（vitest，门控 `CODEBUDDY_LIVE=1`）：
  `test/ui-shell-live.test.ts`（UiShell 连真机：枚举目标 / 录制真实操作转步骤 / 回放，3 passed）；
  另有 `test/system-record-replay.test.ts`、`test/integration-dynamic-webview.test.ts`。

---

## 5. 需要 UI 设计人员决定的呈现方式（非功能约束）

以下功能边界已确定，具体**视觉与交互呈现**由设计决定：
1. 整体形态：独立桌面面板（当前控制台样式）/ 应用内嵌边栏 / Web 控制台，是否常驻。
2. 步骤列表呈现：表格 / 时间线 / 树；如何把定位信息显示为可读文字（当前用 `describeStep` 单行摘要）。
3. 录制态指示：红点、计时、已捕获步骤数实时变化的视觉（当前为顶部红点 + 文案）。
4. 高亮视觉：边框色、阴影、脉冲等样式，与暗色 IDE 主题协调（当前为蓝色边框 + 半透明底）。
5. 目标切换 UI：顶部下拉已落地，多窗口/webview 选中标注的视觉风格由设计决定。
6. 失败呈现：失败步的视觉强调、快照缩略图、错误文案排版（📋 待补，内核 `screenshot()` 已可获取快照，UI 待接）。
7. 导入导出交互：文件选择、导出路径（当前导出用浏览器下载，导入接口已就绪）。
8. 编辑交互：逐条 ↑↓✎✕ 按钮已落地；拖拽重排（📋 待补，逻辑层 `moveStep` 已具备）。
