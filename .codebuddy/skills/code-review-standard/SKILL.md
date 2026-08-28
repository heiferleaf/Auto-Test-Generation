---
name: code-review-standard
description: 本项目 code-review 角色。代码修改后、准备合并前使用。检查设计文档对齐、SOLID、产品符合度、架构文档是否同步。用户可见功能必须对照 visual-mask-ui-spec 交互清单。
---

# Code Review

作为 code-review 校验角色，或对自己刚完成的实现做自审时使用（AGENTS.md §4）。
对照 `docs/architecture/architecture.md` 与 `docs/design/` 读 `git diff`。

## 基线

- 测试已由 test 角色确认通过
- 接口/字段与 `docs/design/design.md`、`src/types/step.ts` 一致
- 无超范围实现、无过度设计

## SOLID / 扩展

- **SRP**：模块职责单一（executor 控制流 / actions 转发 / assert 判定 分离）
- **OCP**：新增 StepType / 断言 kind / target 类型应扩展而非改核心
- **LSP**：`CdpAdapter` 的 mock 与真实实现可互换等价
- **ISP**：接口未强迫实现方提供用不到的方法
- **DIP**：高层依赖抽象，不依赖 Playwright 细节
- 评估接入 MCP Tool、Electron 原生降级（Computer Use）、多窗口/webview 时的改动面
- 无硬编码端口 / 选择器 / 路径的脆弱耦合

## GoF 模式恰当性（参考非硬套）

- 适配器（CDP 适配层）、策略（断言分发）、工厂（adapter 创建）、命令（步骤模型）是否运用合理
- 是否存在可改用标准模式降低耦合的点

## 稳定性

- 错误带结构化上下文（如 stepId），不静默吞错
- 资源（adapter 连接、WS 会话）有明确生命周期，句柄正确关闭

## 产品符合度（用户可见功能必做）

依据 `docs/design/visual-mask-ui-spec.md` §2.x 交互逻辑列验收清单，逐条核对。任一条不满足则不通过。
UI 必须有 `test/ui-core-e2e.test.ts` 覆盖用户主链路（jsdom 跑 `app.boot()` + 模拟 `[data-action]` 点击），禁止只用内部 API 直调冒充用户路径。

## 架构同步

触及 Target 类型、传输层、模块边界、Adapter 工厂时，必须已更新 `docs/architecture/architecture.md`。缺失则不通过。

## 结论格式

通过 / 不通过（文件:行号 + 偏离项 + 改进建议）。任一项不通过即不通过，未解决不得声称完成。
与 `runtime-runnability-review` 互补不替代：这里看"设计对不对"，它看"真实跑不跑得通"。
