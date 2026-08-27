// @vitest-environment jsdom
// 定位展示：给人看 role + name + 截断 css；空 name 不得只渲染成 <textbox>。
// CFG 卡片与详情区共用 describeLocator，改一处两处跟随。

import { describe, it, expect } from 'vitest';
import { describeLocator, describeStepBrief, truncateCss } from '../src/ui/step-label';
import { CfgView } from '../src/ui/cfg-view';
import { UiShell } from '../src/ui/shell';
import type { Script, Step } from '../src/types/step';
import { vi } from 'vitest';

const longCss = 'html > body > div.monaco-workbench > div.part > textarea.inputarea';

describe('truncateCss', () => {
  it('短 css 原样返回', () => {
    expect(truncateCss('div > input')).toBe('div > input');
  });

  it('长 css 截断并保留首尾', () => {
    const s = truncateCss(longCss, 24);
    expect(s.length).toBeLessThan(longCss.length);
    expect(s).toContain('…');
    expect(s.startsWith('html')).toBe(true);
    expect(s.endsWith('inputarea')).toBe(true);
  });
});

describe('describeLocator：role + name + 截断 css', () => {
  it('同时有 role/name/css 时拼成一句人话，name 用方括号', () => {
    const text = describeLocator({
      role: 'button', name: '确定', css: longCss,
    });
    expect(text).toContain('button');
    expect(text).toContain('[确定]');
    expect(text).toContain('…');
    expect(text).not.toContain(longCss);
  });

  it('空 name 的 textbox 不渲染成只有 <textbox>', () => {
    const text = describeLocator({ role: 'textbox', name: '', css: 'div.foo > textarea' });
    expect(text).not.toMatch(/^<textbox>\s*$/);
    expect(text).not.toContain('<textbox>');
    expect(text).toContain('textbox');
    expect(text).toContain('textarea');
  });

  it('只有 role、没有 name/css 时仍用人话 role，不用尖括号标签', () => {
    expect(describeLocator({ role: 'textbox' })).toBe('textbox');
    expect(describeLocator({ role: 'textbox' })).not.toContain('<');
  });

  it('空白 name 当作没有 name', () => {
    const text = describeLocator({ role: 'textbox', name: '   ', css: 'input.search' });
    expect(text).not.toContain('[   ]');
    expect(text).toContain('textbox');
    expect(text).toContain('input.search');
  });
});

describe('CFG 步骤卡片上的定位文案', () => {
  it('卡片显示 role + [name] + 截断 css，不是 <textbox>', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    const step: Step = {
      id: 'a', type: 'click', source: 'manual',
      locator: { role: 'textbox', name: '', css: longCss },
    };
    view.update({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [step],
    });
    const card = host.querySelector('[data-cfg-node="a"] [data-locator-text]');
    const text = card?.textContent ?? '';
    expect(text).toContain('textbox');
    expect(text).not.toMatch(/<textbox>/);
    expect(text).toContain('…');
  });

  it('有 name 时卡片是「点击 [搜索框]」这种封装，不把整串 css 甩上节点', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{
        id: 'a', type: 'click', source: 'manual',
        locator: { role: 'button', name: '搜索框', css: longCss },
      }],
    });
    const text = host.querySelector('[data-cfg-node="a"]')?.textContent ?? '';
    expect(text).toContain('[搜索框]');
    expect(text).not.toContain(longCss);
    expect(describeStepBrief({
      id: 'a', type: 'click', source: 'manual',
      locator: { role: 'button', name: '搜索框', css: longCss },
    })).toMatch(/点击.*\[搜索框\]/);
  });
});

describe('详情区：封装名 + 可展开编辑 css', () => {
  it('选中步骤后详情显示人话定位，css 在可展开字段里可编辑保存', () => {
    const kernel = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      listTargets: vi.fn(() => []),
      selectTarget: vi.fn(),
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      select: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      eval: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => []),
      query: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from('x')),
      locateVisual: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true })),
      startRecording: vi.fn(),
      stopRecording: vi.fn(async () => []),
      playback: vi.fn(async () => ({ ok: true })),
      on: vi.fn(),
      off: vi.fn(),
    };
    const script: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'T' },
      steps: [{
        id: 'a', type: 'click', source: 'manual',
        locator: { role: 'textbox', name: '', css: 'div.foo > textarea' },
      }],
    };
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const shell = new UiShell({ kernel: kernel as never, mount, script });
    shell.render();
    const node = mount.querySelector('[data-cfg-node="a"]') as HTMLElement;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    mount.querySelector('[data-action="edit"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const human = mount.querySelector('[data-locator-human]')?.textContent ?? '';
    expect(human).toContain('textbox');
    expect(human).not.toMatch(/^<textbox>\s*$/);
    expect(mount.querySelector('[data-locator-path]')).toBeTruthy();
    const cssInput = mount.querySelector('[data-edit-field="locator.css"]') as HTMLInputElement;
    expect(cssInput).toBeTruthy();
    expect(cssInput.value).toBe('div.foo > textarea');
    cssInput.value = 'input.bar';
    mount.querySelector('[data-action="save-edit"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.getScript().steps[0].locator?.css).toBe('input.bar');
  });
});
