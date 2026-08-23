# 可视化测试方案（M2 设计文档）

> 配套：`requirements/requirements.md`、`architecture/architecture.md`、`design/design.md`、`plan/plan.md`（M2 已前移为 P0）
> 目标：补齐"可视化"能力，使平台从"代码级单测"升级到"集成/系统测试"层级。
> 被测对象：`CodeBuddy CN`（`C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe`）、`WorkBuddy`。

---

## 1 为什么需要可视化（问题定义）

M1 的执行内核已能通过 CDP 把步骤打到 Electron 应用（click/fill/assert）。但 M1 的"可交互元素清单"来自 **DOM / 可访问性树**，存在盲区：

| 维度 | DOM/可访问性树 | 可视化（截图+坐标） |
|---|---|---|
| 元素是否存在/可见 | ✅ | ✅ |
| 元素在屏幕上的位置/大小 | ❌（只有逻辑层级） | ✅ bounding box |
| "界面看起来对不对"（布局、遮挡、样式、视觉回归） | ❌ | ✅ |
| 多 webview 布局关系 | ❌ | ✅ |

**结论**：没有可视化，集成/系统测试只能"盲操作 + 盲断言"，等价于代码单测。可视化是打通上层测试层级的关口。

---

## 2 测试层级映射

| 层级 | 用到的能力 | 例子 |
|---|---|---|
| 单元 | M1 执行器/断言单测（mock adapter） | assert textContains 命中 |
| 集成 | M1 执行器 + **真实 CDP 连接 CodeBuddy** + snapshot | 连上 IDE、枚举 webview、跑登录脚本 |
| 系统 | 集成 + **截图/视觉断言 + 预期结果报告** | 截图比对、关键元素 bounding box 在视口、输出"预期 vs 实际" |

---

## 3 可视化能力设计

### 3.1 截图采集（ScreenshotCapable）
扩展 `CdpAdapter`（或派生接口），新增：
- `screenshot(opts?: { target?: string; element?: Locator; fullPage?: boolean }): Promise<Buffer|string>`
  - 整窗 / 指定 webview / 指定元素三种粒度。
- 返回 PNG 路径或 base64，供后续断言与人工查看。

### 3.2 元素视觉定位（VisualLocator）
- `locateVisual(loc: Locator): Promise<{ x: number; y: number; width: number; height: number; visible: boolean }>`
  - 基于 `adapter.eval` 在渲染进程内取 `getBoundingClientRect` + `getComputedStyle`。
  - 补 DOM 树无坐标之不足，支持"元素在视口内""不重叠"等视觉断言。
- `SerializedNode`（M1 已定义）扩展字段：`rect`、`visible`、`screenshotRef`。

### 3.3 视觉断言（VisualAssertion，扩展 M1 断言引擎）
在 `assertionHandlers`（M1.5 已为策略注册表）中**追加**以下 kind（OCP：只加一项）：
- `screenshotMatches`：当前截图与基线图比对（像素差异低于阈值 / 结构性比对）。基线存 `scripts/baselines/`。
- `elementVisibleInViewport`：用 `locateVisual` 判定元素 rect 在视口内且 `visible`。
- `visualLooksLike`：调用多模态大模型，传入截图 + 描述，返回"是否符合"。属增强能力，M2 先定义接口与 stub，真实调用可在 M4/M5 接入。

> 所有新增 kind 通过 `assertionHandlers` 注册表扩展，**不动核心**（继承 M1.5 OCP 债已偿还的成果）。

### 3.4 叠加蒙版 + 手动触发 UI（终态形态的最小原型）
对应需求终态"在可视化 UI 中手动调用 Agent 生成的测试脚本"。
- **MVP（M2）**：独立控制台/Web 面板，加载 Script → 列表展示步骤 → 选中步骤时在 CodeBuddy 窗口用 `locateVisual` 高亮对应元素（overlay 或边框高亮）→ 支持"单步试跑""从某步继续"。
- **增强（M5）**：透明叠加层显示步骤序号、点选步骤定位、应用内重蒙版。
- 数据：全程步骤 JSON，与 M1 模型一致。

---

## 4 与 M1 架构的对齐（改动面评估，SOLID）

| 模块 | 改动 | 影响 |
|---|---|---|
| `CdpAdapter` | 加 `screenshot` / `locateVisual`（ISP：可由 `VisualCapable` 派生，避免胖接口——偿还 M1 复核的 P1 ISP 债） | 真实实现在 `PlaywrightCdpAdapter` 补两方法 |
| `SerializedNode` | 加 `rect`/`visible`/`screenshotRef` | 快照更丰富 |
| `assertionHandlers` | 追加 3 个视觉 kind | **OCP 友好，零改核心** |
| `Step`/`Locator` | 无需改 | 复用 |
| 执行器 | 无需改 | 断言引擎自动识别新 kind |

**可扩展性**：接入 MCP Tool（M4）、Agent 视觉分析（M5）时，只新增注册项/接口实现，改动面收敛。

---

## 5 真实靶机接入（CodeBuddy / WorkBuddy）

### 5.1 启动方式（用户已确认 exe 路径）
经 exe 加 `--remote-debugging-port=9222` 启动即开放 CDP：
```
"C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe" --remote-debugging-port=9222
```
- 验证端口：浏览器/HTTP 打开 `http://localhost:9222/json`，返回目标列表即成功。
- WorkBuddy 同理（路径待用户提供，结构相同）。

### 5.2 多 webview 挑战
CodeBuddy IDE 含多个 webview（编辑器、侧栏、终端、AI 面板）。M2 重点验证：
- `listTargets()` 能枚举多个 webview 并区分。
- `selectTarget(id)` 能切换到指定 webview 执行步骤。
- 截图/视觉定位能指定 target。

### 5.3 安全（UC-12）
- 真机测试涉及登录态/写文件，默认**条件跳过**（CI/无 exe/端口占用时 skip），需本地显式启用。
- 敏感输入掩码存储；不默认自动启动带调试端口的生产包。

---

## 6 M2 测试方案（测试先行）

先于实现存在：
1. `test/integration-codebuddy.test.ts`：**集成测试，写文件说明预期结果**（见 §7）。真机部分条件跳过，但测试代码与"预期结果说明"必须先落地。
2. `test/visual.test.ts`：用 mock adapter 验证 `screenshot`/`locateVisual` 接口与视觉断言 kind 注册正确。
3. `test/multi-webview.test.ts`：验证多 target 枚举与切换（mock + 真机可选）。

---

## 7 集成测试"预期结果说明"文件规范

`test/integration-codebuddy.test.ts` 配套 `test/fixtures/codebuddy-expected.md`，以**人类可读文件**声明每一步操作的预期结果，测试运行时对照实际输出生成报告。示例结构：

```markdown
# CodeBuddy 集成测试 - 预期结果

## 步骤 1：连接 CodeBuddy（端口 9222）
- 预期：连接成功，无 CDP 错误
- 预期：listTargets 至少返回 1 个 page + 若干 webview（编辑器/侧栏/终端/AI）

## 步骤 2：打开命令面板（Ctrl+Shift+P）
- 预期：出现命令输入框（role=textbox 或特定 locator 可见）

## 步骤 3：截图主窗口
- 预期：截图非空白（尺寸 > 0，文件存在）

## 步骤 4：视觉断言 - 侧栏可见且在视口内
- 预期：locateVisual(侧栏) 返回 visible=true 且 rect 在视口范围

## 步骤 5：文本断言 - 欢迎/标题包含 X
- 预期：textContains('...') 通过
```

测试输出：`test/reports/codebuddy-run-<timestamp>.md`，列出"预期 vs 实际"对照，失败步骤标红。

---

## 8 M2 验收标准

1. 对 CodeBuddy 真机：连接成功、多 webview 可枚举与切换、可截图、可做视觉断言。
2. 集成测试文件含明确的"操作预期结果"说明，并能产出"预期 vs 实际"报告。
3. 叠加蒙版手动触发 UI 有最小可用原型（控制台列步骤 + 高亮元素）。
4. 新增视觉能力通过 `assertionHandlers` 注册扩展，核心零改动（OCP 维持）。
5. 真实连接测试默认条件跳过，需本地显式启用（安全）。
