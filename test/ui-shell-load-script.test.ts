// @vitest-environment jsdom
// 内核 loadScript：把 Script JSON 推进当前工作台会话（将来 MCP script.open 的前置）。
// 不是替代导入按钮——导入仍走文件选择；本方法是对话/桥推入同一套 CFG。
// 自带 mock，不改 ui-shell.test.ts 基建。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { SCRIPT_SCHEMA, type Script } from '../src/types/step';

const AGENT_IF_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures/agent-generated-if.json'),
  'utf8',
);

const TINY =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type AnyKernel = {
  listeners: Record<string, Set<(d: unknown) => void>>;
  [k: string]: unknown;
};

function makeKernel(): AnyKernel {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  return {
    listeners,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): unknown[] => [{ id: 'main', type: 'page', title: '主窗口' }]),
    selectTarget: vi.fn(),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('png')),
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

function boot(kernel: AnyKernel, script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel: kernel as never, mount, script });
  shell.render();
  return { shell, mount };
}

const ifScript: Script = {
  schema: SCRIPT_SCHEMA,
  app: { name: 'LoadScriptDemo', version: '1' },
  note: 'if treeitem settings.json then click else wait',
  steps: [
    {
      id: 'agent-if',
      type: 'assert',
      source: 'agent',
      control: {
        kind: 'if',
        name: '资源管理器是否有 settings.json',
        condition: { kind: 'exists', locator: { role: 'treeitem', name: 'settings.json' } },
      },
      children: [
        {
          id: 'agent-if-true',
          type: 'click',
          source: 'agent',
          control: { kind: 'sequence', name: 'True' },
          children: [{
            id: 'agent-if-true-click',
            type: 'click',
            source: 'agent',
            locator: { role: 'treeitem', name: 'settings.json' },
            control: { kind: 'sequence', name: 'True：点击 settings.json' },
          }],
        },
        {
          id: 'agent-if-false',
          type: 'wait',
          source: 'agent',
          control: { kind: 'sequence', name: 'False' },
          children: [{
            id: 'agent-if-false-wait',
            type: 'wait',
            source: 'agent',
            params: { durationMs: 200 },
            control: { kind: 'sequence', name: 'False：等待 200ms' },
          }],
        },
      ],
    },
  ],
  shots: { 'agent-if-true-click': TINY, 'agent-if-false-wait': TINY },
};

describe('UiShell.loadScript 推进当前工作台 CFG', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('loadScript(对象) 渲染 if CFG：条件是 treeitem settings.json，不是菜单「文件」', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    shell.loadScript(ifScript);
    expect(mount.querySelector('[data-cfg-node="agent-if"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-kind="if"]')).toBeTruthy();
    expect(mount.textContent).toMatch(/settings\.json/);
    expect(mount.textContent).not.toMatch(/是否出现「文件」/);
    expect(mount.querySelector('[data-cfg-node="agent-if-true-click"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-node="agent-if-false-wait"]')).toBeTruthy();
    expect(shell.getStepShots()['agent-if-true-click']).toBeTruthy();
  });

  it('loadScript(JSON 字符串) 与对象路径等价，shots 进舞台', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    shell.loadScript(JSON.stringify(ifScript));
    expect(mount.querySelector('[data-cfg-kind="if"]')).toBeTruthy();
    expect(shell.getStepShots()['agent-if-false-wait']).toBeTruthy();
  });

  it('桥推送 load-script 事件时内核同样渲染 CFG（MCP script.open 的会话入口）', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    const set = kernel.listeners['load-script'];
    expect(set && set.size).toBeGreaterThan(0);
    for (const cb of set) cb(ifScript);
    expect(mount.querySelector('[data-cfg-node="agent-if"]')).toBeTruthy();
    expect(mount.textContent).toMatch(/settings\.json/);
  });

  it('loadScript 夹具 agent-generated-if：CFG 有 if，True 是点击 settings.json', () => {
    const kernel = makeKernel();
    const { shell, mount } = boot(kernel);
    shell.loadScript(AGENT_IF_JSON);
    expect(mount.querySelector('[data-cfg-node="agent-if"]')).toBeTruthy();
    expect(mount.querySelector('[data-cfg-node="agent-if-true-click"]')).toBeTruthy();
    expect(mount.textContent).toMatch(/settings\.json/);
    expect(shell.getStepShots()['agent-if-true-click']).toBeTruthy();
  });

  it('null 入参不白屏：横幅报错，CFG 保持可渲染', () => {
    const kernel = makeKernel();
    const { mount } = boot(kernel);
    expect(() => {
      for (const cb of kernel.listeners['load-script'] ?? []) cb(null);
    }).not.toThrow();
    expect(mount.querySelector('[data-cfg-empty], [data-cfg-node], .ui-shell-cfg-tree')).toBeTruthy();
    expect(mount.textContent).toMatch(/无法载入|schema/i);
  });
});
