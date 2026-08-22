// 浏览器入口：实例化 UiShell 并绑定面板交互（M3.3 可视化蒙版 UI 壳）。
//
// 运行方式（本地宿主）：`npm run ui`（src/ui/serve.ts 起 HTTP server 托管本页 + index.html）。
// 演示内核：内置 DemoKernel，无需真机即可查看完整交互形态（供 UI 设计 / 人工验收）。
//
// 关于真机连接（重要架构说明）：
//   PlaywrightCdpAdapter 依赖 Node 原生模块（playwright/ws/child_process/fs），
//   无法在浏览器页面内运行。因此「页面直接连真机」架构上不成立。
//   M3 真机链路通过 CLI + LIVE 测试验证（test/ui-shell-live.test.ts / system-record-replay.test.ts，
//   均连真实 CODEBUDDY 9222 端口并跑通录制→回放）。
//   后续 UI 壳接真机需经 WebSocket 桥（页面 ↔ Node 宿主持有 adapter），留作 M3.3-LIVE 扩展点
//   （见 test/visual-overlay-ui.md §4 的 "📋 待补/扩展点"）。

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
  async playback(_script: import('../types/step').Script) {
    log('playback', _script.steps.length, 'steps');
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

  // 真机模式：自动连接靶机（桥端持有 adapter，按 UI_PORT→CDP_PORT 默认 9222 连接）
  if (live) {
    shell.connect({ port: 9222 }).catch((e) => alert(`连接失败: ${(e as Error).message}`));
  }

  // 先渲染骨架
  shell.render();

  // 顶部状态栏增加录制指示灯
  // （UiShell.render 已输出 header，这里追加交互按钮到 actions 区）

  const actions = document.createElement('div');
  actions.className = 'ui-shell-actions';
  actions.setAttribute('data-actions', 'true');

  const btn = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };

  btn('连接', 'primary', async () => { await shell.connect({ port: 9222 }); refreshHeader(); });
  const recBtn = btn('开始录制', '', () => {
    if (shell.isRecording()) {
      shell.stopRecording().then(() => { recBtn.textContent = '开始录制'; refreshHeader(); });
    } else {
      shell.startRecording();
      recBtn.textContent = '停止录制';
      refreshHeader();
    }
  });
  btn('回放', '', async () => { const r = await shell.playback(); alert(r.ok ? '回放成功' : `回放失败: ${r.failedStepId ?? ''}`); });
  btn('高亮示例', '', async () => {
    const rect = await shell.highlight({ role: 'button', name: '高亮我' });
    drawHighlight(rect);
  });
  btn('导出', '', () => {
    const json = shell.exportScript();
    // 简单演示：写入下载
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'script.json'; a.click();
    URL.revokeObjectURL(url);
  });
  btn('清空', 'danger', () => {
    const s = shell.getScript();
    [...s.steps].forEach((st) => shell.removeStep(st.id));
    refreshHeader();
  });

  mount.appendChild(actions);

  // 侧边步骤项点击 → 高亮其在视图中的位置（演示）
  mount.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('[data-step-item]');
    if (item) {
      const loc = demoLocFor(item.getAttribute('data-step-id')!);
      if (loc) shell.highlight(loc).then(drawHighlight);
    }
  });

  function demoLocFor(_id: string): Locator | undefined {
    return { role: 'button', name: '示例元素' };
  }

  function drawHighlight(rect: { x: number; y: number; width: number; height: number }) {
    const stage = mount.querySelector('[data-stage]') as HTMLElement;
    if (!stage) return;
    let hl = stage.querySelector('.ui-shell-highlight') as HTMLElement | null;
    if (!hl) { hl = document.createElement('div'); hl.className = 'ui-shell-highlight'; stage.appendChild(hl); }
    hl.style.left = `${rect.x}px`;
    hl.style.top = `${rect.y}px`;
    hl.style.width = `${rect.width}px`;
    hl.style.height = `${rect.height}px`;
  }

  function refreshHeader() {
    const header = mount.querySelector('.ui-shell-header') as HTMLElement | null;
    if (header) {
      const dot = header.querySelector('.rec-dot') as HTMLElement | null;
      if (dot) dot.classList.toggle('on', shell.isRecording());
    }
  }

  // 初始示例脚本，便于直接看到列表形态
  shell.insertStep({ id: 'seed-1', type: 'click', source: 'manual', locator: { role: 'button', name: '打开设置' } });
  shell.insertStep({ id: 'seed-2', type: 'fill', source: 'manual', locator: { testId: 'search' }, params: { value: '关键词' } });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
