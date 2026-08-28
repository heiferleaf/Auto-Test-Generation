// @vitest-environment jsdom
// 「漏了要响」的最后一环：UI 录制结束时把覆盖率结论报出来。
// 只进诊断日志、不弹窗（录制过程中不打断用户，也不新增 UI 元素）；
// 内核不支持对账或调用失败时静默跳过，不能因为对账把录制结果弄丢。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { buildCoverage, formatCoverage } from '../src/recorder/coverage';

const mount = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

/** 最小内核：只有 stopRecording 与可选的对账方法，够驱动这一条链路。 */
function kernelWith(opts: { coverage?: unknown; rejectCoverage?: boolean } = {}) {
  const calls: string[] = [];
  const kernel = {
    calls,
    off: vi.fn(),
    stopRecording: vi.fn(async () => { calls.push('stopRecording'); return []; }),
  } as Record<string, unknown>;
  if (opts.rejectCoverage) {
    kernel.lastRecordingCoverage = vi.fn(async () => { calls.push('lastRecordingCoverage'); throw new Error('bridge down'); });
  } else if (opts.coverage !== undefined) {
    kernel.lastRecordingCoverage = vi.fn(async () => { calls.push('lastRecordingCoverage'); return opts.coverage; });
  }
  return kernel;
}

const cov = () => buildCoverage([
  { id: 'main', title: '主窗口', injected: true, stats: { intents: 3, emitted: 2, dropped: 1, recovered: 0, reasons: { noNode: 1 } } },
  { id: 'wv2', title: '设置面板', injected: false, stats: null },
]);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('UI 录制结束时的覆盖率结论', () => {
  it('内核支持对账时，结论进诊断日志，未注入的窗口被点名', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = kernelWith({ coverage: cov() });
    const shell = new UiShell({ kernel: k as never, mount: mount() });

    await shell.stopRecording();
    // 结论是 fire-and-forget（不得拖慢录制收尾），等它落地再断言。
    await new Promise((r) => setTimeout(r, 0));

    expect(k.calls).toContain('lastRecordingCoverage');
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('已注入 1/2 个窗口');
    expect(text).toContain('wv2');
  });

  it('内核不支持对账时静默跳过，不影响录制收尾', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = kernelWith();
    const shell = new UiShell({ kernel: k as never, mount: mount() });

    await expect(shell.stopRecording()).resolves.toBeUndefined();

    expect(k.calls).toEqual(['stopRecording']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('对账调用失败不得影响录制结果（少一条结论可以，丢了步骤不行）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = kernelWith({ rejectCoverage: true });
    const shell = new UiShell({ kernel: k as never, mount: mount() });

    await expect(shell.stopRecording()).resolves.toBeUndefined();

    expect(k.calls).toContain('lastRecordingCoverage');
  });

  it('结论文本与宿主侧同一个格式化函数（CLI 与 UI 口径一致）', () => {
    expect(formatCoverage(cov())).toContain('丢弃 1 次');
  });
});
