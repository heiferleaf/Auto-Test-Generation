/** 工作台连靶机的调试端口：URL ?cdp= 优先，其次宿主注入，最后默认 9222。 */
export function resolveCdpPort(search: string, injected?: number): number {
  const q = search.startsWith('?') ? search.slice(1) : search;
  const raw = new URLSearchParams(q).get('cdp');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) return injected;
  return 9222;
}

/** Chromium `--remote-debugging-port` 本机常用号段（不绑定某一款 App）。 */
export const CDP_PROBE_BAND = { from: 9222, to: 9260 } as const;

export function parseCdpProbeList(raw?: string): number[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** 探测顺序：本次首选 → 上次成功 → 环境追加 → 号段扫描。 */
export function cdpProbeCandidates(opts?: {
  preferred?: number;
  lastSuccessful?: number;
  extra?: number[];
}): number[] {
  const o = opts ?? {};
  const out: number[] = [];
  const add = (p?: number) => {
    if (typeof p === 'number' && Number.isFinite(p) && p > 0 && !out.includes(p)) out.push(p);
  };
  add(o.preferred);
  add(o.lastSuccessful);
  for (const p of o.extra ?? []) add(p);
  for (let p = CDP_PROBE_BAND.from; p <= CDP_PROBE_BAND.to; p++) add(p);
  return out;
}

export type ProbeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

async function isLiveCdpPort(port: number, fetchImpl: ProbeFetch, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json`, { signal: ac.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data) && data.some((t) => t && typeof t === 'object' && 'webSocketDebuggerUrl' in t);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 首选口连不上时并行扫候选口的 /json。
 * 只认带 webSocketDebuggerUrl 的，跳过 TCP 在听但 DevTools 没起来的幽灵口。
 */
export async function probeLiveCdpPort(opts?: {
  skip?: number;
  preferred?: number;
  lastSuccessful?: number;
  extra?: number[];
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
}): Promise<number | undefined> {
  const o = opts ?? {};
  const fetchImpl = o.fetchImpl ?? (fetch as ProbeFetch);
  const timeoutMs = o.timeoutMs ?? 400;
  const skip = o.skip;
  const order = cdpProbeCandidates({
    preferred: o.preferred,
    lastSuccessful: o.lastSuccessful,
    extra: o.extra,
  }).filter((p) => skip === undefined || p !== skip);
  const flags = await Promise.all(order.map(async (port) => ({
    port,
    live: await isLiveCdpPort(port, fetchImpl, timeoutMs),
  })));
  return flags.find((f) => f.live)?.port;
}
