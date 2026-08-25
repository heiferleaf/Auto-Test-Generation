// @vitest-environment jsdom
// B6 「从此处运行」(fromStepId) 验收（spec §2.7）。
// 执行器层：前序跳过 fromStepId 之前的步骤；UI 层：点「从此处运行」→ kernel.playback(script, id)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { Script, Step } from '../src/types/step';
import { runScript } from '../src/executor/executor';
import { UiShell } from '../src/ui/shell';

function makeMockAdapter(): CdpAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async connect() {}, async disconnect() {},
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
  };
}

function leaf(id: string, val?: string): Step {
  return val !== undefined
    ? { id, type: 'fill', locator: { name: id }, params: { value: val }, source: 'manual' }
    : { id, type: 'click', locator: { role: 'button', name: id }, source: 'manual' };
}

describe('执行器 fromStepId（§2.7 从此处运行）', () => {
  it('未传 fromStepId：从头执行全部（向后兼容）', async () => {
    const a = makeMockAdapter();
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a', '1'), leaf('b', '2')] };
    await runScript(a, s);
    expect(a.calls).toEqual(['fill:1', 'fill:2']);
  });

  it('传 fromStepId：跳过该步之前的步骤，从该步起执行', async () => {
    const a = makeMockAdapter();
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a', '1'), leaf('b', '2'), leaf('c', '3')] };
    await runScript(a, s, undefined, 'b');
    expect(a.calls).toEqual(['fill:2', 'fill:3']); // a 被跳过
  });

  it('fromStepId 是顺序组内的步骤：跳过组内之前的步骤', async () => {
    const a = makeMockAdapter();
    const grp: Step = { id: 'g', type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: [leaf('a', '1'), leaf('b', '2'), leaf('c', '3')] };
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [grp] };
    await runScript(a, s, undefined, 'b');
    expect(a.calls).toEqual(['fill:2', 'fill:3']); // 组内 a 被跳过
  });

  it('fromStepId 不存在：无步骤执行（不报错）', async () => {
    const a = makeMockAdapter();
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a', '1')] };
    await runScript(a, s, undefined, 'nope');
    expect(a.calls).toEqual([]);
  });

  it('进度回调：fromStepId 之前的步骤不上报 running', async () => {
    const a = makeMockAdapter();
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a', '1'), leaf('b', '2')] };
    const seen: string[] = [];
    await runScript(a, s, (id, st) => { if (st === 'running') seen.push(id); }, 'b');
    expect(seen).toEqual(['b']); // a 不上报
  });
});

// ───────────────────────── UI 主链路 ─────────────────────────

function makeMockKernelUI() {
  return {
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    listTargets: vi.fn(() => [{ id: 'main', type: 'page', title: '主窗口', url: 'app://main' }]),
    selectTarget: vi.fn(() => {}),
    click: vi.fn(async () => {}), fill: vi.fn(async () => {}), select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}), wait: vi.fn(async () => {}), eval: vi.fn(async () => {}),
    snapshot: vi.fn(async () => []), query: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('f')),
    locateVisual: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true })),
    startRecording: vi.fn(() => {}), stopRecording: vi.fn(async () => []),
    playback: vi.fn(async (_s: Script, _from?: string) => ({ ok: true })),
    on: vi.fn(), off: vi.fn(),
    startPick: vi.fn(async () => {}), cancelPick: vi.fn(async () => {}),
  } as any;
}

function bootUI(s: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const kernel = makeMockKernelUI();
  const shell = new UiShell({ kernel, mount, script: s });
  shell.render();
  return { shell, mount, kernel };
}

function click(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('UI「从此处运行」主链路（§2.7）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('详情区显示「从此处运行」按钮，点击后 kernel.playback 收到 fromStepId', async () => {
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a', '1'), leaf('b', '2')] };
    const { shell, mount, kernel } = bootUI(s);
    // 选中 b 打开详情区
    click(mount.querySelector('[data-step-item][data-step-id="b"]'));
    click(mount.querySelector('[data-action="run-from"][data-step-id="b"]'));
    await shell.runAll; // 让微任务跑完（playback 是 async）
    await Promise.resolve();
    expect(kernel.playback).toHaveBeenCalledWith(expect.anything(), 'b');
  });
});
