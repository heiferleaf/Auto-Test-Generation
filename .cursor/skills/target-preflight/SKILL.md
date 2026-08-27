---
name: target-preflight
description: >-
  生成脚本前先探测：app.connect 后 app.list_targets，再对每个 targetId 做 page.snapshot，
  确认用户能看见的字出现在控件名字或文本里。换 VS Code、CodeBuddy、WorkBuddy
  或其他 Electron、准备写步骤、或用户说扫不到某段可见文字时使用。
---

# 写步骤前先探测

生成脚本前跑完。端口只来自 `launch-target` 返回值，或用户告诉你的号码。不要猜 9222。

```
- [ ] 换了待测软件或端口
- [ ] 准备生成脚本
- [ ] 用户说扫不到回复、弹层、或某段看得见的文字
```

## 调用顺序

1. `app.connect` `{ "port": <launch-target 返回值> }`
2. `app.list_targets` `{}` — 记下每条 `id` / `type`（`page` / `webview`）
3. 对每个 `id`：`page.snapshot` `{ "targetId": "<id>" }`
4. 用户能看见的那几个字，必须出现在某个节点的 `name` 或 `text` 里。不要用刚填进输入框的原文。

聊天区可能在 `webview`。只 snapshot 外层 `page` 就下结论会漏「发送」。

## 这一帧没扫到就停

- 看得见的列表项或气泡，快照里没有对应节点
- 弹层/菜单上的独特文字不在 `name` / `text` 里
- 控件全在还没 snapshot 过的那一层

先换一个 `targetId` 再 `page.snapshot`。在快照里看见它之前，不要生成依赖这段文字的步骤，也不要编某一款软件的 CSS class。
