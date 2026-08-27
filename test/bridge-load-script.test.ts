// 桥 RPC loadScript：不经 MCP 进程，把 Script JSON 广播给当前 UI 会话。
// 将来 MCP Tool script.open = 调这一行。跨 WS 的 null 必须明确失败，不能进 adapter。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachKernelBridge, type BridgeAdapter } from '../src/ui/bridge-server';
import { SCRIPT_SCHEMA, type Script } from '../src/types/step';

function makeStub(): BridgeAdapter {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn(() => []),
    selectTarget: vi.fn(() => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('png')),
    locateVisual: vi.fn(async () => ({
      x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true,
    })),
    startRecording: vi.fn(() => {}),
    stopRecording: vi.fn(async () => []),
    startPick: vi.fn(),
    cancelPick: vi.fn(),
    playback: vi.fn(async () => ({ ok: true })),
  } as unknown as BridgeAdapter;
}

const sample: Script = {
  schema: SCRIPT_SCHEMA,
  app: { name: 'BridgeLoad', version: '1' },
  steps: [{
    id: 'agent-if',
    type: 'assert',
    source: 'agent',
    control: {
      kind: 'if',
      name: '资源管理器是否有 settings.json',
      condition: { kind: 'exists', locator: { role: 'treeitem', name: 'settings.json' } },
    },
    children: [
      {
        id: 'agent-if-true',
        type: 'click',
        source: 'agent',
        control: { kind: 'sequence', name: 'True' },
        children: [{
          id: 'agent-if-true-click',
          type: 'click',
          source: 'agent',
          locator: { role: 'treeitem', name: 'settings.json' },
        }],
      },
      {
        id: 'agent-if-false',
        type: 'wait',
        source: 'agent',
        control: { kind: 'sequence', name: 'False' },
        children: [{
          id: 'agent-if-false-wait',
          type: 'wait',
          source: 'agent',
          params: { durationMs: 200 },
        }],
      },
    ],
  }],
};

class TestClient {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>();
  readonly events: Array<{ event: string; data: unknown }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'event') {
        this.events.push({ event: msg.event, data: msg.data });
        return;
      }
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg);
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  call(method: string, ...args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, args }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

type Harness = {
  url: string;
  loadScript: (raw: unknown) => Script;
  close: () => Promise<void>;
};

async function openHarness(): Promise<Harness> {
  const server: Server = createServer();
  const bridge = attachKernelBridge(server, 9222, makeStub());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/kernel-ws`,
    loadScript: (raw) => bridge.loadScript(raw),
    close: async () => {
      await bridge.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let harness: Harness | undefined;
let ui: TestClient | undefined;
let mcp: TestClient | undefined;

afterEach(async () => {
  ui?.close();
  mcp?.close();
  ui = undefined;
  mcp = undefined;
  await harness?.close();
  harness = undefined;
});

describe('桥 RPC loadScript（MCP script.open 前置，无 MCP 进程）', () => {
  it('WS loadScript 把脚本推给已连接的工作台客户端', async () => {
    harness = await openHarness();
    ui = await TestClient.connect(harness.url);
    mcp = await TestClient.connect(harness.url);

    const res = await mcp.call('loadScript', sample);
    expect(res.ok).toBe(true);

    await vi.waitFor(() => {
      expect(ui!.events.some((e) => e.event === 'load-script')).toBe(true);
    });
    const ev = ui!.events.find((e) => e.event === 'load-script')!;
    const data = ev.data as Script;
    expect(data.steps[0]?.id).toBe('agent-if');
    expect(data.steps[0]?.control?.condition?.locator?.name).toBe('settings.json');
  });

  it('进程内 bridge.loadScript 同样广播 load-script（将来 Tool 一行调用）', async () => {
    harness = await openHarness();
    ui = await TestClient.connect(harness.url);
    const loaded = harness.loadScript(sample);
    expect(loaded.steps[0]?.id).toBe('agent-if');
    await vi.waitFor(() => {
      expect(ui!.events.some((e) => e.event === 'load-script')).toBe(true);
    });
  });

  it('null 入参明确失败，不广播', async () => {
    harness = await openHarness();
    ui = await TestClient.connect(harness.url);
    const res = await ui.call('loadScript', null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/script|schema|对象/i);
    expect(ui.events.filter((e) => e.event === 'load-script')).toEqual([]);
  });
});
