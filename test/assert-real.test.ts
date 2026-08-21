// 测试先行（M1.5）：验证 visible/titleIs/urlMatches/expr 的真实判定（消除假绿）。
// 用可控 stub adapter（eval/snapshot 返回预设值）隔离 CDP，覆盖真判断分支。

import { describe, it, expect } from 'vitest';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { SerializedNode } from '../src/cdp/adapter';
import { runAssertion } from '../src/executor/assert';

function stubAdapter(over: Partial<CdpAdapter> = {}): CdpAdapter {
  return {
    async connect() {}, async disconnect() {}, listTargets: () => [],
    selectTarget() {}, async click() {}, async fill() {}, async select() {},
    async hover() {}, async wait() {}, async eval() { return null; },
    async snapshot() { return []; }, async query() { return null; },
    ...over,
  } as CdpAdapter;
}

describe('真实断言判定（消除假绿）', () => {
  it('titleIs 命中返回 true', async () => {
    const a = stubAdapter({ eval: async (c) => (c === 'document.title' ? 'Demo Login' : null) });
    const r = await runAssertion(a, { kind: 'titleIs', value: 'Demo Login' });
    expect(r.passed).toBe(true);
  });

  it('titleIs 不匹配返回 false', async () => {
    const a = stubAdapter({ eval: async () => 'Other' });
    const r = await runAssertion(a, { kind: 'titleIs', value: 'Demo Login' });
    expect(r.passed).toBe(false);
  });

  it('urlMatches 正则命中返回 true', async () => {
    const a = stubAdapter({ eval: async (c) => (c === 'location.href' ? 'https://x.com/home' : null) });
    const r = await runAssertion(a, { kind: 'urlMatches', value: '/home$/' });
    expect(r.passed).toBe(true);
  });

  it('urlMatches 包含比对命中返回 true', async () => {
    const a = stubAdapter({ eval: async (c) => (c === 'location.href' ? 'https://x.com/login' : null) });
    const r = await runAssertion(a, { kind: 'urlMatches', value: 'login' });
    expect(r.passed).toBe(true);
  });

  it('expr 为真返回 true', async () => {
    const a = stubAdapter({ eval: async () => 1 + 1 === 2 });
    const r = await runAssertion(a, { kind: 'expr', value: '1 + 1 === 2' });
    expect(r.passed).toBe(true);
  });

  it('expr 为假返回 false', async () => {
    const a = stubAdapter({ eval: async () => 1 > 2 });
    const r = await runAssertion(a, { kind: 'expr', value: '1 > 2' });
    expect(r.passed).toBe(false);
  });

  it('visible 命中且快照标记为可见返回 true', async () => {
    const nodes: SerializedNode[] = [
      { role: 'button', name: 'Login', visible: true },
    ];
    const a = stubAdapter({ snapshot: async () => nodes });
    const r = await runAssertion(a, { kind: 'visible', locator: { role: 'button', name: 'Login' } });
    expect(r.passed).toBe(true);
  });

  it('visible 命中但快照标记为隐藏返回 false', async () => {
    const nodes: SerializedNode[] = [
      { role: 'button', name: 'Login', visible: false },
    ];
    const a = stubAdapter({ snapshot: async () => nodes });
    const r = await runAssertion(a, { kind: 'visible', locator: { role: 'button', name: 'Login' } });
    expect(r.passed).toBe(false);
  });

  it('visible 无匹配节点返回 false', async () => {
    const a = stubAdapter({ snapshot: async () => [] });
    const r = await runAssertion(a, { kind: 'visible', locator: { role: 'button', name: 'Missing' } });
    expect(r.passed).toBe(false);
  });
});
