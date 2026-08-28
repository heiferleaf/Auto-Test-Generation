// @vitest-environment jsdom
// 测试先行：详情面板支持 visionPrompt（截图 + 提示词断言）。
//
// 覆盖：
//  - 类型下拉里能选到 visionPrompt
//  - 选中后出现多行提示词输入（提示词是一段话，单行 input 不够用）
//  - 提示词存回 assertion.value（零 schema 变更，决策 2）
//  - 给了引导用户提供 apikey 的入口（决策 4：密钥不进脚本，但要告诉用户去哪配）
//  - 切回其它 kind 时提示词框消失，不残留

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

function boot(script: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel: makeMockKernel(), mount, script });
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

/** 打开某步的详情编辑区。 */
function openEdit(mount: Element, stepId: string) {
  click(mount.querySelector(`[data-cfg-node="${stepId}"]`));
  click(mount.querySelector('[data-action="edit"]'));
}

function assertScript(): Script {
  return {
    schema: 'electron-auto-test/step/v2',
    app: { name: 'T' },
    steps: [{
      id: 'a', type: 'assert', source: 'manual',
      params: { assertion: { kind: 'visible', locator: { role: 'status' } } },
    }],
  };
}

describe('详情面板：visionPrompt 断言', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('类型下拉里能选到 visionPrompt', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    const sel = mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toContain('visionPrompt');
  });

  it('切到 visionPrompt 后出现提示词输入（多行 textarea）', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    const ta = mount.querySelector('[data-edit-field="assertion.value"]');
    expect(ta).toBeTruthy();
    expect(ta?.tagName.toLowerCase()).toBe('textarea');
  });

  it('提示词保存后写进 assertion.value（零 schema 变更）', () => {
    const { shell, mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    const ta = mount.querySelector('[data-edit-field="assertion.value"]') as HTMLTextAreaElement;
    ta.value = '截图里是否出现了红色的错误提示？';
    click(mount.querySelector('[data-action="save-edit"]'));
    const step = shell.getScript().steps[0] as Step;
    expect(step.params?.assertion?.kind).toBe('visionPrompt');
    expect(step.params?.assertion?.value).toBe('截图里是否出现了红色的错误提示？');
  });

  it('visionPrompt 不显示点选块（它判定的是截图，不是某个元素）', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    expect(mount.querySelector('[data-assert-slot="pick"]')).toBeFalsy();
  });

  it('切回 textContains 时提示词框变回普通输入（不残留 textarea）', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'textContains');
    const el = mount.querySelector('[data-edit-field="assertion.value"]');
    expect(el?.tagName.toLowerCase()).toBe('input');
  });

  it('visionPrompt 显示配置 apikey 的引导入口', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    const hint = mount.querySelector('[data-vision-key-hint]');
    expect(hint).toBeTruthy();
  });

  it('apikey 引导文案指明环境变量名，且不把任何密钥写进脚本', () => {
    const { shell, mount } = boot(assertScript());
    openEdit(mount, 'a');
    setSelect(mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement, 'visionPrompt');
    const hint = mount.querySelector('[data-vision-key-hint]');
    expect(hint?.textContent ?? '').toMatch(/VISION_API_KEY/);
    const json = JSON.stringify(shell.getScript());
    expect(json).not.toMatch(/sk-|apiKey|Bearer/i);
  });

  it('非 visionPrompt 的断言不显示 apikey 引导（避免噪音）', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    expect(mount.querySelector('[data-vision-key-hint]')).toBeFalsy();
  });

  it('断言标签里 visionPrompt 有中文说明（不是裸 kind 名）', () => {
    const { mount } = boot(assertScript());
    openEdit(mount, 'a');
    const sel = mount.querySelector('[data-edit-field="assertion.kind"]') as HTMLSelectElement;
    const opt = Array.from(sel.options).find((o) => o.value === 'visionPrompt');
    expect(opt?.textContent ?? '').toMatch(/视觉|提示词|截图/);
  });
});
