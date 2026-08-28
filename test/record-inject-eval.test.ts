// @vitest-environment jsdom
// 回归：Playwright page.evaluate 不能把录制注入脚本包成 (() => (expr))()。
// RECORD_INJECT 是两段 IIFE 语句；放进括号表达式会 SyntaxError。
// 旧实现把错误吞在 injectRecorderIntoTargets 的 .catch 里，表现为
// 「开始录制后在靶机操作没有任何步骤」（page 目标走 Playwright evaluate）。

import { describe, it, expect } from 'vitest';
import { RECORD_INJECT, RECORD_DRAIN, PICK_INJECT, asPlaywrightExpression } from '../src/recorder/inject';

describe('录制注入脚本必须能作为完整脚本求值', () => {
  it('包成 (() => (expr))() 会语法错误（这是 page 目标录制失败的根因）', () => {
    expect(() => new Function(`return (() => (${RECORD_INJECT}))()`)()).toThrow(SyntaxError);
    expect(() => new Function(`return (() => (${PICK_INJECT}))()`)()).toThrow(SyntaxError);
  });

  it('按脚本直接求值（类 Runtime.evaluate / page.evaluate(string)）可以安装监听', () => {
    expect(() => new Function(RECORD_INJECT)()).not.toThrow();
    expect(() => new Function(PICK_INJECT)()).not.toThrow();
  });

  it('RECORD_DRAIN 作为表达式求值仍能返回数组', () => {
    new Function(RECORD_INJECT)();
    const buf = new Function(`return (${RECORD_DRAIN})`)();
    expect(Array.isArray(buf)).toBe(true);
  });

  it('contenteditable / role=textbox 的 input 记成 fill', () => {
    new Function(RECORD_INJECT)();
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('aria-label', 'Chat');
    ed.textContent = 'hello';
    document.body.appendChild(ed);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string } }>;
    expect(buf.some((e) => e.type === 'fill' && e.params?.value?.includes('hello'))).toBe(true);
  });

  it('Playwright 表达式模式经 asPlaywrightExpression 能装监听并 drain', () => {
    const install = asPlaywrightExpression(RECORD_INJECT);
    expect(() => new Function(`return ${install}`)()).not.toThrow();
    const drain = asPlaywrightExpression(RECORD_DRAIN);
    const buf = new Function(`return ${drain}`)();
    expect(Array.isArray(buf)).toBe(true);
  });

  it('open shadow 里的按钮点击会记成 click', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Send');
    shadow.appendChild(btn);
    document.body.appendChild(host);
    new Function(RECORD_INJECT)();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; locator?: { name?: string } }>;
    expect(buf.some((e) => e.type === 'click' && e.locator?.name === 'Send')).toBe(true);
  });

  it('textupdate（EditContext 实例派发）记成 fill', () => {
    new Function(RECORD_INJECT)();
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('aria-label', 'Chat');
    // textupdate 由 EditContext 对象派发、不冒泡到 document：必须绑在实例上，
    // 绑在 document 上（旧写法）接不到，于是 EditContext 编辑器的输入一条都录不进来。
    const ec = new EventTarget() as EventTarget & { text: string };
    ec.text = 'final';
    (ed as unknown as { editContext?: unknown }).editContext = ec;
    document.body.appendChild(ed);
    ed.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    ec.dispatchEvent(new Event('textupdate'));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string } }>;
    expect(buf.some((e) => e.type === 'fill' && e.params?.value?.includes('final'))).toBe(true);
  });

  it('submit 记成 click（StepType 没有 submit，回放才能跑）', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    new Function(RECORD_INJECT)();
    const form = document.createElement('form');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Send');
    form.appendChild(btn);
    document.body.appendChild(form);
    form.dispatchEvent(new Event('submit', { bubbles: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string }>;
    expect(buf.some((e) => e.type === 'click')).toBe(true);
    expect(buf.some((e) => e.type === 'submit')).toBe(false);
  });

  it('textarea keydown 记成 fill（部分壳只出按键、不出 input）', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const wrap = document.createElement('div');
    wrap.setAttribute('aria-label', 'notes');
    const ta = document.createElement('textarea');
    ta.value = 'hello from editor';
    wrap.appendChild(ta);
    document.body.appendChild(wrap);
    new Function(RECORD_INJECT)();
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', cancelable: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string }; locator?: { name?: string } }>;
    expect(buf.some((e) => e.type === 'fill' && e.params?.value?.includes('hello from editor'))).toBe(true);
  });

  it('再次注入会刷新 __atgIsHelpName，即使旧会话装过恒 false 的 helper', () => {
    (window as unknown as { __atgInteractive: (el: Element) => boolean }).__atgInteractive = () => true;
    (window as unknown as { __atgIsHelpName: (s: string) => boolean }).__atgIsHelpName = () => false;
    new Function(RECORD_INJECT)();
    const overlay = 'The editor is not accessible. To enable screen reader optimized mode, use Shift+Alt+F1';
    expect((window as unknown as { __atgIsHelpName: (s: string) => boolean }).__atgIsHelpName(overlay)).toBe(true);
    expect((window as unknown as { __atgIsHelpName: (s: string) => boolean }).__atgIsHelpName('Chat')).toBe(false);
  });

  it('负例：overlay 帮助文案不得作为 locator.name，css 仍是事件目标路径', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const overlay = '现在无法访问编辑器。 若要启用屏幕阅读器优化模式，请使用 Shift+Alt+F1';
    const host = document.createElement('div');
    host.id = 'composer';
    const ta = document.createElement('textarea');
    ta.setAttribute('aria-label', overlay);
    ta.value = 'hello chat';
    host.appendChild(ta);
    document.body.appendChild(host);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    const loc = (window as unknown as { __atgLocOf: (el: Element) => { name?: string; css?: string } }).__atgLocOf(ta);
    expect(loc.name ?? '').not.toMatch(/无法访问编辑器|屏幕阅读器|Shift\+Alt\+F1|not accessible/i);
    expect(loc.css).toMatch(/textarea/);
    expect(loc.css).not.toMatch(/interactive-input-part|native-edit-context|monaco-editor/);
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', cancelable: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{
      type: string; locator?: { name?: string; css?: string }; params?: { value?: string };
    }>;
    const fill = buf.find((e) => e.type === 'fill' && (e.params?.value ?? '').includes('hello chat'));
    expect(fill).toBeTruthy();
    expect(fill?.locator?.name ?? '').not.toMatch(/无法访问编辑器|屏幕阅读器|Shift\+Alt\+F1|not accessible/i);
    expect(fill?.params?.value).toContain('hello chat');
  });

  it('同一框连续 keydown 在 drain 前不灌缓冲，drain 只出一步最新值', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    ta.value = 'h';
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'h', cancelable: true }));
    ta.value = 'hi';
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'i', cancelable: true }));
    ta.value = 'hi!';
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '!', cancelable: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string } }>;
    const fills = buf.filter((e) => e.type === 'fill');
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(fills[fills.length - 1].params?.value).toBe('hi!');
  });

  it('空输入框打字：空 fill 丢弃，不成步', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const ta = document.createElement('textarea');
    ta.value = '';
    document.body.appendChild(ta);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', cancelable: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string } }>;
    const fills = buf.filter((e) => e.type === 'fill');
    expect(fills).toHaveLength(0);
  });

  it('点击 role=presentation 内层：走上可交互祖先，不发出 presentation 步', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Send');
    const inner = document.createElement('span');
    inner.setAttribute('role', 'presentation');
    inner.textContent = 'icon';
    btn.appendChild(inner);
    document.body.appendChild(btn);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; locator?: { role?: string; name?: string } }>;
    const clicks = buf.filter((e) => e.type === 'click');
    expect(clicks.every((e) => e.locator?.role !== 'presentation')).toBe(true);
    expect(clicks.some((e) => e.locator?.name === 'Send')).toBe(true);
  });

  it('孤立 presentation 节点的点击不生成步骤', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const deco = document.createElement('div');
    deco.setAttribute('role', 'presentation');
    deco.textContent = 'canvas';
    document.body.appendChild(deco);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    deco.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; locator?: { role?: string } }>;
    expect(buf.some((e) => e.type === 'click' && e.locator?.role === 'presentation')).toBe(false);
  });

  it('两个 textbox 时 fill 绑到事件目标，不绑页面上另一个框', () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const editor = document.createElement('textarea');
    editor.setAttribute('aria-label', 'Editor');
    editor.value = '.reveal.is-off { display: none; } .pager { display: flex; }';
    const chat = document.createElement('textarea');
    chat.setAttribute('aria-label', 'Chat');
    chat.id = 'chat-input';
    chat.value = '你好';
    document.body.appendChild(editor);
    document.body.appendChild(chat);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    chat.dispatchEvent(new Event('input', { bubbles: true }));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{
      type: string; locator?: { name?: string; css?: string }; params?: { value?: string };
    }>;
    const fills = buf.filter((e) => e.type === 'fill');
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(fills.every((e) => !(e.params?.value ?? '').includes('.reveal'))).toBe(true);
    expect(fills.some((e) => (e.params?.value ?? '').includes('你好'))).toBe(true);
    const hi = fills.find((e) => (e.params?.value ?? '').includes('你好'));
    expect(hi?.locator?.name ?? '').not.toBe('Editor');
    expect(hi?.locator?.css ?? '').toMatch(/textarea|#chat-input/);
  });

  it('已有文档的焦点框在无新输入时不会被录成 fill', async () => {
    delete (window as unknown as { __recInstalled?: boolean }).__recInstalled;
    delete (window as unknown as { __atgLocatorHelpers?: boolean }).__atgLocatorHelpers;
    const ta = document.createElement('textarea');
    ta.value = '.reveal.is-off { display: none; }';
    document.body.appendChild(ta);
    new Function(RECORD_INJECT)();
    new Function(`return (${RECORD_DRAIN})`)();
    (window as unknown as { __recActive: boolean }).__recActive = true;
    ta.focus();
    await new Promise((r) => setTimeout(r, 500));
    const buf = new Function(`return (${RECORD_DRAIN})`)() as Array<{ type: string; params?: { value?: string } }>;
    expect(buf.some((e) => e.type === 'fill' && (e.params?.value ?? '').includes('.reveal'))).toBe(false);
  });
});
