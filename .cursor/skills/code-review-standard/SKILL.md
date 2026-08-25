---
name: code-review-standard
description: 本项目 code-review 角色。代码修改后、准备合并前使用。检查设计文档对齐、SOLID、产品符合度、架构文档是否同步。用户可见功能必须对照 visual-mask-ui-spec 交互清单。
---

# Code Review

对照 `docs/architecture/architecture.md` 与 `docs/design/` 读 `git diff`。

## 基线

- 测试已由 test 角色确认通过
- 接口/字段与 `docs/design/design.md`、`src/types/step.ts` 一致
- 无超范围实现

## SOLID / 扩展

- SRP：executor 控制流、actions 转发、assert 判定分离
- OCP：新增 StepType / 断言 kind / target 类型应扩展而非改核心
- LSP：`CdpAdapter` 的 mock 与真实实现可互换
- DIP：高层依赖抽象，不依赖 Playwright 细节
- 评估接入 MCP Tool、原生降级、多窗口时的改动面；避免写死端口/选择器

## 产品符合度（用户可见功能必做）

依据 `docs/design/visual-mask-ui-spec.md` §2.x 交互逻辑列验收清单，逐条核对。任一条不满足则不通过。UI 必须有 `test/ui-core-e2e.test.ts` 覆盖用户主链路。

## 架构同步

触及 Target 类型、传输层、模块边界、Adapter 工厂时，必须已更新 `docs/architecture/architecture.md`。缺失则不通过。

## 结论格式

通过 / 不通过（文件:行号 + 偏离项 + 改进建议）。与 `runtime-runnability-review` 互补：这里看设计对不对。
