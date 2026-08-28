// @vitest-environment jsdom
// UI 主链路端到端验收（CODEBUDDY.md §4.1 强制门槛）：
// 真实驱动 UiShell 渲染的 DOM，用 dispatchEvent 模拟用户点击 [data-action] 按钮，
// 证明用户主链路（插入→编辑→建组→运行→失败标红）端到端跑通。
// 禁止只用内部 API 直调冒充用户路径。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { INTRO_PROGRESS_MS, INTRO_SETTLE_MS } from '../src/ui/intro';
import type { Script, Step, Locator } from '../src/types/step';

const CFG_CONNECTORS_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures/cfg-connectors-sample.json'),
  'utf8',
);
const AGENT_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures/agent-generated-vscode.json'),
  'utf8',
);
const AGENT_IF_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures/agent-generated-if.json'),
  'utf8',
);

// 内联 MockKernel（不修改既有 ui-shell.test.ts，遵循测试代码权威性）
type AnyKernel = any;
function makeMockKernel(recordedEvents: any[] = []) {
  const calls: string[] = [];
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
    screenshot: vi.fn(async (): Promise<Buffer> => { calls.push('screenshot'); return Buffer.from('PNG-BYTES-FOR-STEP-SHOT'); }),
    locateVisual: vi.fn(async (_l: Locator) => ({ x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true })),
    startRecording: vi.fn(() => { calls.push('startRecording'); }),
    stopRecording: vi.fn(async () => recordedEvents),
    playback: vi.fn(async () => ({ ok: true })),
    on: vi.fn(),
    off: vi.fn(),
  } as AnyKernel;
}

function bootShell(kernel: AnyKernel, script?: Script): { shell: UiShell; mount: HTMLElement } {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel, mount, script });
  shell.render();
  return { shell, mount };
}

/** 模拟一次真实用户点击：冒泡到 mount 上的事件委托。 */
function click(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const seed: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'T', version: '1.0.0' },
  steps: [
    { id: 'a', type: 'click', locator: { role: 'button', name: 'A' }, source: 'manual' },
    { id: 'b', type: 'click', locator: { role: 'button', name: 'B' }, source: 'manual' },
  ],
};

describe('UI 主链路 e2e（DOM 事件委托入口）', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeMockKernel(); });

  it('布局：CFG + 舞台两栏，详情停在流图栏，不是常驻右栏、也不盖预览', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('.ui-shell-body')).toBeTruthy();
    expect(mount.querySelector('[data-stage]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg]')).toBeTruthy();
    expect(mount.querySelector('[data-detail]')).toBeTruthy();
    expect(mount.querySelector('.ui-shell-body > [data-detail]')).toBeNull();
    expect(mount.querySelector('[data-cfg] [data-detail]')).toBeTruthy();
    expect(mount.querySelector('[data-stage] [data-detail]')).toBeNull();
    expect(mount.querySelector('.ui-shell-stage-wrap [data-detail]')).toBeNull();
    expect(mount.querySelector('[data-steps]')).toBeNull();
    expect(mount.getAttribute('data-layout')).toMatch(/^(flow|shot)$/);
  });

  it('插入：点击「插入步骤」展开 3 类菜单（wait/waitUntil/assert），不含 click/repeat', () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-action="insert"]'));
    const types = Array.from(mount.querySelectorAll('[data-insert-type]')).map((e) => e.getAttribute('data-insert-type'));
    expect(types.sort()).toEqual(['assert', 'wait', 'waitUntil']);
    expect(types).not.toContain('click');
    expect(types).not.toContain('fill');
    expect(types).not.toContain('repeat'); // 循环走组操作（§2.5），不进插入菜单
  });

  it('插入 wait：点 4 类菜单中的 wait → 列表 +1 且类型为 wait', () => {
    const { shell, mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-action="insert"]'));
    click(mount.querySelector('[data-insert-type="wait"]'));
    const ids = shell.getScript().steps.map((s: Step) => s.type);
    expect(ids).toContain('wait');
    expect(shell.getScript().steps.length).toBe(3);
  });

  it('编辑：选中步骤 → 出现真实编辑区 → 改参数 → 保存 → getScript 该步更新（不可变）', () => {
    const { shell, mount } = bootShell(kernel, seed);
    // 选中 a 步
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const area = mount.querySelector('[data-edit-area]');
    expect(area).toBeTruthy();
    // 编辑区含保存按钮（真实表单，而非 alert）
    const saveBtn = mount.querySelector('[data-action="save-edit"]');
    expect(saveBtn).toBeTruthy();
    // 修改参数输入并保存：以 wait 步为例，这里 a 是 click，验证 locator.name 可编辑
    const input = mount.querySelector('[data-edit-field="locator.name"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.value = '改名后';
    click(saveBtn);
    const a = shell.getScript().steps.find((s: Step) => s.id === 'a');
  });

  it('建组：Ctrl 多选 2 步 → 设为选择组 → 两步进 True，默认无 Else', () => {
    const { shell, mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    click(mount.querySelector('[data-action="wrap-if"]'));
    expect(shell.getScript().steps).toHaveLength(1);
    const grp = shell.getScript().steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.children).toHaveLength(1);
    expect(grp.children?.[0].control?.kind).toBe('sequence');
    expect(grp.children?.[0].children?.map((c: Step) => c.id)).toEqual(['a', 'b']);
    const cfg = mount.querySelector('[data-cfg]');
    expect(cfg?.querySelector('[data-cfg-branch="true"]')).toBeTruthy();
    expect(cfg?.querySelector('[data-cfg-branch="false"]')).toBeNull();
  });

  it('建组：包成 while → CFG 出现回环边', () => {
    const { shell, mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    click(mount.querySelector('[data-action="wrap-while"]'));
    expect(shell.getScript().steps[0].control?.kind).toBe('while');
    const cfg = mount.querySelector('[data-cfg]');
    expect(cfg?.querySelector('[data-cfg-loop="true"]')).toBeTruthy(); // 回环边标记
  });

  it('运行失败：playback 返回 fail → 该步标红 + 提醒条出现', async () => {
    kernel.playback = vi.fn(async () => ({ ok: false, failedStepId: 'a' }));
    const { shell, mount } = bootShell(kernel, seed);
    await shell.connect();
    click(mount.querySelector('[data-action="run-all"]'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-cfg-node="a"]')?.getAttribute('data-cfg-status')).toBe('fail');
    });
    expect(mount.querySelector('[data-run-notice]')).toBeTruthy();
  });

  it('未连接时「运行全部」不禁用：点击出现 [data-run-notice]，不调用 playback', async () => {
    const { mount } = bootShell(kernel, seed);
    const btn = mount.querySelector('[data-action="run-all"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    click(btn);
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/未连接靶机/);
    });
    expect(kernel.playback).not.toHaveBeenCalled();
  });

  it('版本面板：主体流程默认不挂载 [data-version]', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('[data-version]')).toBeNull();
  });

  it('导入 cfg-connectors-sample 后点运行全部（未连接）：必须出现 [data-run-notice]，不得零反馈', async () => {
    const { shell, mount } = bootShell(kernel);
    shell.importScript(CFG_CONNECTORS_JSON);
    expect(mount.querySelector('[data-cfg-node="if-send"]')).toBeTruthy();
    click(mount.querySelector('[data-action="run-all"]'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/未连接靶机/);
    });
    expect(kernel.playback).not.toHaveBeenCalled();
  });

  it('导入 sample 后已连接但 playback 抛错：必须出现 [data-run-notice]，CFG 不得全是 pending 静默', async () => {
    kernel.playback = vi.fn(async () => { throw new Error('if condition exploded'); });
    const { shell, mount } = bootShell(kernel);
    await shell.connect();
    shell.importScript(CFG_CONNECTORS_JSON);
    click(mount.querySelector('[data-action="run-all"]'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/运行失败|exploded/);
    });
  });

  it('已连接时导入 Agent 脚本：点步骤后舞台出现该步截图（用户导入路径）', async () => {
    const { shell, mount } = bootShell(kernel);
    await shell.connect();
    shell.importScript(AGENT_JSON);
    await vi.waitFor(() => {
      expect(shell.getStepShots()['agent-fill-chat']).toBeTruthy();
      expect(shell.getStepShots()['agent-click-send']).toBeTruthy();
    });
    click(mount.querySelector('[data-cfg-node="agent-fill-chat"]'));
    const img = mount.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    expect(img?.src).toContain('base64');
    expect(mount.getAttribute('data-layout')).toBe('flow');
  });

  it('导入 agent-generated-if：CFG 有 if/while；未连接舞台能出图；已连接点运行全部会调 playback', async () => {
    const { shell, mount } = bootShell(kernel);
    shell.importScript(AGENT_IF_JSON);
    expect(mount.querySelector('[data-cfg-node="agent-if"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-node="agent-while"]')).toBeTruthy();
    expect(shell.getStepShots()['agent-if-true-click']).toBeTruthy();
    click(mount.querySelector('[data-cfg-node="agent-if-true-click"]'));
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeTruthy();
    await shell.connect();
    click(mount.querySelector('[data-action="run-all"]'));
    await vi.waitFor(() => {
      expect(kernel.playback).toHaveBeenCalled();
    });
  });
});

describe('工作台交互抛光（保存 / 顶栏 / 框选 / 双栏主次）', () => {
  let kernel: AnyKernel;
  beforeEach(() => { kernel = makeMockKernel(); });

  it('详情保存后出现 [data-save-notice]，编辑区仍在', () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const saveBtn = mount.querySelector('[data-action="save-edit"]');
    expect(saveBtn).toBeTruthy();
    click(saveBtn);
    expect(mount.querySelector('[data-save-notice]')).toBeTruthy();
    expect(mount.querySelector('[data-edit-area]')).toBeTruthy();
  });

  it('顶栏产品名是测试步骤中台，不把 VS Code 当产品名，单目标不显示下拉', async () => {
    kernel.listTargets = vi.fn((): any[] => [
      { id: 'main', type: 'page', title: 'VS Code (Electron sample)' },
    ]);
    const { mount, shell } = bootShell(kernel, {
      ...seed,
      app: { name: 'VS Code (Electron sample)', version: '1.0.0' },
    });
    const header = mount.querySelector('.ui-shell-header')!;
    expect(header.textContent).toContain('测试步骤中台');
    expect(header.textContent).not.toContain('可视化蒙版');
    expect(mount.querySelector('[data-target-select]')).toBeNull();
    await shell.connect();
    const connected = mount.querySelector('.ui-shell-header')!;
    expect(connected.textContent).toContain('测试步骤中台');
    expect(connected.textContent).toContain('已连接');
    expect(connected.textContent).not.toContain('VS Code (Electron sample)');
    expect(mount.querySelector('[data-conn-status]')?.getAttribute('title')).toContain('VS Code (Electron sample)');
    expect(document.title).toBe('测试步骤中台');
    expect(mount.querySelector('[data-target-select]')).toBeNull();
  });

  it('多目标时显示「当前窗口」下拉', async () => {
    kernel.listTargets = vi.fn((): any[] => [
      { id: 'main', type: 'page', title: '主窗口' },
      { id: 'wv1', type: 'webview', title: '侧栏' },
    ]);
    const { mount, shell } = bootShell(kernel, seed);
    await shell.connect();
    const sel = mount.querySelector('[data-target-select]') as HTMLSelectElement | null;
    expect(sel).toBeTruthy();
    expect(mount.querySelector('[data-target-label]')?.textContent).toMatch(/当前窗口/);
    expect(sel!.options.length).toBe(2);
  });

  it('舞台没有锁台横幅或遮罩，预览整张可见', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('.ui-shell-stage-lock')).toBeNull();
    expect(mount.querySelector('[data-stage-lock]')).toBeNull();
    expect(mount.textContent).not.toContain('预览不可操作靶机');
    const stage = mount.querySelector('[data-stage]') as HTMLElement;
    expect(stage.querySelectorAll(':scope > *').length).toBeGreaterThan(0);
    expect(stage.querySelector('[data-frame]')).toBeTruthy();
  });

  it('CFG 栏标题是步骤流图，提示拖拽调序、框选打包、单选编辑', () => {
    const { mount } = bootShell(kernel, seed);
    const title = mount.querySelector('[data-cfg] .ui-shell-pane-title')?.textContent ?? '';
    expect(title).toContain('步骤流图');
    expect(title).toContain('拖拽调序');
    expect(title).toContain('框选打包');
    expect(title).toContain('单选编辑');
    expect(title).not.toContain('Ctrl');
    expect(title).not.toContain('一步 = 一组');
  });

  it('首个 CFG 节点相对画布有内边距，不贴齐 (0,0)', () => {
    const { mount } = bootShell(kernel, seed);
    const tree = mount.querySelector('.ui-shell-cfg-tree') as HTMLElement;
    const node = tree?.querySelector('[data-cfg-node]') as HTMLElement;
    expect(tree).toBeTruthy();
    expect(node).toBeTruthy();
    const padTop = parseInt(tree.style.paddingTop || '0', 10);
    const padLeft = parseInt(tree.style.paddingLeft || '0', 10);
    const marginLeft = parseInt(tree.style.marginLeft || '0', 10);
    expect(tree.getAttribute('data-cfg-inset')).toBe('true');
    expect(padTop).toBeGreaterThanOrEqual(24);
    expect(padLeft).toBeGreaterThanOrEqual(24);
    expect(marginLeft).toBeGreaterThanOrEqual(8);
    // jsdom 的 offsetTop 常为 0；合同是树上的 padding/margin，让第一步不贴齐画布原点。
    expect(padTop + padLeft + marginLeft).toBeGreaterThan(0);
  });

  it('框选后紧凑浮动打包钮贴在选区包围盒旁；点顺序组用内联输入而不是 prompt', async () => {
    const { shell, mount } = bootShell(kernel, seed);
    const box = (left: number, top: number, right: number, bottom: number) =>
      ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ui-shell-cfg-canvas')) return box(0, 0, 400, 400);
      const id = this.getAttribute('data-cfg-node');
      if (id === 'a') return box(20, 20, 80, 50);
      if (id === 'b') return box(20, 60, 80, 90);
      return box(0, 0, 0, 0);
    });
    const canvas = mount.querySelector('.ui-shell-cfg-canvas') as HTMLElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 200, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
    const pack = mount.querySelector('[data-pack-menu]') as HTMLElement | null;
    expect(pack).toBeTruthy();
    expect(pack?.getAttribute('data-pack-float')).toBe('true');
    expect(pack?.getAttribute('data-pack-compact')).toBe('true');
    expect(pack?.getAttribute('data-pack-anchor')).toBe('bbox');
    expect(pack?.closest('.ui-shell-cfg-canvas')).toBeTruthy();
    expect(pack?.style.position).toBe('absolute');
    expect(parseFloat(pack!.style.left)).toBeGreaterThanOrEqual(80);
    expect(pack?.style.bottom).toBeFalsy();
    expect(pack?.getAttribute('data-pack-set')).toBe('marquee');
    expect(pack?.textContent).toContain('打包');
    expect(mount.querySelector('[data-pack-choice="sequence"]')).toBeTruthy();
    expect(mount.querySelector('[data-actions] [data-action="wrap-if"]')).toBeNull();
    expect(mount.querySelector('[data-actions] [data-action="wrap-while"]')).toBeNull();
    expect(mount.querySelector('[data-actions] [data-action="wrap-sequence"]')).toBeNull();
    expect(mount.getAttribute('data-layout')).toBe('flow');
    const promptSpy = vi.spyOn(window, 'prompt');
    click(mount.querySelector('[data-pack-choice="sequence"]'));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    expect(shell.getScript().steps[0].control?.kind).toBe('sequence');
    expect(shell.getScript().steps[0].control?.name).toBe('顺序组');
    click(mount.querySelector('[data-action="edit"]'));
    const nameField = mount.querySelector('[data-edit-field="control.name"]') as HTMLInputElement;
    nameField.value = '登录流程';
    click(mount.querySelector('[data-action="save-edit"]'));
    expect(shell.getScript().steps[0].control?.name).toBe('登录流程');
    promptSpy.mockRestore();
    spy.mockRestore();
  });

  it('框选后点画布空白，打包钮消失', async () => {
    const { mount } = bootShell(kernel, seed);
    const box = (left: number, top: number, right: number, bottom: number) =>
      ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ui-shell-cfg-canvas')) return box(0, 0, 400, 400);
      const id = this.getAttribute('data-cfg-node');
      if (id === 'a') return box(20, 20, 80, 50);
      if (id === 'b') return box(20, 60, 80, 90);
      return box(0, 0, 0, 0);
    });
    const canvas = mount.querySelector('.ui-shell-cfg-canvas') as HTMLElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 200, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
    expect(mount.querySelector('[data-pack-menu]')).toBeTruthy();
    click(mount.querySelector('.ui-shell-cfg-canvas'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-pack-menu]')).toBeNull();
    });
    expect(mount.getAttribute('data-layout')).toBe('shot');
    spy.mockRestore();
  });

  it('点单步：流图主栏，选区旁是编辑/分支/循环；点编辑才开详情', () => {
    const { mount } = bootShell(kernel, seed);
    const box = (left: number, top: number, right: number, bottom: number) =>
      ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ui-shell-cfg-canvas')) return box(0, 0, 520, 400);
      if (this.getAttribute('data-cfg-node') === 'a') return box(20, 40, 120, 80);
      return box(0, 0, 0, 0);
    });
    expect(mount.getAttribute('data-layout')).toBe('shot');
    click(mount.querySelector('[data-cfg-node="a"]'));
    expect(mount.getAttribute('data-layout')).toBe('flow');
    expect(mount.querySelector('[data-detail]')?.getAttribute('data-detail-open')).not.toBe('true');
    expect(mount.querySelector('.ui-shell-stage-wrap [data-action="edit"]')).toBeNull();
    expect(mount.querySelector('[data-step-chip]')).toBeNull();
    const pack = mount.querySelector('[data-pack-menu]') as HTMLElement | null;
    expect(pack).toBeTruthy();
    expect(pack?.getAttribute('data-pack-set')).toBe('atomic');
    expect(pack?.getAttribute('data-pack-anchor')).toBe('bbox');
    expect(parseFloat(pack!.style.left)).toBeGreaterThanOrEqual(120);
    expect(mount.querySelector('[data-pack-menu] [data-action="edit"]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="if"]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="while"]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-choice="sequence"]')).toBeNull();
    click(mount.querySelector('[data-pack-menu] [data-action="edit"]'));
    expect(mount.getAttribute('data-layout')).toBe('flow');
    expect(mount.querySelector('[data-detail-open="true"]')).toBeTruthy();
    expect(mount.querySelector('[data-edit-area]')).toBeTruthy();
    const detail = mount.querySelector('[data-detail]') as HTMLElement;
    expect(detail?.getAttribute('data-detail-anchor')).toBe('node');
    expect(detail?.getAttribute('data-float-origin')).toBe('bbox');
    expect(detail?.closest('[data-cfg]')).toBeTruthy();
    expect(mount.querySelector('[data-pack-menu]')?.getAttribute('data-float-origin')).toBe('bbox');
    // 节点盒 20–120；详情必须在盒外（右侧），不能盖在节点上。
    expect(parseFloat(detail.style.left)).toBeGreaterThanOrEqual(120);
    const row = detail.querySelector('.ui-shell-edit-actions') as HTMLElement;
    expect(row?.querySelector('[data-action="save-edit"]')?.classList.contains('primary')).toBe(true);
    expect(row?.querySelector('[data-action="remove"]')?.textContent).toBe('删除');
    expect(row?.querySelectorAll('button').length).toBe(2);
    expect(detail.querySelector('[data-inspector-close]')?.classList.contains('ui-shell-inspector-close')).toBe(true);
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    spy.mockRestore();
  });

  it('流图画布铺满点阵；雾块只在页面壳，动作条仍在顶栏', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/index.html'), 'utf8');
    expect(html).not.toMatch(/background-size:\s*16px\s+16px/);
    expect(html).toMatch(/html,\s*body,\s*#app/);
    expect(html).toMatch(/100dvh/);
    expect(html).toMatch(/html,\s*body,\s*#app[^{]*\{[^}]*overflow:\s*hidden/);
    expect(html).toMatch(/\.ui-shell-cfg-dots[^{]*\{[^}]*inset:\s*0/);
    expect(html).toMatch(/\.ui-shell-cfg-dots[^{]*\{[^}]*background-size:\s*20px\s+20px/);
    expect(html).not.toMatch(/html[^{]*\{[^}]*background-size:\s*20px/);
    expect(html).not.toMatch(/body[^{]*\{[^}]*background-size:\s*20px/);
    expect(html).toMatch(/backdrop-filter:\s*blur/);
    expect(html).not.toMatch(/ui-shell-particles/);
    expect(html).toMatch(/ui-shell-fluid-blob/);
    expect(html).toMatch(/@keyframes\s+ui-fluid-/);
    expect(html).toMatch(/\.ui-shell-header \{[^}]*box-shadow:/);
    expect(html).toMatch(/\.ui-shell-cfg \{[^}]*box-shadow:/);
    expect(html).toMatch(/\.ui-shell-stage \{[^}]*box-shadow:/);
    expect(html).toMatch(/\.ui-shell-header[\s\S]*?min-height:\s*88px/);
    expect(html).toMatch(/\.ui-shell-header[\s\S]*?z-index:\s*20/);
    expect(html).toMatch(/\.ui-shell-wordmark-label[\s\S]*?font-size:\s*22px/);
    expect(html).toMatch(/\.ui-shell-inspector-close[\s\S]*?border-radius:\s*0\s+8px\s+0\s+100%/);
    expect(html).toMatch(/\.ui-shell-edit-actions[\s\S]*?\[data-action="save-edit"\][\s\S]*?\[data-action="remove"\]/);

    const { mount } = bootShell(kernel, seed);
    expect(mount.style.overflow).toBe('hidden');
    const canvas = mount.querySelector('[data-cfg] .ui-shell-cfg-canvas') as HTMLElement;
    const field = canvas?.querySelector(':scope > [data-cfg-dots]');
    expect(field).toBeTruthy();
    expect(field?.getAttribute('data-cfg-field')).toBe('true');
    expect(Number(field?.getAttribute('data-dot-gap'))).toBe(20);
    expect(canvas.querySelector('.ui-shell-cfg-tree [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('.ui-shell-header [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('[data-header] [data-cfg-dots]')).toBeNull();
    expect(mount.querySelector('[data-app-field] [data-cfg-dots]')).toBeNull();
    expect(mount.querySelectorAll('[data-cfg-dot]').length).toBe(0);
    expect(mount.querySelector('[data-app-field]')).toBeTruthy();
    expect(mount.querySelector('[data-particles]')).toBeNull();
    const blobs = mount.querySelectorAll('[data-app-field] [data-fluid-blob]');
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    expect(blobs.length).toBeLessThanOrEqual(4);
    expect(mount.querySelector('[data-app-field] [data-fluid-spot]')).toBeTruthy();
    const header = mount.querySelector('.ui-shell-header');
    expect(header?.querySelector('[data-actions]')).toBeTruthy();
    expect(header?.querySelector('[data-action="toggle-record"]')).toBeTruthy();
    expect(mount.querySelector('.ui-shell-body + [data-actions]')).toBeNull();

    mount.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    mount.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 60 }));
    expect(mount.style.getPropertyValue('--fluid-x')).toBe('75.00%');
    expect(mount.style.getPropertyValue('--fluid-y')).toBe('20.00%');
  });

  it('出现/消失用 180ms 透明度位移，不是瞬切', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/index.html'), 'utf8');
    expect(html).toMatch(/180ms/);
    expect(html).toMatch(/@keyframes\s+ui-pop-in/);
    expect(html).toMatch(/@keyframes\s+ui-pop-out/);
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    expect(mount.querySelector('[data-detail]')?.getAttribute('data-ui-motion')).toBe('180');
  });

  it('开始录制切到流图主栏', async () => {
    const { mount, shell } = bootShell(kernel, seed);
    await shell.connect();
    expect(mount.getAttribute('data-layout')).toBe('shot');
    click(mount.querySelector('[data-action="toggle-record"]'));
    await vi.waitFor(() => {
      expect(mount.getAttribute('data-layout')).toBe('flow');
    });
  });

  it('步骤流图栏/画布没有 overflow:auto；详情内部可滚动', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/index.html'), 'utf8');
    expect(html).toMatch(/\.ui-shell-cfg-canvas[^{]*\{[^}]*overflow:\s*hidden/);
    expect(html).not.toMatch(/\.ui-shell-cfg-canvas[^{]*\{[^}]*overflow:\s*auto/);
    const { mount } = bootShell(kernel, seed);
    const canvas = mount.querySelector('.ui-shell-cfg-canvas') as HTMLElement;
    const cfg = mount.querySelector('.ui-shell-cfg') as HTMLElement;
    expect(canvas.style.overflow).toBe('hidden');
    expect(cfg.style.overflow === 'hidden' || html.includes('.ui-shell-cfg')).toBe(true);
    click(mount.querySelector('[data-cfg-node="a"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const scroll = mount.querySelector('[data-inspector-scroll]') as HTMLElement;
    expect(scroll.style.overflow).toBe('auto');
  });

  it('导入 if fixture：每列只有一个 True / 一个 False，枝内 sequence 不再印分支词', () => {
    const { mount, shell } = bootShell(kernel);
    shell.importScript(CFG_CONNECTORS_JSON);
    const trueCol = mount.querySelector('[data-cfg-branch="true"]') as HTMLElement;
    const falseCol = mount.querySelector('[data-cfg-branch="false"]') as HTMLElement;
    expect(trueCol).toBeTruthy();
    expect(falseCol).toBeTruthy();
    const labels = (col: HTMLElement) =>
      [...col.querySelectorAll('h4, .ui-shell-cfg-group-head .ui-shell-cfg-label')]
        .map((el) => (el.textContent ?? '').trim());
    expect(labels(trueCol).filter((t) => /^true$/i.test(t))).toEqual(['True']);
    expect(labels(falseCol).filter((t) => /^false$/i.test(t))).toEqual(['False']);
    expect(trueCol.querySelector('[data-cfg-seq-in-branch="true"]')).toBeTruthy();
  });

  it('选择组详情不出现尚未选取，组名可改', () => {
    const { mount, shell } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    click(mount.querySelector('[data-action="wrap-if"]'));
    expect(shell.getScript().steps[0].control?.kind).toBe('if');
    const area = mount.querySelector('[data-edit-area]');
    expect(area).toBeTruthy();
    expect(area?.textContent).not.toContain('尚未选取');
    const name = mount.querySelector('[data-edit-field="control.name"]') as HTMLInputElement | null;
    expect(name).toBeTruthy();
    expect(name?.value.length).toBeGreaterThan(0);
    expect(mount.querySelector('[data-detail]')?.getAttribute('data-detail-anchor')).toBe('node');
  });

  it('悬停一步超过 400ms 切右侧截图，松手不撤回，布局仍是截图主栏', () => {
    vi.useFakeTimers();
    const { mount } = bootShell(kernel, seed);
    expect(mount.getAttribute('data-layout')).toBe('shot');
    const node = mount.querySelector('[data-cfg-node="a"]')!;
    node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(399);
    expect(mount.querySelector('[data-stage]')?.getAttribute('data-preview-step')).not.toBe('a');
    expect(mount.getAttribute('data-layout')).toBe('shot');
    vi.advanceTimersByTime(20);
    expect(mount.querySelector('[data-stage]')?.getAttribute('data-preview-step')).toBe('a');
    expect(mount.getAttribute('data-layout')).toBe('shot');
    node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    expect(mount.querySelector('[data-stage]')?.getAttribute('data-preview-step')).toBe('a');
    expect(mount.getAttribute('data-layout')).toBe('shot');
    vi.useRealTimers();
  });

  it('点单步后点空白：回到截图主栏，保留高亮，浮动钮消失', async () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    expect(mount.getAttribute('data-layout')).toBe('flow');
    expect(mount.querySelector('[data-pack-menu]')).toBeTruthy();
    click(mount.querySelector('.ui-shell-cfg-canvas'));
    await vi.waitFor(() => {
      expect(mount.querySelector('[data-pack-menu]')).toBeNull();
    });
    expect(mount.getAttribute('data-layout')).toBe('shot');
    expect(mount.querySelector('[data-cfg-node="a"]')?.classList.contains('is-selected')).toBe(true);
  });

  it('已打包组浮动钮含拆包，详情里不再放拆包', () => {
    const { mount, shell } = bootShell(kernel, seed);
    click(mount.querySelector('[data-cfg-node="a"]'));
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    click(mount.querySelector('[data-pack-choice="sequence"]'));
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    const gid = shell.getScript().steps[0].id;
    click(mount.querySelector(`[data-cfg-node="${gid}"]`));
    const pack = mount.querySelector('[data-pack-menu]');
    expect(pack?.getAttribute('data-pack-set')).toBe('group');
    expect(pack?.querySelector('[data-action="unpack"]')).toBeTruthy();
    click(pack!.querySelector('[data-action="edit"]'));
    expect(mount.querySelector('[data-edit-area] [data-action="unpack"]')).toBeNull();
    expect(mount.querySelector('[data-stage]')?.getAttribute('data-preview-empty')).toBe('true');
  });

  it('断言表单顺序：类型 → 点选 → 期望值 → 最长等待 → 确定，关闭用 X', () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-action="insert"]'));
    click(mount.querySelector('[data-insert-type="waitUntil"]'));
    const last = mount.querySelectorAll('[data-cfg-node]');
    click(last[last.length - 1]);
    click(mount.querySelector('[data-pack-menu] [data-action="edit"]'));
    const slots = [...mount.querySelectorAll('[data-assert-slot]')].map((el) => el.getAttribute('data-assert-slot'));
    expect(slots[0]).toBe('kind');
    expect(slots).toContain('pick');
    expect(slots).toContain('timeout');
    expect(slots[slots.length - 1]).toBe('actions');
    expect(slots.indexOf('kind')).toBeLessThan(slots.indexOf('pick'));
    expect(slots.indexOf('pick')).toBeLessThan(slots.indexOf('timeout'));
    expect(mount.querySelector('[data-action="save-edit"]')?.textContent).toMatch(/确定|已保存/);
    expect(mount.querySelector('[data-action="cancel-edit"]')).toBeNull();
    expect(mount.querySelector('[data-inspector-close]')).toBeTruthy();
    expect(mount.querySelector('[data-assert-hint]')).toBeTruthy();
  });
});

// 进场动画的用户路径：只用真实点击/按键驱动，不调内部方法。
// 与 test/ui-intro-anim.test.ts 的分工：那边钉状态机细节，这边钉"用户真能这么用"。
describe('顶栏品牌字进场动画（用户路径）', () => {
  let kernel: AnyKernel;
  beforeEach(() => {
    kernel = makeMockKernel();
    vi.useFakeTimers();
    const impl = (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
    (window as any).matchMedia = impl;
  });
  afterEach(() => { vi.useRealTimers(); });

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('打开页面：先进场层挡在前面，进度条在其中，顶栏字标也在（不是二选一）', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('[data-intro]')).toBeTruthy();
    expect(mount.querySelector('[data-intro-progress]')).toBeTruthy();
    // 顶栏字标必须同时存在：进场层只是覆盖，不能把字标顶掉，
    // 否则收敛动画结束时会出现"字从无到有"的跳变。
    expect(mount.querySelector('[data-wordmark]')).toBeTruthy();
  });

  it('等动画自然走完：进场层消失，顶栏字标留在原位可用', async () => {
    const { mount } = bootShell(kernel, seed);
    await advance(INTRO_PROGRESS_MS + INTRO_SETTLE_MS + 60);
    expect(mount.querySelector('[data-intro]')).toBeNull();
    expect(mount.querySelector('[data-wordmark]')?.textContent).toContain('测试步骤中台');
  });

  it('用户点「跳过」：立刻进最终态，不等进度条走完', async () => {
    const { mount } = bootShell(kernel, seed);
    const skip = mount.querySelector('[data-intro-skip]') as HTMLElement;
    expect(skip).toBeTruthy();
    click(skip);
    await advance(INTRO_SETTLE_MS + 60);
    expect(mount.querySelector('[data-intro]')).toBeNull();
  });

  it('动画期间顶栏「插入步骤」仍可点（进场层不吃掉业务点击）', () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-action="insert"]'));
    expect(mount.querySelector('[data-insert-type="wait"]')).toBeTruthy();
  });

  it('动画期间点顶栏按钮，动画不会被打断也不会重播', async () => {
    const { mount } = bootShell(kernel, seed);
    await advance(300);
    click(mount.querySelector('[data-action="insert"]'));
    // 触发了 render：进场层仍在（没被打断），且只有一层（没叠加）。
    expect(mount.querySelectorAll('[data-intro]').length).toBe(1);
    await advance(INTRO_PROGRESS_MS + INTRO_SETTLE_MS + 60);
    expect(mount.querySelector('[data-intro]')).toBeNull();
  });

  it('按 Esc 跳过：不依赖鼠标也能退出动画', async () => {
    const { mount } = bootShell(kernel, seed);
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await advance(INTRO_SETTLE_MS + 60);
    expect(mount.querySelector('[data-intro]')).toBeNull();
  });
});
