// @vitest-environment jsdom
// 末轮 UI：底缝不随选中变化、CFG 无静止点阵、详情 X、打包立刻建组、
// 顶栏安静产品名 + 动作条（不再钉窗口底）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Script, Step } from '../src/types/step';

type AnyKernel = any;

function makeKernel(title = '1.txt - cursor - Visual Studio Code'): AnyKernel {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title }]),
    selectTarget: vi.fn(),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('fake-png')),
    locateVisual: vi.fn(async () => ({
      x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true,
    })),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => []),
    playback: vi.fn(async () => ({ ok: true })),
    startPick: vi.fn(async () => {}),
    cancelPick: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => { listeners[event]?.delete(cb); }),
  };
}

const leaf = (id: string): Step => ({
  id, type: 'click', source: 'manual', locator: { name: id },
});

const seed: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'T' },
  steps: [leaf('a'), leaf('b'), leaf('c')],
};

function boot(kernel: AnyKernel, script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel, mount, script: script ?? seed });
  shell.render();
  return { shell, mount };
}

function click(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function insetOf(mount: HTMLElement) {
  return {
    padding: mount.style.padding,
    gap: mount.style.gap,
    token: mount.getAttribute('data-workbench-inset'),
  };
}

describe('工作台外沿留白不随选中/layout 变', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeKernel(); });

  it('shot 与 flow 的 padding/gap 相同，且不依赖详情是否打开', () => {
    const { mount } = boot(kernel);
    expect(mount.getAttribute('data-layout')).toBe('shot');
    const idle = insetOf(mount);
    expect(idle.padding).toBe('12px 14px 14px');
    expect(idle.gap).toBe('10px');
    expect(idle.token).toBe('12-14-14');

    click(mount.querySelector('[data-cfg-node="a"]'));
    expect(mount.getAttribute('data-layout')).toBe('flow');
    expect(insetOf(mount)).toEqual(idle);

    click(mount.querySelector('[data-action="edit"]'));
    expect(mount.querySelector('[data-detail]')?.getAttribute('data-detail-open')).toBe('true');
    expect(insetOf(mount)).toEqual(idle);

    click(mount.querySelector('[data-inspector-close]'));
    expect(insetOf(mount)).toEqual(idle);
  });
});

describe('CFG 画布没有静止点阵', () => {
  it('流图栏里没有 data-cfg-dots / data-cfg-dot，页面壳雾块仍在', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    expect(mount.querySelector('[data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('[data-cfg-field]')).toBeNull();
    expect(mount.querySelectorAll('[data-cfg-dot]').length).toBe(0);
    expect(mount.querySelector('[data-cfg] .ui-shell-cfg-canvas')).toBeTruthy();
    expect(mount.querySelector('[data-app-field] [data-fluid-blob]')).toBeTruthy();
  });
});

describe('动作条在顶栏，不在窗口底', () => {
  it('开始录制等按钮挂在 header 第二行，双栏是最后一个主区块', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const header = mount.querySelector('.ui-shell-header')!;
    const actions = header.querySelector('[data-actions]');
    expect(actions).toBeTruthy();
    for (const action of ['toggle-record', 'insert', 'run-all', 'import', 'export', 'clear']) {
      expect(header.querySelector(`[data-action="${action}"]`)).toBeTruthy();
    }
    expect(mount.querySelector('.ui-shell-body + [data-actions]')).toBeNull();
    expect(mount.lastElementChild?.classList.contains('ui-shell-body')).toBe(true);
  });
});

describe('打包立刻建组，不要预命名', () => {
  it('框选后点打包：没有内联组名，直接出现默认名顺序组', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    const promptSpy = vi.spyOn(window, 'prompt');
    click(mount.querySelector('[data-cfg-node="a"]'));
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    click(mount.querySelector('[data-pack-choice="sequence"]'));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    expect(shell.getScript().steps[0].control?.kind).toBe('sequence');
    expect(shell.getScript().steps[0].control?.name).toMatch(/顺序组|组\s*\d+/);
    expect(mount.querySelector('[data-detail]')?.getAttribute('data-detail-open')).not.toBe('true');
    promptSpy.mockRestore();
  });
});

describe('详情关闭 X，内部可滚', () => {
  it('打开编辑：有 [data-inspector-close]，没有取消，滚动在弹层内', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const close = mount.querySelector('[data-inspector-close]') as HTMLElement | null;
    expect(close).toBeTruthy();
    expect(close?.textContent).not.toMatch(/取消/);
    expect(mount.querySelector('[data-action="cancel-edit"]')).toBeNull();
    const actions = mount.querySelector('[data-edit-area] .ui-shell-edit-actions')?.textContent ?? '';
    expect(actions).toMatch(/确定|已保存/);
    expect(actions).toMatch(/删除/);
    expect(actions).not.toMatch(/取消/);
    const scroll = mount.querySelector('[data-inspector-scroll]') as HTMLElement;
    expect(scroll).toBeTruthy();
    expect(scroll.style.overflow).toBe('auto');
    const row = mount.querySelector('[data-edit-area] .ui-shell-edit-actions') as HTMLElement;
    const save = row.querySelector('[data-action="save-edit"]') as HTMLElement;
    const del = row.querySelector('[data-action="remove"]') as HTMLElement;
    expect(save).toBeTruthy();
    expect(save.classList.contains('primary')).toBe(true);
    expect(del).toBeTruthy();
    expect(del.textContent).toBe('删除');
    expect(save.parentElement).toBe(row);
    expect(del.parentElement).toBe(row);
    expect(row.querySelectorAll('button').length).toBe(2);
  });
});

describe('顶栏安静产品名 + 网页标题', () => {
  it('可见文案是测试步骤中台 + 已连接，完整窗口 title 只在 tooltip', async () => {
    const kernel = makeKernel('1.txt - cursor - Visual Studio Code');
    const { mount, shell } = boot(kernel);
    expect(document.title).toBe('测试步骤中台');
    expect(mount.querySelector('[data-product-title]')?.textContent).toBe('测试步骤中台');
    expect(mount.querySelector('[data-wordmark]')).toBeTruthy();
    await shell.connect();
    const header = mount.querySelector('.ui-shell-header')!;
    expect(header.textContent).toContain('测试步骤中台');
    expect(header.textContent).toContain('已连接');
    expect(header.textContent).not.toMatch(/1\.txt/);
    expect(header.textContent).not.toContain('cursor - Visual Studio Code');
    const status = mount.querySelector('[data-conn-status]') as HTMLElement;
    expect(status.textContent).toBe('已连接');
    expect(status.title).toBe('1.txt - cursor - Visual Studio Code');
  });
});
