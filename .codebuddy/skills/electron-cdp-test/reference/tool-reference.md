# Tool 参考

按"解决什么问题"组织，不是按字母顺序。所有 Tool 的入参里，`null` 与"不传"等价。

---

## 一、让软件进入可控状态

### `launch-target`
**解决**：你无法自己启动一个带调试能力的桌面软件。

```
{ "name": "vscode" }        // 或 codebuddy / workbuddy
{ "name": "vscode", "port": 9244 }   // 可选：指定端口，省略用该靶机默认值
```
返回 `{ name, port, jsonUrl, label }`。**`port` 必须记下并用于后续 `app.connect`**——端口被占用时软件会自动换一个，猜 `9222` 会连错。

⚠️ **平台限制**：这条走的是 `scripts/launch-*.cmd`（Windows 批处理），底层的 `scripts/targets.json` 里
exe 路径目前写死为某台 Windows 机器的个人目录。**macOS / Linux 上不要用这条**，
改走 `app.connect` 的 `appPath`（见下）。

### `target.stop`
**解决**：测完把被测软件关掉。
```
{ "port": 9244 }     // 省略则用本会话 launch-target 返回的端口
```

### `app.connect` / `app.disconnect`
**解决**：建立/断开控制通道。不连接则后续所有操作都不可用。

两种连法：

```
// 连已带调试端口运行的软件
app.connect { "port": <launch-target 返回值，或用户告知的端口> }

// 由平台拉起软件：给可执行文件位置，平台自动加 --remote-debugging-port
app.connect { "port": 9244, "appPath": "<可执行文件完整路径>" }
```

**`appPath` 要可执行文件本身，不是目录**：

| 平台 | 传什么 |
|---|---|
| Windows | `C:\...\XXX.exe` |
| macOS | `/Applications/XXX.app/Contents/MacOS/Electron`（`.app` 是文件夹，直接传启动不了） |
| Linux | `/usr/bin/code` 之类可执行文件路径 |

用 `appPath` 时平台会自己启动进程并轮询 `/json/version` 直到就绪（约 15s 超时）。
这条是**跨平台的首选路径**——`launch-target` 依赖的 `scripts/launch-*.cmd` 目前是 Windows 专用。

`app.disconnect {}` 断开连接。

### `workbench.start` / `workbench.stop`
**解决**：打开/关闭网页工作台（给人看脚本和截图用的界面）。
```
workbench.start {}    // 返回 { url }，端口占用时可能不是 5173
```
Agent 自己执行脚本时不需要它；只有要把脚本推给人看时才开。

---

## 二、看懂界面

### `app.list_targets`
**解决**：**回答"这个软件里有哪些可以操作的页面层"**。

这是必做步骤，不是可选项。Electron 软件常把聊天区、侧边栏做成独立的嵌入层，目标控件往往不在主窗口里。

返回 `[{ id, type, title, isMain }]`，`type` 为 `page`（主窗口）或 `webview`（嵌入层）。**`id` 要写进步骤的 `target` 字段**。

### `page.snapshot`
**解决**：**回答"这一层上有哪些可以操作的控件"**。

你看不见界面，这是获取界面信息的唯一途径。
```
{ "targetId": "<list_targets 的 id>" }   // 省略/null = 当前层
```
返回可交互节点列表，每个节点带 `role`（控件类型）、`name`（名称）、`text`（文字）。据此决定点什么。

**没找到目标控件时，换一个 `targetId` 再快照**，不要就此下结论说"没有这个控件"。

### `page.screenshot`
**解决**：看界面长什么样（返回 png base64）。快照已能满足大部分需求，截图用于需要视觉确认时。
```
{ "targetId": "...", "highlight": { "role": "button", "name": "发送" }, "savePath": "..." }
```
`highlight` 会在图上高亮指定元素；`savePath` 可落盘供人工查看。

---

## 三、执行测试

### `actions.execute_steps`
**解决**：**真正跑一遍脚本**，这是测试的主体动作。
```
{ "script": <Script 对象或 JSON 字符串>, "fromStepId": "s2" }
```
返回 `{ ok, failedStepId }`。失败时改 JSON 里那一步，可用 `fromStepId` 从指定步骤续跑，不必重头。

### `script.open`
**解决**：把脚本推进网页工作台，**让人看到步骤列表、CFG 图和逐步截图，由人决定何时运行**。

与 `actions.execute_steps` 的区别：后者是你自己跑拿结果，前者是交给人在界面里操作。工作台在已连接状态下会自动为各步骤补拍高亮截图。

### `script.import`
**解决**：校验并解析一份脚本（写完后自检，或读取已有文件）。
```
{ "path": "x.json" }   // 或 { "json": "<字符串>" }
```

### `script.export`
**解决**：把脚本序列化成 JSON 字符串落盘。
```
{ "script": <Script 对象> }
```

---

## 四、单步探针（辅助）

**定位**：验证不确定的定位，确认后**仍要写回 Script JSON**。禁止连调多次代替写脚本——探针不产生可复用的产物。

| Tool | 用途 |
|---|---|
| `page.click` | 点一次，确认 locator 对不对 |
| `page.fill` | 填一次值 |
| `page.wait` | 等时长或等某段文字出现 |
| `page.waitUntil` | 轮询直到断言成立 |
| `assert.run` | 执行单条断言 |

---

## 五、录制内核（默认不用）

人在真实软件窗口操作时，中台会自动录成步骤，**你不要替他按"开始录制"**。

只有用户明确要求你控制录制内核时才用：
```
record.start {}  →（人操作完）  record.stop {}  →  record.get_steps {}
```

---

## 未封装

`script.update_step` —— 改单步请走工作台，或 `script.export` 改完再 `script.open`。

---

## 跨 Tool 的通用约束

- **端口只用 `launch-target` 的返回值**，或用户明确告知的号码
- **`targetId` 省略或 `null` = 当前层**，不要把 `null` 当成一个 id 传
- **缺参当缺省**：跨 JSON 边界 `null` 等同未传，不会当成有效值
