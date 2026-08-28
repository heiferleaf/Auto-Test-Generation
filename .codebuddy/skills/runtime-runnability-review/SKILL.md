---
name: runtime-runnability-review
description: 本项目可运行性审查角色。只要有代码修改就必须使用。专抓编译/单测全绿但真实路径会崩的盲区，以及跨 WS/JSON/CDP 的 undefined→null 问题。性能优化必须先有测试守住功能。
---

# 可运行性审查

独立于实现者与 code-review。只要改了代码就必须跑。

## 为什么需要

M3 曾出现 `screenshot` 经 WebSocket 崩溃：`JSON.stringify` 把 `undefined` 变成 `null`，函数默认参数 `= {}` 对 `null` 不生效，随即 `null.target` 抛错。`tsc`、Mock 单测、走 `args:[]` 的 verify 都绿，只有浏览器 `WsKernel` 真传 `undefined` 才爆。

## 清单（命中任一项 = 不通过）

1. 跨进程边界：被调函数体内用 `x = x ?? {}`，不要依赖默认参数。`opts.x` 访问前确认 `opts` 在 null/undefined 下安全。
2. 对外方法显式传 `null` / `undefined` / `''` / `[]` 各跑一次。
3. Mock 通过不等于真实路径通过。确认 `PlaywrightCdpAdapter` / `WsKernel` 在真机或近真机跑通一次。
4. UI/脚本入口要有冒烟证据：`npm run ui` 后 `http://localhost:5173/?live=1` 截图流真实出图；或 `scripts/verify-ui-live.mjs`。返回值必须有效（截图 base64 不能过短）。

## 性能与复杂度审查

可运行性（不崩）通过后，再查实现代码的执行性能与算法复杂度。本节前提是**接口不变、功能不变、测试先绿**：性能优化必须在已有测试守住功能的前提下进行（与 `test-first-dev` 一致），禁止在无覆盖的路径上「顺手优化」——没有测试守的优化和没有测试守的重构一样，改完无法证明没改坏行为。

### 前提与红线

- 优化前先确认该热点路径已有测试覆盖（单测或 UI 主链路 E2E）。没有就先补测试，再动实现。
- 禁止为压性能改公共接口、改测试断言、改 `Step`/`Script` schema 或 WS 桥协议。这些是更高级别的契约，性能不构成破坏它们的理由。
- 禁止为压性能去掉 `?? {}` 兜底或 `sanitizeArgs` 的 null→undefined 还原——跨 WS/JSON/CDP 边界的 null 陷阱正是本角色第一职责要防的崩点，性能优化不得反向 reintroduce。
- 禁止为压性能引入可变共享状态破坏既有不可变约定（如 `version-store` 写操作返回新 store、`Step` 不被运行态污染）。可变共享换来的常数收益不抵状态串扰的排查成本。

### 时间复杂度

审查热点路径是否在改动中**退化**，特别警惕 O(n²) 被引入。当前已知热点（基于现有架构/代码，作为审查基线，不是优化任务清单）：

- `executor.runNode`（`src/executor/executor.ts`）：递归调度，总遍历量 = 全部叶子数 n；`while` 组按 `loopCount` 放大执行次数（这是语义本身，不算退化）。`childrenOf` 每次调用对 children 做一次 null 扫描，O(children)，整体 O(n)。审查点：改动是否在递归体内引入对全量 steps 的查找/遍历（如每步 `flattenSteps`、每步全量 `runIndex` 重建）。
- `UiShell.flattenSteps`（`src/ui/shell.ts`）：递归展平所有步为线性数组，O(n)。**它是被反复调用的**——`findStep`、`runAll`、`resetRunStatus`、`backfillStatus`、`render` 失败定位都各自调一次。若某次改动在循环里对每步都调 `flattenSteps`/`findStep`，立刻退化成 O(n²)。审查点：循环体内是否出现 `flattenSteps()` 或 `findStep(id)` 调用；若是，改用预先建好的 `runIndex` Map（O(1) 查找）。
- `CfgView` 渲染（`src/ui/cfg-view.ts`）：`renderNode` 对每个节点调 `nodeLabel`，`nodeLabel` 内 `findByStepId` 对整棵树做递归查找 O(n)。渲染 n 个节点 → **当前已是 O(n²)**。这是已知可优化点，登记为后续子阶段，**不属本次审查必须修**；审查点：改动是否再叠加新的全树查找使常数继续放大；若要修，必须先有 `test/cfg-view.test.ts` 守住图结构与文案，再引入 `stepId → Step` Map 把 `findByStepId` 降为 O(1)。
- `UiShell.render`：当前 `root.innerHTML=''` 全量重建 + `flattenSteps` 多次调用，单次渲染 O(n²)（含上一条）。`setStatus`/`CfgView.setStatus` 已做原地更新 O(1) 避免每步重渲染——这是正确方向，审查点：改动是否把已用原地更新的路径改回全量 `render()`。
- `bridge-server.assertRunnableScript`：递归校验 steps 及每层 children，O(n)。审查点：是否在递归体内引入重复 RPC 或全量克隆。
- 运行态 `stepStatus` Map、`runIndex` Map：O(1) 查找，正确形态。审查点：改动是否把它们改成线性扫描或每次 `new Map` 重建。

**降阶才算优化**：O(n²)→O(n)/O(log n) 是优化；同阶常数优化（如少一次 map、少一次浅拷贝）必须有证据——基准计数或 perf 计数，不凭感觉判断「更快」。无证据的常数改动不纳入审查通过条件，也不构成合并阻断。

### 空间复杂度

审查是否引入不必要的全量拷贝、深克隆或大对象常驻：

- `runAll` 的 `stepStatus` Map：随叶子数 O(n) 常驻，合理。审查点：是否在运行结束后仍不释放、或每次进度回调都新建 Map。
- 录制去重指纹集合：若新增去重，确认指纹集合是增量更新而非每事件全量重建。
- `buildCfgGraph` 的 `edges` 数组：O(n)，合理。审查点：是否在递归中重复传递同一数组导致隐式拷贝。
- 深克隆：`version-store` 不可变更新靠返回新 store，审查其是否对整棵 `Script` 做结构化克隆（应用浅拷贝 + 结构共享即可，深克隆会把 commit 退化成 O(n·历史长度)）。
- 递归深度：`runNode`/`buildCfgGraph`/`flattenSteps`/`assertRunnableScript` 均按 `children` 嵌套深度递归。审查点：用户脚本嵌套极深时是否有栈溢出风险；当前未设深度上限，登记为已知限制，**不属本次必须修**。

### 输出

审查报告给出：当前复杂度评估（哪条热点、几阶、是否退化）+ 退化点/可优化点（带文件与触发条件）+ 是否阻断合并。判定规则：

- 引入 O(n²) 退化且无测试覆盖 → **阻断**（先补测试再决定是否回退）。
- 引入 O(n²) 退化但有测试覆盖、且属临时登记的已知项 → 不阻断，但必须在报告里显式登记。
- 同阶常数优化无证据 → 不阻断，不计入通过条件。
- 为性能破坏接口/schema/不可变约定/边界兜底 → **阻断**。

## 命令

```bash
npm test
npm run typecheck
node scripts/verify-ui-live.mjs
```

结论：通过 / 不通过（崩点 + 复现步骤 + 涉及的真实路径）。不通过则打回，修复后再跑本角色。
