// @vitest-environment jsdom
// 对照原型 docs/design/m3-visual-panel-prototype.html 与 spec §2 的工作台时序。
// 这些用例描述用户看得见的交互，不是内部 API 直调。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { ScriptEditor } from '../src/editor/editor';
import { mergeRecordingEvent, sameFillLocator } from '../src/recorder/recorder';
import type { Script, Step } from '../src/types/step';

type AnyKernel = any;

function makeKernel(): AnyKernel {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  return {
    listeners,
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
    screenshot: vi.fn(async () => Buffer.from('PNG-BYTES-FOR-STEP-SHOT')),
    locateVisual: vi.fn(async () => ({ x: 10, y: 20, width: 80, height: 24, visible: true, inViewport: true })),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => []),
    playback: vi.fn(async () => ({ ok: true })),
    startPick: vi.fn(async () => {}),
    cancelPick: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => {
      listeners[event]?.delete(cb);
    }),
    emit(event: string, data: unknown) {
      listeners[event]?.forEach((cb) => cb(data));
    },
  };
}

const seed: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'T', version: '1.0.0' },
  steps: [
    { id: 'a', type: 'click', locator: { role: 'button', name: '搜索框' }, source: 'manual', control: { kind: 'sequence', name: '组 1' } },
    { id: 'b', type: 'fill', locator: { name: '搜索框' }, params: { value: '你好' }, source: 'manual', control: { kind: 'sequence', name: '组 2' } },
  ],
};

function boot(kernel: AnyKernel, script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel, mount, script: script ?? seed });
  shell.render();
  return { shell, mount };
}

function click(el: Element | null, opts: { ctrl?: boolean } = {}) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: !!opts.ctrl, metaKey: !!opts.ctrl }));
}

describe('工作台对照原型（CFG 唯一主视图）', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeKernel(); });

  it('布局：CFG + 舞台 + 详情，没有可编辑步骤列表', () => {
    const { mount } = boot(kernel);
    expect(mount.querySelector('[data-cfg]')).toBeTruthy();
    expect(mount.querySelector('[data-stage]')).toBeTruthy();
    expect(mount.querySelector('[data-detail]')).toBeTruthy();
    expect(mount.querySelector('[data-steps]')).toBeNull();
    expect(mount.querySelector('[data-cfg-flow]')).toBeTruthy();
  });

  it('CFG 显示组名，不把打包组渲染成「等待」', () => {
    const { mount } = boot(kernel);
    const text = mount.querySelector('[data-cfg]')?.textContent ?? '';
    expect(text).toContain('搜索框');
    expect(text).toContain('你好');
    expect(text).not.toMatch(/等待\s*$/);
  });

  it('插入 wait：该步自身即原子顺序组，详情可改组名', async () => {
    const { shell, mount } = boot(kernel);
    await shell.connect();
    click(mount.querySelector('[data-action="insert"]'));
    click(mount.querySelector('[data-insert-type="wait"]'));
    const wait = shell.getScript().steps.find((s) => s.type === 'wait');
    expect(wait?.control?.kind).toBe('sequence');
    expect(wait?.control?.name).toBeTruthy();
    click(mount.querySelector(`[data-cfg-node="${wait!.id}"]`));
    click(mount.querySelector('[data-action="edit"]'));
    expect(mount.querySelector('[data-edit-field="control.name"]')).toBeTruthy();
  });

  it('同一输入框连续 fill 跨 drain 坍缩为一条，值为最终文本', async () => {
    const loc = { name: '搜索框', css: 'input' };
    const { shell, mount } = boot(kernel, { ...seed, steps: [] });
    await shell.startRecording();
    kernel.emit('recording', { type: 'fill', locator: loc, params: { value: 'n' } });
    kernel.emit('recording', { type: 'fill', locator: loc, params: { value: 'ni' } });
    kernel.emit('recording', { type: 'fill', locator: loc, params: { value: '你好' } });
    const fills = shell.getScript().steps.filter((s) => s.type === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].params?.value).toBe('你好');
    expect(mount.querySelector('[data-cfg]')?.textContent).toContain('你好');
    expect(mount.querySelector('[data-cfg]')?.textContent).not.toContain('= n');
  });

  it('点选态下的点击不写入录制步骤', async () => {
    const { shell, mount } = boot(kernel, { ...seed, steps: [] });
    await shell.connect();
    click(mount.querySelector('[data-action="insert"]'));
    click(mount.querySelector('[data-insert-type="assert"]'));
    const assertId = shell.getScript().steps[0].id;
    click(mount.querySelector(`[data-cfg-node="${assertId}"]`));
    click(mount.querySelector('[data-action="edit"]'));
    await shell.startRecording();
    click(mount.querySelector('[data-action="pick"]'));
    expect(mount.querySelector('[data-pick-mode]')).toBeTruthy();
    const before = shell.getScript().steps.length;
    kernel.emit('recording', { type: 'click', locator: { name: '提交' } });
    expect(shell.getScript().steps.length).toBe(before);
  });

  it('点选完成后详情显示封装名，并有点选横幅反馈', async () => {
    const { shell, mount } = boot(kernel, { ...seed, steps: [] });
    await shell.connect();
    click(mount.querySelector('[data-action="insert"]'));
    click(mount.querySelector('[data-insert-type="assert"]'));
    click(mount.querySelector(`[data-cfg-node="${shell.getScript().steps[0].id}"]`));
    click(mount.querySelector('[data-action="edit"]'));
    click(mount.querySelector('[data-action="pick"]'));
    expect(mount.querySelector('[data-pick-mode]')?.textContent).toMatch(/真实软件|靶机/);
    kernel.emit('pick', { locator: { name: '提交按钮', css: 'button.submit' } });
    expect(shell.getScript().steps[0].params?.assertion?.locator?.name).toBe('提交按钮');
    expect(mount.querySelector('[data-detail]')?.textContent).toContain('提交按钮');
  });

  it('仅打包：多选两个原子组 → 顺序组显示组名；拆包恢复', async () => {
    vi.stubGlobal('prompt', () => '登录流程');
    const { shell, mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-cfg-node="b"]'), { ctrl: true });
    click(mount.querySelector('[data-action="wrap-sequence"]'));
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    expect(shell.getScript().steps).toHaveLength(1);
    expect(shell.getScript().steps[0].control?.kind).toBe('sequence');
    expect(shell.getScript().steps[0].control?.name).toBe('顺序组');
    click(mount.querySelector('[data-action="edit"]'));
    const nameField = mount.querySelector('[data-edit-field="control.name"]') as HTMLInputElement;
    nameField.value = '登录流程';
    click(mount.querySelector('[data-action="save-edit"]'));
    expect(shell.getScript().steps[0].control?.name).toBe('登录流程');
    expect(mount.querySelector('.ui-shell-cfg-tree')?.textContent).toContain('登录流程');
    expect(mount.querySelector('.ui-shell-cfg-tree')?.textContent).not.toContain('等待');
    click(mount.querySelector('[data-action="unpack"]'));
    expect(shell.getScript().steps.map((s) => s.id).sort()).toEqual(['a', 'b']);
    vi.unstubAllGlobals();
  });

  it('设为选择组：对已有原子组设 kind，不是再包一层等待', () => {
    const { shell, mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="wrap-if"]'));
    const grp = shell.getScript().steps.find((s) => s.id === 'a') ?? shell.getScript().steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.type).not.toBe('wait');
    expect(mount.querySelector('[data-cfg-branch="true"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-branch="false"]')).toBeNull();
  });

  it('选中有截图的步骤：舞台显示该步图，不再叠 CSS 高亮框', async () => {
    const { shell, mount } = boot(kernel);
    await shell.connect();
    await shell.startRecording();
    kernel.emit('recording', { type: 'click', locator: { name: '搜索框' } });
    await vi.waitFor(() => {
      expect(Object.keys(shell.getStepShots()).length).toBeGreaterThan(0);
    });
    const id = Object.keys(shell.getStepShots())[0];
    shell.selectStep(id);
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeTruthy();
    expect(mount.querySelector('[data-highlight]')).toBeNull();
    expect(kernel.screenshot.mock.calls.some((c: unknown[]) => (c[0] as { highlight?: { name?: string } } | undefined)?.highlight?.name === '搜索框')).toBe(true);
  });

  it('未连接时运行全部按钮可点，点击后出现未连接提醒', async () => {
    const { mount } = boot(kernel);
    const run = mount.querySelector('[data-action="run-all"]') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    click(run);
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/未连接靶机/);
    });
  });

  it('清空前弹出确认；取消则步骤仍在', () => {
    vi.stubGlobal('confirm', () => false);
    const { shell, mount } = boot(kernel);
    click(mount.querySelector('[data-action="clear"]'));
    expect(shell.getScript().steps).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('CFG 节点可拖拽（组内调序走拖放，不是上下箭头）', () => {
    const { mount } = boot(kernel);
    const node = mount.querySelector('[data-cfg-node="a"]') as HTMLElement;
    expect(node.getAttribute('data-cfg-draggable')).toBe('true');
    expect(mount.querySelector('[data-action="up"]')).toBeNull();
    expect(mount.querySelector('[data-action="down"]')).toBeNull();
  });
});

describe('原子组转选择组（数据层）', () => {
  it('一步一组的叶子设为 if：动作进入 True，默认没有 Else', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{
        id: 'a', type: 'click', source: 'manual',
        locator: { name: '搜索' },
        control: { kind: 'sequence', name: '组 1' },
      }],
    };
    const out = ScriptEditor.setGroupKind(s, 'a', 'if');
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.control?.name).toBe('组 1');
    expect(grp.children).toHaveLength(1);
    expect(grp.children?.[0].children?.some((c) => c.type === 'click')).toBe(true);
  });
});

describe('fill 跨窗口合并', () => {
  it('sameFillLocator + mergeRecordingEvent 覆盖 drain 边界', () => {
    const loc = { name: 'q', css: 'input' };
    expect(sameFillLocator(loc, { ...loc })).toBe(true);
    const merged = mergeRecordingEvent(
      [{ type: 'fill', locator: loc, params: { value: 'n' } }],
      { type: 'fill', locator: loc, params: { value: '你好' } },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].params?.value).toBe('你好');
  });
});
