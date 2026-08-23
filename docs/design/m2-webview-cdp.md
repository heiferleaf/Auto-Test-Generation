# M2-webview-CDP 设计文档：沙箱 webview 元素可达（方案 C）

> 阶段：M2（可视化能力层）的延伸修复 —— 让所有可交互元素（含 Electron 沙箱 webview 内的 UI）对自动化执行器可达。
> 依据：CODEBUDDY.md §5（测试先行）、§4（SOLID/GoF 审查）、用户确认「第二个就按照你说的改」。

## 1. 问题背景与实证

CodeBuddy / WorkBuddy 是 VS Code 系 Electron 应用。其 UI 由若干 `webview` 承载（右侧对话、编辑器、设置面板等）。

**关键实证（真机探针，端口 9222）：**
- `/json` 列出 1 个 `page` + 3 个 `iframe`（CDP 把 webview 归类为 `iframe`）。
- 每个 webview 有独立 `webSocketDebuggerUrl`，直连后其 `document` 是 **webview host 外壳页**（内容是 bootstrap 脚本，约 43018 字符）。
- 真实 UI 在 webview 的**内层 iframe execution context** 中。实证：对话 webview 有 2 个 execution context（`ctx 1` 空 / `ctx 3` 承载 UI），输入框为 `<div role="textbox" contenteditable="true">`，class `input-module_editable_gNSDL`（CSS module hash，不稳定）。
- **已验证**：在 `ctx 3` 中 `document.querySelector('[role="textbox"]')` 成功写入「你好」并读回。

**结论**：方案 C 成立 —— 必须为每个 webview 建立独立 CDP 会话，并在会话内切换到内层 execution context，才能真正操作 webview UI。

## 2. 设计目标

1. `selectTarget(webviewId)` 后，`fill/click/snapshot` 作用于 webview 内层真实 UI。
2. 所有元素可达：page、webview（含其内层 context）。
3. 不破坏既有 page 控制路径（Playwright `connectOverCDP` 对 page 仍稳定）。
4. 测试先行：先写 mock 单测 + 真机集成测试（受 `CODEBUDDY_LIVE` 控制），再实现。

## 3. 架构设计（SOLID / GoF）

### 3.1 抽象：CdpTarget（ISP）

将「一个可被操作的目标」抽象为接口，page 与 webview 各自实现，避免 fat adapter。

```ts
interface CdpTarget {
  readonly id: string;
  readonly type: TargetType;
  listContexts(): Promise<ExecContext[]>;
  /** 默认作用域句柄：page 返回 Page；webview 返回内层 context 的 evaluate 代理 */
  evaluate<T>(expr: string, ctxId?: number): Promise<T>;
  snapshot(): Promise<SerializedNode[]>;
}
```

### ：
- **PlaywrightPageTarget**：page 目标，内部持有 Playwright `Page`，`evaluate` 委托 `page.evaluate`。
- **WebviewCdpTarget**：webview 目标，内部持有 native `WebSocket` CDP 会话（`ws` 库），维护 `executionContexts`；`evaluate(expr, ctxId?)` 向指定（默认内层）context 发 `Runtime.evaluate`。

### 3.2 工厂（Factory / OCP）

`enumerateTargets` 升级为工厂：
- `page` → `PlaywrightPageTarget`（复用现有 Playwright Browser）。
- `webview` → `WebviewCdpTarget`（用 `webSocketDebuggerUrl` 建 native 会话）。
- 新增 target 类型（如 `worker`）只需扩展工厂分支，不动操作核心 → 符合 OCP。

### 3.3 适配器（Adapter）

`PlaywrightCdpAdapter` 保持不变对外接口（`connect/selectTarget/fill/...`），内部把 `current` 从 `TargetEntry` 改为 `CdpTarget`。`fill`/`click` 改为调用 `current.evaluate(...)`；对 `contenteditable` 用 `Input.insertText` 语义。

### 3.4 策略（Strategy，输入框写入）

`fill` 根据元素类型选择策略：
- `<input>/<textarea>` → 设值 + 触发 `input`/`change`。
- `contenteditable` → `Input.insertText`（CDP 真实键盘输入，受控组件友好）。

## 4. 关键接口变更

| 现有 | 变更 |
|---|---|
| `TargetEntry { info, page, frame? }` | → `TargetEntry { target: CdpTarget }` |
| `enumerateTargets(browser, rawTargets?)` | 工厂：webview 走 native CDP 会话 |
| `adapter.scope()` 返回 `Page|Frame` | → `adapter.current.evaluate()` |
| `resolveLocator` 依赖 Playwright `Locator` | → 内层 context 内的 `querySelector` 解析（webview） |

## 5. 风险与缓解

- **内层 context 时机**：`Runtime.executionContextCreated` 可能在 connect 后才到；缓解：connect 后 `Runtime.enable` + 轮询直到出现非空 context。
- **contenteditable 写入**：纯 `textContent=` 部分框架不感知；缓解：优先 `Input.insertText`。
- **真机依赖**：集成测试受 `CODEBUDDY_LIVE` 控制，默认 mock 通过。

## 6. 验收标准

1. 单测：mock 下 `WebviewCdpTarget` 能列出 contexts、切内层 context、`evaluate` 正确转发 `contextId`。
2. 集成（LIVE=1，端口 9222 且已开对话）：`selectTarget(对话webview)` → `fill('[role=textbox]','你好')` → 读回值含「你好」。
3. 既有全量测试保持通过。
