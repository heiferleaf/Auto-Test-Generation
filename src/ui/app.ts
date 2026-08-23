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

import { UiShell, type UiKernel, ASSERTION_KINDS } from './shell';
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
      .catch((e) => alert(`连接失败: ${(e as Error).message}`));
  }

  // 先渲染骨架
  shell.render();

  // 初始示例脚本，便于直接看到列表形态
  shell.insertStep({ id: 'seed-1', type: 'click', source: 'manual', locator: { role: 'button', name: '打开设置' } });
  shell.insertStep({ id: 'seed-2', type: 'fill', source: 'manual', locator: { testId: 'search' }, params: { value: '关键词' } });

  // ---- 事件委托：驱动 shell.render 输出的所有 [data-action] 按钮 ----
  mount.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!el) return;
    const action = el.getAttribute('data-action')!;
    const stepId = el.getAttribute('data-step-id') ?? undefined;

    switch (action) {
      case 'insert': {
        const type = prompt('步骤类型 (click/fill/select/hover/wait/eval/snapshot)', 'click') as any;
        if (!type) break;
        shell.insertStep({
          id: `manual-${Date.now().toString(36)}`,
          type,
          source: 'manual',
          locator: { role: 'button', name: '请指定元素' },
          params: type === 'fill' ? { value: '值' } : undefined,
        });
        break;
      }
      case 'add-assert': {
        // 断言类型菜单从单一真相源 ASSERTION_KINDS 派生（新增类型无需改此处）
        const menu = ASSERTION_KINDS
          .map((k, i) => `${i + 1}=${k.label}(${k.kind})`)
          .join('\n');
        const pick = prompt(`断言类型：\n${menu}`, '1');
        if (!pick) break;
        const idx = Number(pick) - 1;
        const entry = ASSERTION_KINDS[idx];
        if (!entry) break;
        const k = entry.kind;
        const locStr = prompt('定位（如 role=button,name=登录状态）', 'role=status') ?? '';
        const locator = parseLocator(locStr);
        const value = entry.needsValue ? (prompt('期望内容', '登录成功') ?? undefined) : undefined;
        const waitMs = Number(prompt('检测前等待毫秒（Agent 推理留时，0=不等待）', '0')) || 0;
        shell.insertAssertion(k, locator, value, waitMs);
        break;
      }
      case 'toggle-record': {
        if (shell.isRecording()) {
          await shell.stopRecording();
        } else {
          shell.startRecording();
        }
        refreshHeader();
        break;
      }
      case 'run-all': {
        // 运行全部（R3，原「回放」）：步骤态与高亮由 shell 内部经进度推送实时回显，
        // 此处只在中断时给汇总提示；失败详情由 shell 渲染的失败提醒条呈现。
        const r = await shell.runAll();
        if (!r.ok) alert(`运行中断于步骤: ${r.failedStepId ?? '(未知)'}`);
        break;
      }
      case 'highlight': {
        const rect = await shell.highlight({ role: 'button', name: '高亮我' });
        drawHighlight(rect);
        break;
      }
      case 'export': {
        const json = shell.exportScript();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'script.json'; a.click();
        URL.revokeObjectURL(url);
        break;
      }
      case 'clear': {
        [...shell.getScript().steps].forEach((st) => shell.removeStep(st.id));
        break;
      }
      case 'up': if (stepId) shell.moveStep(stepId, Math.max(0, stepIndex(shell, stepId) - 1)); break;
      case 'down': if (stepId) shell.moveStep(stepId, stepIndex(shell, stepId) + 1); break;
      case 'edit': if (stepId) alert('编辑：' + JSON.stringify(findStep(shell, stepId), null, 2)); break;
      case 'remove': if (stepId) shell.removeStep(stepId); break;
      case 'select-target': {
        const sel = el as HTMLSelectElement;
        shell.selectTarget(sel.value);
        break;
      }
    }
  });

  // 步骤项点击 → 高亮其在视图中的位置
  mount.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('[data-step-item]');
    if (!item) return;
    if ((e.target as HTMLElement).closest('[data-action]')) return; // 操作按钮不触发高亮
    const loc = demoLocFor(item.getAttribute('data-step-id')!);
    if (loc) shell.highlight(loc).then(drawHighlight);
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
    const dot = mount.querySelector('.ui-shell-header .rec-dot') as HTMLElement | null;
    if (dot) dot.classList.toggle('on', shell.isRecording());
  }
}

// ---- 小工具 ----
function stepIndex(shell: UiShell, id: string): number {
  return shell.getScript().steps.findIndex((s) => s.id === id);
}
function findStep(shell: UiShell, id: string) {
  return shell.getScript().steps.find((s) => s.id === id);
}
function parseLocator(input: string): Locator {
  const loc: Locator = {};
  input.split(',').forEach((kv) => {
    const [k, v] = kv.split('=').map((s) => s.trim());
    if (k && v) (loc as any)[k] = v;
  });
  return loc;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
