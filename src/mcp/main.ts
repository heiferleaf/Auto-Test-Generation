// MCP 进程入口。由 `npm run mcp` 或 Cursor .cursor/mcp.json 拉起。
// 不能往 stdout 打日志。

import { startMcpStdio } from './server';

startMcpStdio().catch((err) => {
  console.error('[mcp]', err instanceof Error ? err.message : err);
  process.exit(1);
});
