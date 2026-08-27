# Electron 自动化测试平台 — M1 设计文档

> 配套文档：`requirements/requirements.md`（产品目标与用例）、`architecture/architecture.md`（技术选型手册）
> 本文档聚焦 **M1（最小可跑通脚本闭环）** 的工程设计与接口定义，技术栈 **TypeScript**。

---

## 1 目标与范围

### 1.1 M1 交付物（来自architecture/architecture.md §4）

| 交付项 | 说明 |
|---|---|
| CDP 连接 | 连接目标 Electron 应用并枚举 target（window/webview），选中主操作目标 |
| 步骤执行器 | 解释步骤 JSON，逐条执行操作 + 断言 |
| 断言 | 元素存在/可见、文案包含、URL/标题、自定义表达式 |
| 脚本导入导出 | 读写标准步骤 JSON（脚本库），导入导出与 MCP 一致 |
| 简易编辑 | 步骤列表的增删改（为 M2 录制、M3 MCP 全量 Tool 打基础） |

**M1 验收问题**：脚本能否稳定控目标 App（见 §8）。

### 1.2 本期不做（明确边界）

- 版本监听触发（M2）
- 录制 UI（M2）
- MCP 全量 Tool / 测试向 Skill / Agent 执行导出（M3）
- 更新触发 Agent 任务 / 失败 Diff 补丁（M4）
- 原生菜单/系统文件框控制（降级方案，architecture/architecture.md §3-A）

---

## 2 分层架构（M1 视角）

```
┌─────────────────────────────────────────┐
│  脚本库（本地 JSON 文件，按应用版本打标）   │
├─────────────────────────────────────────┤
│  CLI / 入口：加载脚本 → 调执行器          │
├─────────────────────────────────────────┤
│  Executor：步骤解释器 + 断言引擎          │
├─────────────────────────────────────────┤
│  CDP Adapter：Playwright connectOverCDP   │
│    - connect / listTargets / selectTarget│
│    - click / fill / select / wait / eval  │
├─────────────────────────────────────────┤
│  目标：Electron 客户端（--remote-debugging-port=9222）│
└─────────────────────────────────────────┘
```

> M1 以 **CLI + 库** 形态交付（不强制 MCP/UI）。MCP Server 在 M3 接入，但其 Tool 语义已在 §6 预留，M1 的执行器/适配器可直接复用。

---

## 3 目录结构（TypeScript）

```
electron-auto-test/
├── package.json
├── tsconfig.json
├── src/
│   ├── types/
│   │   └── step.ts            # 统一步骤模型（§4）
│   ├── cdp/
│   │   ├── adapter.ts         # Playwright connectOverCDP 封装
│   │   └── targets.ts         # 枚举/选择 window/webview
│   ├── executor/
│   │   ├── executor.ts        # 步骤解释器主循环
│   │   ├── actions.ts         # click/fill/select/wait 实现
│   │   └── assert.ts          # 断言引擎
│   ├── script/
│   │   ├── io.ts              # 导入/导出 JSON
│   │   └── edit.ts            # 增删改步骤（简易编辑）
│   ├── cli.ts                 # 入口：run <script.json> [--app <path>] [--port 9222]
│   └── index.ts               # 库导出（供 M3 MCP 复用）
├── scripts/                   # 示例脚本库（JSON）
│   └── demo-login.json
└── docs/
    ├── requirements/requirements.md
    ├── architecture/architecture.md
    └── design/design.md
```

---

## 4 统一步骤模型（核心）

所有模式（录制、Agent 轨迹、导入导出、MCP Tool、执行器）共用此 JSON 结构。

```typescript
// src/types/step.ts
export type StepType =
  | 'click' | 'fill' | 'select' | 'wait'
  | 'assert' | 'hover' | 'eval' | 'snapshot';

export type Locator = {
  // 优先级：role/text/name/testid > css > xpath
  role?: string;
  name?: string;        // accessibility name
  text?: string;        // 可见文本（模糊/精确）
  textExact?: boolean;
  testId?: string;      // data-testid
  css?: string;
  xpath?: string;
};

export type Step = {
  id: string;                       // 唯一，便于编辑/Diff
  type: StepType;
  target?: string;                  // window/webview 标识；缺省=主目标
  locator?: Locator;                // click/fill/select/hover/assert 用
  params?: {
    value?: string;                 // fill 的文本 / select 的 option
    optionText?: string;            // select
    durationMs?: number;            // wait
    key?: string;                   // wait 文本/键
    code?: string;                  // eval 的 JS
    assertion?: Assertion;          // assert 用
  };
  expect?: Assertion;               // 步骤级可选期望
  source: 'manual' | 'agent' | 'repaired' | 'recorded';
  meta?: {
    window?: string;
    timestamp?: string;
    note?: string;
  };
};

export type Assertion = {
  kind: 'exists' | 'visible' | 'textContains' | 'titleIs' | 'urlMatches' | 'expr';
  locator?: Locator;               // exists/visible/textContains 用
  value?: string;                  // textContains/titleIs/urlMatches/expr 用
};

export type Script = {
  schema: 'electron-auto-test/step/v1';
  app: { name: string; version?: string };
  steps: Step[];
  createdAt?: string;
  note?: string;
};
```

**设计要点**
- `target` 必带意识：architecture/architecture.md 风险清单 #2 强调"多窗口/webview → 步骤必须带 target"。M1 允许缺省（默认主目标），但结构预留。
- `source` 字段贯穿录制↔Agent↔修复（UC-07/08/10），为 M3/M4 留痕。
- 定位优先语义化（role/name/text/testid），脆了再降级 css/xpath（呼应 UC-05 异常）。

---

## 5 CDP 适配层设计

基于 **Playwright `connectOverCDP`**（architecture/architecture.md §3-A 主选）。

```typescript
// src/cdp/adapter.ts（接口摘要）
export interface CdpAdapter {
  connect(opts: { port?: number; appPath?: string; launchArgs?: string[] }): Promise<void>;
  disconnect(): Promise<void>;
  listTargets(): TargetInfo[];          // window/webview 列表
  selectTarget(id: string): void;       // 设主目标
  click(loc: Locator): Promise<void>;
  fill(loc: Locator, value: string): Promise<void>;
  select(loc: Locator, option: string): Promise<void>;
  hover(loc: Locator): Promise<void>;
  wait(opts: { text?: string; durationMs?: number }): Promise<void>;
  eval(code: string): Promise<unknown>;
  snapshot(): Promise<SerializedNode[]>; // 可交互元素清单（UC-02 雏形）
  query(loc: Locator): Promise<ElementHandle | null>;
}
```

**连接策略**
- 若给定 `appPath`：以 `--remote-debugging-port=9222` 启动应用后连接。
- 若给定 `port`：直接 `chromium.connectOverCDP('http://localhost:' + port)`。
- 端口默认 9222，可配置（architecture/architecture.md §3-A）。
- 生产包禁用调试（风险 #1）：M1 仅支持可开调试端口的包/测试通道；启动时检测端口连通性并报明确错误（UC-01 异常）。

**target 选择**：`listTargets()` 返回 CDP 目标，按类型过滤 `page`/`webview`，首个作为主目标；`selectTarget` 切换（多窗口场景）。

---

## 6 执行器与 MCP Tool 语义对齐

M1 执行器内部循环即后续 MCP Tool 的语义来源（architecture/architecture.md §3-C）：

| 执行器能力 | 对应未来 MCP Tool |
|---|---|
| `executor.run(script)` | `actions.execute_steps` |
| `cdp.snapshot()` | `page.snapshot` |
| `script.io.import/export` | `script.import` / `script.export` |
| `UiShell.loadScript` / 桥 RPC `loadScript` | **`script.open`**（把 Script JSON 推进**当前工作台会话**；工作台「导入」按钮仍保留） |
| `script.edit.*` | `script.update_step` |
| `cdp.connect/listTargets` | `app.connect` / `app.list_targets` |
| `assert.run` | `assert.run` |

> M1 不实现 MCP Server 进程，但将上述方法在库函数中对齐语义，M4 封装为 Tool，避免重写。第一期 MCP 必须含 **`script.open`**：Agent 在对话里生成脚本后，把同一份 JSON 推进当前 UI 会话（内核已有 `loadScript` + 桥 RPC）。这**不是**替代 `script.import`（文件解析）也不是替代工作台「导入」按钮——三条路径并存。不要把可视化理解成「只能 Import」。

---

## 7 脚本导入/导出格式

- 文件：`*.json`，结构见 §4 `Script`。
- 导入：`script/io.ts` 校验 `schema` 字段，缺字段给明确错误。
- 导出：执行器/录制产出步骤数组 → 包裹为 `Script` 写入。
- 简易编辑：`script/edit.ts` 提供 `insertStep/removeStep/reorderStep/updateStep`，供 CLI 子命令或后续 UI 调用。
- 脚本库：`scripts/` 目录按应用/版本组织，M2 起接入版本标签（architecture/architecture.md §3-H）。

---

## 8 M1 验收标准

1. 给定一可开调试端口的 Electron 应用，CLI `run demo-login.json --app <path>` 能连上并跑通登录主路径（click/fill/assert）。
2. 步骤 JSON 与 §4 模型一致；`script.export` 产出的 JSON 可被 `script.import` 原样加载并回放。
3. 断言失败时能输出：失败步骤 id、当前快照、明确错误信息（为 M2 录制/Diff 留接口）。
4. 多 target 场景下，带 `target` 字段的步骤能正确作用于指定 window/webview。
5. 连接失败（端口占用/生产包禁用）返回明确错误码，不静默崩溃。

---

## 9 后续阶段接口预留（不实现，仅标注）

| 阶段 | 复用点 |
|---|---|
| M2 版本监听 | 触发 `executor.run(script)`；监听用 chokidar/watchdog（architecture/architecture.md §3-E） |
| M3 MCP/Skill | `index.ts` 库函数封装为 Tool；录制产步骤 → `script.export` |
| M4 Agent 任务 | `executor` 输出轨迹 → `Script`；失败快照 → Diff（UC-10/11） |

---

## 10 风险对照（architecture/architecture.md §5）

| 风险 | M1 应对 |
|---|---|
| 正式包关闭 remote debugging | M1 仅支持调试可达的包；错误明确提示需测试通道/启动参数 |
| 多窗口/webview | 步骤带 `target`；适配器 `listTargets/selectTarget` |
| 定位脆 | 优先语义化 locator；失败时提示降级 css/xpath |
| 过度承诺 AI 覆盖 | M1 不碰 Agent 覆盖断言，仅做结构快照（UC-02 雏形） |
