// 共享 Mock Kernel（供版本集成测试等复用，避免各测试文件重复定义）。
// 注意：既有 test/ui-shell.test.ts 内部仍保留自己的内联副本（未改动，遵循测试代码权威性）。
// 这里单独抽出一份等价实现，供新增测试导入。

import { vi } from 'vitest';
import type { Locator } from '../src/types/step';

export type AnyKernel = {
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
  captureFrame: ReturnType<typeof vi.fn>;
  calls: string[];
};

export function makeMockKernel(recordedEvents: any[] = []): AnyKernel {
  const calls: string[] = [];
  const kernel = {
    calls,
    connect: vi.fn(async () => { calls.push('connect'); }),
    disconnect: vi.fn(async () => { calls.push('disconnect'); }),
    listTargets: vi.fn((): any[] => {
      calls.push('listTargets');
      return [
        { id: 'main', type: 'page', title: '主窗口', url: 'app://main' },
        { id: 'wv1', type: 'webview', title: '设置面板', url: 'vscode-webview://x' },
      ];
    }),
    selectTarget: vi.fn((id: string) => { calls.push(`selectTarget:${id}`); }),
    click: vi.fn(async (_l: Locator) => { calls.push('click'); }),
    fill: vi.fn(async (_l: Locator, _v: string) => { calls.push('fill'); }),
    select: vi.fn(async (_l: Locator, _o: string) => { calls.push('select'); }),
    hover: vi.fn(async (_l: Locator) => { calls.push('hover'); }),
    wait: vi.fn(async (_o: any) => { calls.push('wait'); }),
    eval: vi.fn(async (_c: string) => { calls.push('eval'); return undefined; }),
    snapshot: vi.fn(async (): Promise<any[]> => { calls.push('snapshot'); return []; }),
    query: vi.fn(async () => { calls.push('query'); return undefined; }),
    screenshot: vi.fn(async (): Promise<Buffer> => {
      calls.push('screenshot');
      return Buffer.from('fake-png');
    }),
    locateVisual: vi.fn(async (_l: Locator) => {
      calls.push('locateVisual');
      return { x: 10, y: 20, width: 100, height: 40, visible: true, inViewport: true };
    }),
    startRecording: vi.fn(() => { calls.push('startRecording'); }),
    stopRecording: vi.fn(async () => {
      calls.push('stopRecording');
      return recordedEvents;
    }),
    playback: vi.fn(async () => {
      calls.push('playback');
      return { ok: true };
    }),
  } as unknown as AnyKernel;
  return kernel;
}
