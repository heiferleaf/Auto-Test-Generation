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
    async pageText() { return null; },
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

  it('textContains 有 locator 时只搜该节点文本', async () => {
    const a = stubAdapter({
      snapshot: async () => ([
        { role: 'button', name: '发送', text: '发送' },
        { role: 'status', name: 'out', text: 'Welcome Dashboard' },
      ]),
    });
    const miss = await runAssertion(a, {
      kind: 'textContains',
      value: 'Dashboard',
      locator: { role: 'button', name: '发送' },
    });
    expect(miss.passed).toBe(false);
    const hit = await runAssertion(a, {
      kind: 'textContains',
      value: '发送',
      locator: { role: 'button', name: '发送' },
    });
    expect(hit.passed).toBe(true);
  });

  // ---- textContains 的整页兜底（网页靶机评估暴露的主分支缺陷）----
  //
  // snapshot 只收可交互元素与带 role 的元素，而"操作后出现的新结果"多半是
  // 无 role 的 div/p/span 里的纯文本。只搜 snapshot 会导致「页面上有字、断言却超时」。
  // 以下用例钉死：snapshot 未命中时回落到整页文本，但 locator 的限定作用不被架空。

  it('textContains 在 snapshot 空时回落到整页文本（纯 div 文字也能断言）', async () => {
    const a = stubAdapter({
      snapshot: async () => [],
      pageText: async () => '操作成功，共 3 条记录',
    });
    const r = await runAssertion(a, { kind: 'textContains', value: '共 3 条记录' });
    expect(r.passed).toBe(true);
  });

  it('textContains 回落仍会判负：整页文本里没有期望串', async () => {
    const a = stubAdapter({
      snapshot: async () => [],
      pageText: async () => '操作成功',
    });
    const r = await runAssertion(a, { kind: 'textContains', value: '共 3 条记录' });
    expect(r.passed).toBe(false);
  });

  it('textContains 回落取不到整页文本（null）时不放宽为通过', async () => {
    const a = stubAdapter({ snapshot: async () => [], pageText: async () => null });
    const r = await runAssertion(a, { kind: 'textContains', value: '操作成功' });
    expect(r.passed).toBe(false);
  });

  it('textContains 有 css locator 时，回落只搜该子树', async () => {
    let asked: string | undefined;
    const a = stubAdapter({
      snapshot: async () => [],
      pageText: async (sel) => {
        asked = sel;
        return sel === '#result' ? '搜索完成' : '别处的文字';
      },
    });
    const hit = await runAssertion(a, {
      kind: 'textContains', value: '搜索完成', locator: { css: '#result' },
    });
    expect(asked).toBe('#result');
    expect(hit.passed).toBe(true);

    // 该串只在 #result 里；换个子树就该判负，证明 locator 未被架空。
    const miss = await runAssertion(a, {
      kind: 'textContains', value: '搜索完成', locator: { css: '#other' },
    });
    expect(miss.passed).toBe(false);
  });

  it('textContains 的语义 locator（role/name）不降级为整页兜底，避免架空限定', async () => {
    let pageTextCalls = 0;
    const a = stubAdapter({
      // snapshot 里没有 button（模拟该 button 未被收录）
      snapshot: async () => [],
      pageText: async () => { pageTextCalls += 1; return '发送成功'; },
    });
    const r = await runAssertion(a, {
      kind: 'textContains', value: '发送成功', locator: { role: 'button', name: '发送' },
    });
    // role/name 无法可靠映射成 CSS 选择器，猜错范围比不兜底更糟，故不兜底。
    expect(pageTextCalls).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('textContains 命中 snapshot 时不额外查整页文本（不拖慢轮询）', async () => {
    let pageTextCalls = 0;
    const a = stubAdapter({
      snapshot: async () => [{ text: 'Welcome Dashboard' }],
      pageText: async () => { pageTextCalls += 1; return ''; },
    });
    const r = await runAssertion(a, { kind: 'textContains', value: 'Dashboard' });
    expect(r.passed).toBe(true);
    expect(pageTextCalls).toBe(0);
  });

  // 这条是缺陷的真实形状：snapshot **非空**（页面上有控件），但要找的字在纯文本节点里。
  // 若兜底只在"snapshot 为空"时触发，这里就永远落不到兜底，缺陷照旧。
  it('textContains 在 snapshot 非空但不含目标文字时，仍回落到整页文本', async () => {
    const a = stubAdapter({
      snapshot: async () => [
        { role: 'button', name: '搜索', text: '搜索' },
        { role: 'textbox', name: '搜索', text: '' },
      ],
      pageText: async () => '搜索\n搜索完成，共 3 条记录',
    });
    const r = await runAssertion(a, { kind: 'textContains', value: '共 3 条记录' });
    expect(r.passed).toBe(true);
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
