// @vitest-environment jsdom
// 真机反馈落地：打包就位、fill 不丢、详情不重复设 kind、步骤截图、叶子不套「顺序组」外壳。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { ScriptEditor } from '../src/editor/editor';
import { buildCfgGraph } from '../src/ui/cfg-view';
import { runScript, AssertionError } from '../src/executor/executor';
import type { Script, Step } from '../src/types/step';
import type { CdpAdapter } from '../src/cdp/adapter';
import { RECORD_INJECT } from '../src/recorder/inject';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    locateVisual: vi.fn(async () => ({
      x: 10, y: 20, width: 30, height: 12, visible: true, inViewport: true,
      viewportWidth: 800, viewportHeight: 400, devicePixelRatio: 1,
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
    emit(event: string, data: unknown) {
      listeners[event]?.forEach((cb) => cb(data));
    },
  };
}

const leaf = (id: string, type: Step['type'] = 'click'): Step => ({
  id, type, source: 'manual', locator: { name: id },
  ...(type === 'fill' ? { params: { value: 'x' } } : {}),
});

function click(el: Element | null) {
  if (!el) throw new Error('missing click target');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('打包就位', () => {
  it('包中间两步时新组插在原位，第一步仍是未选中的 a', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [leaf('a'), leaf('b'), leaf('c'), leaf('d')],
    };
    const out = ScriptEditor.wrap(s, ['b', 'c'], 'sequence');
    expect(out.steps.map((x) => x.control?.kind ?? x.id)).toEqual(['a', 'sequence', 'd']);
    expect(out.steps[1].children?.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('用户多选中间两步再打包：新组留在原位，选中态在新组', () => {
    const kernel = makeKernel();
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const script: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [leaf('a'), leaf('b'), leaf('c'), leaf('d')],
    };
    const shell = new UiShell({ kernel, mount, script });
    shell.render();
    vi.spyOn(window, 'prompt').mockReturnValue('中间组');
    mount.querySelector('[data-cfg-node="b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    mount.querySelector('[data-cfg-node="c"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    click(mount.querySelector('[data-action="wrap-sequence"]'));
    expect(mount.querySelector('[data-pack-name]')).toBeNull();
    expect(shell.getScript().steps[0].id).toBe('a');
    expect(shell.getScript().steps[1].control?.kind).toBe('sequence');
    expect(shell.getScript().steps[2].id).toBe('d');
    expect(shell.getSelectedStepId()).toBe(shell.getScript().steps[1].id);
    expect(mount.querySelector(`[data-cfg-node="${shell.getSelectedStepId()}"]`)?.getAttribute('data-cfg-selected')).toBe('true');
  });
});

describe('fill 最终值保留', () => {
  it('点一下再打字：fill 不被 click 的去重吃掉；连续输入坍成最终值', async () => {
    const kernel = makeKernel();
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const shell = new UiShell({ kernel, mount });
    await shell.startRecording();
    kernel.emit('recording', { type: 'click', locator: { name: 'chat' } });
    kernel.emit('recording', { type: 'fill', locator: { name: 'chat' }, params: { value: '你' } });
    kernel.emit('recording', { type: 'fill', locator: { name: 'chat' }, params: { value: '你好' } });
    kernel.emit('recording', { type: 'click', locator: { name: 'send' } });
    kernel.emit('recording', { type: 'fill', locator: { name: 'chat' }, params: { value: '第二句' } });
    const fills = shell.getScript().steps.filter((s) => s.type === 'fill');
    expect(fills.map((s) => s.params?.value)).toEqual(['你好', '第二句']);
    expect(shell.getScript().steps.some((s) => s.type === 'click' && s.locator?.name === 'send')).toBe(true);
  });
});

describe('详情区不重复设 kind / 无从此处运行', () => {
  it('选中组后详情没有设为选择组/循环组，底部操作栏仍有', () => {
    const kernel = makeKernel();
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] },
      ['a', 'b'], 'sequence',
    );
    packed.steps[0].id = 'g';
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const shell = new UiShell({ kernel, mount, script: packed });
    shell.render();
    click(mount.querySelector('[data-cfg-node="g"]'));
    const detail = mount.querySelector('[data-detail]');
    expect(detail?.querySelector('[data-action="set-group-kind"]')).toBeNull();
    expect(detail?.querySelector('[data-action="run-from"]')).toBeNull();
    expect(detail?.querySelector('[data-action="wrap-if"]')).toBeNull();
    expect(detail?.querySelector('[data-action="wrap-while"]')).toBeNull();
    expect(mount.querySelector('[data-actions] [data-action="wrap-if"]')).toBeNull();
    expect(mount.querySelector('[data-actions] [data-action="wrap-while"]')).toBeNull();
  });
});

describe('步骤截图，不实时刷帧', () => {
  it('连接并录制一步后舞台出现该步 img，boot 默认不 startFrameStream', async () => {
    const kernel = makeKernel();
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const shell = new UiShell({ kernel, mount });
    await shell.connect();
    shell.render();
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeNull();
    await shell.startRecording();
    kernel.emit('recording', { type: 'click', locator: { name: 'Explorer' } });
    await vi.waitFor(() => {
      expect(Object.keys(shell.getStepShots()).length).toBeGreaterThan(0);
    });
    const id = shell.getScript().steps[0].id;
    shell.selectStep(id);
    const img = mount.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    expect(img?.src).toContain('base64');
  });

  it('选中没有截图的步骤时清掉上一张图，提示该步尚无截图', async () => {
    const kernel = makeKernel();
    // 连接后会给已有叶子补拍；这里先让补拍失败，才能留下「尚无截图」的步。
    kernel.screenshot.mockRejectedValue(new Error('no-frame'));
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const script: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [leaf('a'), leaf('b')],
    };
    const shell = new UiShell({ kernel, mount, script });
    await shell.connect();
    await vi.waitFor(() => {
      expect(kernel.screenshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    kernel.screenshot.mockReset();
    kernel.screenshot.mockResolvedValue(Buffer.from('PNG-BYTES-FOR-STEP-SHOT'));
    await shell.startRecording();
    kernel.emit('recording', { type: 'click', locator: { name: 'a' } });
    await vi.waitFor(() => {
      expect(Object.keys(shell.getStepShots()).length).toBeGreaterThan(0);
    });
    const recordedId = [...Object.keys(shell.getStepShots())][0];
    shell.selectStep(recordedId);
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeTruthy();
    shell.selectStep('b');
    expect(mount.querySelector('img.ui-shell-frame-img')).toBeNull();
    expect(mount.querySelector('[data-frame]')?.textContent).toContain('该步尚无截图');
    expect(mount.querySelector('[data-highlight]')).toBeNull();
  });
});

describe('叶子不画「点击 · 顺序组」套娃', () => {
  it('原子 click 节点文本不含「· 顺序组」', () => {
    const kernel = makeKernel();
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const script: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [{ id: 'a', type: 'click', source: 'manual', locator: { name: 'Explorer' }, control: { kind: 'sequence', name: '点击 "Explorer"' } }],
    };
    new UiShell({ kernel, mount, script }).render();
    const node = mount.querySelector('[data-cfg-node="a"]');
    expect(node?.textContent).not.toMatch(/· 顺序组/);
    expect(node?.textContent).toMatch(/Explorer/);
  });
});

describe('选择/断言/循环可执行', () => {
  it('if 条件成立跑 True；while 按次数跑；assert 失败抛错', async () => {
    const calls: string[] = [];
    const adapter = {
      async connect() {}, async disconnect() {},
      listTargets: () => [],
      selectTarget() {},
      async click(l: { name?: string }) { calls.push('click:' + (l.name ?? '')); },
      async fill() {}, async select() {}, async hover() {},
      async wait() { calls.push('wait'); },
      async eval() { return true; },
      async snapshot() { return []; },
      async query() { return { visible: true, exists: true, text: 'ok' }; },
      async pageText() { return null; },
    } as unknown as CdpAdapter;

    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'vscode' },
      steps: [
        {
          id: 'g-if', type: 'assert', source: 'manual',
          control: { kind: 'if' },
          children: [{
            id: 'true', type: 'wait', source: 'manual', control: { kind: 'sequence' },
            children: [{ id: 't1', type: 'click', source: 'manual', locator: { name: 'Open Folder' } }],
          }],
        },
        {
          id: 'g-w', type: 'wait', source: 'manual',
          control: { kind: 'while', loopCount: 2 },
          children: [{ id: 'w1', type: 'click', source: 'manual', locator: { name: 'Refresh' } }],
        },
      ],
    };
    await runScript(adapter, script);
    expect(calls.filter((c) => c.startsWith('click:Open'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('click:Refresh'))).toHaveLength(2);

    const g = buildCfgGraph(script);
    expect(g.edges).toContainEqual({ from: 'g-if', to: 'true', kind: 'true' });
    expect(g.edges).not.toContainEqual({ from: 'true', to: 'g-w', kind: 'true' });

    const failing: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'vscode' },
      steps: [{
        id: 'bad', type: 'assert', source: 'manual',
        params: { assertion: { kind: 'visible', locator: { name: 'Nope' } } },
      }],
    };
    await expect(runScript(adapter, failing)).rejects.toBeInstanceOf(AssertionError);
  });
});

describe('录制注入覆盖 contenteditable / iframe / shadow', () => {
  it('RECORD_INJECT 含 beforeinput、iframe、contenteditable、textupdate 与 shadow 绑定', () => {
    expect(RECORD_INJECT).not.toMatch(/monaco-mouse-cursor-text|interactive-input-part|native-edit-context/);
    expect(RECORD_INJECT).toMatch(/beforeinput/);
    expect(RECORD_INJECT).toMatch(/iframe/);
    expect(RECORD_INJECT).toMatch(/contenteditable/);
    expect(RECORD_INJECT).toMatch(/textupdate/);
    expect(RECORD_INJECT).toMatch(/shadowRoot/);
    expect(RECORD_INJECT).toMatch(/composedPath/);
  });

  it('webview 注入失败不得写入 injectedTargets（iframe 要能重试）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../src/cdp/adapter.ts'), 'utf8');
    expect(src).toMatch(/\.then\(\(\) => \{\s*this\.injectedTargets\.add\(t\.info\.id\)/);
    expect(src).toMatch(/injectRecorderIntoTargets\(\)/);
  });
});
