// 测试先行（R3 · code-review 第 3 项打回）：step-progress 经**真实 WebSocket** 的端到端传输。
//
// 为何必须有这个文件：
//   既有测试只覆盖了 WS 线路的「两岸」——
//   · `test/ui-shell-run-all.test.ts`：浏览器侧，用 mock kernel 直接 emit（不过 WS）；
//   · `test/executor-progress.test.ts`：Node 侧，纯进程内函数传递（不过 WS）。
//   中间那段 WS 线路恰恰是 CODEBUDDY.md §4.1 血泪教训的出事点（JSON 序列化把
//   undefined 变 null、函数被静默丢弃）。只测两岸不测桥，等于没测桥。
//
// 本文件用「真 http server + 真 WebSocketServer + 真 ws-kernel 协议」跑通
// playback → executor 进度上报 → pushEvent → 客户端 on('step-progress')，
// 用 stub adapter 替代真机，从而在无 9222 靶机的情况下守住这段线路。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachKernelBridge, type BridgeAdapter } from '../src/ui/bridge-server';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { Script, Step } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';
import { runCli } from '../src/cli';
import type { StepProgress } from '../src/executor/executor';

/**
 * 近真机 adapter 桩：只实现 playback 走真实 executor（进度真的从执行器产生），
 * 其余动作方法为空实现。目的是让 WS 线路上跑的是**真实进度事件流**，
 * 而非测试自己造的假事件。
 */
type StubAdapter = BridgeAdapter & { calls: string[] };

function makeBridgeStubAdapter(failOnName?: string): StubAdapter {
  const calls: string[] = [];
  const base = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn(() => []),
    selectTarget: vi.fn(() => {}),
    click: vi.fn(async (l: { name?: string }) => {
      calls.push(`click:${l.name}`);
      if (failOnName && l.name === failOnName) throw new Error('点击失败');
    }),
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
  };
  // 显式标注类型，避免 playback 在自身初始化器中引用 adapter 造成的隐式 any（TS7022）。
  const adapter: StubAdapter = {
    ...base,
    calls,
    // 与 PlaywrightCdpAdapter.playback 同形：接收进程内 onStep，交给真实 runCli/executor。
    playback: vi.fn((script: Script, onStep?: StepProgress) =>
      runCli({ adapter: adapter as unknown as CdpAdapter, script, onStep }),
    ),
  } as unknown as StubAdapter;
  return adapter;
}

const clickStep = (id: string, name: string): Step => ({
  id, type: 'click', source: 'manual', locator: { name },
});

const scriptOf = (steps: Step[]): Script => ({
  schema: SCRIPT_SCHEMA, app: { name: 'WsProg', version: '1.0.0' }, steps,
});

type Harness = {
  url: string;
  close: () => Promise<void>;
};

const openHarness = async (adapter: BridgeAdapter): Promise<Harness> => {
  const server: Server = createServer();
  const bridge = attachKernelBridge(server, 9222, adapter);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/kernel-ws`,
    close: async () => {
      await bridge.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** 最小客户端：复刻 ws-kernel 的 RPC + event 协议（浏览器侧行为等价）。 */
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

  progress(): string[] {
    return this.events
      .filter((e) => e.event === 'step-progress')
      .map((e) => {
        const d = e.data as { stepId?: string; status?: string };
        return `${d.stepId}:${d.status}`;
      });
  }

  close(): void {
    this.ws.close();
  }
}

let harness: Harness | undefined;
let client: TestClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await harness?.close();
  harness = undefined;
});

describe('step-progress 经真实 WebSocket 端到端传输', () => {
  it('playback 的每步进度真的通过 WS 推送到客户端（不是只在 Node 侧发生）', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    const res = await client.call('playback', scriptOf([clickStep('a', 'A'), clickStep('b', 'B')]));

    expect(res.ok).toBe(true);
    expect((res.result as { ok: boolean }).ok).toBe(true);
    // 关键断言：客户端确实收到了流式进度（此前这段线路无任何测试覆盖）
    expect(client.progress()).toEqual(['a:running', 'a:pass', 'b:running', 'b:pass']);
  });

  it('失败步骤的 fail 进度也经 WS 送达，且 failedStepId 不为 undefined', async () => {
    const adapter = makeBridgeStubAdapter('B');
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    const res = await client.call('playback', scriptOf([clickStep('a', 'A'), clickStep('b', 'B')]));

    expect(res.ok).toBe(true);
    const payload = res.result as { ok: boolean; failedStepId?: string };
    expect(payload.ok).toBe(false);
    // §4.1 静默误提示的反向守卫：必须能明确说出是哪一步失败，不能是 "(未知)"
    expect(payload.failedStepId).toBe('b');
    expect(client.progress()).toEqual(['a:running', 'a:pass', 'b:running', 'b:fail']);
  });

  it('CFG 循环内子步骤的进度按真实执行次数经 WS 送达', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    const loop: Step = {
      id: 'loop', type: 'wait', source: 'manual',
      control: { kind: 'while', loopCount: 2 },
      children: [clickStep('in', 'IN')],
    };
    await client.call('playback', scriptOf([loop]));

    expect(client.progress()).toEqual(['in:running', 'in:pass', 'in:running', 'in:pass']);
  });

  it('进度事件载荷跨 JSON 往返后字段完好（stepId/status 均为字符串）', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    await client.call('playback', scriptOf([clickStep('a', 'A')]));

    const first = client.events.find((e) => e.event === 'step-progress');
    expect(first).toBeDefined();
    expect(first!.data).toEqual({ stepId: 'a', status: 'running' });
  });

  it('客户端传 null script 时，桥端回明确错误而非静默 failedStepId:undefined（§4.1）', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    const res = await client.call('playback', null);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/script/i);
    // 未进入执行器，故不应有任何进度事件
    expect(client.progress()).toEqual([]);
  });

  it('客户端传 children:[null] 的坏 CFG 时，桥端递归校验拦截并带路径', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    const bad = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'Bad', version: '1' },
      steps: [{ id: 'g', type: 'click', control: { kind: 'sequence' }, children: [null] }],
    };
    const res = await client.call('playback', bad);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/steps\[0\]\.children\[0\]/);
    expect(adapter.playback).not.toHaveBeenCalled();
  });

  it('多次 playback 之间进度事件不串台（每次都是完整独立序列）', async () => {
    const adapter = makeBridgeStubAdapter();
    harness = await openHarness(adapter);
    client = await TestClient.connect(harness.url);

    await client.call('playback', scriptOf([clickStep('a', 'A')]));
    const afterFirst = client.progress().length;
    await client.call('playback', scriptOf([clickStep('b', 'B')]));

    expect(afterFirst).toBe(2);
    expect(client.progress()).toEqual(['a:running', 'a:pass', 'b:running', 'b:pass']);
  });
});
