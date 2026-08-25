// @vitest-environment jsdom
// 关键补强（暴露盲区后的强制防护，见 CODEBUDDY.md §4.1）：
// 此前 8 个 UI e2e case 全部用 bootShell() 直接 new UiShell() ，
// **绕过了真实浏览器入口 app.ts 的 boot()**。用户实际打开的是经 app.ts 启动的页面，
// 而测试从未执行过 app.ts —— 这正是「测试全绿、浏览器点不动」的盲区来源。
//
// 本文件在 import app.ts 之前先就位 #app 挂载点（贴近真实浏览器：
// script type=module 执行时 DOM 已就绪），真正执行 boot()，再验证：
//   1) 操作栏/开始录制按钮确实被渲染（boot 没静默失败）；
//   2) 点击「开始录制」触发录制态（header 显示「录制中」）；
//   3) 再次点击停止录制，态复位。
// 禁止再用内部 API 直调冒充用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('app.ts boot() 真实入口（用户实际打开的页面）', () => {
  beforeEach(() => {
    // 真实浏览器里 <script type=module> 在 DOM 解析后执行，#app 已存在。
    // 必须在 import app.ts 之前就位，否则 boot() 即时执行时 getElementById('app') 为 null。
    // 先清空 body：app.ts 的 boot() 用 document.getElementById('app') 取挂载点，
    // 多 case 累积多个 #app 会导致取到旧的、已脱离当前测试的节点（测试隔离陷阱）。
    // vi.resetModules：ESM import 有缓存，不 reset 则仅首个 case 真正执行 boot()。
    document.body.innerHTML = '';
    vi.resetModules();
    const mount = document.createElement('div');
    mount.id = 'app';
    document.body.appendChild(mount);
  });

  it('boot() 渲染出操作栏与「开始录制」按钮（入口未静默失败）', async () => {
    await import('../src/ui/app');
    // 给模块顶层 boot() 一个微任务窗口
    await new Promise((r) => setTimeout(r, 50));

    const actions = document.querySelector('[data-actions]');
    expect(actions).toBeTruthy();
    const recBtn = document.querySelector('[data-action="toggle-record"]');
    expect(recBtn).toBeTruthy();
    expect(recBtn!.textContent).toContain('开始录制');
  });

  it('点击「开始录制」→ 录入态生效（header 显示「录制中」），再次点击复位', async () => {
    await import('../src/ui/app');
    await new Promise((r) => setTimeout(r, 50));

    // 关键：每次点击前都重新 query 按钮。render() 会 innerHTML='' 重建 DOM，
    // 旧引用已脱离文档树，在其上派发事件不会冒泡到 mount 委托（这是测试陷阱，非产品 bug）。
    const recBtn = () => document.querySelector('[data-action="toggle-record"]') as HTMLElement;
    const dot = () => document.querySelector('.rec-dot');

    expect(dot()?.classList.contains('on')).toBe(false);

    recBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(dot()?.classList.contains('on')).toBe(true);
    expect(document.querySelector('.ui-shell-header')?.textContent).toContain('录制中');
    // 演示模式未连接真机时，应给出「录制不会产生真实步骤」的明确提示（而非静默失效）。
    expect(document.querySelector('[data-banner]')?.textContent).toContain('演示模式');

    // 再次点击 → 停止录制，态复位（用当前文档中的真实按钮引用）
    recBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(dot()?.classList.contains('on')).toBe(false);
  });

  it('演示模式（默认无 ?live）启动即展示模式说明横幅', async () => {
    await import('../src/ui/app');
    await new Promise((r) => setTimeout(r, 50));
    const banner = document.querySelector('[data-banner]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('演示模式');
  });
});
