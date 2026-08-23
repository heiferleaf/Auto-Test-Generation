
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

**WS 桥主动推送通道（§2.3 关键设施）**
- 当前 `bridge-server.ts` 为纯 req/res；需新增服务端主动推送消息类型（区分 req/res/event），供"录制增量事件"与"运行逐步进度"下发。
- 边界兜底：除已修的 `screenshot` 外，桥端反射转发 `fn.apply(adapter, req.args)` 须对每方法入参做 `arg ?? {}`（尤其 `wait`），杜绝 `null` 陷阱（CODEBUDDY.md §4.1）。

**Git 式版本层（与 CFG 融合）**
- **版本节点 = 最外层顺序组**（Sequential Group），非单个 Step；仅最外层顺序组支持切分支（选择/循环组内不可切，保控制流合法）。
- 一个 Script = 一条分支链（含嵌套控制结构）；整个脚本库 = 一个仓库。
- 功能 7 项：commit / branch / switch / cherry-pick / history(CFG 融合图) / tag / diff；砍 reset / merge / rebase。
- 落点：新增 `src/script/version-store.ts`（提交树 + 不可变更新），UI 壳 `src/ui/version-panel.ts`（SRP）；`UiKernel` **不**上提版本操作（保持 DIP，版本状态在 UI 侧/本地）。

**增量渲染**：`UiShell.render()` 当前全量 `innerHTML=''`，实时生成与逐步状态会带来高频重渲染；须改为增量 DOM 更新（按 stepId diff）或视图虚拟化，避免步骤多时卡顿（CODEBUDDY.md §4.1 清单 7）。

---

### 2.3 模块边界与改动面（实现架构）

| 模块 | 文件 | 职责 | 本次改动 |
|---|---|---|---|
| 步骤类型 | `src/types/step.ts` | CFG 递归字段 + v2 schema | 加法扩展（兼容 v1） |
| 执行器 | `src/executor/executor.ts` | 线性→递归 `runNode` | 新增递归调度，复用 `runStep` |
| 脚本 IO | `src/script/io.ts` | schema 校验 + 往返 | 增 v2 常量、children 浅校验 |
| 录制内核 | `src/recorder/recorder.ts` + `inject.ts` | 产出扁平叶子 | 不改（仍产叶子）；增量推送在桥/UI 层 |
| UI 壳 | `src/ui/shell.ts` | 编排 + 增量渲染 | 增量 append + 步骤态 + CFG 视图挂载 |
| CFG 视图 | `src/ui/cfg-view.ts`（新） | 图形化控制流 | 新增组件（SRP） |
| 版本面板 | `src/ui/version-panel.ts`（新） | Git 式版本操作 | 新增组件（SRP） |
| WS 桥 | `src/ui/bridge-server.ts` + `ws-kernel.ts` | RPC + 推送 | 加 event/push 消息类型 + 全方法 `?? {}` 兜底 |
| 页面 | `src/ui/index.html` | 四区→加 cfg/version 区 | CSS 扩展 |

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