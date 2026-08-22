// 测试先行（M2-webview，方案 C）：沙箱 webview 内层 execution context 可达性。
// 先于 src/cdp/webview-session.ts / targets.ts / adapter.ts 的实现存在。
// 默认 mock 单测全跑；真机用例受 CODEBUDDY_LIVE 控制。

import { describe, it, expect, vi } from 'vitest';

// ---- 待测模块（实现前先声明契约）----
import { WebviewCdpTarget } from '../src/cdp/webview-session';
import { enumerateTargets } from '../src/cdp/targets';
import type { RawCdpTarget } from '../src/cdp/targets';

// ---------------------------------------------------------------------------
// 1) WebviewCdpTarget：独立 CDP 会话 + 内层 context 管理（mock WebSocket）
// ---------------------------------------------------------------------------

// 用 EventEmitter 模拟 ws，注入可控的 CDP 消息往返。
import { EventEmitter } from 'node:events';

let mockHandler: (msg: any) => any = () => ({ id: 0, result: {} });

class MockWs extends EventEmitter {
  sent: any[] = [];
  constructor(_url?: any, _opts?: any) {
    super();
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    // 同步回包（真实 ws 是异步，这里用 queueMicrotask 模拟）
    const reply = mockHandler(msg);
    if (reply) queueMicrotask(() => this.emit('message', JSON.stringify(reply)));
  }
  close() {}
  // 模拟服务端主动推送（如 executionContextCreated）
  push(event: any) {
    this.emit('message', JSON.stringify(event));
  }
}

function makeTargetWithMock(handler: (msg: any) => any, wsUrl = 'ws://mock/webview') {
  mockHandler = handler;
  const ws = new MockWs(wsUrl) as any;
  const t = new WebviewCdpTarget('wv1', wsUrl, ws);
  return { t, ws };
}

describe('WebviewCdpTarget（方案 C 核心）', () => {
  it('连接后列出 execution contexts，并识别内层 UI context', async () => {
    const { t, ws } = makeTargetWithMock((msg) => {
      if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelectorAll')) {
        // 默认 context 无 textbox；内层 context (id=3) 有
        const ctxId = msg.params.contextId;
        const hasBox = ctxId === 3;
        return {
          id: msg.id,
          result: {
            result: {
              type: 'number',
              value: hasBox ? 1 : 0,
            },
          },
        };
      }
      if (msg.method === 'Runtime.enable' || msg.method === 'Runtime.runIfWaitingForDebugger') {
        return { id: msg.id, result: {} };
      }
      return { id: msg.id, result: {} };
    });

    // 注入两个 context：默认(1) 空，内层(3) 有 UI
    ws.push({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, auxData: { isDefault: true } } } });
    ws.push({ method: 'Runtime.executionContextCreated', params: { context: { id: 3, auxData: { isDefault: false } } } });

    const inner = await t.findUiContext();
    expect(inner).toBe(3);
  });

  it('evaluate 自动转发到内层 context（contextId 正确）', async () => {
    let capturedCtx: number | undefined;
    const { t, ws } = makeTargetWithMock((msg) => {
      if (msg.method === 'Runtime.evaluate') {
        capturedCtx = msg.params.contextId;
        return { id: msg.id, result: { result: { type: 'string', value: '你好' } } };
      }
      return { id: msg.id, result: {} };
    });
    ws.push({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, auxData: { isDefault: true } } } });
    ws.push({ method: 'Runtime.executionContextCreated', params: { context: { id: 3, auxData: { isDefault: false } } } });

    const val = await t.evaluate('document.querySelector("[role=textbox]").textContent', undefined);
    expect(val).toBe('你好');
    expect(capturedCtx).toBe(3); // 自动选内层 context
  });

  it('fill 写入 contenteditable 触发真实输入语义', () => {
    const sent: any[] = [];
    const { t, ws } = makeTargetWithMock((msg) => {
      sent.push(msg);
      if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
        return { id: msg.id, result: { result: { type: 'string', value: 'div' } } };
      }
      if (msg.method === 'Input.insertText') {
        return { id: msg.id, result: {} };
      }
      return { id: msg.id, result: {} };
    });
    ws.push({ method: 'Runtime.executionContextCreated', params: { context: { id: 3, auxData: { isDefault: false } } } });

    return t.fill('[role=textbox]', '你好').then(() => {
      const insert = sent.find((m) => m.method === 'Input.insertText');
      expect(insert).toBeTruthy();
      expect(insert.params.text).toBe('你好');
    });
  });
});

// ---------------------------------------------------------------------------
// 2) enumerateTargets 工厂：webview 走独立 native CDP 会话（OCP）
// ---------------------------------------------------------------------------

describe('enumerateTargets 工厂（方案 C 路径）', () => {
  it('webview 原始 target 带 webSocketDebuggerUrl 时建 WebviewCdpTarget', async () => {
    const raw: RawCdpTarget[] = [
      { id: 'p1', type: 'page', title: 'main', url: 'vscode-file://app', webSocketDebuggerUrl: 'ws://x/page' },
      {
        id: 'wv1',
        type: 'iframe',
        title: 'dialog',
        url: 'vscode-webview://abc',
        webSocketDebuggerUrl: 'ws://x/webview1',
      },
    ];
    // 提供假的 ws 构造器，避免真实连接；提供假 browser 以匹配 page 目标。
    const fakeWsCtor: any = (url: string) => new MockWs(() => ({ id: 0, result: {} }));
    const fakeBrowser = {
      contexts: () => [{ pages: () => [{ url: () => 'vscode-file://app' }] }],
    } as any;
    const entries = await enumerateTargets(fakeBrowser, raw, fakeWsCtor as any);
    expect(entries.length).toBe(2);
    expect(entries[0].target.type).toBe('page');
    expect(entries[1].target.type).toBe('webview');
    expect(entries[1].target).toBeInstanceOf(WebviewCdpTarget);
  });
});

// ---------------------------------------------------------------------------
// 3) 真机集成（LIVE=1，需 CodeBuddy 开对话 + 端口 9222）
// ---------------------------------------------------------------------------

const LIVE = process.env.CODEBUDDY_LIVE === '1';
const liveWeb = LIVE ? describe : describe.skip;

liveWeb('CodeBuddy webview 内层输入框可达（方案 C 真机验证）', () => {
  it('selectTarget 对话 webview → fill 你好 → 读回', async () => {
    const { PlaywrightCdpAdapter } = await import('../src/cdp/adapter');
    const a = new PlaywrightCdpAdapter();
    await a.connect({ port: 9222 });
    try {
      const targets = a.listTargets();
      const webviews = targets.filter((t) => t.type === 'webview');
      expect(webviews.length).toBeGreaterThan(0);

      // 找到真正承载对话输入框的内层 webview（逐一试探 [role=textbox]）。
      let dialogWv: string | undefined;
      for (const wv of webviews) {
        a.selectTarget(wv.id);
        const hasBox = await a
          .eval('!!document.querySelector("[role=textbox]")')
          .then((r) => Boolean(r))
          .catch(() => false);
        if (hasBox) {
          dialogWv = wv.id;
          break;
        }
      }
      expect(dialogWv, '未找到含对话输入框的 webview').toBeTruthy();

      a.selectTarget(dialogWv!);
      await a.fill({ role: 'textbox' }, '你好');
      const val = (await a.eval(
        'document.querySelector("[role=textbox]").textContent',
      )) as string;
      expect(val).toContain('你好');
    } finally {
      await a.disconnect();
    }
  }, 30_000);
});
