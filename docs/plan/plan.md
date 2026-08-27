# 总体实施计划

> 配套：`requirements/requirements.md`、`architecture/architecture.md`、`design/design.md`、`AGENTS.md`
> 纪律基线：任何实现前先有测试方案/测试代码；实现后以通过测试为迭代目标（详见 `AGENTS.md` §5）。
> 以后的插件（截图+提示词断言、脚本版本控制、Agent 建议步骤）**不在本计划排期**，见需求文档「以后的插件 / 非本轮」。

---

## 0 工程纪律（贯穿所有阶段）

1. **测试先行**：每阶段/每任务动手前，先确定测试方案或在 `test/` 落地测试骨架。
2. **通过测试才算完成**：实现以让测试通过为第一目标，未通过不得合并。
3. **Worktree 隔离**：每个实现任务在 `.cursor/worktree/<name>` 独立工作树进行（`AGENTS.md` §3）。主树只做合并后的可编译基线。
4. **双角色校验**：每个任务完成须过 **test**、**code-review**、**runtime-runnability** 三个角色（`AGENTS.md` §4）。
5. **并行用 Agent team**：可并行子任务用多 Agent / Agent team，各自 worktree + 各自校验。
6. **知识沉淀**：重复任务总结进 `.cursor/skills/`；短约束在 `.cursor/rules/`；完整纪律在 `AGENTS.md`。

---

## 阶段总览

对标 `architecture/architecture.md` §4。不新开与 `AGENTS.md` 冲突的里程碑名。MCP 第一刀已经在仓库根落地，不再写成「要等 M4 才开始」。

| 阶段 | 状态 | 范围 | 验收 |
|---|---|---|---|
| **M1** | ✅ | CDP 连接 + 步骤执行器 + 断言 + 脚本导入导出 + CLI | 脚本稳定控目标 App |
| **M2** | ✅ | 截图/可视化定位 + 真机靶机（CodeBuddy / WorkBuddy / VS Code 启动脚本） | 对真机看得见、可枚举多 webview |
| **M3** | ✅ 主体 | **测试步骤中台**：CFG、录制/回放、导入导出、运行全部、节点旁详情、`shots`、waitUntil、步骤 `target` | 人在真实窗口录、模型写 JSON，同一内核可跑 |
| **M4** | ✅ 第一刀 | stdio MCP（`npm run mcp`）1:1 包装内核 + Skill 工作流 | Agent 在克隆根打开仓库即可遥控中台 |
| **M5** | 计划中 | Agent 分析生成覆盖步骤 + 参考已有脚本改写（为版本更新后改脚本做准备） | 脚本可由 Agent 生成/演化 |
| **M6** | 计划中 | 安装包/应用 **版本更新检测** + 触发一次任务（不是中台里的 Git 脚本版本库） | 版本更新后自动驱动脚本维护 |

M2 当年写过的「多模态大模型视觉断言」没有作为本轮能力交付；像素基线 `screenshotMatches` 仍在断言引擎里，模型视觉见需求插件节。

---

## 已完成切片（实现日程，不是愿望清单）

| 切片 | 内容 | 证据 |
|---|---|---|
| CFG 工作台 | 步骤树 + 图形化控制流（顺序链 / if 两枝 / while 回环）；画布平移缩放；无 minimap | `src/ui/cfg-view.ts`；`test/cfg-view.test.ts`、`test/ui-core-e2e.test.ts` |
| 录制 | 注入 **全部** CDP target；动态 webview 补注入；实时推步；连续 fill 坍缩 | `startRecording`；LIVE 门控 `test/integration-*.test.ts` |
| 回放 | Playwright 真实指针；步骤带 `target`；运行全部进度经 WS `step-progress` | `clickOnPage` / `fillOnPage`；`test/ui-shell-run-all.test.ts` |
| 脚本 IO | v1/v2 schema、可选根字段 `shots`、工作台导入按钮 + 内核 `loadScript` | `src/script/io.ts` |
| MCP stdio | 仓库根 `npm run mcp`；`.cursor/mcp.json` 的 cwd 为 `${workspaceFolder}` | `src/mcp/`；契约测试 `test/mcp-*.test.ts`（与内核同合并） |
| Skill 工作流 | 决策树 + 从零写 JSON / 观察 / 已有脚本 / 扫功能 / 人录制；产物是 Script 不是 click 链 | `.cursor/skills/electron-cdp-test/SKILL.md` |

合并记录（主体）：`feat/cfg-step-model`、`feat/ws-push-channel`、`feat/run-all`、`feat/cfg-view`、`feat/pick-record` 合入 `9d6a4ae`（中台内核、MCP、Skill）。

---

## M1 / M2（历史，已完成）

M1 测试骨架仍在：`test/model.test.ts`、`test/cdp.test.ts`、`test/executor.test.ts`、`test/assert.test.ts`、`test/cli.test.ts`。CLI `npm run run` 仍可直接跑 JSON。

M2 真机接入：`scripts/launch-codebuddy.cmd` / `launch-workbuddy.cmd` / `launch-vscode.cmd`，调试口以脚本返回值为准（CodeBuddy 9222 / WorkBuddy 9233 / VS Code 9244，幽灵口会 +1）。集成测试无 `*_LIVE=1` 时必须 skip。

---

## M3 现状：测试步骤中台

已不是「先交可单测核心、图形 UI 以后再说」。当前 UI 就是中台：

- 顶栏：产品名、已连接/未连接、开始/停止录制、插入 wait/waitUntil/assert、运行全部、导入/导出/清空。
- 左栏步骤流图（CFG pan，点阵在画布 `[data-cfg-dots]`，不在顶栏）；右栏该步截图（`shots` 或补拍）。
- 详情浮动在选中节点旁：确定+删除同一行，四分之一椭圆 X 关闭。
- 文档不滚动；只有详情内部和需要时的 inspector 滚动。
- Git 版本面板默认不挂（`enableVersionPanel`）。

交互细则仍以 `docs/design/visual-mask-ui-spec.md` 为准；软件结构以 `docs/design/design.md` 为准（已按现码重写）。

### 已知仍红的 UI 测试（2026-08-27 实测，docs-only 不修代码）

1. `test/ui-app-boot.test.ts`：`?demo=1` 点开始录制后，断言 `.ui-shell-header` 文案含「录制中」。实现把「录制中：请到靶机…」放在 header **外面** 的横幅，顶栏按钮文案是「停止录制」，所以 header 文本不含「录制中」。
2. `test/workbench-last-ui.test.ts`：断言流图栏 **没有** `[data-cfg-dots]`。实现按产品要求把点阵铺在 CFG 画布上，该用例与现 UI 相反，故失败。同文件其余 5 例通过。

这两条是工程债（测例与现交互不一致），不是新里程碑。修的时候走 worktree，先定测例该跟产品还是产品该跟旧测例。

主链路 `test/ui-core-e2e.test.ts` 仍是 UI 改动的强制门槛。

---

## M4 现状：MCP 第一刀已落地（不是「未来才做」）

已交付：

- stdio Server：`src/mcp/main.ts`，Cursor 默认传输。
- 仓库根启动：`npm run mcp`；`.cursor/mcp.json` 的 `cwd` 必须是 `${workspaceFolder}`，禁止写 worktree 路径。
- Tool 1:1 包装内核。会话：`launch-target`、`workbench.start/stop`、`target.stop`、`app.connect/disconnect/list_targets`。观察+跑：`page.snapshot/screenshot`、`script.open/import/export`、`actions.execute_steps`。探针：`page.click/fill/wait/waitUntil`、`assert.run`、`record.*`。
- Skill：`.cursor/skills/electron-cdp-test`（Anthropic webapp-testing 风格：决策树、命名工作流、Don't/Do）。

未做、仍算 **本计划工程剩余**（不是插件）：

- `script.update_step`（改步走工作台或导出后再 open）。
- 桥事件多标签页 `runId` 隔离（`pushEvent` 仍广播；单客户端可接受）。
- 工作台「手动选连接目标」UI（连接仍走自动探测 + MCP `app.connect` 带 port；本刀不强制改 `src/ui/**` 才能称 MCP 第一刀完成）。

不要把「第一刀已落地」说成「MCP 全量 Tool 已完成」。

---

## 工程剩余（下一刀，仍不是插件）

| 项 | 说明 | 状态 |
|---|---|---|
| 上述两条 UI 测例 | header「录制中」文案位置；`[data-cfg-dots]` 测例与点阵产品化打架 | 仍失败，见 M3 |
| 多客户端 `runId` | 两个标签页同连一桥会串 `step-progress` / `recording` | 已知限制，多标签前再修 |
| 手动选靶机 UI | 顶栏仍自动连探测口；人若要手填端口，工作台还没有独立输入 | 未做 |
| `script.update_step` | MCP 改单步仍缺 Tool | 未做 |

---

## M5 / M6（仍在计划里的产品阶段，未开工）

**M5**：Agent 根据快照生成覆盖步骤、参考已有脚本改写。测试方案：轨迹→Script 可回放；基线脚本+修改意图产出新脚本可回放。依赖已落地的同一 `Step` 模型与 MCP 观察工具，但 **不是** 当前 Skill 里的 `agent.suggest_steps` Tool（那个名字尚未封装，且建议生成属本阶段而不是 v1 插件口）。

**M6**：监听安装目录/exe 版本变化，防抖后触发「跑已有脚本」或「拉起 Agent 任务模板」。这是需求 UC-04，**不是** 中台里的 Git 式脚本版本控制。

---

## 风险与对策（继承 architecture.md §5）

| 风险 | 应对 |
|---|---|
| 正式包关闭 remote debugging | 仅支持调试可达包；错误明确提示测试通道/启动参数 |
| 多窗口/webview | 步骤带 `target`；人靠注入录层，模型靠 list + snapshot |
| 定位脆 | 优先语义化 locator；失败提示降级 css/xpath |
| 过度承诺 AI 覆盖 | 仅做结构快照，业务完整性靠断言与人工抽检 |
| 把 MCP cwd 写成 worktree | 第三方打不开；配置必须 `${workspaceFolder}` 指向克隆根 |
