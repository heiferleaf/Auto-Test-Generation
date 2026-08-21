---
name: code-review-standard
description: 当你需要审查本项目代码（作为 code-review 校验角色，或对刚完成的实现做自审）时加载。提供一套检查清单：除语法与设计文档对齐外，必查 SOLID 五原则、GoF 设计模式恰当性、可扩展性与适配性，以及错误处理与资源生命周期，确保系统稳定可靠、易扩展、符合 CODEBUDDY.md §4 基线。
type: skill
---

# Code Review 标准（code-review 角色专用）

适用：本项目所有实现任务的 code-review 角色（参见 CODEBUDDY.md §4）。

## 检查清单

### 1. 基线合规
- [ ] 实现满足对应测试（test 角色已确认通过）
- [ ] 接口/字段与 `docs/设计文档.md`、类型定义一致
- [ ] 无超范围实现、无过度设计

### 2. SOLID
- [ ] **SRP**：模块职责单一（如 executor 控制流 / actions 转发 / assert 判定 分离）
- [ ] **OCP**：新增 StepType、断言 kind、target 类型时是否只需扩展而非改核心
- [ ] **LSP**：`CdpAdapter` 等抽象的实现（mock / 真实）可互换等价
- [ ] **ISP**：接口未强迫实现方提供无用方法
- [ ] **DIP**：高层（executor）依赖抽象，不依赖 Playwright 等具体细节

### 3. GoF 模式恰当性（参考非硬套）
- 适配器（CDP 适配层）、策略（断言分发）、工厂（adapter 创建）、命令（步骤模型）是否运用合理
- 是否存在可改用标准模式降低耦合的点

### 4. 可扩展性 / 适配性
- [ ] 接入 MCP Tool 时的改动面
- [ ] 新增 Electron 原生降级（Computer Use）的扩展点
- [ ] 多窗口/webview 扩展是否平滑
- [ ] 无硬编码端口/选择器/路径外的脆弱耦合

### 5. 稳定性
- [ ] 错误带结构化上下文（如 stepId），不静默吞错
- [ ] 资源（adapter 连接）有明确生命周期

## 结论
- 任一项不通过 → review 不通过，须指明文件:行号 + 改进建议。
- 确认通过后才允许合并回 master。
