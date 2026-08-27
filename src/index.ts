// 库导出：给 MCP / CLI / 后续封装同一条入口，避免从内部文件路径掏 connect/snapshot。

export { PlaywrightCdpAdapter, DEFAULT_CDP_PORT } from './cdp/adapter';
export type { CdpAdapter, ConnectOptions, TargetInfo } from './cdp/adapter';
export { runScript } from './executor/executor';
export { runAssertion } from './executor/assert';
export { runCli } from './cli';
export { importScript, exportScript } from './script/io';
export { Recorder } from './recorder/recorder';
export type { Script, Step, Locator, Assertion } from './types/step';
export { TOOL_NAMES, TOOL_DEFS } from './mcp/tool-catalog';
export { dispatchTool } from './mcp/dispatch';
export { createMcpServer, startMcpStdio } from './mcp/server';
