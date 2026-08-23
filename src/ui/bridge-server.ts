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
/** 服务端主动推送消息（非请求/响应），用于录制增量事件、运行进度等。 */
type WsEvent = { type: 'event'; event: string; data: unknown };

/** 把结果中的 Node Buffer 递归转为 base64 字符串（跨 WS 序列化安全）。 */
export function serializeBuffers(v: unknown): unknown {
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

/** WS 边界兜底：JSON.stringify 把 undefined 元素变 null，服务端默认参数对 null 不生效，
 * 会导致 null.target 等崩溃（CODEBUDDY.md §4.1 血泪教训）。此处把 null 还原为 undefined，
 * 让各方法体内 `x ?? {}` 兜底生效。 */
export function sanitizeArgs(args: unknown[]): unknown[] {
  return (args ?? []).map((a) => (a === null ? undefined : a));
}

/** 在已有 http server 上升级出 /kernel-ws 端点，桥接真机 adapter。 */
export function attachKernelBridge(
  server: import('node:http').Server,
  port = 9222,
): { close: () => Promise<void> } {
  const adapter = new PlaywrightCdpAdapter();
  let connected = false;
  const clients = new Set<WebSocket>();

  const wss = new WebSocketServer({ noServer: true });

  /** 向所有已连接客户端广播服务端事件（录制增量 / 运行进度）。 */
  const pushEvent = (event: string, data: unknown) => {
    const msg: WsEvent = { type: 'event', event, data };
    const payload = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  };

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url === '/kernel-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('error', () => { /* 单连接错误不应影响 server 进程 */ });
    ws.on('close', () => clients.delete(ws));
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
        if (method === 'startRecording') {
          // 注册实时回调：录制中每捕获一个交互即广播给所有客户端（边操作边长步骤）。
          adapter.startRecording((ev) => pushEvent('recording', ev));
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        const fn = (adapter as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        if (typeof fn !== 'function') {
          send({ id: req.id, ok: false, error: `未知方法: ${String(method)}` });
          return;
        }
        let result: unknown;
        try {
          // WS 边界兜底：null 入参还原为 undefined，避免服务端默认参数失效（§4.1）。
          result = await fn.apply(adapter, sanitizeArgs(req.args as unknown[]));
        } catch (err) {
          send({ id: req.id, ok: false, error: (err as Error).message });
          return;
        }
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
