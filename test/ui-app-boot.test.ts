// @vitest-environment jsdom
// 关键补强（暴露盲区后的强制防护，见 CODEBUDDY.md §4.1）：
// 此前 8 个 UI e2e case 全部用 bootShell() 直接 new UiShell() ，
// **绕过了真实浏览器入口 app.ts 的 boot()**。用户实际打开的是经 app.ts 启动的页面，
// 而测试从未执行过 app.ts —— 这正是「测试全绿、浏览器点不动」的盲区来源。
//
// 本文件在 import app.ts 之前先就位 #app 挂载点（贴近真实浏览器：
// script type=module 执行时 DOM 已就绪），真正执行 boot()，覆盖两条用户真实路径：
//   A) 默认模式（连真机）：无靶机时降级横幅 + 点击录制不进入态（正确降级，非崩溃）；
//   B) ?demo=1 显式演示：DemoKernel，点击录制进入态、再点复位。
// 禁止再用内部 API 直调冒充用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom 的 WebSocket 会真去连 localhost:5173/kernel-ws 并失败（行为不确定/慢）。
// 这里 mock 成一个「构造即 onerror」的实现，让默认模式的「连不上靶机」降级路径确定可测。
class MockWebSocket {
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(_url: string) {
    // 下一个 tick 触发 onerror，模拟「靶机未启动、WS 连接失败」
    setTimeout(() => this.onerror?.(new Error('mock ws connect failed')), 0);
  }
  send() {}
  close() {}
}

describe('app.ts boot() 真实入口（用户实际打开的页面）', () => {
  beforeEach(() => {
    // 真实浏览器里 <script type=module> 在 DOM 解析后执行，#app 已存在。
    // 必须在 import app.ts 之前就位，否则 boot() 即时执行时 getElementById('app') 为 null。
    // 先清空 body：app.ts 的 boot() 用 document.getElementById('app') 取挂载点，
    // 多 case 累积多个 #app 会导致取到旧的、已脱离当前测试的节点（测试隔离陷阱）。
    // vi.resetModules：ESM import 有缓存，不 reset 则仅首个 case 真正执行 boot()。
    document.body.innerHTML = '';
    vi.resetModules();
    (globalThis as any).WebSocket = MockWebSocket;
    const mount = document.createElement('div');
    mount.id = 'app';
    document.body.appendChild(mount);
  });

  it('默认模式：boot 渲染操作栏+开始录制按钮，无靶机时降级横幅（不崩溃）', async () => {
    await import('../src/ui/app');
    await new Promise((r) => setTimeout(r, 50));

    const actions = document.querySelector('[data-actions]');
    expect(actions).toBeTruthy();
    const recBtn = document.querySelector('[data-action="toggle-record"]');
    expect(recBtn).toBeTruthy();
    expect(recBtn!.textContent).toContain('开始录制');

    // 无靶机（mock WS 连不上）→ 应出现「未连接靶机」降级横幅，而非静默或崩溃。
    const banner = document.querySelector('[data-banner]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('未连接靶机');
  });

  it('默认模式：点开始录制因未连真机而不进入录制态（降级提示，非失败崩溃）', async () => {
    await import('../src/ui/app');
    await new Promise((r) => setTimeout(r, 50));

    const recBtn = () => document.querySelector('[data-action="toggle-record"]') as HTMLElement;
    const dot = () => document.querySelector('.rec-dot');

    expect(dot()?.classList.contains('on')).toBe(false);
    recBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    // 未连真机：startRecording 应被 try/catch 拦下，不进入录制态；banner 变「录制失败」提示。
    expect(dot()?.classList.contains('on')).toBe(false);
    expect(document.querySelector('[data-banner]')?.textContent).toContain('录制失败');
  });

  it('?demo=1：演示内核，点击开始录制进入态、再次点击复位', async () => {
    // 模拟 ?demo=1：在 import 前改写 location.search
    (globalThis as any).location = { ...(globalThis as any).location, search: '?demo=1' };
    await import('../src/ui/app');
    await new Promise((r) => setTimeout(r, 50));

    const banner = document.querySelector('[data-banner]');
    expect(banner?.textContent).toContain('演示模式');

    const recBtn = () => document.querySelector('[data-action="toggle-record"]') as HTMLElement;
    const dot = () => document.querySelector('.rec-dot');

    expect(dot()?.classList.contains('on')).toBe(false);
    recBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(dot()?.classList.contains('on')).toBe(true);
    expect(document.querySelector('.ui-shell-header')?.textContent).toContain('录制中');

    recBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(dot()?.classList.contains('on')).toBe(false);
  });
});
