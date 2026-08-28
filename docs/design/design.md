# 测试步骤中台 — M3 软件设计

> 配套：`docs/requirements/requirements.md`（产品目标与用例）、`docs/architecture/architecture.md`（技术选型与模块边界）、`docs/design/visual-mask-ui-spec.md`（工作台交互基线）。
> 本文描述 **当前已经落地的实现**，不是 2025 年「M1 只有 CLI、MCP 留到以后」的承诺。不改 Script schema；注释写行为与原因。

---

## 1 现在的 M3 是什么

产品名是 **测试步骤中台**。当前交付叠在同一套内核上，不是三套互不相通的系统：

1. **工作台（CFG 中台）**：本地网页。人在这里看/编控制流图、导入导出脚本、运行全部、在节点旁打开详情。开始录制之后，操作发生在 **真实软件窗口**，不发生在网页截图上。
2. **stdio MCP**：`npm run mcp` 把同一套内核（连接、快照、录制、执行、把脚本推进当前会话）暴露给 Cursor Agent。MCP 是遥控，不是第二套执行器。
3. **Skill**（`.codebuddy/skills/electron-cdp-test`）：教模型走「观察 → 把步骤写进 Script JSON → `script.open` + `actions.execute_steps`」，让每一步都留在可回放、可编辑的脚本里，而不是把一串裸点击当产物（点完即弃，无法复跑与润色）。

人录制与模型写 JSON 是同一条步骤模型、同一份工作台会话。嵌套页面（外层 `page` 与内层 `webview`）对人：点哪里就录哪一层，不用选手动选层。对模型：没有鼠标，必须先 `app.list_targets`，再对需要的层 `page.snapshot`，并把该层 `id` 写进步骤已有的 `target` 字段。不要为此改 schema。

**明确不在本设计里**：截图 + 提示词交给模型做视觉断言、脚本版本控制。这两项是以后的插件，见 `docs/requirements/requirements.md` 的「以后的插件 / 非本轮」。内核里已有可选的 `version-store` 与像素基线 `screenshotMatches`，不等于那两项产品能力已经作为 v1 MCP Tool 或当前 Skill 内容交付。

---

## 2 双路径与产物

两条路最终都落到同一份 **Script JSON**：

| 谁 | 怎么得到步骤 | 怎么跑 |
|---|---|---|
| 人 | 工作台「开始录制」，在已连接的真实窗口里点/填 | 「运行全部」（内核 `playback` → `runCli`） |
| 模型 | `list_targets` + `snapshot`（必要时截图）后，把 click/fill/waitUntil 写成步骤 | `script.open` 推进当前中台会话，再 `actions.execute_steps` |

`page.click` / `page.fill` / `page.wait` / `page.waitUntil` 是可选的 **单步探针**：locator 不确定时试一次。它们和脚本步骤用同一套原子（同一 `Step`、同一执行器）。产品路径是把步骤写进 Script，再 open + execute，不是再发明一条「只点不写脚本」的模型。

`script.open` 的行为是调用工作台会话的 `loadScript`（桥 RPC + WS 广播 `load-script`），把这份 JSON 推进 **当前已打开的中台**。工作台顶栏的「导入」按钮仍然保留：人从文件选 JSON 也是同一套 `importScript` 校验。`script.import` 只解析/校验，不推进工作台。三条路径并存，不要把可视化理解成「只能 Import」。

---

## 3 分层（与代码目录对齐）

```
┌──────────────────────────────────────────────────────────┐
│  Cursor Agent + Skill（electron-cdp-test）                 │
│  stdio MCP：npm run mcp  →  src/mcp/main.ts               │
├──────────────────────────────────────────────────────────┤
│  测试步骤中台网页：src/ui/（app.ts / shell.ts / cfg-view） │
│  真机经 WS 桥：ws-kernel ↔ bridge-server                   │
├──────────────────────────────────────────────────────────┤
│  内核（MCP 与 UI 共用）                                    │
│  CDP 适配 PlaywrightCdpAdapter / 录制 Recorder            │
│  执行器 runScript + 断言 / 脚本 IO importScript            │
├──────────────────────────────────────────────────────────┤
│  目标 Electron（--remote-debugging-port，端口由 launch 返回）│
└──────────────────────────────────────────────────────────┘
```

浏览器跑不了 Playwright，所以真机必须走 Node 桥。演示模式 `?demo=1` 用内存内核看交互，默认打开是连真机。MCP 进程自己持有一份 `PlaywrightCdpAdapter` 与工作台子进程句柄（`src/mcp/session.ts`），`script.open` 通过已启动的工作台 URL 做 RPC，而不是在 MCP 里再画一套 UI。

跨 JSON / WS / CDP 边界：入参一律 `args = args ?? {}`。`targetId: null` 当缺省（当前页），不要把 `null` 当成 id。函数默认参数在 `null` 传到服务端时不会生效。

---

## 4 统一步骤模型（当前契约，不改字段）

所有模式共用 `src/types/step.ts`。schema 可以是 `electron-auto-test/step/v1` 或 `v2`；`io.ts` 兼容扁平 v1。步骤可带递归 `children` 与 `control.kind`（`sequence` / `if` / `while`），这是 CFG 与执行器已经在用的加法扩展，不是新文件格式。

叶子类型：`click` `fill` `select` `wait` `assert` `hover` `eval` `snapshot` `waitUntil` `repeat`。`repeat` 必须作为带 `children` 的循环组出现，不能当叶子执行。

定位 `Locator`：优先 `role` + `name` / `text` / `testId`，脆了再 `css` / `xpath`。回放不要用某一款 App 的 class 当知识。

断言 `kind` 现有：`exists` `visible` `textContains` `titleIs` `urlMatches` `expr` `elementVisibleInViewport` `screenshotMatches`。`textContains` 的 `locator` 可选：有则只搜匹配到的节点，无则把 snapshot 里各节点的 `text` / `name` / `role` 拼成 haystack。原因：嵌套 `listitem` 上的字可能不在父节点截断后的 200 字里，整页拼接才能等到弹层里那句独特的话。

可选根字段 `shots`：`stepId → png data URL`。步骤对象本身不加 png。导入后未连接也能在舞台看图；无配图且已连接则按叶子补拍。这不是第二种 schema。

`source`：`manual` | `agent` | `repaired` | `recorded`。模型写的步骤用 `agent`。

`target`：window/webview 标识，缺省=当前主目标。执行器按步切换。模型必须把 `list_targets` 的 id 写在这里；人录制时由注入脚本带上事件所在层。

运行态 `pending/running/pass/fail` **不进 Step**，只存在工作台的 Map 里。原因：Step 要导出落盘，瞬时 UI 态混进去会污染脚本文件。

---

## 5 MCP：会话、观察、回放

入口：`npm run mcp` → `src/mcp/main.ts`。在 **仓库根** 跑，不依赖 worktree。配置见仓库里的 `.codebuddy/mcp.json`，`cwd` 必须是 `${workspaceFolder}`，**不要**写成某台机器的绝对路径，也**不要**写成 `.codebuddy/worktree/...`。对方克隆后打开克隆根目录即可，`${workspaceFolder}` 会指向那份克隆。

**启动命令必须抑制 npm 横幅**：`command` 用 `npm`、`args` 用 `["run", "--silent", "mcp"]`。若写成 `["run", "mcp"]`，npm 会往 stdout 注入 4 行横幅（`> electron-auto-test@0.1.0 mcp` 等），违反「stdout 只走 JSON-RPC」的约定，客户端会连上却显示 0 个 tool。诊断信息一律走 stderr。

Tool 是对已有内核的 1:1 封装（`src/mcp/dispatch.ts` 调 `src/index.ts` 导出的能力），不重写 CDP。

### 5.1 会话（本机拉起，不要让用户自己敲 cmd）

| Tool | 行为 |
|---|---|
| `launch-target` | 按当前平台跑 `scripts/launch-target.mjs` + 读 `scripts/targets.json` 的平台分支，返回 **实际** 调试端口。VS Code 目录默认 9244，遇幽灵口会 +1。不要口播「试试 9222」。软件装在非默认位置时改用 `app.connect` 的 `appPath`。 |
| `target.stop` | 按该端口停被测进程。 |
| `workbench.start` / `workbench.stop` | 等价 `npm run ui`，返回打印出来的 URL（占用时可能不是 5173）。已在听则复用；stop 不杀外部实例。 |
| `app.connect` / `app.disconnect` / `app.list_targets` | CDP 连接、断开、列出外层 page 与嵌套 webview。`connect` 的 port 用 launch-target 的返回值。 |

### 5.2 观察 + 跑脚本

| Tool | 行为 |
|---|---|
| `page.snapshot` | 可交互节点。可选 `targetId`，默认当前目标。 |
| `page.screenshot` | 返回 png base64；可选 highlight / 落盘。不改 Script schema。 |
| `script.import` / `script.export` | 校验解析 / 序列化。 |
| `script.open` | `loadScript` 推进当前工作台会话。 |
| `actions.execute_steps` | 内核 `runCli`。步骤上已有 `target` 会被执行器遵守。可带 `fromStepId`。 |

### 5.3 可选单步探针（与脚本步骤同一套原子）

`page.click` / `page.fill` / `page.wait` / `page.waitUntil`、`assert.run`、`record.start` / `record.stop` / `record.get_steps`。

Agent 默认不要替人按录制。人要自己在窗口里点时，告诉他去已连接的真实软件里操作。

**本期未封装（不是插件，是工程剩余）**：`script.update_step`（改步仍走工作台或导出后再 `script.open`）。**以后的插件，不要写进本设计当 v1 Tool**：`agent.suggest_steps`、视觉断言专用 Tool、脚本版本库。

---

## 6 录制、回放、等待

**录制**：`startRecording` 向 **全部已枚举 CDP target**（主 page + 每个 webview）注入监听，并听 `Target.targetCreated`，中途新开的层也会注入。顶栏「当前窗口」下拉在录制中隐藏：人不必先选层。事件带所在 `target`，停止后写入步骤。空 fill 丢弃；同一 locator 连续输入只留最终文本。可交互祖先走到 button/link/input 等，不把 `presentation` / 屏幕阅读器长文案当 `name`。

**回放**：主窗口走 Playwright **真实指针**（`clickOnPage` / `fillOnPage` 的 `page.mouse`），不是 DOM `element.click()`。原因：许多 Electron 壳只认鼠标，合成 click 会「步骤成功、界面不动」。webview 走 CDP 坐标点击。

**waitUntil**：按 `timeoutMs` 轮询 `runAssertion`，默认间隔 200ms。没有 assertion 时退化为死等时长。产品路径里「等到弹层出现某句独特的话」用 `kind: textContains`，不要用刚填进输入框的原文，也不要只调 `page.wait` 干等。

**textContains**：见 §4。有 locator 则只搜该节点；无则搜交互 haystack。

---

## 7 工作台 UI（对照实现，交互细则以 visual-mask-ui-spec 为准）

工作台产品名 **测试步骤中台**。`document.title` 也是这六个字。顶栏可见「已连接 / 未连接」；完整靶机窗口 title 只放 tooltip。

- **没有整页文档滚动**：`html/body/#app` 都是 `overflow: hidden`。CFG 再高也只在栏内 **平移/缩放**，不要冒出页面滚动条。
- **点阵在 CFG 画布上**（`[data-cfg-dots]`），不铺顶栏。页面壳只留跟指针的雾块。
- **浮动层贴节点包围盒**：详情 `[data-detail-anchor=node]`、打包簇 `[data-pack-anchor=bbox]`，按节点盒相对画布重算，不钉画布左上、不占半幅抽屉。
- **详情**：确定与删除同一行等宽。关闭是右上角四分之一椭圆 X（`[data-inspector-close]`，`border-radius: 0 8px 0 100%`），没有「取消」按钮。弹层内 `[data-inspector-scroll]` 可滚；画布本身不用 `overflow: auto`。
- 点节点默认看该步截图（`shots`）；点「编辑」才打开详情。Git 版本面板默认不挂载（`enableVersionPanel` 才出现）。

UI 主链路验收仍走 `test/ui-core-e2e.test.ts` 的 `app.boot()` + `[data-action]`，禁止只用内部 API 冒充用户路径。

---

## 8 内核目录（当前）

```
src/
  types/step.ts          步骤模型与 CONTROL_KINDS / STEP_TYPES
  cdp/adapter.ts         connectOverCDP、录制注入、playback
  cdp/targets.ts         枚举 target；clickOnPage / fillOnPage 真指针
  executor/              runScript / waitUntil 轮询 / 断言
  recorder/              事件 → Step
  script/io.ts           导入导出与 schema 校验
  script/version-store.ts 可选数据层（UI 默认不挂；产品化见需求插件节）
  ui/                    测试步骤中台（serve + 桥 + shell + cfg-view）
  mcp/                   stdio 入口、tool-catalog、dispatch、session
  cli.ts / cli-main.ts   命令行跑脚本（工作台与 MCP 仍复用 runCli）
  index.ts               库导出，避免从内部路径掏 connect/snapshot
```

---

## 9 与后续阶段的边界

M5（Agent 根据页面生成覆盖步骤、按已有脚本改写）和 M6（安装包版本更新后自动触发一次任务）仍是产品方向，见计划与需求用例，不在本文展开接口。不要把它们和「脚本版本控制插件」「模型视觉断言插件」混成一件事：前者是调度与生成，后者是中台里的可插拔增强。
