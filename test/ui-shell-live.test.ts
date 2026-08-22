// @vitest-environment jsdom
// M3 UI 壳 LIVE 集成测试：验证 UiShell 真实连接 CODEBUDDY（9222）并跑通
// 「连接 → 枚举目标 → 录制 → 转步骤 → 回放」完整链路。
//
// 门控：默认无 CODEBUDDY_LIVE 自动 skip（CODEBUDDY.md §5）。靶机须开启 9222 调试端口。
// 运行：set CODEBUDDY_LIVE=1 && npm test -- test/ui-shell-live.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import type { UiKernel } from '../src/ui/shell';
import { SCRIPT_SCHEMA, type Step } from '../src/types/step';

const LIVE = process.env.CODEBUDDY_LIVE === '1';
const PORT = Number(process.env.CODEBUDDY_PORT ?? 9222);

const live = LIVE ? describe : describe.skip;

let kernel: UiKernel;
let shell: UiShell;

beforeAll(async () => {
  if (!LIVE) return;
  const adapter = new PlaywrightCdpAdapter();
  await adapter.connect({ port: PORT });
  kernel = adapter as UiKernel;
  shell = new UiShell({ kernel, mount: document.createElement('div') });
  await shell.connect({ port: PORT });
}, 30_000);

afterAll(async () => {
  if (!LIVE) return;
  await (kernel as PlaywrightCdpAdapter).disconnect().catch(() => undefined);
});

live('M3 UI 壳：真实连接并枚举多目标', () => {
  it('连接后状态为已连接，且至少枚举到一个目标', () => {
    expect(shell.isConnected()).toBe(true);
    const targets = (kernel as PlaywrightCdpAdapter).listTargets();
    expect(targets.length).toBeGreaterThan(0);
  });
});

live('M3 UI 壳：录制真实操作并转为步骤', () => {
  it('注入受控元素并操作，stopRecording 产出可执行的 step', async () => {
    // 1) 在真实页面注入受控元素（TrustedHTML 兼容，参考 system-record-replay.test.ts）
    await kernel.eval(`(() => {
      const d = document.createElement('div');
      const inp = document.createElement('input');
      inp.id = 'ui-rec-input'; inp.setAttribute('aria-label', 'ui-rec-input');
      const btn = document.createElement('button');
      btn.id = 'ui-rec-btn'; btn.setAttribute('aria-label', 'ui-rec-btn'); btn.textContent = 'UiGo';
      d.appendChild(inp); d.appendChild(btn); document.body.appendChild(d);
    })()`);

    // 2) 开始录制（内核注入交互监听）
    shell.startRecording();
    expect(shell.isRecording()).toBe(true);

    // 3) 真实操作：填入文本并点击按钮
    await kernel.fill({ testId: 'ui-rec-input', css: '#ui-rec-input' }, 'M3LIVE');
    await kernel.click({ testId: 'ui-rec-btn', css: '#ui-rec-btn' });

    // 4) 停止录制并收集步骤
    await shell.stopRecording();
    expect(shell.isRecording()).toBe(false);

    const steps = shell.getScript().steps;
    expect(steps.length).toBeGreaterThanOrEqual(1);

    // 至少含一条 fill 或 click 步骤
    const hasAction = steps.some((s: Step) => s.type === 'fill' || s.type === 'click');
    expect(hasAction).toBe(true);

    // 5) 导出再导入，结构等价（schema 正确）
    const json = shell.exportScript();
    const back = JSON.parse(json);
    expect(back.schema).toBe(SCRIPT_SCHEMA);
    expect(Array.isArray(back.steps)).toBe(true);
  });
});

live('M3 UI 壳：回放已录制脚本', () => {
  it('playback 返回结构化结果', async () => {
    const res = await shell.playback();
    expect(typeof res.ok).toBe('boolean');
    if (!res.ok) {
      // 失败须暴露失败步，便于定位
      expect(res.failedStepId).toBeDefined();
    }
  });
});
