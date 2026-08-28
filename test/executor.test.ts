// 测试先行：先于 src/executor/executor.ts 与 src/executor/actions.ts 实现存在。
// 目标：用 mock adapter 驱动一组步骤，验证各 type 正确映射到 CDP 调用（M1 验收 §8）。

import { describe, it, expect, vi } from 'vitest';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { Script } from '../src/types/step';
import { runScript } from '../src/executor/executor';

function makeMockAdapter(): CdpAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async connect() {},
    async disconnect() {},
    listTargets: () => [{ id: 'w1', type: 'page', title: 'main', isMain: true }],
    selectTarget() {},
    async click(_l) { calls.push('click'); },
    async fill(_l, v) { calls.push('fill:' + v); },
    async select(_l, o) { calls.push('select:' + o); },
    async hover(_l) { calls.push('hover'); },
    async wait(_o) { calls.push('wait'); },
    async eval(_c) { return null; },
    async snapshot() { return []; },
    async query(_l) { return null; },
    async pageText() { return null; },
  };
}

describe('步骤执行器', () => {
  it('按序执行 fill + click 并映射到 adapter', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [
        { id: 's1', type: 'fill', locator: { name: 'Username' }, params: { value: 'admin' }, source: 'manual' },
        { id: 's2', type: 'click', locator: { role: 'button', name: 'Login' }, source: 'manual' },
      ],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['fill:admin', 'click']);
  });

  it('遇 assert 失败应抛出结构化错误并保留步骤信息', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [
        { id: 's1', type: 'assert', expect: { kind: 'textContains', value: 'Dashboard' }, source: 'manual' },
      ],
    };
    // 注：assert 引擎（src/executor/assert.ts）真实实现后，此处应断言抛错且含 stepId 's1'
    await expect(runScript(a, script)).rejects.toMatchObject({ stepId: 's1' });
  });

  it('waitUntil 轮询 assertion 直到成立，不是只 sleep', async () => {
    let n = 0;
    const a = makeMockAdapter();
    a.query = async () => {
      n += 1;
      return n >= 3 ? {} : null;
    };
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [{
        id: 'w',
        type: 'waitUntil',
        source: 'manual',
        params: {
          timeoutMs: 2000,
          assertion: { kind: 'exists', locator: { name: 'Ready' } },
        },
      }],
    };
    await runScript(a, script);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  // 只报"超时 5000ms"没法区分两种故障：目标还没渲染（该调大超时），
  // 还是判定来源不对（要找的字压根不在断言视野里）。超时必须带"最后一次为何不匹配"。
  it('waitUntil 超时信息带上最后一次未匹配的原因，不只是"超时 N ms"', async () => {
    const a = makeMockAdapter();
    a.pageText = async () => '当前页面只有这段字';
    a.query = async () => null;
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [{
        id: 'w',
        type: 'waitUntil',
        source: 'manual',
        params: {
          timeoutMs: 300,
          assertion: { kind: 'textContains', value: '期望出现的提示' },
        },
      }],
    };
    await expect(runScript(a, script)).rejects.toThrow(/期望出现的提示/);
    await expect(runScript(a, script)).rejects.toThrow(/最后一次未匹配原因/);
    // 诊断上下文要能看清页面上现在到底有什么，才谈得上判断"是没渲染还是找错地方"。
    await expect(runScript(a, script)).rejects.toThrow(/当前页面只有这段字/);
  });

  it('waitUntil 超时时 exists 断言给出"未找到节点"而非笼统超时', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [{
        id: 'w',
        type: 'waitUntil',
        source: 'manual',
        params: {
          timeoutMs: 300,
          assertion: { kind: 'exists', locator: { name: 'Ready' } },
        },
      }],
    };
    await expect(runScript(a, script)).rejects.toThrow(/未找到节点/);
  });
});
