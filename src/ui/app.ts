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

  async playback(script: import('../types/step').Script, fromStepId?: string) {
    log('playback', script.steps.length, 'steps');
    // 演示逐步进度：与真机桥经 'step-progress' 推送的形态一致（UiShell 不感知差异）。
    // 支持「从此处运行」：前序跳过 fromStepId 之前的顶层步骤（演示与真机语义一致）。
    let started = fromStepId === undefined;
    for (const s of script.steps) {
      if (!started) {
        if (s.id === fromStepId) started = true;
        else continue;
      }
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
  // 产品需求：面板默认就驱动真实软件（经 WebSocket 桥 → PlaywrightCdpAdapter）。
  // ?demo=1 为显式逃生通道（无靶机时纯演示），但默认不再是 demo。
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  // 端口来源：URL 参数 ?cdp=9233 优先，回退默认 9222。浏览器环境无 process，不能直接读 env。
  const cdpParam = new URLSearchParams(location.search).get('cdp');
  const cdpPort = cdpParam ? Number(cdpParam) : 9222;

  // 真机内核：WsKernel 经 WebSocket 桥接 Node 侧 PlaywrightCdpAdapter；
  // 显式 demo 模式：DemoKernel（浏览器可运行，无需真机，操作为模拟）。
  // 二者都满足 UiKernel 接口，UiShell 不感知差异（DIP）。
  const kernel: UiKernel = demo
    ? new DemoKernel()
    : new WsKernel(`ws://${location.host}/kernel-ws`);

  const shell = new UiShell({ kernel, mount });

  // 刷新顶部录制指示灯（录制态变化后）。
  const refreshHeader = () => {
    const dot = mount.querySelector('.ui-shell-header .rec-dot') as HTMLElement | null;
    if (dot) dot.classList.toggle('on', shell.isRecording());
  };
  mount.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('[data-action="toggle-record"]');
    if (el) refreshHeader();
  });

  // 显式 demo：提示为模拟，不连真机。
  if (demo) {
    shell.setBanner('演示模式（显式 ?demo=1）：内置示例内核，操作为模拟，不驱动真实软件。', true);
  } else {
    // 默认连真机：连接成功 → 开截图流（中间区看到软件画面）；
    // 失败 → 降级：顶部红条提示，但面板仍可手动插入/编辑步骤（操作不下发）。
    shell.connect({ port: cdpPort })
      .then(() => { shell.startFrameStream(1000); refreshHeader(); })
      .catch((e) => {
        // 不用 alert（jsdom/无头环境无实现，且不符合 spec 交互）；以横幅提示替代。
        console.error('[UiShell] 连接靶机失败:', e instanceof Error ? e.message : e);
        shell.setBanner(`未连接靶机：请先启动软件调试端口 ${cdpPort}（如 scripts/launch-codebuddy.cmd）。当前面板仅可手动插入/编辑步骤，操作不会下发到真实软件。`);
      });
  }

  // 先渲染骨架（含可能的降级横幅）
  shell.render();

  // 初始示例脚本（演示「录制产出的步骤形态」：click/fill 仅由录制产生，此处用种子数据替代真实录制回放）。
  shell.insertStep({ id: 'seed-1', type: 'click', source: 'recorded', locator: { role: 'button', name: '打开设置' } });
  shell.insertStep({ id: 'seed-2', type: 'fill', source: 'recorded', locator: { testId: 'search' }, params: { value: '关键词' } });

  // 用户交互（插入 4 类、编辑区、建组、运行、导出、录制……）全部由 UiShell 内部事件委托处理，
  // app.ts 不再用 prompt/alert 实现交互（避免 jsdom 不可测、且不符合 spec §2.6 真实编辑区）。
  // app.ts 仅负责：内核装配（DemoKernel / WsKernel）、真机连接与截图流、录制指示灯刷新。
  // 录制指示灯刷新（refreshHeader）与 click 订阅已在上方 boot 开头定义。
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
