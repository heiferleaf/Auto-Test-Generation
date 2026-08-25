// @vitest-environment jsdom
// B1 嵌入式点选录制（spec §2.3）验收：waitUntil / assert / 选择组条件三处共用一套点选子模式。
// 主链路走真实 DOM 事件委托（[data-action="pick"]），禁止只直调内部 API 冒充用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Script, Step, Locator } from '../src/types/step';

type AnyKernel = any;

/** 可记录 pick 事件订阅者，便于测试模拟「用户在靶机点了一个元素」。 */
function makeMockKernel(): AnyKernel {
  const calls: string[] = [];
  const listeners: Record<string, Array<(d: unknown) => void>> = {};
  return {
    calls,
    connect: vi.fn(async () => { calls.push('connect'); }),
    disconnect: vi.fn(async () => { calls.push('disconnect'); }),
    listTargets: vi.fn((): any[] => [
      { id: 'main', type: 'page', title: '主窗口', url: 'app://main' },
    ]),
    selectTarget: vi.fn((id: string) => { calls.push(`selectTarget:${id}`); }),
    click: vi.fn(async (_l: Locator) => { calls.push('click'); }),
    fill: vi.fn(async (_l: Locator, _v: string) => { calls.push('fill'); }),
    select: vi.fn(async (_l: Locator, _o: string) => { calls.push('select'); }),
    hover: vi.fn(async (_l: Locator) => { calls.push('hover'); }),
    wait: vi.fn(async (_o: any) => { calls.push('wait'); }),
    eval: vi.fn(async (_c: string) => { calls.push('eval'); return undefined; }),
    snapshot: vi.fn(async (): Promise<any[]> => { calls.push('snapshot'); return []; }),
    query: vi.fn(async () => { calls.push('query'); return undefined; }),
    screenshot: vi.fn(async (): Promise<Buffer> => { calls.push('screenshot'); return Buffer.from('fake'); }),
    locateVisual: vi.fn(async (_l: Locator) => ({ x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true })),
    startRecording: vi.fn(() => { calls.push('startRecording'); }),
    stopRecording: vi.fn(async () => { calls.push('stopRecording'); return []; }),
    playback: vi.fn(async () => { calls.push('playback'); return { ok: true }; }),
    startPick: vi.fn(async () => { calls.push('startPick'); }),
    cancelPick: vi.fn(async () => { calls.push('cancelPick'); }),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      calls.push(`on:${event}`);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => {
      const arr = listeners[event];
      if (arr) {
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      }
      calls.push(`off:${event}`);
    }),
    __emitPick(loc: Locator) {
      for (const cb of listeners['pick'] ?? []) cb({ locator: loc });
    },
    __hasPickListener() {
      return (listeners['pick'] ?? []).length > 0;
    },
  } as AnyKernel;
}

function bootShell(kernel: AnyKernel, script?: Script): { shell: UiShell; mount: HTMLElement } {
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

const waitUntilStep: Step = {
  id: 'wu', type: 'waitUntil', source: 'manual',
  params: { assertion: { kind: 'visible', locator: { role: 'status' } }, timeoutMs: 5000 },
};

const assertStep: Step = {
  id: 'as', type: 'assert', source: 'manual',
  params: { assertion: { kind: 'visible', locator: { role: 'status' } } },
};

const ifGroupScript: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'T', version: '1.0.0' },
  steps: [
    {
      id: 'grp-if-1', type: 'assert', source: 'manual',
      control: { kind: 'if' },
      children: [
        { id: 't1', type: 'click', locator: { role: 'button', name: 'T' }, source: 'manual' },
      ],
    },
  ],
};

describe('B1 嵌入式点选录制（§2.3）', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeMockKernel(); });

  it('未连接时，waitUntil 详情区的「在软件中点选」按钮禁用', () => {
    const { mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [waitUntilStep],
    });
    click(mount.querySelector('[data-step-item][data-step-id="wu"]'));
    const pickBtn = mount.querySelector('[data-action="pick"]') as HTMLButtonElement | null;
    expect(pickBtn).toBeTruthy();
    expect(pickBtn!.disabled).toBe(true);
  });

  it('连接后点「在软件中点选」→ 进入点选态：提示出现 + startPick 调用 + 订阅 pick', async () => {
    const { shell, mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [waitUntilStep],
    });
    await shell.connect();
    click(mount.querySelector('[data-step-item][data-step-id="wu"]'));
    const pickBtn = mount.querySelector('[data-action="pick"]') as HTMLButtonElement;
    expect(pickBtn.disabled).toBe(false);
    click(pickBtn);
    expect(kernel.startPick).toHaveBeenCalled();
    expect(kernel.__hasPickListener()).toBe(true);
    expect(mount.querySelector('[data-pick-mode]')).toBeTruthy();
  });

  it('点选回写：模拟靶机点击 → waitUntil 的 assertion.locator 被完整 locator 覆盖 → 退出点选态', async () => {
    const { shell, mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [waitUntilStep],
    });
    await shell.connect();
    click(mount.querySelector('[data-step-item][data-step-id="wu"]'));
    click(mount.querySelector('[data-action="pick"]'));
    const picked: Locator = { role: 'button', name: '确定', testId: 'ok-btn', css: 'div.x > button' };
    kernel.__emitPick(picked);
    const step = shell.getScript().steps.find((s: Step) => s.id === 'wu') as Step;
    expect(step.params?.assertion?.locator).toEqual(picked);
    expect(mount.querySelector('[data-pick-mode]')).toBeNull();
    expect(kernel.__hasPickListener()).toBe(false);
    expect(kernel.cancelPick).toHaveBeenCalled();
  });

  it('点选点击不进普通录制步骤列表（步骤数不变）', async () => {
    const { shell, mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [waitUntilStep],
    });
    await shell.connect();
    const before = shell.getScript().steps.length;
    click(mount.querySelector('[data-step-item][data-step-id="wu"]'));
    click(mount.querySelector('[data-action="pick"]'));
    kernel.__emitPick({ role: 'button', name: 'X' });
    expect(shell.getScript().steps.length).toBe(before);
  });

  it('断言（assert 元素类）走同一套点选：回写到 assertion.locator', async () => {
    const { shell, mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [assertStep],
    });
    await shell.connect();
    click(mount.querySelector('[data-step-item][data-step-id="as"]'));
    click(mount.querySelector('[data-action="pick"]'));
    const picked: Locator = { role: 'textbox', name: '搜索框', testId: 'q' };
    kernel.__emitPick(picked);
    const step = shell.getScript().steps.find((s: Step) => s.id === 'as') as Step;
    expect(step.params?.assertion?.locator).toEqual(picked);
  });

  it('选择组条件走同一套点选：回写到 control.condition.locator', async () => {
    const { shell, mount } = bootShell(kernel, ifGroupScript);
    await shell.connect();
    click(mount.querySelector('[data-step-item][data-step-id="grp-if-1"]'));
    click(mount.querySelector('[data-action="pick"]'));
    const picked: Locator = { role: 'checkbox', name: '同意', testId: 'agree' };
    kernel.__emitPick(picked);
    const grp = shell.getScript().steps[0] as Step;
    expect(grp.control?.condition?.locator).toEqual(picked);
  });

  it('取消点选：点取消按钮 → 退出点选态 + cancelPick 调用 + 不回写', async () => {
    const { shell, mount } = bootShell(kernel, {
      schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [waitUntilStep],
    });
    await shell.connect();
    click(mount.querySelector('[data-step-item][data-step-id="wu"]'));
    click(mount.querySelector('[data-action="pick"]'));
    const before = (shell.getScript().steps[0] as Step).params?.assertion?.locator;
    click(mount.querySelector('[data-action="cancel-pick"]'));
    expect(mount.querySelector('[data-pick-mode]')).toBeNull();
    expect(kernel.cancelPick).toHaveBeenCalled();
    const after = (shell.getScript().steps[0] as Step).params?.assertion?.locator;
    expect(after).toEqual(before);
  });
});
