// @vitest-environment jsdom
// 生成后的非破坏性预演（dry run）：只验证定位、不执行操作。
//
// 语义边界（刻意如此，不是缺陷）：预演只对**当前界面状态下就存在的元素**有效。
// 第 1 步通常有效；第 3 步那种"前两步跑完才出现"的元素，预演必然找不到 ——
// 这不是失败，不能报成错误把 Agent 带偏，必须如实说"需前序步骤执行后才出现"。
//
// 最硬的一条约束：预演**不得产生任何副作用**。它只能调 kernel.locateVisual，
// 不点击、不填值、不切窗口、不跑 playback。本文件用"内核调用清单"守住这条。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Locator, Script } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';

type AnyKernel = any;

/** 当前界面上"存在"的元素名。 */
const PRESENT = new Set(['搜索框', '结果区']);

function makeProbeKernel(opts: { throwOn?: string } = {}): AnyKernel {
  const calls: string[] = [];
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  const kernel: AnyKernel = {
    calls,
    listeners,
    connect: vi.fn(async () => { calls.push('connect'); }),
    disconnect: vi.fn(async () => { calls.push('disconnect'); }),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title: '主窗口' }]),
    selectTarget: vi.fn((id: string) => { calls.push(`selectTarget:${id}`); }),
    click: vi.fn(async (l: Locator) => { calls.push(`click:${l.name}`); }),
    fill: vi.fn(async (l: Locator) => { calls.push(`fill:${l.name}`); }),
    select: vi.fn(async () => { calls.push('select'); }),
    hover: vi.fn(async () => { calls.push('hover'); }),
    wait: vi.fn(async () => { calls.push('wait'); }),
    eval: vi.fn(async () => { calls.push('eval'); return undefined; }),
    snapshot: vi.fn(async () => { calls.push('snapshot'); return []; }),
    query: vi.fn(async () => { calls.push('query'); return undefined; }),
    screenshot: vi.fn(async () => { calls.push('screenshot'); return Buffer.from('PNG'); }),
    // 视觉定位是**只读**能力：取 bounding box，不改变被测软件任何状态。
    locateVisual: vi.fn(async (l: Locator) => {
      calls.push(`locateVisual:${l.name ?? ''}`);
      if (opts.throwOn && l.name === opts.throwOn) throw new Error('定位服务不可用');
      // 真机 locateVisual 找不到元素时返回 visible:false 的零框，**不抛错**。
      return PRESENT.has(l.name ?? '')
        ? { x: 1, y: 2, width: 30, height: 12, visible: true, inViewport: true }
        : { x: 0, y: 0, width: 0, height: 0, visible: false, inViewport: false };
    }),
    startRecording: vi.fn(async () => { calls.push('startRecording'); }),
    stopRecording: vi.fn(async () => { calls.push('stopRecording'); return []; }),
    playback: vi.fn(async () => { calls.push('playback'); return { ok: true }; }),
    startPick: vi.fn(async () => { calls.push('startPick'); }),
    cancelPick: vi.fn(async () => { calls.push('cancelPick'); }),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => { listeners[event]?.delete(cb); }),
  };
  return kernel;
}

const scriptOf = (steps: Script['steps']): Script => ({
  schema: SCRIPT_SCHEMA, app: { name: 'T' }, steps,
});

/** 3 步：第 1 步当前就存在，第 2 步要前序执行后才出现，第 3 步又是当前存在的。 */
const THREE: Script = scriptOf([
  { id: 'p1', type: 'click', source: 'agent', locator: { name: '搜索框' } },
  { id: 'p2', type: 'click', source: 'agent', locator: { name: '稍后才出现的按钮' } },
  { id: 'p3', type: 'assert', source: 'agent', locator: { name: '结果区' }, expect: { kind: 'visible' } },
]);

function boot(kernel: AnyKernel, script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel, mount, script });
  shell.render();
  return { shell, mount };
}

describe('生成后的非破坏性预演：只验证定位、不执行操作', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('当前状态存在的元素报 found，不存在的报 notYetPresent（不是失败）', async () => {
    const kernel = makeProbeKernel();
    const { shell } = boot(kernel, THREE);
    await shell.connect();
    const report = await shell.dryRun();

    expect(report.ran).toBe(true);
    expect(report.results.map((r) => [r.stepId, r.outcome])).toEqual([
      ['p1', 'found'],
      ['p2', 'notYetPresent'],
      ['p3', 'found'],
    ]);
    expect(report.foundCount).toBe(2);
    expect(report.notYetCount).toBe(1);
    expect(report.results[0].message).toContain('已确认存在');
    // 关键文案：说清"为什么没有"，而不是报错把 Agent 带偏
    expect(report.results[1].message).toContain('需前序步骤执行后才出现');
    expect(report.results[1].message).toContain('无法在预演阶段验证');
  });

  it('预演不产生任何副作用：只调 locateVisual，绝不点击/填值/切窗口/跑脚本', async () => {
    const kernel = makeProbeKernel();
    const { shell } = boot(kernel, THREE);
    await shell.connect();
    const before = [...kernel.calls];

    await shell.dryRun();

    const added: string[] = kernel.calls.slice(before.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((c) => !c.startsWith('locateVisual'))).toEqual([]);
    expect(kernel.playback).not.toHaveBeenCalled();
    expect(kernel.click).not.toHaveBeenCalled();
    expect(kernel.fill).not.toHaveBeenCalled();
    expect(kernel.hover).not.toHaveBeenCalled();
    expect(kernel.select).not.toHaveBeenCalled();
    expect(kernel.selectTarget).not.toHaveBeenCalled();
    expect(kernel.screenshot).not.toHaveBeenCalled();
    expect(kernel.eval).not.toHaveBeenCalled();
  });

  it('未连接时明确告知无法预演，不静默返回空结论', async () => {
    const kernel = makeProbeKernel();
    const { shell } = boot(kernel, THREE);
    const report = await shell.dryRun();
    expect(report.ran).toBe(false);
    expect(report.notice).toContain('未连接靶机');
    expect(report.results).toEqual([]);
    expect(kernel.locateVisual).not.toHaveBeenCalled();
  });

  it('locateVisual 抛错时该步记 notYetPresent 并带上原因，整体不抛、不算失败', async () => {
    const kernel = makeProbeKernel({ throwOn: '搜索框' });
    const { shell } = boot(kernel, THREE);
    await shell.connect();
    const report = await shell.dryRun();
    expect(report.ran).toBe(true);
    expect(report.results[0].outcome).toBe('notYetPresent');
    expect(report.results[0].message).toContain('定位服务不可用');
  });

  it('没有 locator 的步骤（整页 textContains / 纯等待）不参与预演', async () => {
    const kernel = makeProbeKernel();
    const script = scriptOf([
      { id: 'w1', type: 'wait', source: 'agent', params: { durationMs: 10 } },
      {
        id: 'w2', type: 'waitUntil', source: 'agent',
        params: { timeoutMs: 1000, assertion: { kind: 'textContains', value: 'atg-agent' } },
      },
      { id: 'c1', type: 'click', source: 'agent', locator: { name: '搜索框' } },
    ]);
    const { shell } = boot(kernel, script);
    await shell.connect();
    const report = await shell.dryRun();
    expect(report.results.map((r) => r.stepId)).toEqual(['c1']);
  });

  it('预演不改变工作台状态：步骤仍是 pending，不产生截图', async () => {
    const kernel = makeProbeKernel();
    const { shell, mount } = boot(kernel, THREE);
    await shell.connect();
    await shell.dryRun();
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(mount.querySelector('[data-cfg-node="p1"]')?.getAttribute('data-cfg-status')).toBe('pending');
  });
});
