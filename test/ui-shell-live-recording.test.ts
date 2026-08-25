// @vitest-environment jsdom
// 测试先行（R2）：嵌入实时录制 —— 录制中每收到一个交互事件即实时生成步骤，
// 而非停止后批量。验证 UiShell 订阅 kernel 'recording' 事件并增量插入脚本与 DOM。
//
// 本文件为新增独立测试，不修改既有 ui-shell.test.ts 的 MockKernel 契约（测试权威不受侵扰）。

import { describe, it, expect, vi } from 'vitest';
import type { Locator } from '../src/types/step';
import { UiShell } from '../src/ui/shell';

/** R2 专用 mock：支持 on/emit 模拟 R1 的 WS 主动推送。 */
type R2Kernel = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  listTargets: ReturnType<typeof vi.fn>;
  selectTarget: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  locateVisual: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  playback: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  listeners: Record<string, Set<(d: unknown) => void>>;
  emit(event: string, data: unknown): void;
};

function makeR2Kernel(recordedEvents: any[] = []) {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  const kernel = {
    listeners,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title: '主窗口', url: 'app://main' }]),
    selectTarget: vi.fn((_id: string) => {}),
    click: vi.fn(async (_l: Locator) => {}),
    fill: vi.fn(async (_l: Locator, _v: string) => {}),
    select: vi.fn(async (_l: Locator, _o: string) => {}),
    hover: vi.fn(async (_l: Locator) => {}),
    wait: vi.fn(async (_o: any) => {}),
    eval: vi.fn(async (_c: string) => undefined),
    snapshot: vi.fn(async (): Promise<any[]> => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async (): Promise<Buffer> => Buffer.from('fake')),
    locateVisual: vi.fn(async (_l: Locator) => ({ x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true })),
    startRecording: vi.fn(() => {}),
    stopRecording: vi.fn(async () => recordedEvents),
    playback: vi.fn(async () => ({ ok: true })),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    emit(event: string, data: unknown) {
      listeners[event]?.forEach((cb) => cb(data));
    },
  } as unknown as R2Kernel;
  return kernel;
}

describe('R2 嵌入实时录制', () => {
  it('startRecording 后，每收到一个 recording 事件即实时增加脚本步骤', async () => {
    const k = makeR2Kernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    await shell.startRecording();
    expect(k.startRecording).toHaveBeenCalledTimes(1);
    expect(k.on).toHaveBeenCalledWith('recording', expect.any(Function));

    // 模拟用户在靶机操作 → 桥推送两个事件
    k.emit('recording', { type: 'click', locator: { role: 'button', name: '登录' } });
    k.emit('recording', { type: 'fill', locator: { testId: 'usr' }, params: { value: 'tom' } });

    const steps = shell.getScript().steps;
    expect(steps.length).toBe(2);
    expect(steps[0].type).toBe('click');
    expect(steps[1].type).toBe('fill');
    expect(steps[1].params?.value).toBe('tom');
  });

  it('实时事件会增量追加到 DOM 步骤列表（非全量重渲染也能见）', async () => {
    const k = makeR2Kernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount });
    await shell.startRecording();
    k.emit('recording', { type: 'click', locator: { name: 'A' } });
    const items = mount.querySelectorAll('[data-step-item]');
    expect(items.length).toBe(1);
    expect(items[0].getAttribute('data-step-id')).toBe(shell.getScript().steps[0].id);
  });

  it('停止录制时，stopRecording 拉回的事件对实时已插入的做去重', async () => {
    const k = makeR2Kernel([{ type: 'click', locator: { name: 'B' } }]);
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    await shell.startRecording();
    k.emit('recording', { type: 'click', locator: { name: 'B' } }); // 实时已插入
    await shell.stopRecording();
    // 实时 1 条 + stop 拉回 1 条但去重 → 仍 1 条
    expect(shell.getScript().steps.length).toBe(1);
    expect(shell.isRecording()).toBe(false);
  });

  it('未开始录制时收到 recording 事件不应插入（防御脏数据）', () => {
    const k = makeR2Kernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    k.emit('recording', { type: 'click', locator: { name: 'X' } });
    expect(shell.getScript().steps.length).toBe(0);
  });
});
