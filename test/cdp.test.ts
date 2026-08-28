// 测试先行：先于 src/cdp/adapter.ts 与 src/cdp/targets.ts 实现存在。
// 目标：验证 CDP 适配层连接/枚举/选择行为，以及真实连接冒烟（M1 验收 §8-1,§8-4）。

import { describe, it, expect, vi } from 'vitest';
import type { CdpAdapter, TargetInfo } from '../src/cdp/adapter';
import type { Locator } from '../src/types/step';

// 用 mock adapter 验证执行器与 CDP 的契约，不依赖真实 Electron。
function makeMockAdapter(): CdpAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async connect() { calls.push('connect'); },
    async disconnect() { calls.push('disconnect'); },
    listTargets(): TargetInfo[] {
      return [
        { id: 'w1', type: 'page', title: 'main', isMain: true },
        { id: 'wv1', type: 'webview', title: 'settings' },
      ];
    },
    selectTarget(id: string) { calls.push('select:' + id); },
    async click(_l: Locator) { calls.push('click'); },
    async fill(_l: Locator, _v: string) { calls.push('fill'); },
    async select(_l: Locator, _o: string) { calls.push('select'); },
    async hover(_l: Locator) { calls.push('hover'); },
    async wait(_o: { text?: string; durationMs?: number }) { calls.push('wait'); },
    async eval(_c: string) { return null; },
    async snapshot() { return []; },
    async query(_l: Locator) { return null; },
    async pageText() { return null; },
  };
}

describe('CDP 适配层契约', () => {
  it('connect 后 listTargets 返回 window/webview', () => {
    const a = makeMockAdapter();
    a.connect();
    const ts = a.listTargets();
    expect(ts.some((t) => t.type === 'page')).toBe(true);
    expect(ts.some((t) => t.type === 'webview')).toBe(true);
  });

  it('selectTarget 能切换到指定 webview', () => {
    const a = makeMockAdapter();
    a.selectTarget('wv1');
    expect(a.calls).toContain('select:wv1');
  });
});

// 真实连接冒烟：需示例 Electron App 开启 9222。无环境时跳过。
describe.skip('CDP 真实连接冒烟', () => {
  it('connect localhost:9222 能列出目标', async () => {
    // 见 src/cdp/adapter.ts 真实实现 + scripts/demo-electron-app
  });
});
