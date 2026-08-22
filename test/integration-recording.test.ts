// M3 集成测试（真实录制监听，LIVE 门控）：验证 Recordable 能在连靶机时
// 捕获真实 DOM 交互并转为 InteractionEvent，再经 Recorder→runCli 回放。
//
// 测试先行：本文件与 M3 集成层实现同期存在。运行：
//   set CODEBUDDY_LIVE=1 && npm test -- test/integration-recording.test.ts
// 默认无 CODEBUDDY_LIVE 自动 skip。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import type { CdpAdapter, VisualCapable, Recordable } from '../src/cdp/adapter';
import { Recorder } from '../src/recorder/recorder';
import { runCli } from '../src/cli';

const LIVE = process.env.CODEBUDDY_LIVE === '1';
const PORT = 9222;
type Target = CdpAdapter & VisualCapable & Recordable;

const live = LIVE ? describe : describe.skip;
let adapter: Target;

beforeAll(async () => {
  if (!LIVE) return;
  adapter = new PlaywrightCdpAdapter() as Target;
  await adapter.connect({ port: PORT });
}, 30_000);

afterAll(async () => {
  if (!LIVE) return;
  await (adapter as PlaywrightCdpAdapter).disconnect().catch(() => undefined);
});

live('M3 真实录制监听（连接 CodeBuddy 捕获交互）', () => {
  it('注入监听后，fill+click 被捕获为 InteractionEvent 且可回放', async () => {
    // 在页面注入确定存在的受控元素，避免依赖应用 UI。
    // 注意：CodeBuddy 启用 TrustedHTML，禁用 innerHTML，须用 createElement 构建。
    await adapter.eval(`(() => {
      const d = document.createElement('div');
      const inp = document.createElement('input');
      inp.id = 'rec-test'; inp.setAttribute('aria-label', 'rec-input');
      const btn = document.createElement('button');
      btn.id = 'rec-btn'; btn.setAttribute('aria-label', 'rec-button'); btn.textContent = 'Go';
      d.appendChild(inp); d.appendChild(btn);
      document.body.appendChild(d);
      return true;
    })()`);

    adapter.startRecording();

    // 模拟"用户"操作（Playwright fill/click 会派发真实 DOM input/click 事件）。
    await adapter.fill({ css: '#rec-test' }, '你好');
    await adapter.click({ css: '#rec-btn' });

    const events = await adapter.stopRecording();
    expect(events.length).toBeGreaterThan(0);

    // 至少一个 fill、一个 click 被捕获，且带语义化 locator。
    const types = events.map((e) => e.type);
    expect(types).toContain('fill');
    expect(types).toContain('click');
    const fillEv = events.find((e) => e.type === 'fill');
    expect(fillEv?.locator?.name).toBe('rec-input');
    expect(fillEv?.params?.value).toBe('你好');

    // 录制的事件应能转 Step 并经 runCli 回放（对目标软件响应）。
    const rec = new Recorder();
    events.forEach((e) => rec.record(e));
    const script = rec.buildScript({ name: 'CodeBuddy' });
    const res = await runCli({ adapter: adapter as unknown as CdpAdapter, script });
    expect(res.ok).toBe(true);
  });
});
