// @vitest-environment jsdom
// 高亮截图的**补拍时机**：导入时不拍，执行到某一步、执行该步之前拍一张。
//
// 为什么必须有这个文件（架构背景，不是功能清单）：
//   录制是"边操作边拍"，走到第 N 步时靶机正好在第 N 步的状态，元素存在 → 拍得到、框画得上。
//   而 Agent 脚本此前是「导入那一刻把全部叶子步骤一口气拍完」，此时靶机还在初始状态，
//   第 N 步的元素根本不存在 → 拍不到、框画不出，且全程静默不报错。
//   所以两者高亮表现必然不同。新语义：执行时逐步拍，与录制对齐；没跑过的步骤诚实显示
//   「未运行，暂无截图」，而不是给一张初始状态的误导性图。
//
// 截图不能由 UI 收到 running 事件后异步补拍（会与该步的执行动作赛跑，可能拍到执行后的画面），
// 故链路是：shell 传逐步截图计划 shotPlan → 桥端在该步执行前 await 截图 →
// 截图随 step-progress 事件的 shot 字段回传。本文件守的是这条契约的两端。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell, type StepShotPlan } from '../src/ui/shell';
import type { Locator, Script, StepRunStatus } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';

type AnyKernel = any;

/** 每步一张不同的图，用于区分"逐步拍"与"全是同一张初始状态图"。 */
const shotOf = (stepId: string): string => Buffer.from(`PNG-FOR-${stepId}`).toString('base64');

type KernelOpts = {
  /** 是否给 running 事件附带 shot（模拟桥端执行前截图并回传）。 */
  withShots?: boolean;
};

function makeShotKernel(opts: KernelOpts = {}): AnyKernel {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  const emit = (event: string, data: unknown) => {
    listeners[event]?.forEach((cb) => cb(data));
  };
  const kernel: AnyKernel = {
    listeners,
    emit,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title: '主窗口' }]),
    selectTarget: vi.fn(),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    locateVisual: vi.fn(async () => ({
      x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true,
    })),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => []),
    /**
     * 模拟 bridge-server 的行为：收到 shotPlan 时，在 emit running **之前**先把该步的图准备好，
     * 并把图塞进事件载荷（真机上截图发生在 Node 侧、执行动作之前）。
     */
    playback: vi.fn(async (script: Script, fromStepId?: string, shotPlan?: StepShotPlan) => {
      const started = fromStepId === undefined;
      for (const step of script.steps) {
        if (!started && step.id !== fromStepId) continue;
        const shot = shotPlan?.[step.id] ? shotOf(step.id) : undefined;
        const payload: { stepId: string; status: StepRunStatus; shot?: string } = {
          stepId: step.id, status: 'running',
        };
        if (opts.withShots !== false && shot) payload.shot = shot;
        emit('step-progress', payload);
        emit('step-progress', { stepId: step.id, status: 'pass' });
      }
      return { ok: true };
    }),
    startPick: vi.fn(async () => {}),
    cancelPick: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => { listeners[event]?.delete(cb); }),
  };
  return kernel;
}

const THREE_STEPS: Script = {
  schema: SCRIPT_SCHEMA,
  app: { name: 'T' },
  steps: [
    { id: 's1', type: 'click', source: 'agent', locator: { name: 'A' } },
    { id: 's2', type: 'click', source: 'agent', locator: { name: 'B' } },
    { id: 's3', type: 'click', source: 'agent', locator: { name: 'C' } },
  ],
};

function boot(kernel: AnyKernel, script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel, mount, script });
  shell.render();
  return { shell, mount };
}

function click(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const node = (mount: HTMLElement, id: string) => mount.querySelector(`[data-cfg-node="${id}"]`);

describe('导入不再批量补拍（截图时机 §1）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('已连接导入无配图的脚本：一张图都不拍，screenshot 不被调用', async () => {
    const kernel = makeShotKernel();
    const { shell } = boot(kernel);
    await shell.connect();
    shell.importScript(JSON.stringify(THREE_STEPS));
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('先导入再连接也不补拍（旧行为是连接后立刻批量拍）', async () => {
    const kernel = makeShotKernel();
    const { shell } = boot(kernel);
    shell.importScript(JSON.stringify(THREE_STEPS));
    await shell.connect();
    await Promise.resolve();
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('导入后每个步骤卡片都显示「未运行，暂无截图」，不是给一张初始状态图', async () => {
    const kernel = makeShotKernel();
    const { shell, mount } = boot(kernel);
    await shell.connect();
    shell.importScript(JSON.stringify(THREE_STEPS));
    for (const id of ['s1', 's2', 's3']) {
      expect(node(mount, id)?.getAttribute('data-cfg-shot')).toBe('none');
      expect(node(mount, id)?.querySelector('[data-cfg-shot-hint]')?.textContent)
        .toBe('未运行，暂无截图');
    }
  });
});

describe('执行时逐步拍（截图时机 §2）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('已连接 runAll 把逐步截图计划作为第 3 参传给 playback，每步对应自己的 locator', async () => {
    const kernel = makeShotKernel();
    const { shell } = boot(kernel, THREE_STEPS);
    await shell.connect();
    await shell.runAll();
    const plan = kernel.playback.mock.calls[0][2] as StepShotPlan;
    expect(plan).toBeTruthy();
    expect((plan['s1']?.highlight as Locator)?.name).toBe('A');
    expect((plan['s2']?.highlight as Locator)?.name).toBe('B');
    expect((plan['s3']?.highlight as Locator)?.name).toBe('C');
  });

  it('无 locator 的步骤（纯 wait）也进计划，但没有 highlight', async () => {
    const kernel = makeShotKernel();
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'T' },
      steps: [{ id: 'w', type: 'wait', source: 'agent', params: { durationMs: 10 } }],
    };
    const { shell } = boot(kernel, script);
    await shell.connect();
    await shell.runAll();
    const plan = kernel.playback.mock.calls[0][2] as StepShotPlan;
    expect(plan['w']).toBeTruthy();
    expect(plan['w']?.highlight).toBeUndefined();
  });

  it('断言步没有自身 locator 时，计划用 assertion.locator 高亮', async () => {
    const kernel = makeShotKernel();
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'T' },
      steps: [{
        id: 'a', type: 'waitUntil', source: 'agent',
        params: { timeoutMs: 1000, assertion: { kind: 'visible', locator: { name: '结果区' } } },
      }],
    };
    const { shell } = boot(kernel, script);
    await shell.connect();
    await shell.runAll();
    const plan = kernel.playback.mock.calls[0][2] as StepShotPlan;
    expect((plan['a']?.highlight as Locator)?.name).toBe('结果区');
  });

  it('组节点不进计划（只有叶子步骤是"要操作的元素"）', async () => {
    const kernel = makeShotKernel();
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'T' },
      steps: [{
        id: 'g', type: 'click', source: 'agent', control: { kind: 'sequence' },
        children: [{ id: 'c1', type: 'click', source: 'agent', locator: { name: '子步' } }],
      }],
    };
    const { shell } = boot(kernel, script);
    await shell.connect();
    await shell.runAll();
    const plan = kernel.playback.mock.calls[0][2] as StepShotPlan;
    expect(plan['g']).toBeUndefined();
    expect((plan['c1']?.highlight as Locator)?.name).toBe('子步');
  });

  it('跑 3 步得到 3 张各不相同的图：第 N 步的图是第 N 步那张，不是初始状态那张', async () => {
    const kernel = makeShotKernel();
    const { shell, mount } = boot(kernel, THREE_STEPS);
    await shell.connect();
    await shell.runAll();
    const shots = shell.getStepShots();
    expect(Object.keys(shots).sort()).toEqual(['s1', 's2', 's3']);
    expect(shots['s1']).toBe(shotOf('s1'));
    expect(shots['s2']).toBe(shotOf('s2'));
    expect(shots['s3']).toBe(shotOf('s3'));
    // 三张互不相同 —— 若是"导入时的一张初始状态图复用"，这里必然相等
    expect(new Set(Object.values(shots)).size).toBe(3);
    // 卡片不再显示"未运行"
    for (const id of ['s1', 's2', 's3']) {
      expect(node(mount, id)?.getAttribute('data-cfg-shot')).toBe('has');
      expect(node(mount, id)?.querySelector('[data-cfg-shot-hint]')?.textContent).toBe('');
    }
  });

  it('点开已跑过的步骤，舞台显示的是该步自己的图', async () => {
    const kernel = makeShotKernel();
    const { shell, mount } = boot(kernel, THREE_STEPS);
    await shell.connect();
    await shell.runAll();
    click(node(mount, 's2'));
    const img = mount.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    expect(img?.src).toContain(shotOf('s2'));
  });

  it('只跑了前两步时，第 3 步仍然诚实显示「未运行，暂无截图」', async () => {
    const kernel = makeShotKernel();
    const { shell, mount } = boot(kernel, THREE_STEPS);
    await shell.connect();
    // 内核在 s2 之后就结束（模拟从此处运行/中断）：这里直接 emit 前两步的进度。
    kernel.playback = vi.fn(async () => {
      for (const id of ['s1', 's2']) {
        kernel.emit('step-progress', { stepId: id, status: 'running', shot: shotOf(id) });
        kernel.emit('step-progress', { stepId: id, status: 'pass' });
      }
      return { ok: true };
    });
    await shell.runAll();
    expect(Object.keys(shell.getStepShots()).sort()).toEqual(['s1', 's2']);
    expect(node(mount, 's3')?.getAttribute('data-cfg-shot')).toBe('none');
    expect(node(mount, 's3')?.querySelector('[data-cfg-shot-hint]')?.textContent)
      .toBe('未运行，暂无截图');
  });

  it('内核没回传 shot（旧内核不支持逐步截图）时不报错、也不伪造图', async () => {
    const kernel = makeShotKernel({ withShots: false });
    const { shell } = boot(kernel, THREE_STEPS);
    await shell.connect();
    const res = await shell.runAll();
    expect(res.ok).toBe(true);
    expect(Object.keys(shell.getStepShots())).toEqual([]);
  });

  it('未连接时执行不拍：playback 只有 2 个参数，不传截图计划', async () => {
    const kernel = makeShotKernel();
    const { shell } = boot(kernel, THREE_STEPS);
    await shell.runAll();
    expect(kernel.playback.mock.calls[0].length).toBe(2);
    expect(kernel.playback.mock.calls[0][2]).toBeUndefined();
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('未连接点「运行全部」：给出未连接提示，且不调 playback', async () => {
    const kernel = makeShotKernel();
    const { mount } = boot(kernel, THREE_STEPS);
    click(mount.querySelector('[data-action="run-all"]'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/未连接靶机/);
    });
    expect(kernel.playback).not.toHaveBeenCalled();
  });
});
