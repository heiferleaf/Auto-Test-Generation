// 测试先行：先于 src/cli.ts 实现存在。
// 目标：CLI 跑通 demo 脚本全流程，失败路径输出结构化错误（M1 验收 §8-3,§8-5）。

import { describe, it, expect } from 'vitest';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { Script } from '../src/types/step';
import { runCli } from '../src/cli';

function stubAdapter(opts: { failAt?: string } = {}): CdpAdapter {
  return {
    async connect() {}, async disconnect() {},
    listTargets: () => [{ id: 'w1', type: 'page', title: 'main', isMain: true }],
    selectTarget() {},
    async click() { if (opts.failAt === 'click') throw new Error('element not found'); },
    async fill() {}, async select() {}, async hover() {}, async wait() {},
    async eval() { return null; }, async snapshot() { return []; }, async query() { return null; },
  } as CdpAdapter;
}

const demoScript: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'demo' },
  steps: [
    { id: 's1', type: 'fill', locator: { name: 'Username' }, params: { value: 'admin' }, source: 'manual' },
    { id: 's2', type: 'click', locator: { role: 'button', name: 'Login' }, source: 'manual' },
  ],
};

describe('CLI 入口', () => {
  it('成功路径返回 ok', async () => {
    const res = await runCli({ adapter: stubAdapter(), script: demoScript });
    expect(res.ok).toBe(true);
  });

  it('失败路径返回结构化错误（含 stepId）', async () => {
    const res = await runCli({ adapter: stubAdapter({ failAt: 'click' }), script: demoScript });
    expect(res.ok).toBe(false);
    expect(res.failedStepId).toBe('s2');
  });
});
