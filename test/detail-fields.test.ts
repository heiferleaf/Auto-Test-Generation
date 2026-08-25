// @vitest-environment jsdom
// B6 详情区字段补全 + 失败高亮（spec §2.3/§2.7）验收。
// 详情区对 waitUntil/assert 补 timeoutMs / 断言类型选择 / 期望值；
// 选择组(if)补条件类型选择；运行失败时把失败步滚入视口并标红。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Script, Step } from '../src/types/step';

type AnyKernel = any;

function makeMockKernel(playbackResult: any = { ok: true }) {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title: '主窗口', url: 'app://main' }]),
    selectTarget: vi.fn(() => {}),
    click: vi.fn(async () => {}), fill: vi.fn(async () => {}), select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}), wait: vi.fn(async () => {}), eval: vi.fn(async () => {}),
    snapshot: vi.fn(async () => []), query: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('f')),
    locateVisual: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true })),
    startRecording: vi.fn(() => {}), stopRecording: vi.fn(async () => []),
    playback: vi.fn(async () => playbackResult),
    on: vi.fn(), off: vi.fn(),
    startPick: vi.fn(async () => {}), cancelPick: vi.fn(async () => {}),
  } as AnyKernel;
}

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

function setSelect(sel: HTMLSelectElement | null, value: string) {
  if (!sel) throw new Error('select not found');
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('B6 详情区字段补全 + 失败高亮（§2.3/§2.7）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('waitUntil 详情区：显示超时(timeoutMs) + 断言类型选择', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [{ id: 'w', type: 'waitUntil', source: 'manual', params: { assertion: { kind: 'visible', locator: { role: 'button' } }, timeoutMs: 5000 } }],
    };
    const { mount } = boot(makeMockKernel(), s);
    click(mount.querySelector('[data-step-item][data-step-id="w"]'));
    expect(mount.querySelector('[data-edit-field="params.timeoutMs"]')).toBeTruthy();
    expect(mount.querySelector('[data-edit-field="assertion.kind"]')).toBeTruthy();
  });

  it('断言类型改为 textContains → 保存后 assertion.kind 更新，且出现期望值字段', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [{ id: 'w', type: 'waitUntil', source: 'manual', params: { assertion: { kind: 'visible', locator: { role: 'button' } }, timeoutMs: 5000 } }],
    };
    const { shell, mount } = boot(makeMockKernel(), s);
    click(mount.querySelector('[data-step-item][data-step-id="w"]'));
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'textContains');
    // textContains 需要期望值字段
    const valInput = mount.querySelector('[data-edit-field="assertion.value"]') as HTMLInputElement;
    expect(valInput).toBeTruthy();
    valInput.value = '成功';
    click(mount.querySelector('[data-action="save-edit"]'));
    const step = shell.getScript().steps[0] as Step;
    expect(step.params?.assertion?.kind).toBe('textContains');
    expect(step.params?.assertion?.value).toBe('成功');
    // timeoutMs 保留
    expect(step.params?.timeoutMs).toBe(5000);
  });

  it('assert 详情区：显示断言类型选择', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [{ id: 'a', type: 'assert', source: 'manual', params: { assertion: { kind: 'visible', locator: { role: 'status' } } } }],
    };
    const { mount } = boot(makeMockKernel(), s);
    click(mount.querySelector('[data-step-item][data-step-id="a"]'));
    expect(mount.querySelector('[data-edit-field="assertion.kind"]')).toBeTruthy();
  });

  it('选择组(if)详情区：显示条件类型选择', () => {
    const grp: Step = { id: 'g', type: 'assert', source: 'manual', control: { kind: 'if', condition: { kind: 'visible', locator: { role: 'button' } } }, children: [] };
    const s: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [grp] };
    const { mount } = boot(makeMockKernel(), s);
    click(mount.querySelector('[data-step-item][data-step-id="g"]'));
    expect(mount.querySelector('[data-edit-field="condition.kind"]')).toBeTruthy();
  });

  it('失败高亮：运行失败时失败步 CFG 节点标红并滚入视口', async () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [
        { id: 'a', type: 'click', locator: { role: 'button', name: 'A' }, source: 'manual' },
        { id: 'b', type: 'click', locator: { role: 'button', name: 'B' }, source: 'manual' },
      ],
    };
    const kernel = makeMockKernel({ ok: false, failedStepId: 'b' });
    const { shell, mount } = boot(kernel, s);
    // jsdom 的 Element.prototype 可能没有 scrollIntoView，直接挂一个 mock 上去。
    const spy = vi.fn();
    (Element.prototype as any).scrollIntoView = spy;
    try {
      await shell.runAll();
      const cfgNode = mount.querySelector('[data-cfg-node="b"]') as HTMLElement;
      expect(cfgNode).toBeTruthy();
      expect(cfgNode.getAttribute('data-cfg-status')).toBe('fail');
      expect(cfgNode.classList.contains('is-fail')).toBe(true);
      // 失败步被滚入视口
      expect(spy).toHaveBeenCalled();
    } finally {
      delete (Element.prototype as any).scrollIntoView;
    }
  });
});
