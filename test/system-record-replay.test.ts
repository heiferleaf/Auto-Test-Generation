// M3 系统测试（LIVE 门控）：端到端验证「录制 → 导出 → 导入 → 回放」闭环。
// 这是集成测试之上的一层：不只验证单模块，而是走通完整系统路径，
// 用于用户的集成测试与系统测试。默认无 CODEBUDDY_LIVE 自动 skip。
//
// 运行：set CODEBUDDY_LIVE=1 && npm test -- test/system-record-replay.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import type { CdpAdapter, VisualCapable, Recordable } from '../src/cdp/adapter';
import { Recorder } from '../src/recorder/recorder';
import { importScript, exportScript } from '../src/script/io';
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

live('M3 系统测试：录制→导出→导入→回放 端到端闭环', () => {
  it('多 target 注入录制不报错，且主 page 交互被捕获', async () => {
    // 注入受控元素（TrustedHTML 兼容）。
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
    await adapter.fill({ css: '#rec-test' }, '你好系统测试');
    await adapter.click({ css: '#rec-btn' });
    const events = await adapter.stopRecording();

    // 至少捕获到主 page 的 fill + click，且事件带 target 标识。
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => e.type);
    expect(types).toContain('fill');
    expect(types).toContain('click');
    const fillEv = events.find((e) => e.type === 'fill');
    expect(fillEv?.locator?.name).toBe('rec-input');
    expect(fillEv?.params?.value).toBe('你好系统测试');
    expect(fillEv?.target).toBeTruthy(); // 标注来源 target
  });

  it('导出→导入→回放 全链路成功（系统闭环）', async () => {
    // 重新录制一小段并导出。
    await adapter.eval(`(() => {
      const i = document.getElementById('rec-test');
      if (i) { i.value=''; }
      return true;
    })()`);
    adapter.startRecording();
    await adapter.fill({ css: '#rec-test' }, '闭环验证');
    await adapter.click({ css: '#rec-btn' });
    const events = await adapter.stopRecording();

    const rec = new Recorder();
    events.forEach((e) => rec.record(e));
    const script = rec.buildScript({ name: 'CodeBuddy', version: 'sys' });

    // 导出 → 导入（往返一致性，模拟脚本落盘后被后续回放消费）。
    const json = exportScript(script);
    const reloaded = importScript(json);
    expect(reloaded.steps.length).toBe(script.steps.length);

    // 回放（对目标软件响应）。
    const res = await runCli({ adapter: adapter as unknown as CdpAdapter, script: reloaded });
    expect(res.ok).toBe(true);
  });
});
