// stdio MCP Server：把 dispatchTool 挂到 Cursor Agent 默认的 JSON-RPC 传输。
// stdout 只走协议；诊断打 stderr。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFS } from './tool-catalog';
import { dispatchTool, type McpDeps } from './dispatch';
import { createLiveSession } from './session';

export function createMcpServer(deps: McpDeps): Server {
  const server = new Server(
    { name: 'electron-auto-test', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    const name = req.params.name;
    const result = await dispatchTool(name, args, deps);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: result.error }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
    };
  });

  return server;
}

export async function startMcpStdio(deps?: McpDeps): Promise<void> {
  const session = deps ?? createLiveSession();
  const server = createMcpServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
