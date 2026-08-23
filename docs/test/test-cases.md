# 测试清单（M1–M3）

> 本文档汇总 `test/` 目录下全部测试的内容与期待结果，供集成测试 / 系统测试参考。
> 测试命令本身固定不变（见 CODEBUDDY.md §5.1）：日常 `npm test` 全量跑（真机用例自动 skip），
> 真机测试靠 `CODEBUDDY_LIVE=1` / `WORKBUDDY_LIVE=1` 环境变量开启，命令仍是 `npm test -- <文件>`。

## 运行矩阵

| 层级 | 默认 `npm test` | 真机（LIVE） |
|---|---|---|
| 单元 / 集成前基础层（1–12 号文件） | ✅ 全跑 | — |
| `webview-cdp` 的 mock 部分 | ✅ 全跑 | 其真机用例需 `CODEBUDDY_LIVE=1` |
| 集成 / 系统 / 录制（13–17 号文件） | ⏭ skip | ✅ 需 `CODEBUDDY_LIVE` / `WORKBUDDY_LIVE` |

**目录约定**
- `test/fixtures/`：预期结果说明文件（`*-expected.md`），被集成测试读取作对照契约。
- `test/reports/`：真机测试运行时自动生成的「预期 vs 实际」报告与截图落盘产物。

---

## 1. 单元测试（默认全跑，不依赖靶机）

### `test/cdp.test.ts` — CDP 适配层接口契约
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| listTargets 返回 page+webview | 验证 `listTargets()` 覆盖两类目标 | 结果同时含 `type==='page'` 与 `type==='webview'` |
| selectTarget 切换 webview | 调用 `selectTarget('wv1')` | adapter 调用记录含 `'select:wv1'` |
| 真实连接冒烟（`describe.skip`） | 永久跳过的占位，未用环境变量 | 默认不执行 |

### `test/assert.test.ts` — 断言引擎各 kind（M1 执行器）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| textContains 命中 | snapshot 含 `'Welcome Dashboard'` | `r.passed===true` |
| textContains 未命中 | snapshot 仅 `'Login'` | `passed===false` |
| exists 命中 | `query` 返回非空 | `passed===true` |
| 未知 kind 抛错 | `kind:'unknown'` | `rejects.toThrow(/kind/i)` |

### `test/visual.test.ts` — M2 可视化接口 + 视觉 kind 注册
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| screenshot 返回非空 Buffer | mock 适配器截图 | `Buffer.isBuffer` 且 `length>0` |
| screenshot 选项透传 | 传 element/target/fullPage | 实际入参与期望值完全相等 |
| locateVisual 返回视觉位置 | 调 `locateVisual` | 含 `{x,y,width,height,visible}`，`visible` 为布尔 |
| 两个视觉 kind 已注册 | `elementVisibleInViewport` / `screenshotMatches` | 均为 function，可调用 |
| runAssertion 分发视觉 kind | 传视觉 kind | 返回含 `passed` 的结果，不抛未知 kind |
| SerializedNode 携带 rect/visible | 编译期契约 | `n.rect?.width===1`、`n.visible===true` |

### `test/assert-real.test.ts` — 真实断言判定（消除"假绿"，M1.5）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| titleIs 命中/不匹配 | `eval('document.title')` 分别返回 `'Demo Login'`/`'Other'` | `passed` 依次为 `true`/`false` |
| urlMatches 正则命中 | `href` 含 `/home`，`value:'/home$/'` | `passed===true` |
| urlMatches 包含比对 | `href` 含 `'login'`，`value:'login'` | `passed===true` |
| expr 真/假 | `eval` 返回 `1+1===2` / `1>2` | `passed` 为 `true`/`false` |
| visible 命中且可见 | 节点 `visible:true` | `passed===true` |
| visible 命中但隐藏 | 节点 `visible:false` | `passed===false` |
| visible 无匹配节点 | snapshot 为空 | `passed===false` |

### `test/path.test.ts` — Windows 路径归一化回归护栏
> 捕获 `new URL().pathname` 产出 `/D:/` 伪 POSIX 路径 + cwd 拼接导致双重盘符 ENOENT 的 bug。
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| 标准绝对路径 | `resolveAssetPath` | 以 `/` 或 `盘符:` 开头，不匹配 `/[A-Za-z]:/` 与双重盘符 |
| 可创建并写入 | dirname 后 mkdirSync+writeFileSync | 不报 ENOENT，`existsSync` 为真、读回内容正确 |
| basename 正确 | — | 返回 `'codebuddy-expected.md'` |

### `test/model.test.ts` — 步骤模型与脚本导入/导出（M1 验收 §8-2）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| 合法 click 步骤字段 | 构造 step | 含 `id/type/locator.name/source` 且正确 |
| 断言步骤携带 value | `textContains` | `expect.kind==='textContains'`、`value==='Welcome'` |
| 步骤可带 target | 指向 webview | `step.target==='webview-settings'` |
| 导出→导入往返一致 | `exportScript`→`importScript` | `toEqual(sample)` |
| 非法 schema 抛错 | `importScript` 坏数据 | 抛 `/schema/i` |
| 缺 steps 抛错 | `importScript` 无 steps | 抛 `/steps/i` |

### `test/recorder.test.ts` — M3 录制采集器（Recorder）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| 单事件→单 Step | record 一个 click | 字段与模型一致（type/target/source/locator） |
| 累积顺序 | click→fill | 类型数组 `['click','fill']`，fill 值 `'你好'` |
| size / reset | — | `size===2`，`reset()` 后 `size===0` 且 `toSteps()` 空 |
| buildScript 合规 | — | `schema===SCRIPT_SCHEMA`、含 `app.name/version/note` |
| assert 事件补丁 | assert 事件 | `params.assertion` 含 `{kind:'exists', locator}` |

### `test/cli.test.ts` — CLI 入口（runCli）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| 成功路径 | 正常 stub 跑 demo 脚本 | `res.ok===true` |
| 失败路径 | click 抛错 | `res.ok===false` 且 `res.failedStepId==='s2'` |

### `test/executor.test.ts` — 步骤执行器（runScript，M1 验收 §8）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| fill+click 映射 | mock adapter 跑步骤 | `calls` 等于 `['fill:admin','click']`（顺序与映射正确） |
| assert 失败抛结构化错误 | assert 失败 | `rejects.toMatchObject({stepId:'s1'})` |

### `test/editor.test.ts` — M3 ScriptEditor 不可变编辑 + 录制回放闭环
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| insert 不改原对象 | insert 到位置 | 原 `steps` 仍长 2，新序 `['s1','s3','s2']` |
| remove 按 id | — | 剩余 `['s2']` |
| update 合并补丁 | 改值 | 新值 `'root'`，原对象仍为 `'admin'`（不可变） |
| move 重排 | — | `['s2','s1']` |
| load 校验非法 JSON | `load('{ not json')` | 抛 `ScriptError` |
| roundTrip 等价 | 导出→导入 | `back` `toEqual(base)` |
| 录制脚本可回放 | Recorder→runCli | `res.ok===true` |
| 编辑后仍可回放 | 插入 fill 前置 | `res.ok===true` 且 `steps` 长 2 |

### `test/webview-cdp.test.ts` — M2 方案 C：webview 内层 context 可达
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| 列出 contexts 并识别内层 UI | 推送 ctx1(默认)/ctx3(内层) | `findUiContext()===3` | 否 |
| evaluate 转发内层 | — | 返回值 `'你好'` 且 `capturedCtx===3` | 否 |
| fill contenteditable | — | 发出 `Input.insertText`，`text==='你好'` | 否 |
| 原始 target 建 WebviewCdpTarget | 带 webSocketDebuggerUrl | entries 长 2、类型 page/webview | 否 |
| CodeBuddy 内层输入框可达 | 连 9222，找 `[role=textbox]` 的 webview | fill `'你好'` 后读回含 `'你好'`（30s 超时） | **是** |

### `test/targets.test.ts` — CDP target 分类（iframe→webview 偏差修正）
| 用例 | 测试内容 | 期待结果 |
|---|---|---|
| page 保持 | `type:'page'` | `'page'` |
| iframe 归 webview | `type:'iframe'`（真机偏差点） | `'webview'` |
| worker/other 透传 | `type:'worker'` | `'worker'` |
| 无 type 回退 | 缺 type | `'page'` |

---

## 2. 集成 / 系统 / 录制测试（LIVE 门控）

> 以下全部需要靶机 GUI 已启动（管理员运行 `scripts/launch-codebuddy.cmd` 开 9222 / `launch-workbuddy.cmd` 开 9233）。
> 无环境变量时整文件 skip。

### `test/integration-codebuddy.test.ts` — CodeBuddy 真机（端口 9222）
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| 步骤1 连接+枚举多 webview | 连 9222 | `targets.length>0`、`pages.length>=1` | 是 |
| 步骤2 主窗快照非空 | `snapshot()` | 节点数 `>0` | 是 |
| 步骤6 标题断言 | `document.title` | 含 `'codebuddy'` | 是 |
| 步骤4 截图非空白且落盘 | `screenshot({savePath})` | 字节 `>0` 且 `existsSync` 真 | 是 |
| 步骤5 侧栏可见且在视口 | `locateVisual({name:'侧栏'})` | `visible===true` 且 `inViewport===true` | 是 |
| 契约自查 | 读 `fixtures/codebuddy-expected.md` | 文件非空且含 `'预期'`（默认跑） | 否 |

### `test/integration-workbuddy.test.ts` — WorkBuddy 真机（端口 9233）
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| 步骤1 连接+枚举多 webview | 连 9233 | `targets.length>0`、`pages.length>=1` | 是 |
| 步骤2 截图非空白且落盘 | `screenshot({savePath})` | 字节 `>0` 且文件存在 | 是 |
| 步骤3 webview 内层可达 | 找含 `[role=textbox]` 的 webview | `dialogWv` 为真（方案 C 跨应用） | 是 |
| 契约自查 | 读 `fixtures/workbuddy-expected.md` | 文件非空且含 `'预期'`（默认跑） | 否 |

### `test/integration-recording.test.ts` — M3 真机录制监听
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| fill+click 被捕获并回放 | 注入受控元素→`startRecording`→`fill/click`→`stopRecording` | `events.length>0`、含 fill+click、`fillEv.locator.name==='rec-input'`、`value==='你好'`；经 `runCli` 回放 `res.ok===true` | 是 |

### `test/integration-dynamic-webview.test.ts` — M3 动态 target 自动注入
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| 监听激活 + 注入覆盖全部已枚举 target | 独立浏览器级 CDP 监听 `Target.targetCreated`；`startRecording` 后检查 | `targetCreatedCount>0`（监听在跑）、`before.length>0`、每个已枚举 target `eval('!!window.__recInstalled')===true`、能录到主 target 的 click（`target` 非空） | 是 |

### `test/system-record-replay.test.ts` — M3 系统闭环
| 用例 | 测试内容 | 期待结果 | LIVE |
|---|---|---|---|
| 多 target 录制捕获主 page 交互 | 注入受控元素→录制 fill/click | `events.length>0`、含 fill+click、`fillEv.locator.name==='rec-input'`、`value==='你好系统测试'`、`fillEv.target` 非空 | 是 |
| 导出→导入→回放全链路 | 录制→`exportScript`→`importScript`→`runCli` | `reloaded.steps.length===script.steps.length`、回放 `res.ok===true` | 是 |

---

## 3. 汇总表

| 文件 | 用例数 | LIVE | 主题 |
|---|---|---|---|
| `cdp.test.ts` | 3（1 skip 占位） | 否 | CDP 适配层接口契约 |
| `assert.test.ts` | 4 | 否 | 断言引擎各 kind |
| `visual.test.ts` | 7 | 否 | M2 可视化接口 + 视觉 kind 注册 |
| `assert-real.test.ts` | 9 | 否 | 真实断言判定（消除假绿） |
| `path.test.ts` | 3 | 否 | Windows 路径归一化回归 |
| `model.test.ts` | 6 | 否 | 步骤模型 + 脚本导入/导出 |
| `recorder.test.ts` | 5 | 否 | Recorder 采集器 |
| `cli.test.ts` | 2 | 否 | CLI 成功/失败返回 |
| `executor.test.ts` | 2 | 否 | 步骤执行器映射 + 断言失败抛错 |
| `editor.test.ts` | 8 | 否 | ScriptEditor 编辑 + 录制回放 |
| `webview-cdp.test.ts` | 5（1 LIVE） | 部分 | M2 方案 C webview 内层 |
| `targets.test.ts` | 4 | 否 | CDP target 分类偏差修正 |
| `integration-codebuddy.test.ts` | 6（5 LIVE + 1 自查） | 是 | CodeBuddy 真机 + 可视化 |
| `integration-workbuddy.test.ts` | 4（3 LIVE + 1 自查） | 是 | WorkBuddy 真机（方案 C 通用） |
| `integration-recording.test.ts` | 1 | 是 | M3 真机录制→回放 |
| `integration-dynamic-webview.test.ts` | 1 | 是 | M3 动态 target 监听与注入 |
| `system-record-replay.test.ts` | 2 | 是 | M3 系统闭环 |

**统计**：17 个文件、约 71 个 `it` 用例。默认 `npm test` 跑 1–12 号（含 `webview-cdp` 的 mock 部分与两集成文件的契约自查）；13–17 号及 `webview-cdp` 真机用例需 `CODEBUDDY_LIVE` / `WORKBUDDY_LIVE`。
