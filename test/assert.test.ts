// 测试先行：先于 src/executor/assert.ts 实现存在。
// 目标：覆盖各断言 kind 的行为（M1 执行器断言引擎）。

import { describe, it, expect } from 'vitest';
import type { Assertion } from '../src/types/step';
import type { CdpAdapter } from '../src/cdp/adapter';
import { runAssertion } from '../src/executor/assert';

// 用可控的 adapter 桩，snapshot/query 返回预设值。
function stubAdapter(over: Partial<CdpAdapter> = {}): CdpAdapter {
  return {
    async connect() {}, async disconnect() {}, listTargets: () => [],
    selectTarget() {}, async click() {}, async fill() {}, async select() {},
    async hover() {}, async wait() {}, async eval() { return null; },
    async snapshot() { return []; }, async query() { return null; },
    ...over,
  } as CdpAdapter;
}

describe('断言引擎', () => {
  it('textContains 命中返回 true', async () => {
    const a = stubAdapter({ snapshot: async () => { return [{ text: 'Welcome Dashboard' }]; } });
    const r = await runAssertion(a, { kind: 'textContains', value: 'Dashboard' });
    expect(r.passed).toBe(true);
  });

  it('textContains 未命中返回 false', async () => {
    const a = stubAdapter({ snapshot: async () => { return [{ text: 'Login' }]; } });
    const r = await runAssertion(a, { kind: 'textContains', value: 'Dashboard' });
    expect(r.passed).toBe(false);
  });

  it('exists 命中（query 非空）返回 true', async () => {
    const a = stubAdapter({ query: async () => ({}) });
    const r = await runAssertion(a, { kind: 'exists', locator: { css: '#btn' } });
    expect(r.passed).toBe(true);
  });

  it('未知 kind 抛错', async () => {
    const a = stubAdapter();
    await expect(runAssertion(a, { kind: 'unknown' as any })).rejects.toThrow(/kind/i);
  });
});
