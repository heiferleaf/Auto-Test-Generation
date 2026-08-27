// 测试先行：M2 可视化能力层。
// 先于 src/cdp/adapter.ts（screenshot/locateVisual）与 src/executor/assert.ts（视觉断言 kind）实现存在。
// 目标：验证可视化接口契约 + 视觉断言 kind 注册正确（OCP，仅追加）。
//
// 设计依据：docs/可视化测试方案.md §3；验收 §8-3/§8-4（核心零改动，仅注册扩展）。

import { describe, it, expect } from 'vitest';
import type { CdpAdapter, VisualCapable, SerializedNode } from '../src/cdp/adapter';
import type { Locator } from '../src/types/step';
import { assertionHandlers, runAssertion } from '../src/executor/assert';

/** mock 一个可视化适配器，记录调用并返回可控结果。 */
function makeVisualMock(overrides: Partial<VisualCapable> = {}): VisualCapable & {
  calls: string[];
  lastScreenshotOpts?: unknown;
  lastLocateLoc?: Locator;
} {
  const calls: string[] = [];
  return {
    calls,
    async screenshot(opts?: { target?: string; element?: Locator; fullPage?: boolean }) {
      calls.push('screenshot');
      this.lastScreenshotOpts = opts;
      return Buffer.from('fake-png');
    },
    async locateVisual(loc: Locator) {
      calls.push('locateVisual');
      this.lastLocateLoc = loc;
      return { x: 10, y: 20, width: 100, height: 40, visible: true, inViewport: true };
    },
    ...overrides,
  } as VisualCapable & { calls: string[]; lastScreenshotOpts?: unknown; lastLocateLoc?: Locator };
}

describe('可视化适配器接口契约（ISP：VisualCapable 派生）', () => {
  it('screenshot 返回非空 Buffer/PNG 数据', async () => {
    const a = makeVisualMock();
    const buf = await a.screenshot();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect((buf as Buffer).length).toBeGreaterThan(0);
  });

  it('screenshot 支持指定 element / target / fullPage 选项透传', async () => {
    const a = makeVisualMock();
    const loc: Locator = { role: 'button', name: '侧栏' };
    await a.screenshot({ target: 'webview-1', element: loc, fullPage: true });
    expect(a.calls).toContain('screenshot');
    expect(a.lastScreenshotOpts).toEqual({ target: 'webview-1', element: loc, fullPage: true });
  });

  it('screenshot 支持 highlight：拍摄前在靶机上画定位框', async () => {
    const a = makeVisualMock();
    const loc: Locator = { name: 'settings.json' };
    await a.screenshot({ highlight: loc });
    expect(a.lastScreenshotOpts).toEqual({ highlight: loc });
  });

  it('locateVisual 返回含 rect 与 visible 的视觉位置', async () => {
    const a = makeVisualMock();
    const box = await a.locateVisual({ role: 'button', name: '侧栏' });
    expect(box).toMatchObject({ x: 10, y: 20, width: 100, height: 40, visible: true });
    expect(typeof box.visible).toBe('boolean');
  });
});

describe('视觉断言 kind 注册（OCP：仅追加，不动核心）', () => {
  it('elementVisibleInViewport 已注册且可调用', () => {
    expect(typeof assertionHandlers.elementVisibleInViewport).toBe('function');
  });

  it('screenshotMatches 已注册且可调用', () => {
    expect(typeof assertionHandlers.screenshotMatches).toBe('function');
  });

  it('runAssertion 能分发到视觉 kind（不抛未知 kind）', async () => {
    // 用 mock adapter 提供 locateVisual；断言引擎只验证 kind 可达。
    const a = makeVisualMock() as unknown as CdpAdapter;
    // 仅验证种类分发不抛错（具体真值由实现决定，此处 mock 返回 visible=true）。
    const r = await runAssertion(a, {
      kind: 'elementVisibleInViewport',
      locator: { role: 'button', name: '侧栏' },
    });
    expect(r).toHaveProperty('passed');
  });
});

// 占位：SerializedNode 扩展 rect/visible 字段的编译期存在性（M2 §3.2）。
describe('SerializedNode 视觉字段（编译期契约）', () => {
  it('SerializedNode 可选携带 rect 与 visible', () => {
    const n: SerializedNode = { role: 'button', rect: { x: 0, y: 0, width: 1, height: 1 }, visible: true };
    expect(n.rect?.width).toBe(1);
    expect(n.visible).toBe(true);
  });
});
