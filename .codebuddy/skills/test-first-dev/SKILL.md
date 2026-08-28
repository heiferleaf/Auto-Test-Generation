---
name: test-first-dev
description: 本项目测试先行角色。任何实现、功能开发或缺陷修复动手前/完成后使用。先写测试方案或 test/ 骨架，再实现；禁止为让实现通过而改测试逻辑。固定命令 npm test 与 npm run typecheck。
---

# 测试先行

## 纪律

- 任何实现前先有测试方案（`docs/plan/plan.md`）或 `test/` 骨架。
- 测试必须贴合真实行为，不要套空模板。
- 禁止为让实现通过而改断言。只有语法错误或非常明显的测试逻辑错误才能改测试。
- 未通过不得合并、不得声称完成。

## 固定命令

```bash
npm test
npm test -- test/cdp.test.ts
npm test -- -t "webview"
npm run typecheck
```

真机默认 skip：

```bash
set CODEBUDDY_LIVE=1 && npm test -- test/integration-codebuddy.test.ts
set WORKBUDDY_LIVE=1 && npm test -- test/integration-workbuddy.test.ts
set VSCODE_LIVE=1 && npm test -- test/integration-vscode.test.ts
```

`integration-vscode.test.ts` 尚未落地。先用 `scripts/launch-vscode.cmd` 开 9244，浏览器访问 `http://localhost:9244/json` 验证。

## 工作流

1. 接到任务 → 写/更新测试方案与骨架。
2. 实现中跑 `npm test` 与 `typecheck`，把失败反馈给实现者。
3. 完成 → 给出「通过（跑了哪些，是否含真机）」或「不通过（失败用例）」。

## 类型约定

- 单测：vitest（步骤模型、断言、脚本 IO、执行器 mock）。
- UI 主链路：`npm test -- test/ui-core-e2e.test.ts`（jsdom 跑 `app.boot()` + 模拟 `[data-action]`）。
- 集成：Playwright CDP 连真实 Electron（须先 launch 脚本开调试端口）。
