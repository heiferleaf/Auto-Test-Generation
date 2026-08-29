# Auto-Test-Generation

> 面向 **Electron 桌面客户端** 的测试自动化平台。底层用 CDP 控制真实软件，对外以 **Skill + MCP** 提供能力，支持 **Agent 驱动** 与 **脚本回放** 两种模式。

[![npm test](https://img.shields.io/badge/tests-vitest-blue)](https://github.com/heiferleaf/Auto-Test-Generation)
[![typecheck](https://img.shields.io/badge/typecheck-tsc-green)](https://github.com/heiferleaf/Auto-Test-Generation)
[![license](https://img.shields.io/badge/license-see%20LICENSE-gray)](LICENSE)

**唯一产物是 Script JSON** —— 无论用户录制还是 Agent 生成，最终都是同一份 JSON，两种模式可以随时互换、互相改写。

---

## ✨ 特性

- **真机驱动**：通过 CDP 连上带调试端口的桌面软件（CodeBuddy / WorkBuddy / VS Code 等），操作真实界面，不是模拟。
- **双模式互通**：用户手动录制 ⇄ Agent 生成脚本，产物同构，可互相改写。
- **封闭步骤模型**：10 种步骤类型 + 3 种控制流（顺序 / 选择 / 循环）+ 9 种断言，格式自洽、导入即校验，不会写出「看起来对但跑不了」的脚本。
- **MCP 工具集**：21 个 stdio MCP Tool，Agent 直接用自然语言指挥平台录、探、写、跑。
- **可视化工作台**：网页端导入脚本即可逐步高亮查看，执行时逐步补拍截图。
- **Agent 自证可用 SOP**：生成的脚本必须真实回放跑通才算交付，而非「写完即交付」。

---

## 🚀 快速开始

```bash
npm install
npm test              # 全量测试（vitest）
npm run typecheck     # 类型检查（tsc）
npm run ui            # 起网页工作台（默认 5173，占用则顺延）
npm run mcp           # 起 MCP server（stdio，供 Agent 调用）
```

手动拉起一台靶机（被测试的软件）：

```bash
node scripts/launch-target.mjs --name codebuddy --port 9222
```

> 靶机调试端口：CodeBuddy `9222` / WorkBuddy `9233` / VS Code `9244`（幽灵口会 +1，**以工具返回的实际端口为准**）。

---

## 🏗️ 架构

三层，上层不关心下层实现细节：

```
┌─ Skill + MCP ────────── 对外能力层（Agent 只用这一层）
│    .codebuddy/skills/electron-cdp-test/   给 Agent 的行为准则
│    src/mcp/                              21 个 stdio MCP Tool
├─ 内核（Kernel）──────── 领域层
│    src/cdp/       CDP 连接、多层 target 枚举、元素定位
│    src/executor/  步骤执行、断言
│    src/recorder/  录制注入与事件归并
│    src/script/    Script JSON 校验、导入导出、结构变换
└─ 工作台（UI）────────── 展示层
     src/ui/        网页工作台，可视化编辑 / 运行 / 看图
```

**靶机**：被测试的软件。平台通过 CDP 连上它的调试端口，逐层（target）枚举并操作界面元素。

### 关键概念

| 概念 | 说明 |
|---|---|
| **target（层）** | Electron 常把不同区域做成独立嵌入层（主窗口之外还有 webview），每个 target 有独立 id。写脚本时每步都要带 `target`，否则打到默认层。 |
| **locator** | 元素定位。优先 `{ role, name }` 语义定位，避免 `:nth-of-type(3)` 这类位置选择器。 |
| **Script JSON** | 平台唯一不变式。步骤通过 `children` 递归嵌套，是 CFG 树而非平铺列表。 |

> 架构细节见 [`docs/architecture/`](docs/architecture/)。

---

## 🧰 MCP 工具（21 个）

| 组 | 工具 | 用途 |
|---|---|---|
| **靶机** | `launch-target` | 拉起被测软件，返回**实际**端口（不要假设 9222） |
| | `target.stop` | 停掉本会话拉起的靶机 |
| **工作台** | `workbench.start` | 起网页工作台，返回**实际** URL（端口占用会顺延） |
| | `workbench.stop` | 停掉本会话起的工作台 |
| **连接** | `app.connect` | CDP 连上带调试端口的进程；`appPath` 可直接给可执行文件路径 |
| | `app.disconnect` | 断开 |
| | `app.list_targets` | 列出所有层，**写脚本前先调** |
| **探查** | `page.snapshot` | 某层的可交互节点快照 |
| | `page.click` / `page.fill` | 单步探针（确认 locator 用） |
| | `page.wait` / `page.waitUntil` | 等待；`waitUntil` 支持 `textContains` 等断言 |
| | `page.screenshot` | 截图，可带 locator 画高亮框 |
| **脚本** | `script.import` | **校验并解析** Script JSON（非法步骤类型在这一步被拒） |
| | `script.export` | 序列化为 JSON 字符串（存盘前先调） |
| | `script.open` | 推进工作台 UI |
| **执行** | `actions.execute_steps` | 执行整份脚本，返回 `failedStepId` |
| | `assert.run` | 执行单条断言 |
| **录制** | `record.start` / `record.stop` / `record.get_steps` | 录制并转成 Step[] |

---

## 🧭 两条使用路径

| 场景 | 走法 |
|---|---|
| **A. 用户录制** | `launch-target` → `app.connect` → `record.start` → 用户手动操作 → `record.stop` → `record.get_steps` |
| **B. Agent 生成** | `app.list_targets` → 逐层 `page.snapshot` → 写 Script JSON → 自证可用闭环 → `script.export` 存盘 |

### Agent 生成脚本：必须自证可用

录制出来的步骤天然可用（用户真点过）；**Agent 生成的步骤是推断出来的，第一次就跑通是例外**。因此生成脚本不是「写完交付」，而是「写完开始验」：

```
① 写  →  ② 静态自检  →  ③ script.import（格式校验）
     →  ④ actions.execute_steps（真实回放）  →  ⑤ 按 failedStepId 迭代
```

③④⑤ 不可跳过。最多迭代 3 轮，3 轮不通就停下问用户。

**步骤类型是封闭集合（10 种）**：`click` / `fill` / `select` / `wait` / `assert` / `hover` / `eval` / `snapshot` / `waitUntil` / `repeat`。
**控制流（3 种）**：`sequence`（顺序 / 打包）/ `if`（选择组）/ `while`（循环组）。

> ⚠️ 这是平台自有格式，**不是 Playwright API**。写 `press` / `type` / `dblclick` 这类 Playwright 方法名是最常见的错。完整写法与 Playwright 误写映射表见仓库 Skill 参考 `.codebuddy/skills/electron-cdp-test/reference/script-json.md`（随仓库克隆到本地，不在 GitHub 网页端展示）。

### 可直接复制的提示词

```
帮我测试 CodeBuddy 的「新建会话」功能，脚本存到 D:/scripts/new-session.json
```
```
扫描 WorkBuddy 里所有能点的功能，生成一份覆盖测试脚本
```
```
录一段操作：我在软件里点一遍，你记下来
```
```
上次那份脚本，改成先登录再执行，其余不变
```

---

## 📏 能力边界

| 能做到 | 做不到 |
|---|---|
| CDP 可达的 DOM 元素 | 原生菜单（非 DOM）、系统级弹窗 |
| 多层 webview（需逐层枚举） | 跨域 webview 权限不足的部分 |
| 语义断言（文字 / 存在 / 可见） | 像素级视觉回归（仅轻量基线） |
| Electron 软件 | 非 Chromium 内核的桌面软件 |

**已知限制**：靶机已运行时再拉起会被**单实例锁**接管，调试端口不会开启。要么先关掉软件，要么用 `app.connect` 连现有实例。

---

## 🗺️ 路线图（尚未产品化）

需求中登记、尚未交付的部分（登记处：[`docs/requirements/requirements.md`](docs/requirements/requirements.md)）：

| 项 | 状态 | 说明 |
|---|---|---|
| **脚本版本控制** | 未实现 | 想像 git 一样管理脚本步骤。`src/script/version-store.ts` 有纯数据接口，但未对用户交付 |
| **`agent.suggest_steps` / `agent.repair_steps`** | 未实现 | 根据快照或失败现场自动给出步骤补丁；目前由 Agent 直接写 Script JSON |
| **视觉断言（模型判定）** | 部分 | `visionPrompt` 断言 kind 已就绪，但依赖外部模型，需宿主注入判定函数 |
| **资源自动释放** | 部分 | 工作台 / Agent 自拉靶机可清理；用户自己开的软件刻意不代关，会话级全自动清理待补 |

---

## 🛠️ 开发（贡献指南）

```bash
npm install
npm test              # 全量测试
npm run typecheck     # 类型检查
```

- 实现任务建议在 git worktree 中隔离开发，合并回 `master` 后再删 worktree。
- **测试先行**：先写测试骨架再写实现；完成标准固定为 `npm test` 与 `npm run typecheck` 两条。
- 运行时常量（`STEP_TYPES` / `CONTROL_KINDS` / `ASSERTION_KINDS`，见 [`src/types/step.ts`](src/types/step.ts)）是唯一真相源，任何地方列合法值都要从它生成，禁止手写数组。
- 跨 WS / JSON / CDP 边界必须用 `x = x ?? {}` 兜底（`undefined` 经 JSON 会变成 `null`）。

### 项目布局

```
scripts/targets.json           靶机清单（按 win32/darwin/linux 分支，可增补）
scripts/launch-target.mjs      统一启动器（Node，跨平台）
src/types/step.ts              STEP_TYPES / CONTROL_KINDS / ASSERTION_KINDS 唯一真相源
docs/requirements/             需求（含「以后的插件」唯一登记处）
docs/architecture/             架构详文
docs/design/                   设计规格（含 visual-mask-ui-spec）
```

---

## 📄 License

详见 [LICENSE](LICENSE)。（如需指定协议，欢迎提 PR 补充。）
