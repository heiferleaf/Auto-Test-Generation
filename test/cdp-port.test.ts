import { describe, it, expect, vi } from 'vitest';
import {
  resolveCdpPort,
  CDP_PROBE_BAND,
  cdpProbeCandidates,
  parseCdpProbeList,
  probeLiveCdpPort,
} from '../src/ui/cdp-port';

describe('resolveCdpPort', () => {
  it('?cdp= 优先于注入端口和默认 9222', () => {
    expect(resolveCdpPort('?cdp=9246', 9244)).toBe(9246);
  });

  it('没有 ?cdp= 时用宿主注入的 CDP_PORT', () => {
    expect(resolveCdpPort('', 9244)).toBe(9244);
    expect(resolveCdpPort('?live=1', 9246)).toBe(9246);
  });

  it('都没有则 9222', () => {
    expect(resolveCdpPort('?live=1')).toBe(9222);
  });

  it('非法 cdp 参数忽略，回退注入或默认', () => {
    expect(resolveCdpPort('?cdp=abc', 9244)).toBe(9244);
    expect(resolveCdpPort('?cdp=0')).toBe(9222);
  });
});

describe('cdpProbeCandidates', () => {
  it('顺序：首选 → 上次成功 → 环境追加 → 号段扫描', () => {
    const ports = cdpProbeCandidates({
      preferred: 9300,
      lastSuccessful: 9310,
      extra: parseCdpProbeList('9320, 9330'),
    });
    expect(ports.slice(0, 4)).toEqual([9300, 9310, 9320, 9330]);
    expect(ports).toContain(CDP_PROBE_BAND.from);
    expect(ports).toContain(CDP_PROBE_BAND.to);
  });

  it('号段是本机调试口，不是某一款 App 的产品知识', () => {
    expect(CDP_PROBE_BAND.from).toBe(9222);
    expect(CDP_PROBE_BAND.to).toBe(9260);
  });
});

describe('probeLiveCdpPort', () => {
  it('跳过已失败端口，连上号段里第一个 /json 有 webSocketDebuggerUrl 的口', async () => {
    const tried: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const port = Number(new URL(url).port);
      tried.push(port);
      const live = port === 9246;
      return {
        ok: live,
        json: async () => (live ? [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9246/devtools' }] : []),
      };
    });
    const port = await probeLiveCdpPort({ skip: 9222, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(port).toBe(9246);
    expect(tried).not.toContain(9222);
    expect(tried).toContain(9246);
    expect(tried.some((p) => p >= CDP_PROBE_BAND.from && p <= CDP_PROBE_BAND.to)).toBe(true);
  });

  it('全部无 /json 时返回 undefined', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const port = await probeLiveCdpPort({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(port).toBeUndefined();
  });
});
