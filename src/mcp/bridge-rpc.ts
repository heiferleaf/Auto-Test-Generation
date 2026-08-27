// 作为 WS 客户端调工作台桥的 loadScript RPC。
// 桥会校验 Script 并向浏览器广播 load-script；UiShell 已订阅该事件。

import WebSocket from 'ws';
import type { Script } from '../types/step';
import { parseLoadScriptArg } from '../ui/bridge-server';

export function httpToKernelWs(httpUrl: string): string {
  const u = new URL(httpUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}/kernel-ws`;
}

export async function rpcLoadScript(opts: {
  workbenchUrl: string;
  raw: unknown;
  timeoutMs?: number;
}): Promise<Script> {
  // 先在本进程校验：坏 JSON 不必占桥。真正推进会话仍走 RPC（测试会断言调了 loadScript）。
  const script = parseLoadScriptArg(opts.raw);
  const wsUrl = httpToKernelWs(opts.workbenchUrl);
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`script.open 等待工作台超时（${wsUrl}）`));
    }, timeoutMs);

    const finish = (err?: Error, value?: Script) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value as Script);
    };

    ws.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'loadScript', args: [script] }));
    });
    ws.on('message', (data) => {
      let msg: { id?: number; ok?: boolean; error?: string; result?: unknown; type?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'event') return;
      if (msg.id !== 1) return;
      if (!msg.ok) {
        finish(new Error(msg.error ?? 'loadScript 失败'));
        return;
      }
      finish(undefined, script);
    });
  });
}
