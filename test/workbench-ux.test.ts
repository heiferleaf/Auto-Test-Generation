// @vitest-environment jsdom
// 用户指定补丁 + spec 未落地项：原子组不拆包、可选 Else、拖拽调序、橡皮筋、有向边/minimap。
// UI 主链路走 boot + dispatchEvent，禁止只直调内部 API 冒充用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell, boxesIntersect, floatingChromePosition } from '../src/ui/shell';
import { ScriptEditor, isAtomicGroup } from '../src/editor/editor';
import { CfgView } from '../src/ui/cfg-view';
import type { Script, Step } from '../src/types/step';

type AnyKernel = any;

function makeKernel(): AnyKernel {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  return {
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
    screenshot: vi.fn(async () => Buffer.from('fake-png-data-for-shot')),
    emit(event: string, data: unknown) {
      listeners[event]?.forEach((cb) => cb(data));
    },
    locateVisual: vi.fn(async () => ({
      x: 100, y: 50, width: 40, height: 20, visible: true, inViewport: true,
      viewportWidth: 800, viewportHeight: 400, devicePixelRatio: 2,
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
  id, type: 'click', source: 'manual',
  locator: { name: id },
  control: { kind: 'sequence', name: `组 ${id}` },
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

function click(el: Element | null, opts: { ctrl?: boolean } = {}) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: !!opts.ctrl, metaKey: !!opts.ctrl }));
}

function dragNode(from: Element, to: Element) {
  from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 8, clientY: 8, buttons: 1 }));
  from.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20, buttons: 1 }));
  to.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 24, clientY: 90, buttons: 1 }));
  to.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 24, clientY: 90 }));
}

describe('原子组不显示拆包', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeKernel(); });

  it('isAtomicGroup：无 children 的 sequence 是原子项', () => {
    expect(isAtomicGroup(leaf('a'))).toBe(true);
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] },
      ['a', 'b'], 'sequence',
    );
    expect(isAtomicGroup(packed.steps[0])).toBe(false);
  });

  it('选中原子项：工具栏和详情都没有拆包', () => {
    const { mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    expect(mount.querySelector('[data-action="unpack"]')).toBeNull();
  });

  it('选中已打包顺序组：详情出现拆包', () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const { mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-cfg-node="b"]'), { ctrl: true });
    click(mount.querySelector('[data-action="wrap-sequence"]'));
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(mount.querySelector('[data-action="unpack"]')).toBeTruthy();
    expect(mount.querySelector('[data-edit-area] [data-action="unpack"]')).toBeNull();
    promptSpy.mockRestore();
  });
});

describe('选择组 Else 可选', () => {
  it('setGroupKind if：默认只有 True，没有空 False', () => {
    const s: Script = { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a')] };
    const out = ScriptEditor.setGroupKind(s, 'a', 'if');
    expect(out.steps[0].children).toHaveLength(1);
    expect(out.steps[0].children?.[0].children?.some((c) => c.type === 'click')).toBe(true);
  });

  it('wrap if：两步进 True，不自动造 Else', () => {
    const s: Script = { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] };
    const out = ScriptEditor.wrap(s, ['a', 'b'], 'if');
    expect(out.steps[0].children).toHaveLength(1);
    expect(out.steps[0].children?.[0].children?.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('addElseBranch / removeElseBranch 成对可逆', () => {
    const s = ScriptEditor.setGroupKind(
      { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a')] },
      'a', 'if',
    );
    const withElse = ScriptEditor.addElseBranch(s, 'a');
    expect(withElse.steps[0].children).toHaveLength(2);
    expect(withElse.steps[0].children?.[1].children).toEqual([]);
    const gone = ScriptEditor.removeElseBranch(withElse, 'a');
    expect(gone.steps[0].children).toHaveLength(1);
  });

  it('UI：设为选择组后无 False 列；点增加 Else 才出现', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-cfg-node="b"]'), { ctrl: true });
    click(mount.querySelector('[data-action="wrap-if"]'));
    expect(mount.querySelector('[data-cfg-branch="true"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-branch="false"]')).toBeNull();
    click(mount.querySelector('[data-action="add-else"]'));
    expect(mount.querySelector('[data-cfg-branch="false"]')).toBeTruthy();
    click(mount.querySelector('[data-action="remove-else"]'));
    expect(mount.querySelector('[data-cfg-branch="false"]')).toBeNull();
  });
});

describe('CFG 拖拽调序（含组内）', () => {
  it('拖拽过程有拖起态、落点高亮和跟随幽灵', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const a = mount.querySelector('[data-cfg-node="a"]')!;
    const c = mount.querySelector('[data-cfg-node="c"]')!;
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 8, clientY: 8, buttons: 1 }));
    a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20, buttons: 1 }));
    expect(a.classList.contains('is-drag')).toBe(true);
    expect(document.querySelector('[data-drag-ghost]')).toBeTruthy();
    c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 24, clientY: 90, buttons: 1 }));
    expect(c.classList.contains('is-drop-target')).toBe(true);
    expect(document.querySelector('[data-drop-line]')).toBeTruthy();
    c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 24, clientY: 90 }));
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    expect(document.querySelector('[data-drop-line]')).toBeNull();
  });

  it('顶层：把 a 拖到 c 上，顺序变成 b,a,c 或 a 插到 c 前', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    const a = mount.querySelector('[data-cfg-node="a"]')!;
    const c = mount.querySelector('[data-cfg-node="c"]')!;
    dragNode(a, c);
    const ids = shell.getScript().steps.map((s) => s.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids.indexOf('a')).not.toBe(0);
  });

  it('组内：打包后拖子节点调序', () => {
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a'), leaf('b'), leaf('c')] },
      ['a', 'b'], 'sequence',
    );
    packed.steps[0].id = 'g';
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel, packed);
    const a = mount.querySelector('[data-cfg-node="a"]')!;
    const b = mount.querySelector('[data-cfg-node="b"]')!;
    dragNode(b, a);
    const kids = shell.getScript().steps.find((s) => s.id === 'g')?.children?.map((s) => s.id) ?? [];
    expect(kids).toEqual(['b', 'a']);
  });

  it('relocate 拒绝把 if 的 True 包装节点拖走', () => {
    const s = ScriptEditor.setGroupKind(
      { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a')] },
      'a', 'if',
    );
    const trueId = s.steps[0].children![0].id;
    const out = ScriptEditor.relocate(s, trueId, 'a');
    expect(out.steps[0].children?.[0].id).toBe(trueId);
  });
});

describe('框选橡皮筋', () => {
  it('空白处拖框命中两个节点后弹出打包菜单', async () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const canvas = mount.querySelector('[data-cfg] .ui-shell-cfg-canvas') as HTMLElement
      ?? mount.querySelector('[data-cfg]') as HTMLElement;
    const a = mount.querySelector('[data-cfg-node="a"]') as HTMLElement;
    const b = mount.querySelector('[data-cfg-node="b"]') as HTMLElement;
    a.getBoundingClientRect = () => ({ x: 20, y: 20, left: 20, top: 20, right: 80, bottom: 50, width: 60, height: 30, toJSON() {} }) as DOMRect;
    b.getBoundingClientRect = () => ({ x: 20, y: 60, left: 20, top: 60, right: 80, bottom: 90, width: 60, height: 30, toJSON() {} }) as DOMRect;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 200, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
    expect(mount.querySelector('[data-pack-menu]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-menu]')?.getAttribute('data-pack-float')).toBe('true');
    expect(mount.querySelector('[data-pack-menu]')?.getAttribute('data-pack-compact')).toBe('true');
    expect(mount.querySelector('[data-pack-menu]')?.getAttribute('data-pack-anchor')).toBe('bbox');
    expect(mount.querySelector('[data-pack-menu]')?.closest('.ui-shell-cfg-canvas')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="sequence"]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="if"]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="while"]')).toBeTruthy();
    mount.querySelector('.ui-shell-cfg-canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 4, clientY: 4 }));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-pack-menu]')).toBeNull();
    });
  });
});

describe('工作台稀疏流体背景', () => {
  it('页面壳是雾块；点阵只铺在步骤流图画布上，盖住整个 pan 世界', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    expect(mount.querySelector('.ui-shell-particles')).toBeNull();
    expect(mount.querySelector('[data-particles]')).toBeNull();
    expect(mount.querySelector('[data-app-field] [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('[data-app-field] [data-cfg-field]')).toBeNull();
    expect(mount.querySelectorAll('[data-cfg-dot]').length).toBe(0);
    const canvas = mount.querySelector('[data-cfg] .ui-shell-cfg-canvas') as HTMLElement;
    const field = canvas?.querySelector(':scope > [data-cfg-dots]') as HTMLElement | null;
    expect(field).toBeTruthy();
    expect(field?.getAttribute('data-cfg-field')).toBe('true');
    expect(Number(field?.getAttribute('data-dot-gap'))).toBe(20);
    expect(canvas.querySelector('.ui-shell-cfg-tree [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('.ui-shell-header [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('[data-actions] [data-cfg-dots]')).toBeNull();
    const blobs = mount.querySelectorAll('[data-app-field] [data-fluid-blob]');
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    expect(blobs.length).toBeLessThanOrEqual(4);
    expect(mount.querySelector('[data-app-field] [data-fluid]')).toBeTruthy();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(canvas.querySelector(':scope > [data-cfg-dots]')).toBe(field);
    expect(field?.getAttribute('data-cfg-pan-y')).not.toBe('0');
  });
});

describe('同层有向边，无 minimap', () => {
  it('只画 true/false/loop 的 SVG 边，不画 flow（flow 用层内 ↓）', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const view = new CfgView({ mount });
    view.update(seed);
    expect(mount.querySelector('[data-cfg-edge]')).toBeNull();
    expect(mount.querySelector('[data-cfg-flow]')).toBeTruthy();
  });

  it('画布没有 minimap', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const view = new CfgView({ mount });
    view.update(seed);
    expect(mount.querySelector('[data-cfg-minimap]')).toBeNull();
  });
});

describe('步骤截图拍摄时画高亮，舞台不再叠 CSS 框', () => {
  it('录制点击后 screenshot 带 highlight，舞台没有 [data-highlight] overlay', async () => {
    const kernel = makeKernel();
    kernel.screenshot = vi.fn(async () => Buffer.from('fake-png-data-for-shot'));
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const shell = new UiShell({ kernel, mount });
    await shell.connect();
    await shell.startRecording();
    kernel.emit('recording', { type: 'click', locator: { name: 'Explorer' } });
    await vi.waitFor(() => {
      expect(Object.keys(shell.getStepShots()).length).toBeGreaterThan(0);
    });
    expect(kernel.screenshot).toHaveBeenCalled();
    const highlightArg = (kernel.screenshot as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => {
      const opts = (c[0] ?? {}) as { highlight?: { name?: string } };
      return opts.highlight?.name === 'Explorer';
    });
    expect(highlightArg).toBe(true);
    const id = Object.keys(shell.getStepShots())[0];
    shell.selectStep(id);
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeTruthy();
    expect(mount.querySelector('[data-highlight]')).toBeNull();
  });
});

function rect(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function mockCfgBoxes(
  canvas: { left: number; top: number; right: number; bottom: number },
  nodes: Record<string, { left: number; top: number; right: number; bottom: number }>,
) {
  const box = (b: { left: number; top: number; right: number; bottom: number }) =>
    ({ ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON() {} }) as DOMRect;
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ui-shell-cfg-canvas')) return box(canvas);
    const id = this.getAttribute('data-cfg-node');
    if (id && nodes[id]) return box(nodes[id]);
    if (this.hasAttribute('data-pack-menu') || this.hasAttribute('data-detail')) {
      const l = parseFloat(this.style.left || '0');
      const t = parseFloat(this.style.top || '0');
      const w = this.hasAttribute('data-detail') ? 280 : 168;
      const h = this.hasAttribute('data-detail') ? 180 : 32;
      return box({ left: canvas.left + l, top: canvas.top + t, right: canvas.left + l + w, bottom: canvas.top + t + h });
    }
    return box({ left: 0, top: 0, right: 0, bottom: 0 });
  });
}

describe('浮动钮锚在选区包围盒旁，不钉画布原点', () => {
  it('floatingChromePosition：工具栏在节点右侧，不是 (12,12)', () => {
    const p = floatingChromePosition(
      rect(150, 80, 260, 120),
      { width: 480, height: 400 },
      { width: 168, height: 32 },
      'toolbar',
    );
    expect(p.left).toBeGreaterThanOrEqual(260);
    expect(p.left).not.toBe(12);
    expect(p.top).not.toBe(12);
    expect(boxesIntersect(
      { left: p.left, top: p.top, right: p.left + 168, bottom: p.top + 32 },
      rect(150, 80, 260, 120),
    )).toBe(false);
  });

  it('floatingChromePosition：详情在节点外侧，右侧不够时不盖住节点', () => {
    const node = rect(40, 40, 200, 110);
    const p = floatingChromePosition(node, { width: 300, height: 400 }, { width: 280, height: 180 }, 'detail');
    expect(boxesIntersect(
      { left: p.left, top: p.top, right: p.left + 280, bottom: p.top + 180 },
      node,
    )).toBe(false);
    expect(p.left === 40 && p.top === 40).toBe(false);
    expect(p.left === 12 && p.top === 12).toBe(false);
  });

  it('点原子步：编辑/分支/循环贴在该步包围盒旁，不在 CFG 左上角', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const spy = mockCfgBoxes(
      { left: 0, top: 0, right: 480, bottom: 400 },
      { a: { left: 150, top: 80, right: 260, bottom: 120 } },
    );
    click(mount.querySelector('[data-cfg-node="a"]'));
    const pack = mount.querySelector('[data-pack-menu]') as HTMLElement;
    expect(pack).toBeTruthy();
    expect(pack.closest('.ui-shell-cfg-canvas')).toBeTruthy();
    expect(pack.getAttribute('data-pack-anchor')).toBe('bbox');
    expect(pack.getAttribute('data-float-origin')).toBe('bbox');
    expect(parseFloat(pack.style.left)).toBeGreaterThanOrEqual(260);
    expect(pack.style.left).not.toBe('12px');
    expect(pack.style.top).not.toBe('12px');
    expect(pack.textContent).toContain('编辑');
    expect(pack.querySelector('[data-action="edit"]')).toBeTruthy();
    expect(pack.querySelector('[data-action="wrap-if"]')).toBeTruthy();
    expect(pack.querySelector('[data-action="wrap-while"]')).toBeTruthy();
    spy.mockRestore();
  });

  it('平移后浮动钮按新的节点盒重放', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const spy = mockCfgBoxes(
      { left: 0, top: 0, right: 480, bottom: 400 },
      { a: { left: 150, top: 80, right: 260, bottom: 120 } },
    );
    click(mount.querySelector('[data-cfg-node="a"]'));
    const pack = mount.querySelector('[data-pack-menu]') as HTMLElement;
    const top0 = pack.style.top;
    spy.mockImplementation(function (this: HTMLElement) {
      const box = (b: { left: number; top: number; right: number; bottom: number }) =>
        ({ ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON() {} }) as DOMRect;
      if (this.classList.contains('ui-shell-cfg-canvas')) return box({ left: 0, top: 0, right: 480, bottom: 400 });
      if (this.getAttribute('data-cfg-node') === 'a') return box({ left: 150, top: 140, right: 260, bottom: 180 });
      return box({ left: 0, top: 0, right: 0, bottom: 0 });
    });
    const canvas = mount.querySelector('.ui-shell-cfg-canvas') as HTMLElement;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }));
    const pack2 = mount.querySelector('[data-pack-menu]') as HTMLElement;
    expect(pack2.style.top).not.toBe(top0);
    expect(parseFloat(pack2.style.top)).toBeGreaterThanOrEqual(140);
    spy.mockRestore();
  });

  it('点已打包组：浮动钮跟组节点走，不钉画布原点', () => {
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v1', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] },
      ['a', 'b'], 'sequence',
    );
    packed.steps[0].id = 'g';
    const kernel = makeKernel();
    const { mount } = boot(kernel, packed);
    const spy = mockCfgBoxes(
      { left: 20, top: 40, right: 540, bottom: 400 },
      { g: { left: 140, top: 120, right: 280, bottom: 200 } },
    );
    click(mount.querySelector('[data-cfg-node="g"]'));
    const pack = mount.querySelector('[data-pack-menu]') as HTMLElement;
    expect(pack.querySelector('[data-action="unpack"]')).toBeTruthy();
    expect(pack.getAttribute('data-float-origin')).toBe('bbox');
    expect(parseFloat(pack.style.left)).toBeGreaterThanOrEqual(260);
    expect(pack.style.left).not.toBe('12px');
    spy.mockRestore();
  });
});

describe('详情悬浮在步骤边上，不覆盖节点', () => {
  it('点编辑：详情在节点右侧且包围盒不相交，不盖预览', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const spy = mockCfgBoxes(
      { left: 0, top: 0, right: 520, bottom: 420 },
      { a: { left: 40, top: 60, right: 160, bottom: 110 } },
    );
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const detail = mount.querySelector('[data-detail]') as HTMLElement;
    const stage = mount.querySelector('[data-stage]');
    expect(detail.getAttribute('data-detail-open')).toBe('true');
    expect(detail.getAttribute('data-detail-anchor')).toBe('node');
    expect(detail.getAttribute('data-float-origin')).toBe('bbox');
    expect(detail.closest('[data-cfg]')).toBeTruthy();
    expect(stage?.contains(detail)).toBe(false);
    const left = parseFloat(detail.style.left);
    const top = parseFloat(detail.style.top);
    expect(left).toBeGreaterThanOrEqual(160);
    expect(boxesIntersect(
      { left, top, right: left + 280, bottom: top + 180 },
      { left: 40, top: 60, right: 160, bottom: 110 },
    )).toBe(false);
    spy.mockRestore();
  });

  it('画布偏窄：详情不盖住节点（右侧不够则左侧或上下外侧）', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const spy = mockCfgBoxes(
      { left: 0, top: 0, right: 300, bottom: 400 },
      { a: { left: 40, top: 40, right: 200, bottom: 100 } },
    );
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const detail = mount.querySelector('[data-detail]') as HTMLElement;
    const left = parseFloat(detail.style.left);
    const top = parseFloat(detail.style.top);
    expect(boxesIntersect(
      { left, top, right: left + 280, bottom: top + 180 },
      { left: 40, top: 40, right: 200, bottom: 100 },
    )).toBe(false);
    expect(left === 40 && top === 40).toBe(false);
    expect(detail.style.left === '12px' && detail.style.top === '12px').toBe(false);
    spy.mockRestore();
  });

  it('确定和删除同一行等宽；关闭是扇形 X，不是取消', () => {
    const kernel = makeKernel();
    const { mount, shell } = boot(kernel);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const detail = mount.querySelector('[data-detail]') as HTMLElement;
    const row = detail.querySelector('[data-edit-actions], .ui-shell-edit-actions') as HTMLElement;
    expect(row).toBeTruthy();
    const save = row.querySelector('[data-action="save-edit"]') as HTMLElement;
    const del = row.querySelector('[data-action="remove"]') as HTMLElement;
    expect(save).toBeTruthy();
    expect(del).toBeTruthy();
    expect(save.textContent).toMatch(/确定|已保存/);
    expect(del.textContent).toBe('删除');
    expect(save.classList.contains('primary')).toBe(true);
    expect(del.classList.contains('danger')).toBe(true);
    expect(save.parentElement).toBe(row);
    expect(del.parentElement).toBe(row);
    expect(row.querySelectorAll('button').length).toBe(2);
    const close = detail.querySelector('[data-inspector-close]') as HTMLElement;
    expect(close).toBeTruthy();
    expect(close.getAttribute('data-action')).toBe('close-inspector');
    expect(close.classList.contains('ui-shell-inspector-close')).toBe(true);
    expect(close.textContent).toBe('×');
    expect(detail.querySelector('[data-action="cancel-edit"]')).toBeNull();
    click(del);
    expect(shell.getScript().steps.find((s) => s.id === 'a')).toBeUndefined();
  });
});

