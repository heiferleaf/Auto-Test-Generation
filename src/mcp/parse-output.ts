// 从启动脚本/工作台 stdout 解析真实端口与 URL。
// 不把 9222 / 5173 当唯一回退：解析失败就返回 undefined，由调用方用目录项或报错。

export function parseCdpPortFromLaunchOutput(text: string): number | undefined {
  const src = text ?? '';
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/json/i,
    /remote-debugging-port[=:\s]+(\d+)/i,
    /CDP(?:_PORT)?[^\d]{0,20}(\d{4,5})/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export function parseWorkbenchUrl(text: string): string | undefined {
  const src = text ?? '';
  const m = src.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
  if (!m) return undefined;
  return `http://localhost:${m[1]}`;
}
