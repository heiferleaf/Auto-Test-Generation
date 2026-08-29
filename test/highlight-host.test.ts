// 高亮静默失败的宿主侧（src/cdp/adapter.ts + src/recorder/inject.ts 的边界兜底）：
//   1. 原来 `evaluate(...).catch(() => false)` 把「evaluate 抛异常」和「没找到元素」吞成同一个 false，
//      宿主侧既不知道画没画上，也不知道为什么；
//   2. webview 目标能画框、拍不了图，scopeFor 抛错后静默回退主窗口 —— 框在图上看不到。
// 这里用假 target 驱动 adapter 的私有绘制路径，不依赖真浏览器；层是否匹配走纯函数。

import { describe, it, expect, vi } from 'vitest';
import { PlaywrightCdpAdapter, highlightLayerMismatch } from '../src/cdp/adapter';
import { normalizeHighlightResult } from '../src/recorder/inject';
import type { Locator } from '../src/types/step';

/** 只暴露本轮要验的高亮路径，不牵扯 connect / 真浏览器。 */
type HighlightProbe = {
  paintHighlight(target: unknown, loc: Locator): Promise<boolean>;
  lastHighlightStatus(): { ok: boolean; via?: string; reason?: string; detail?: string } | null;
};

const probe = () => new PlaywrightCdpAdapter() as unknown as HighlightProbe;

/** 假 CdpTarget：只实现 evaluate，行为由用例给定。 */
function fakeTarget(fn: (code: string) => unknown): { evaluate: (code: string) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  return {
    evaluate: async (code: string) => { calls.push(code); return fn(code); },
    calls,
  };
}

describe('修复点 1 宿主侧：画不上要带原因，不再吞成 false', () => {
  it('注入层报告没找到元素时，宿主侧原样拿到 reason', async () => {
    const a = probe();
    const t = fakeTarget(() => ({ ok: false, reason: 'no-match' }));

    expect(await a.paintHighlight(t, { css: '#nope' })).toBe(false);
    expect(a.lastHighlightStatus()).toEqual({ ok: false, reason: 'no-match' });
  });

  it('evaluate 抛异常时记 evaluate-failed，而不是和「没找到元素」混成同一个 false', async () => {
    const a = probe();
    const t = fakeTarget(() => { throw new Error('Runtime.evaluate 被拒'); });

    expect(await a.paintHighlight(t, { css: '#x' })).toBe(false);
    const st = a.lastHighlightStatus();
    expect(st?.ok).toBe(false);
    expect(st?.reason).toBe('evaluate-failed');
    expect(st?.detail).toContain('Runtime.evaluate 被拒');
  });

  it('画上了就返回 true 并记住命中路径', async () => {
    const a = probe();
    const t = fakeTarget(() => ({ ok: true, via: 'role+name' }));

    expect(await a.paintHighlight(t, { role: 'button', name: '发送' })).toBe(true);
    expect(a.lastHighlightStatus()).toEqual({ ok: true, via: 'role+name' });
    // 确实把绘制脚本打进了目标上下文。
    expect(t.calls[0]).toContain('__atgHl');
  });

  it('没画过高亮时 lastHighlightStatus 为 null（调用方据此跳过提示）', () => {
    expect(probe().lastHighlightStatus()).toBeNull();
  });

  it('画不上时往 stderr 留痕：有图无框和整页截图在视觉上完全一样', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = probe();
      await a.paintHighlight(fakeTarget(() => ({ ok: false, reason: 'ambiguous' })), { name: '发送' });
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('ambiguous');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('修复点 4：webview 层不匹配必须判得出来', () => {
  it('webview 条目（无 Playwright page）画框层与截图层不一致', () => {
    expect(highlightLayerMismatch({ info: { id: 'wv1' } } as never)).toBe(true);
  });

  it('page 条目（有 Playwright page）两层一致，可以正常画框', () => {
    expect(highlightLayerMismatch({ page: {} } as never)).toBe(false);
  });

  it('未指定 target（走主窗口）不算不匹配', () => {
    expect(highlightLayerMismatch(undefined)).toBe(false);
  });
});

describe('CDP / WS 边界兜底：normalizeHighlightResult', () => {
  it('正常结果原样透传', () => {
    expect(normalizeHighlightResult({ ok: true, via: 'css', multiple: true }))
      .toEqual({ ok: true, via: 'css', multiple: true });
    expect(normalizeHighlightResult({ ok: false, reason: 'no-match', detail: 'x' }))
      .toEqual({ ok: false, reason: 'no-match', detail: 'x' });
  });

  it('旧注入会话的裸 false 也当成「没画上」，不能误判为成功', () => {
    const res = normalizeHighlightResult(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown');
    expect(res.detail ?? '').toContain('旧会话');
  });

  it('null / 空对象 / 非对象同样归为没画上', () => {
    for (const raw of [null, undefined, {}, 'x', 0]) {
      expect(normalizeHighlightResult(raw).ok).toBe(false);
    }
  });
});
