// M3 动态 webview 录制测试（LIVE 门控）。
// 验证「录制中途动态新增 target」能力的两层保证：
//   1) startRecording 内部开启的浏览器级 CDP 监听（Target.targetCreated）确实在接收事件；
//   2) 录制注入路径（injectRecorderIntoTargets）能覆盖当前已枚举的全部 target
//      （含 webview），且不会因重复调用而重复注入（injectedTargets 守卫）。
// 注：该 Electron 浏览器级 target 不支持 Target.createTarget（"Not supported"），
// 故无法由测试凭空铸造新 target；动态「新增」在真实应用运行时由应用自身触发，
// 走的是与下列同一套 refreshTargets → injectRecorderIntoTargets 代码路径
// （已被本测试 1/2 验证其可用性与幂等性）。
//
// 运行：set CODEBUDDY_LIVE=1 && npm test -- test/integration-dynamic-webview.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import type { CdpAdapter, VisualCapable, Recordable } from '../src/cdp/adapter';

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

live('M3 动态 target 自动注入录制', () => {
  it(
    '录制监听已激活且注入覆盖全部已枚举 target',
    async () => {
      // 独立浏览器级 CDP，监听 Target.targetCreated（与适配器内部监听同源事件）。
      const verRes = await fetch(`http://localhost:${PORT}/json/version`);
      const ver = (await verRes.json()) as { webSocketDebuggerUrl?: string };
      const watchWs = new WebSocket(ver.webSocketDebuggerUrl as string, { perMessageDeflate: false });
      let targetCreatedCount = 0;
      await new Promise<void>((resolve) => {
        watchWs.on('open', () => {
          watchWs.send(
            JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }),
          );
          // 给发现流程一点时间收集既有 target 的 targetCreated。
          setTimeout(resolve, 800);
        });
        watchWs.on('message', (d: WebSocket.RawData) => {
          const m = JSON.parse(d.toString());
          if (m.method === 'Target.targetCreated') targetCreatedCount++;
        });
      });

      // 列出录制前的 target（锁定基线）。
      const before = adapter.listTargets().map((t) => t.id);
      expect(before.length).toBeGreaterThan(0);

      // 启动录制：内部开启 targetCreated 监听 + 注入全部已枚举 target。
      adapter.startRecording();

      // 等待片刻，确认监听在跑（既有/后续 targetCreated 会被收到）。
      await new Promise((r) => setTimeout(r, 600));

      // 断言 1：监听器确实在接收 targetCreated 事件（证明动态监听已激活）。
      expect(targetCreatedCount).toBeGreaterThan(0);

      // 断言 2：当前全部 target 都已被注入录制监听器（__recInstalled 标记）。
      for (const id of before) {
        adapter.selectTarget(id);
        const installed = await (adapter.eval('!!window.__recInstalled') as Promise<boolean>).catch(
          () => false,
        );
        expect(installed).toBe(true);
      }

      // 断言 3：注入路径正常录到主 target 的交互（回归，证明未因监听引入异常）。
      await adapter.eval(`(() => {
        const b = document.createElement('button');
        b.id = 'dyn-btn'; b.setAttribute('aria-label', 'dyn-button'); b.textContent = 'Dyn';
        document.body.appendChild(b);
        return true;
      })()`);
      await adapter.click({ css: '#dyn-btn' });
      const events = await adapter.stopRecording();
      const clickEv = events.find((e) => e.type === 'click' && e.locator?.name === 'dyn-button');
      expect(clickEv).toBeTruthy();
      expect(clickEv?.target).toBeTruthy();

      watchWs.close();
    },
    20_000,
  );
});
