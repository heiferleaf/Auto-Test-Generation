// 真机桥（Node 侧）：WebSocket server + 持有 PlaywrightCdpAdapter。
// 浏览器页面无法直接运行 PlaywrightCdpAdapter（依赖 Node 原生模块），
// 故由本 Node 进程持有真机 adapter，页面通过 WS 把 UiKernel 调用转交此处执行并回传结果。
//
// 这是 M3「UI 壳真实录制 CODEBUDDY」的关键桥接层（DIP：页面只认 UiKernel 接口，
// 真机能力由桥内的 PlaywrightCdpAdapter 提供）。

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { PlaywrightCdpAdapter } from '../cdp/adapter';
import type { UiKernel } from './shell';
import type { Script, Locator } from '../types/step';

type RpcReq = { id: number; method: keyof UiKernel; args: unknown[] };
type RpcRes = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

/** 把结果中的 Node Buffer 递归转为 base64 字符串（跨 WS 序列化安全）。 */
function serializeBuffers(v: unknown): unknown {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return { __base64: v.toString('base64') };
  if (Array.isArray(v)) return v.map(serializeBuffers);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = serializeBuffers(val);
    }
    return out;
  }
  return v;
}

/** 在已有 http server 上升级出 /kernel-ws 端点，桥接真机 adapter。 */
export function attachKernelBridge(
  server: import('node:http').Server,
  port = 9222,
): { close: () => Promise<void> } {
  const adapter = new PlaywrightCdpAdapter();
  let connected = false;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url === '/kernel-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', () => { /* 单连接错误不应影响 server 进程 */ });
    ws.on('message', async (raw: Buffer) => {
      let req: RpcReq;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const send = (r: RpcRes) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(r));
      };
      try {
        const method = req.method;
        // connect 需真连；其余直接转发到 adapter 实例。
        if (method === 'connect') {
          const opts = (req.args[0] as { port?: number }) ?? {};
          await adapter.connect({ ...opts, port: opts.port ?? port });
          connected = true;
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'disconnect') {
          await adapter.disconnect();
          connected = false;
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (!connected && method !== 'listTargets') {
          // 未连接时（除读取型）先自动按需连接
        }
        const fn = (adapter as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        if (typeof fn !== 'function') {
          send({ id: req.id, ok: false, error: `未知方法: ${String(method)}` });
          return;
        }
        const result = await fn.apply(adapter, req.args as unknown[]);
        // 跨进程序列化：Node Buffer 经 JSON.stringify 会变成 {type:'Buffer',data:[...]}，
        // 浏览器无法解码为 PNG。故在桥端（Node 侧）把 Buffer 转 base64 字符串，
        // ws-kernel 端再还原为浏览器可用的 base64，供截图流渲染。
        send({ id: req.id, ok: true, result: serializeBuffers(result) });
      } catch (err) {
        send({ id: req.id, ok: false, error: (err as Error).message });
      }
    });
  });

  return {
    close: () => new Promise<void>((resolve) => {
      wss.close(() => resolve());
    }),
  };
}

export type { Locator, Script };
