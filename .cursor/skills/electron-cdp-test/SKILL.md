---
name: electron-cdp-test
description: >-
  通过 MCP 给 Electron 桌面软件生成并回放测试脚本 JSON。调用 launch-target、
  workbench.start/stop、app.connect、app.list_targets、page.snapshot、
  page.screenshot、script.open、actions.execute_steps、target.stop。
  产物是脚本文件，不是一串 page.click。用户要测 VS Code、CodeBuddy、WorkBuddy
  或其他 Electron，要写或跑中台脚本、扫功能点、处理嵌套页面时使用。
---

# 测试步骤中台

**产物是 Script JSON**（对象或文件）。MCP 提供观察、会话、回放：先看页面，把 click/fill/waitUntil **写成步骤写进这份 JSON**，再 `script.open` + `actions.execute_steps`。

`page.click` / `page.fill` / `page.wait` / `page.waitUntil` 是可选的**单步探针**，和脚本步骤是同一套原子，不是第二条产品线。不要连调它们 20 次来代替写脚本。

软件或操作还不清楚时，先问：测哪一扇软件？覆盖哪一条操作（例如「发一条聊天」）？会删东西、发到真服务、花真钱 → 先问能不能做。然后进决策树。

缺参或 `null` 当缺省（`args ?? {}`）。`targetId` 省略或 `null` = 当前页，不要把 `null` 当成 id。端口只用 `launch-target` 的返回值，或用户告诉你的号码。

## 决策树

```
用户任务
    ├─ 生成并跑一条操作
    │     待测软件已带调试口在跑？
    │         ├─ 否 → launch-target → 记下返回的 port → 从零写脚本并回放
    │         └─ 是 → 问用户端口（禁止猜 9222）→ app.connect({ port }) → 从零写脚本并回放（跳过 launch-target）
    │
    ├─ 已有 JSON 打开就跑 → 工作流：已有脚本
    ├─ 扫功能点 → 工作流：扫功能
    └─ 人在窗口里录 → 人录制（你不要按录制）
```

## 工作流：从零写脚本并回放

何时：要覆盖一条操作，还没有脚本。

1. `launch-target` `{ "name": "vscode" }`（`codebuddy` / `workbuddy` 同形）  
   用返回的 `port`。调不到本工具 → 问用户端口。禁止让用户跑 cmd、打开 `/json`。
2. `workbench.start` `{}`  
   记下返回的 `url`。
3. `app.connect` `{ "port": <返回的 port> }`
4. **观察**：`app.list_targets` → 对需要的层 `page.snapshot` `{ "targetId": "<id>" }`（必要时 `page.screenshot`）
5. **写出 Script JSON**（`source`: `"agent"`，每步有 `id`）。嵌套页把该层 `id` 写进步骤的 `target` 字段，不要只 snapshot 外层就编 locator。
6. `script.open` `{ "script": <Script> }` — 推进**当前**中台会话
7. `actions.execute_steps` `{ "script": <同一份 Script> }`  
   失败 → 只改 JSON 里失败那一步，再 `actions.execute_steps`（可带 `fromStepId`）
8. 收尾：`app.disconnect` `{}` → `target.stop` `{}` → `workbench.stop` `{}`

## 工作流：观察再写步骤

何时：从零生成的第 4–5 步；扫功能时要认控件；某步 locator 不确定。先观察，再把步骤写进 JSON。

1. **列出嵌套页**  
   `app.list_targets` `{}`  
   结果：`[{ id, type, title, isMain }]`。`type` 为 `page` 或 `webview`。聊天「发送」往往在 `webview`；只 snapshot 外层 `page` 会点空。
2. **看控件**  
   对选中的 id：`page.snapshot` `{ "targetId": "<id>" }`  
   从节点的 `role` / `name` / `text` 认控件。没有目标 → 换下一个 id 再 snapshot。
3. **写进 JSON**（同一 `id` 作为该步 `target`）  
   步骤类型用 `fill` / `click` / `waitUntil`，locator 用 `role`+`name`，不要用 nth css。
4. **可选探针**（不确定 locator 时用一次，确认后仍写回 JSON）  
   `page.fill` / `page.click` / `page.waitUntil` 与脚本步骤同形；禁止用它们串成整条测试。
5. **等到结果**写进 JSON 的 `waitUntil` 步：`kind` 用 `textContains`，`value` 必须是弹层/菜单上那句独特的话。禁止用刚填进输入框的原文。不要只调 `page.wait` 干等。

人在软件里点不用选层，点击落到鼠标底下那一层。你没有鼠标：必须先 `app.list_targets`，再对那个 id 做 snapshot，并把 id 写进步骤 `target`。顶栏网页下拉不是给人录的。

## 工作流：已有脚本

何时：用户已有 Script JSON，要打开并跑。

1. 未连接：走从零的 1–3 步（`launch-target` → `workbench.start` → `app.connect`）
2. 校验：`script.import` `{ "json": "<字符串>" }` 或 `{ "path": "<文件>" }`  
   中台要显示这份稿：`script.open` `{ "script": <Script 或 JSON 字符串> }`（导入按钮仍在中台，你也可以 `script.open`）
3. `actions.execute_steps` `{ "script": <Script> }`  
   失败只修 JSON 那一步再 execute

## 工作流：扫功能

何时：用户说扫一遍功能、扫控件、列能点的入口。

`app.list_targets` → 各层 `page.snapshot` → 把值得覆盖的入口**写成脚本步骤**（或如实告诉用户看见了哪些控件）。点遍可见控件 ≠ 全部网络请求。覆盖到哪一层、哪几个入口，如实告诉用户。没有「扫完全部网络」这种工具。不要对每个入口调一次 `page.click` 当作扫描。

## 人录制

告诉用户：在**已经连上的真实软件窗口**里点，中台会录成步骤。你不要替他按「开始录制」。顶栏网页下拉不是给人录的。

默认不走录制工具。只有用户明确要你控录制内核时才用：`record.start` `{}` →（人点完）`record.stop` `{}` → `record.get_steps` `{}`。需要中台显示时再 `script.open`。

## Don't / Do

| Don't | Do |
|---|---|
| 连调 `page.click` / `page.fill` 当测试产物 | 写出 Script JSON → `script.open` → `actions.execute_steps` |
| 猜端口 9222 | 用 `launch-target` 返回的 `port`，否则问用户 |
| 让用户跑 cmd / 打开 `/json` | 你自己调 `launch-target` / `workbench.start` |
| 跳过 `app.list_targets` 只 snapshot 外层 | 先 list，再 snapshot；id 写进步骤 `target` |
| `{ "css": ".monaco-button:nth-of-type(3)" }` | `{ "role": "button", "name": "发送" }` |
| 填「你好」后 `waitUntil` 含文字「你好」 | 等到弹层上那句独特的话；`kind` 用 `textContains` |
| 点中台网页上的预览 | 对已 `app.connect` 的真实窗口写步骤并 `execute_steps` |
| 编按键、滚动、系统菜单、纯画布按钮 | 能力外先说明点不到，等用户确认再改路 |

## 三步脚本示例

```json
{
  "app": { "name": "VS Code" },
  "steps": [
    {
      "id": "s1",
      "type": "fill",
      "source": "agent",
      "target": "<list_targets 的 id>",
      "locator": { "role": "textbox", "name": "消息" },
      "params": { "value": "你好" }
    },
    {
      "id": "s2",
      "type": "click",
      "source": "agent",
      "target": "<同一 id>",
      "locator": { "role": "button", "name": "发送" }
    },
    {
      "id": "s3",
      "type": "waitUntil",
      "source": "agent",
      "target": "<同一 id>",
      "params": {
        "timeoutMs": 5000,
        "assertion": { "kind": "textContains", "value": "是否覆盖" }
      }
    }
  ]
}
```

步骤上的 `target` 字段执行器已遵守，不要改 Script schema。
