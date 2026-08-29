# Script JSON 参考

## 顶层结构

```json
{
  "schema": "v2",
  "app": { "name": "VS Code" },
  "steps": [ ... ],
  "shots": { "s1": "data:image/png;base64,..." }
}
```

- `steps`：步骤数组，每个元素可递归嵌套 `children`（见"控制流组"）
- `shots`：**可选**根字段，`stepId → png data URL`。**执行器完全不读它**，带图不影响执行
- 旧脚本（v1 扁平结构）可正常导入

## 步骤通用字段

```json
{
  "id": "s1",              // 必填，用于失败定位与 fromStepId 续跑
  "type": "click",         // 见下方类型表
  "source": "agent",       // agent / manual / repaired
  "target": "<层 id>",     // 来自 list_targets，省略则用当前层
  "locator": { ... },      // 定位元素，见下方
  "params": { ... }        // 依 type 而定
}
```

**`id` 必须全局唯一且稳定**——失败时靠它定位，续跑时靠它找起点。

## 步骤类型

**这是封闭集合，只有这 10 种。** 不在列表内的 type 一律被拒绝（导入期就报错，不会等到执行）。

| type | 用途 | 关键 params |
|---|---|---|
| `click` | 点击元素 | — |
| `fill` | 填充输入 | `{ "value": "..." }` |
| `select` | 下拉选择 | `{ "optionText": "..." }` |
| `hover` | 悬停 | — |
| `wait` | 固定等待 | `{ "durationMs": 1000 }` |
| `waitUntil` | 等条件成立 | `{ "assertion": {...}, "timeoutMs": 5000 }` |
| `assert` | 断言 | `{ "assertion": {...} }` |
| `snapshot` | 取快照 | — |
| `eval` | 在页面里执行 JS | `{ "code": "..." }` |
| `repeat` | 重复执行子步骤 | `children` + `control.loopCount` |

### 不是 Playwright API

本平台格式与 Playwright 没有任何关系。**别把 Playwright 的方法名写进来** —— 这是最常见的错：

| 写了这个 ❌ | 改成 |
|---|---|
| `press` / `type` | 要按键 → `eval`（`code` 里派发事件）；要填文本 → `fill` 直接给最终值 |
| `dblclick` | `eval`，或两次 `click` |
| `check` / `uncheck` | `click` 那个 checkbox |
| `goto` / `reload` | `eval`（`location.href = ...` / `location.reload()`） |
| `waitForSelector` | `waitUntil` + `{ "assertion": { "kind": "exists", ... } }` |

导入时若命中这类名字，报错里会带上对应的改写建议。

## Locator（定位元素）

按优先级选用，语义化优先：

```json
{ "role": "button", "name": "发送" }      // 推荐：控件类型 + 名称
{ "role": "textbox", "name": "消息" }
{ "text": "提交" }                         // 按文字
{ "testId": "submit-btn" }                 // 按 data-testid
{ "css": ".submit" }                       // 兜底：仅当无语义信息时
{ "xpath": "//button[1]" }                 // 最脆，尽量避免
```

**避免位置依赖选择器**（`:nth-of-type(3)` 之类）——界面一调整就断。

## Assertion（断言）

```json
{ "kind": "textContains", "value": "发送成功" }
{ "kind": "visible", "locator": { "role": "status" } }
{ "kind": "exists", "locator": { "role": "button", "name": "发送" } }
```

**同样是封闭集合，只有这 9 种。**

| kind | 含义 | 用 `value` / `locator` |
|---|---|---|
| `textContains` | 快照文本中包含指定文字（会搜索嵌套节点的文字） | `value` = 要找的文字；`locator` 可选（缺省搜整页） |
| `visible` | 元素可见（按快照的 rect 面积判定） | `locator` 必填 |
| `exists` | 元素存在 | `locator` 必填 |
| `titleIs` | 窗口标题等于指定值 | `value` |
| `urlMatches` | 地址匹配 | `value` |
| `expr` | 页面内 JS 表达式求值为真 | `value` = 表达式 |
| `elementVisibleInViewport` | 元素在视口内可见（滚动位置影响结果） | `locator` 必填 |
| `screenshotMatches` | 截图比对 | `value` |
| `visionPrompt` | 截图交给视觉模型判定（最后手段，见 SKILL.md） | `value` = 给模型的提示词 |

所有断言都支持可选 `waitMs`：检测前先等 N 毫秒，给异步渲染留时间。

**`textContains` 的 `value` 必须是操作产生的新结果上那句独特的话**，不能是刚输入的内容。

### 断言有效性自检

把断言单独放在操作**之前**，如果它也能通过 → 恒真 → 无效。

- ❌ 填"你好"后断言"页面有你好"：填之前没有，但这是自己造成的，不证明发送功能正常
- ✅ 点发送后断言"出现对方回复"：证明发送+接收链路真的通了

## 控制流组

步骤可嵌套 `children` 表达流程，脚本是 CFG 树而非平铺列表：

```json
{
  "id": "grp-1",
  "type": "assert",
  "control": { "kind": "if", "name": "如果登录了" },
  "params": { "assertion": { "kind": "visible", "locator": { "role": "button", "name": "退出" } } },
  "children": [
    { "id": "g1-then", "type": "wait", "control": { "kind": "sequence" }, "children": [ ... ] },
    { "id": "g1-else", "type": "wait", "control": { "kind": "sequence" }, "children": [ ... ] }
  ]
}
```

| control.kind | 含义 | children 约定 |
|---|---|---|
| `sequence` | 顺序组 | 依次执行 |
| `if` | 选择组 | `children[0]` = 条件成立分支，`children[1]` = 否则分支 |
| `while` | 循环组 | 循环体，`control.loopCount` 控制次数 |

**`if` 的分支顺序不能写反**：第一个子项是条件成立时走的路径。

## 完整示例

```json
{
  "app": { "name": "CodeBuddy" },
  "steps": [
    { "id": "s1", "type": "fill", "source": "agent", "target": "webview-chat",
      "locator": { "role": "textbox", "name": "消息" },
      "params": { "value": "你好" } },
    { "id": "s2", "type": "click", "source": "agent", "target": "webview-chat",
      "locator": { "role": "button", "name": "发送" } },
    { "id": "s3", "type": "waitUntil", "source": "agent", "target": "webview-chat",
      "params": {
        "timeoutMs": 5000,
        "assertion": { "kind": "textContains", "value": "很高兴为你服务" }
      } }
  ]
}
```

## 截图（shots）

- 是**根字段**，不在 step 对象内，执行器不读，**不影响执行**
- Agent 自己执行（`actions.execute_steps`）时无需产生截图——执行路径没有可视化界面
- 用 `script.open` 推进工作台时，工作台会在**已连接状态下自动补拍**逐步高亮截图（有 locator 的步骤高亮该元素，无 locator 的拍整页）
