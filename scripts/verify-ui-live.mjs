// 真机录制端到端验证（经 UI 桥 /kernel-ws，与浏览器 WsKernel 同协议）。
// 目的：用脚本证明「M3 UI 壳真机录制路径」在真实 CODEBUDDY 上可跑通——
// 即浏览器页面 ?live=1 时点击「开始录制/停止录制/回放」所走的代码路径。
//
// 运行：先 `npm run ui`（桥 server 在 5173 监听 /kernel-ws），再 `node scripts/verify-ui-live.mjs`
import { WebSocket } from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:5173/kernel-ws';
const PORT = Number(process.env.CDP_PORT ?? 9222);

let seq = 0;
const pending = new Map();

const ws = new WebSocket(WS_URL);
ws.on('open', main);
ws.on('message', (raw) => {
  const res = JSON.parse(raw.toString());
  const p = pending.get(res.id);
  if (p) { pending.delete(res.id); res.ok ? p.resolve(res.result) : p.reject(new Error(res.error)); }
});
ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, args }));
  });
}

async function main() {
  console.log('[1] connect → CODEBUDDY 调试端口', PORT);
  await call('connect', { port: PORT });
  console.log('    ✓ 连接成功');

  const targets = await call('listTargets');
  console.log(`[2] listTargets → 枚举到 ${targets.length} 个目标`);
  targets.slice(0, 5).forEach((t) => console.log(`    - ${t.type} | ${t.title?.slice(0, 30)} | ${t.url?.slice(0, 40)}`));
  if (targets.length === 0) throw new Error('未枚举到任何目标');

  console.log('[3] 注入受控元素（真实页面）');
  await call('eval', `(() => {
    const d = document.createElement('div');
    const inp = document.createElement('input');
    inp.id = 'ui-live-input'; inp.setAttribute('aria-label', 'ui-live-input');
    const btn = document.createElement('button');
    btn.id = 'ui-live-btn'; btn.setAttribute('aria-label', 'ui-live-btn'); btn.textContent = 'UiLiveGo';
    d.appendChild(inp); d.appendChild(btn); document.body.appendChild(d);
  })()`);
  console.log('    ✓ 元素已注入');

  console.log('[4] startRecording（内核注入交互监听）');
  await call('startRecording');
  console.log('    ✓ 录制中');

  console.log('[5] 真实操作：fill + click');
  await call('fill', { testId: 'ui-live-input', css: '#ui-live-input' }, 'M3LIVE-录制的文本');
  await call('click', { testId: 'ui-live-btn', css: '#ui-live-btn' });
  console.log('    ✓ 操作完成');

  console.log('[6] stopRecording → 收集交互事件');
  const events = await call('stopRecording');
  console.log(`    ✓ 捕获 ${events.length} 条交互事件`);
  events.forEach((e, i) => console.log(`    ${i + 1}. ${e.type} ${e.locator ? JSON.stringify(e.locator) : ''} ${e.params ? JSON.stringify(e.params) : ''}`));
  if (events.length === 0) throw new Error('未捕获到任何交互事件');

  // 把事件转成 UiShell 内部的 Step（与 Recorder.toSteps 同构，验证"事件→步骤"闭环）
  const steps = events.map((ev, i) => ({
    id: `step-${i}`,
    type: ev.type,
    source: 'recorded',
    locator: ev.locator,
    params: ev.params,
    target: ev.target,
  }));
  const script = {
    schema: 'electron-auto-test/step/v1',
    app: { name: 'CodeBuddyCN', version: '1.106.1' },
    steps,
  };
  console.log(`[7] 构造脚本 ${steps.length} 步，调用 playback 回放`);
  const res = await call('playback', script);
  console.log(`    → playback 结果: ok=${res.ok}${res.failedStepId ? ` failedStepId=${res.failedStepId}` : ''}`);
  if (!res.ok) throw new Error('回放失败: ' + res.failedStepId);

  await call('disconnect');
  console.log('\n✅ M3 真机录制经 UI 桥闭环验证通过（连接→枚举→注入→录制→捕获→回放）');
  ws.close();
  process.exit(0);
}

setTimeout(() => { console.error('超时（30s）'); process.exit(1); }, 30_000);
