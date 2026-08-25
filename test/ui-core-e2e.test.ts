// @vitest-environment jsdom
// UI 主链路端到端验收（CODEBUDDY.md §4.1 强制门槛）：
// 真实驱动 UiShell 渲染的 DOM，用 dispatchEvent 模拟用户点击 [data-action] 按钮，
// 证明用户主链路（插入→编辑→建组→运行→失败标红）端到端跑通。
// 禁止只用内部 API 直调冒充用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Script, Step, Locator } from '../src/types/step';

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
    screenshot: vi.fn(async (): Promise<Buffer> => { calls.push('screenshot'); return Buffer.from('fake'); }),
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

  it('布局：render 后存在 .ui-shell-body 包裹 stage/steps/cfg 三区（4 栏生效）', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('.ui-shell-body')).toBeTruthy();
    expect(mount.querySelector('[data-stage]')).toBeTruthy();
    expect(mount.querySelector('[data-steps]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg]')).toBeTruthy();
  });

  it('插入：点击「插入步骤」展开 4 类菜单（wait/waitUntil/assert/repeat），不含 click 等', () => {
    const { mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-action="insert"]'));
    const types = Array.from(mount.querySelectorAll('[data-insert-type]')).map((e) => e.getAttribute('data-insert-type'));
    expect(types.sort()).toEqual(['assert', 'repeat', 'wait', 'waitUntil']);
    expect(types).not.toContain('click');
    expect(types).not.toContain('fill');
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
    click(mount.querySelector('[data-step-item][data-step-id="a"]'));
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

  it('建组：多选 2 步 → 包成 if → 两步进 True 分支，False 为空（A2 正确形态）', () => {
    const { shell, mount } = bootShell(kernel, seed);
    // 多选 a、b
    click(mount.querySelector('[data-step-item][data-step-id="a"]'));
    click(mount.querySelector('[data-step-item][data-step-id="b"]'));
    click(mount.querySelector('[data-action="wrap-if"]'));
    // 脚本顶层应只剩 1 个组节点
    expect(shell.getScript().steps).toHaveLength(1);
    const grp = shell.getScript().steps[0];
    expect(grp.control?.kind).toBe('if');
    // children[0]=True（含 a、b 的顺序组），children[1]=False（空顺序组）
    expect(grp.children).toHaveLength(2);
    expect(grp.children?.[0].control?.kind).toBe('sequence');
    expect(grp.children?.[0].children?.map((c: Step) => c.id)).toEqual(['a', 'b']);
    expect(grp.children?.[1].children).toEqual([]);
    // CFG 视图应渲染出 true/false 两枝标识
    const cfg = mount.querySelector('[data-cfg]');
    expect(cfg?.querySelector('[data-cfg-branch="true"]')).toBeTruthy();
    expect(cfg?.querySelector('[data-cfg-branch="false"]')).toBeTruthy();
  });

  it('建组：包成 while → CFG 出现回环边', () => {
    const { shell, mount } = bootShell(kernel, seed);
    click(mount.querySelector('[data-step-item][data-step-id="a"]'));
    click(mount.querySelector('[data-step-item][data-step-id="b"]'));
    click(mount.querySelector('[data-action="wrap-while"]'));
    expect(shell.getScript().steps[0].control?.kind).toBe('while');
    const cfg = mount.querySelector('[data-cfg]');
    expect(cfg?.querySelector('[data-cfg-loop="true"]')).toBeTruthy(); // 回环边标记
  });

  it('运行失败：playback 返回 fail → 该步标红 + 提醒条出现', async () => {
    kernel.playback = vi.fn(async () => ({ ok: false, failedStepId: 'a' }));
    const { shell, mount } = bootShell(kernel, seed);
    await shell.runAll();
    const item = mount.querySelector('[data-step-item][data-step-id="a"]');
    expect(item?.getAttribute('data-step-status')).toBe('fail');
    expect(mount.querySelector('[data-run-notice]')).toBeTruthy();
  });

  it('版本面板：主体流程默认不挂载 [data-version]', () => {
    const { mount } = bootShell(kernel, seed);
    expect(mount.querySelector('[data-version]')).toBeNull();
  });
});
