// 浏览器入口：实例化 UiShell 并绑定面板交互（M3.3 可视化蒙版 UI 壳）。
//
// 运行方式（本地宿主）：`npm run ui`（src/ui/serve.ts 起 HTTP server 托管本页 + index.html）。
// 演示内核：内置 DemoKernel，无需真机即可查看完整交互形态（供 UI 设计 / 人工验收）。
//
// 关于真机连接（重要架构说明）：
//   PlaywrightCdpAdapter 依赖 Node 原生模块（playwright/ws/child_process/fs），
//   无法在浏览器页面内运行。因此页面经 WebSocket 桥接真机：
//   WsKernel（浏览器侧 UiKernel 代理）↔ /kernel-ws ↔ bridge-server（Node 侧持有 PlaywrightCdpAdapter）。
//   `?live=1` 即走此真机链路，已验证可枚举目标、录制、截图流、回放（见 scripts/verify-ui-live.mjs）。
//   演示模式（默认）用 DemoKernel，无需真机即可查看完整交互形态。

import { UiShell, type UiKernel } from './shell';
import type { Locator } from '../cdp/adapter';
import { WsKernel } from './ws-kernel';

/** 浏览器内演示内核：行为与单测 MockKernel 同构，但独立存在（测试文件不进浏览器）。 */
class DemoKernel implements UiKernel {
  private targets = [
    { id: 'main', type: 'page', title: '主窗口', url: 'app://main' },
    { id: 'wv1', type: 'webview', title: '设置面板', url: 'vscode-webview://x' },
  ];
  async connect() { /* demo: 模拟已连接 */ }
  async disconnect() {}
  listTargets() { return this.targets as any; }
  selectTarget(_id: string) {}
  async click(_l: Locator) { log('click', _l); }
  async fill(_l: Locator, v: string) { log('fill', _l, v); }
  async select(_l: Locator, o: string) { log('select', _l, o); }
  async hover(_l: Locator) { log('hover', _l); }
  async wait(_o: any) {}
  async eval(_c: string) { return undefined; }
  async snapshot() { return []; }
  async query() { return undefined; }
  async screenshot() { return Buffer.from('demo'); }
  async locateVisual(_l: Locator) {
    return { x: 40, y: 60, width: 120, height: 36, visible: true, inViewport: true };
  }
  startRecording() { log('startRecording'); }
  async stopRecording() {
    // 演示：返回两条示例交互
    return [
      { type: 'click', locator: { role: 'button', name: '登录' } },
      { type: 'fill', locator: { testId: 'username' }, params: { value: 'demo_user' } },
    ] as any;
  }
  /** 演示用事件通道（与 WsKernel 的 on/off 同形，让演示模式也能看到逐步回显）。 */
  private listeners = new Map<string, Set<(d: unknown) => void>>();
  on(event: string, cb: (d: unknown) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  off(event: string, cb: (d: unknown) => void) {
    this.listeners.get(event)?.delete(cb);
  }
  private emit(event: string, data: unknown) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  async playback(script: import('../types/step').Script) {
    log('playback', script.steps.length, 'steps');
    // 演示逐步进度：与真机桥经 'step-progress' 推送的形态一致（UiShell 不感知差异）。
    for (const s of script.steps) {
      this.emit('step-progress', { stepId: s.id, status: 'running' });
      await new Promise((r) => setTimeout(r, 300));
      this.emit('step-progress', { stepId: s.id, status: 'pass' });
    }
    return { ok: true } as const;
  }
}

function log(...args: unknown[]) {
  // 演示日志：可在控制台面板查看编排调用
  // eslint-disable-next-line no-console
  console.log('[UiShell]', ...args);
}

function boot() {
  const mount = document.getElementById('app')!;
  const live = new URLSearchParams(location.search).get('live') === '1';

  // 真机模式：WsKernel 经 WebSocket 桥接 Node 侧 PlaywrightCdpAdapter；
  // 演示模式：DemoKernel（浏览器可运行，无需真机）。
  // 二者都满足 UiKernel 接口，UiShell 不感知差异（DIP）。
  const kernel: UiKernel = live
    ? new WsKernel(`ws://${location.host}/kernel-ws`)
    : new DemoKernel();

  const shell = new UiShell({ kernel, mount });

  // 真机模式：自动连接靶机并启动截图流（让中间区看到软件画面）
  if (live) {
    shell.connect({ port: 9222 })
      .then(() => { shell.startFrameStream(1000); refreshHeader(); })
      .catch((e) => {
        // 不用 alert（jsdom/无头环境无实现，且不符合 spec 交互）；以控制台 + 顶部错误条提示。
        console.error('[UiShell] 连接失败:', e instanceof Error ? e.message : e);
        const errBar = document.createElement('div');
        errBar.className = 'ui-shell-conn-error';
        errBar.textContent = `连接失败: ${e instanceof Error ? e.message : String(e)}`;
        mount.prepend(errBar);
      });
  }

  // 先渲染骨架
  shell.render();

  // 演示模式（默认，无 ?live）下无真机事件源：一进来就告知用户，
  // 避免「点了录制却什么都没发生」被误判为功能失效（真实路径可用性反馈）。
  if (!live) {
    shell.setBanner('演示模式：内置示例内核，操作为模拟。要录制真实软件操作，请访问 http://localhost:5173/?live=1 连接靶机。');
  }

  // 初始示例脚本（演示「录制产出的步骤形态」：click/fill 仅由录制产生，此处用种子数据替代真实录制回放）。
  shell.insertStep({ id: 'seed-1', type: 'click', source: 'recorded', locator: { role: 'button', name: '打开设置' } });
  shell.insertStep({ id: 'seed-2', type: 'fill', source: 'recorded', locator: { testId: 'search' }, params: { value: '关键词' } });

  // 用户交互（插入 4 类、编辑区、建组、运行、导出、录制……）全部由 UiShell 内部事件委托处理，
  // app.ts 不再用 prompt/alert 实现交互（避免 jsdom 不可测、且不符合 spec §2.6 真实编辑区）。
  // app.ts 仅负责：内核装配（DemoKernel / WsKernel）、真机连接与截图流、录制指示灯刷新。

  // 录制指示灯跟随（内核录制态变化后刷新顶部指示）。
  const refreshHeader = () => {
    const dot = mount.querySelector('.ui-shell-header .rec-dot') as HTMLElement | null;
    if (dot) dot.classList.toggle('on', shell.isRecording());
  };
  // 录制按钮在 shell 内部委托处理 start/stop，这里仅订阅录制态以刷新指示。
  mount.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('[data-action="toggle-record"]');
    if (el) refreshHeader();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
