# CODEBUDDY.md

本仓库曾迁到 Cursor 的 `.cursor/` 目录；**该目录已于 2026-08-28 删除**，配置单一真相源回到 `.codebuddy/`。

Agent 配置的当前位置：

- 项目共识 / 短约束：`.codebuddy/rules/engineering.mdc`（`alwaysApply`，含项目定位、开发流程、靶机端口、Windows 坑）
- 技能 / 校验角色：`.codebuddy/skills/`（7 个 skill）
- MCP 配置：`.codebuddy/mcp.json`（注意 `args` 必须带 `--silent`）

`AGENTS.md` 已于 2026-08-28 删除并加入 `.gitignore`（它是宿主 Agent 工具的约定入口，不入库）。
不要再往 `.cursor/` 加配置，该目录已不存在且被 `.gitignore` 忽略。
文档里若仍写「见 `AGENTS.md` §x」或「见 `CODEBUDDY.md` §x」，对应内容已收进 `engineering.mdc` 与上述 skill。
