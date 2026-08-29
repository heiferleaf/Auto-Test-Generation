// @vitest-environment jsdom
// 导入/连接**不再**补拍逐步截图：截图改到执行该步之前再拍（与录制语义一致），
// 逐步拍的契约见 test/shot-timing.test.ts。
// 本文件守的是：任何时刻导入都不拍（这是"未连接时不拍"约定在新语义下的延续），
// 只有脚本自带的可选 shots / 侧车 *.shots.json 才会在导入时进 getStepShots。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import type { Script } from '../src/types/step';

const AGENT_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures/agent-generated-vscode.json'),
  'utf8',
);

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
    screenshot: vi.fn(async () => Buffer.from('PNG-BYTES-FOR-IMPORT-SHOT')),
    locateVisual: vi.fn(async () => ({
      x: 10, y: 20, width: 30, height: 12, visible: true, inViewport: true,
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

describe('导入脚本后补截图流（§2.9）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('未连接时导入无配图的 Agent JSON：getStepShots 为空，不调 screenshot', () => {
    const kernel = makeKernel();
    const { shell } = boot(kernel);
    shell.importScript(AGENT_JSON);
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('未连接时导入带 shots 的 JSON：getStepShots 有图，舞台能显示，不调 screenshot', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const json = JSON.stringify({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      shots: { 's1': `data:image/png;base64,${tiny}` },
      steps: [{ id: 's1', type: 'click', source: 'agent', locator: { name: 'Go' } }],
    });
    shell.importScript(json);
    expect(kernel.screenshot).not.toHaveBeenCalled();
    expect(shell.getStepShots()['s1']).toBe(tiny);
    click(mount.querySelector('[data-cfg-node="s1"]'));
    const img = mount.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    expect(img?.src).toContain(tiny);
  });

  it('侧车 *.shots.json 与脚本一起导入也能灌进 getStepShots', () => {
    const kernel = makeKernel();
    const { shell } = boot(kernel);
    const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const json = JSON.stringify({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{ id: 's1', type: 'wait', source: 'agent', params: { durationMs: 10 } }],
    });
    shell.importScript(json, JSON.stringify({ shots: { s1: tiny } }));
    expect(shell.getStepShots()['s1']).toBe(tiny);
  });

  it('已连接时导入带 locator 的 Agent 脚本：一张都不拍（截图留到执行该步之前再拍）', async () => {
    const kernel = makeKernel();
    const { shell } = boot(kernel);
    await shell.connect();
    shell.importScript(AGENT_JSON);
    // 让任何"导入即拍"的异步尾巴都跑完，再断言确实没拍
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('先导入再连接：连接后同样不补拍（截图时机只跟执行走）', async () => {
    const kernel = makeKernel();
    const { shell } = boot(kernel);
    shell.importScript(AGENT_JSON);
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    await shell.connect();
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(shell.getStepShots())).toEqual([]);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });

  it('导出 JSON 含可选 shots 根字段，步骤上仍没有 png', async () => {
    const kernel = makeKernel();
    const { shell } = boot(kernel);
    await shell.connect();
    const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    shell.importScript(AGENT_JSON, JSON.stringify({ shots: { 'agent-fill-chat': tiny } }));
    const exported = JSON.parse(shell.exportScript()) as Script & { shots?: Record<string, string> };
    expect(exported.shots?.['agent-fill-chat']).toMatch(/base64/i);
    expect(exported.steps.every((s) => !('png' in s) && !('shots' in s))).toBe(true);
    expect(kernel.screenshot).not.toHaveBeenCalled();
  });
});

describe('textContains 无 locator：详情文案不是「尚未选取」', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('waitUntil textContains 无 locator → 「整页文本，无需点选」', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{
        id: 'agent-wait-token',
        type: 'waitUntil',
        source: 'agent',
        params: { timeoutMs: 20000, assertion: { kind: 'textContains', value: 'atg-agent-0827' } },
        control: { kind: 'sequence', name: '等待出现 atg-agent-0827' },
      }],
    };
    const { mount } = boot(makeKernel(), s);
    click(mount.querySelector('[data-cfg-node="agent-wait-token"]'));
    click(mount.querySelector('[data-action="edit"]'));
    const encap = mount.querySelector('[data-locator-human]');
    expect(encap?.textContent).toBe('整页文本，无需点选');
    expect(encap?.textContent).not.toBe('尚未选取');
  });

  it('waitUntil visible 无 locator → 仍是「尚未选取」（元素类必须点选）', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{
        id: 'w',
        type: 'waitUntil',
        source: 'manual',
        params: { timeoutMs: 5000, assertion: { kind: 'visible' } },
      }],
    };
    const { mount } = boot(makeKernel(), s);
    click(mount.querySelector('[data-cfg-node="w"]'));
    click(mount.querySelector('[data-action="edit"]'));
    expect(mount.querySelector('[data-locator-human]')?.textContent).toBe('尚未选取');
  });
});
