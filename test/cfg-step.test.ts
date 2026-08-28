// 测试先行：M3-R0 CFG 步骤模型。
// 目标：验证递归控制流（sequence / if / while）与 v2 schema IO 往返、v1 向后兼容。

import { describe, it, expect, vi } from 'vitest';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { Script, Step } from '../src/types/step';
import { runScript } from '../src/executor/executor';
import { importScript, exportScript } from '../src/script/io';

function makeMockAdapter(): CdpAdapter & { calls: string[] } {
  const calls: string[] = [];
  // click/fill 等按 id 记录，便于验证控制流走向
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
    // 返回含 'always' 的节点，使 TRUE_COND(textContains 'always') 真为真、
    // FALSE_COND(textContains 'never') 真为假 —— 两个条件必须可区分，
    // 否则 if 分支测试无法证伪实现。
    async snapshot() { return [{ role: 'text', name: 'always', text: 'always' }]; },
    async query(_l) { return null; },
    // 整页兜底必须返回空：否则 FALSE_COND(textContains 'never') 会被兜底改成真，
    // 两个条件就不可区分，if 分支测试失去证伪能力。
    async pageText() { return ''; },
  };
}

// 构造带 children 的节点（CFG 树）
function seq(id: string, children: Step[]): Step {
  return { id, type: 'snapshot', source: 'manual', control: { kind: 'sequence' }, children };
}
function iff(id: string, cond: Step['control'] extends infer _ ? any : never, thenStep: Step, elseStep?: Step): Step {
  return {
    id, type: 'snapshot', source: 'manual',
    control: { kind: 'if', condition: cond },
    children: elseStep ? [thenStep, elseStep] : [thenStep],
  } as Step;
}
function whileLoop(id: string, count: number, body: Step[]): Step {
  return { id, type: 'snapshot', source: 'manual', control: { kind: 'while', loopCount: count }, children: body };
}
function leaf(id: string, type: Step['type'], value?: string): Step {
  return { id, type, locator: { name: id }, params: value !== undefined ? { value } : undefined, source: 'manual' };
}

const TRUE_COND = { kind: 'textContains' as const, value: 'always' };
const FALSE_COND = { kind: 'textContains' as const, value: 'never' };

describe('CFG 递归执行器', () => {
  it('sequence 节点按序执行全部 children', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [seq('g1', [leaf('a', 'click'), leaf('b', 'click')])],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['click', 'click']);
  });

  it('if 条件为真只执行 then 分支', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [iff('if1', TRUE_COND, leaf('then', 'click'), leaf('els', 'fill', 'x'))],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['click']);
  });

  it('if 条件为假只执行 else 分支', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [iff('if1', FALSE_COND, leaf('then', 'click'), leaf('els', 'fill', 'x'))],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['fill:x']);
  });

  it('while 按 loopCount 重复执行 body', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [whileLoop('w1', 3, [leaf('b', 'hover')])],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['hover', 'hover', 'hover']);
  });

  it('嵌套 sequence 内含 if 按结构执行', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [seq('g', [leaf('a', 'click'), iff('i', FALSE_COND, leaf('t', 'click'), leaf('e', 'fill', 'y'))])],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['click', 'fill:y']);
  });

  it('扁平叶子步骤仍走原 runStep（向后兼容 v1 行为）', async () => {
    const a = makeMockAdapter();
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [leaf('a', 'fill', 'hi'), leaf('b', 'click')],
    };
    await runScript(a, script);
    expect(a.calls).toEqual(['fill:hi', 'click']);
  });
});

describe('CFG 脚本 IO', () => {
  it('v2 含 children 经 import→export→import 往返一致', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [seq('g', [leaf('a', 'click'), iff('i', TRUE_COND, leaf('t', 'click'))])],
    };
    const round = importScript(exportScript(s));
    expect(round.schema).toBe('electron-auto-test/step/v2');
    expect(round.steps[0].children).toHaveLength(2);
    expect(round.steps[0].control?.kind).toBe('sequence');
  });

  it('v1 扁平脚本仍能 import 成功（向后兼容）', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'demo' },
      steps: [leaf('a', 'click')],
    };
    expect(() => importScript(exportScript(s))).not.toThrow();
  });

  it('非 v1/v2 schema 仍抛错', () => {
    expect(() => importScript(JSON.stringify({ schema: 'other', steps: [] }))).toThrow();
  });
});
