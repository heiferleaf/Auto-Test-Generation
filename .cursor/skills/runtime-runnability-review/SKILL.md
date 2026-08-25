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

## 可运行性通过后再查

坏味道、嵌套遍历复杂度、重复 RPC/全量重渲染。提出优化前必须先有测试守住功能；禁止为性能去掉 `?? {}` 兜底。

## 命令

```bash
npm test
npm run typecheck
node scripts/verify-ui-live.mjs
```

结论：通过 / 不通过（崩点 + 复现步骤 + 涉及的真实路径）。不通过则打回，修复后再跑本角色。
