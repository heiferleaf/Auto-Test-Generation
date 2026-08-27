// @vitest-environment jsdom
// 测试先行（R3）：运行全部 + 步骤运行态 + 高亮自动跟随（P1）。
//
// 需求依据：docs/design/visual-mask-ui-spec.md §2.3.4（"回放"改名"运行全部"）、
//          docs/plan/plan.md 阶段 M3-R3、待做需求 P1（高亮自动跟随当前步骤）。
//
// 本文件为新增独立测试，自带 mock kernel，不修改既有 ui-shell.test.ts / ui-shell-live-recording.test.ts
// 的 mock 契约（CODEBUDDY.md：测试代码权威性，既有基建不得为迁就实现而改）。

import { describe, it, expect, vi } from 'vitest';
import type { Locator, Script, Step } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';
import { UiShell, type StepRunStatus } from '../src/ui/shell';

/** 构造一个 N 步脚本（click 步，便于按 index 断言）。 */
function makeScript(n: number): Script {
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    steps.push({
      id: `s${i}`,
      type: 'click',
      source: 'manual',
      locator: { name: `按钮${i}` },
    });
  }
  return { schema: SCRIPT_SCHEMA, app: { name: 'RunAll', version: '1.0.0' }, steps };
}

type RunAllKernelOpts = {
  /** 流式回放时，指定第几步失败（0-based）；不传则全部通过。 */
  failAt?: number;
  /**
   * 是否支持进度推送（false 则模拟旧内核：不实现 on/off，只返回汇总结果）。
   *
   * 注意（可运行性审查裁定）：进度**不能**以回调函数入参传给 playback ——
   * UiKernel 会被 WsKernel 跨 WebSocket 实现，函数无法 JSON 序列化，真机必然丢失。
   * 故此处 mock 严格模拟真机形态：playback 单参 + 经 'step-progress' 事件推送进度。
   */
  streaming?: boolean;
};

function makeRunAllKernel(opts: RunAllKernelOpts = {}) {
  const streaming = opts.streaming !== false;
  const locateCalls: Locator[] = [];
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  const emit = (event: string, data: unknown) => {
    listeners[event]?.forEach((cb) => cb(data));
  };
  const kernel = {
    locateCalls,
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
    locateVisual: vi.fn(async (l: Locator) => {
      locateCalls.push(l);
      return { x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true };
    }),
    startRecording: vi.fn(() => {}),
    stopRecording: vi.fn(async () => []),
    /**
     * 单参 playback（与真机 WsKernel 签名一致）；进度经 'step-progress' 事件推送，
     * 模拟 bridge-server 侧 `adapter.playback(script, (id,st) => pushEvent(...))` 的行为。
     */
    playback: vi.fn(async (script: Script) => {
      if (!streaming) {
        const failed = opts.failAt !== undefined ? script.steps[opts.failAt]?.id : undefined;
        return failed ? { ok: false, failedStepId: failed } : { ok: true };
      }
      for (let i = 0; i < script.steps.length; i++) {
        const s = script.steps[i];
        emit('step-progress', { stepId: s.id, status: 'running' });
        if (opts.failAt === i) {
          emit('step-progress', { stepId: s.id, status: 'fail' });
          return { ok: false, failedStepId: s.id };
        }
        emit('step-progress', { stepId: s.id, status: 'pass' });
      }
      return { ok: true };
    }),
    /** 事件订阅/退订：旧内核（streaming=false）不实现，用于验证降级路径。 */
    ...(streaming
      ? {
          on: vi.fn((event: string, cb: (d: unknown) => void) => {
            if (!listeners[event]) listeners[event] = new Set();
            listeners[event].add(cb);
          }),
          off: vi.fn((event: string, cb: (d: unknown) => void) => {
            listeners[event]?.delete(cb);
          }),
        }
      : {}),
    emit,
  };
  return kernel;
}

function mountShell(script: Script, kernel: any) {
  const mount = document.createElement('div');
  const shell = new UiShell({ kernel, mount, script });
  shell.render();
  return { shell, mount };
}

describe('R3 运行全部：按钮与入口', () => {
  it('操作栏提供「运行全部」按钮（原"回放"改名），data-action=run-all', () => {
    const k = makeRunAllKernel();
    const { mount } = mountShell(makeScript(2), k);
    const btn = mount.querySelector('[data-action="run-all"]');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toBe('运行全部');
    // 旧的 "回放" 文案不应再出现在操作栏
    const actions = mount.querySelector('[data-actions]');
    expect(actions?.textContent).not.toContain('回放');
  });

  it('runAll() 调用内核 playback 并返回汇总结果', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(3), k);
    const res = await shell.runAll();
    expect(k.playback).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});

describe('R3 步骤运行态流转', () => {
  it('全部成功时，每步状态最终为 pass', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(3), k);
    await shell.runAll();
    expect(shell.getStepStatus('s0')).toBe('pass');
    expect(shell.getStepStatus('s1')).toBe('pass');
    expect(shell.getStepStatus('s2')).toBe('pass');
  });

  it('中途失败时，失败步为 fail，其后步骤保持 pending（不再执行）', async () => {
    const k = makeRunAllKernel({ failAt: 1 });
    const { shell } = mountShell(makeScript(4), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(false);
    expect(res.failedStepId).toBe('s1');
    expect(shell.getStepStatus('s0')).toBe('pass');
    expect(shell.getStepStatus('s1')).toBe('fail');
    expect(shell.getStepStatus('s2')).toBe('pending');
    expect(shell.getStepStatus('s3')).toBe('pending');
  });

  it('运行过程中能观察到 running 中间态（流式而非批处理黑盒）', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(2), k);
    const seen: string[] = [];
    shell.onStepStatusChange = (stepId, status) => seen.push(`${stepId}:${status}`);
    await shell.runAll();
    expect(seen).toEqual(['s0:running', 's0:pass', 's1:running', 's1:pass']);
  });

  it('再次 runAll 会先把所有步骤状态重置为 pending', async () => {
    const k = makeRunAllKernel({ failAt: 0 });
    const { shell } = mountShell(makeScript(2), k);
    await shell.runAll();
    expect(shell.getStepStatus('s0')).toBe('fail');
    // 换成全通过的内核再跑，旧的 fail 态不应残留
    (shell as any).kernel = makeRunAllKernel();
    await shell.runAll();
    expect(shell.getStepStatus('s0')).toBe('pass');
  });
});

describe('R3 步骤态渲染', () => {
  it('render 后 CFG 节点带运行态（data-cfg-status）', async () => {
    const k = makeRunAllKernel({ failAt: 1 });
    const { shell, mount } = mountShell(makeScript(3), k);
    await shell.runAll();
    expect(mount.querySelector('[data-cfg-node="s0"]')?.getAttribute('data-cfg-status')).toBe('pass');
    expect(mount.querySelector('[data-cfg-node="s1"]')?.getAttribute('data-cfg-status')).toBe('fail');
    expect(mount.querySelector('[data-cfg-node="s2"]')?.getAttribute('data-cfg-status')).toBe('pending');
    expect(mount.querySelector('[data-cfg-node="s1"]')?.className).toContain('is-fail');
  });

  it('失败时显示失败提醒（含失败步描述），成功时无提醒', async () => {
    const kFail = makeRunAllKernel({ failAt: 0 });
    const { shell, mount } = mountShell(makeScript(2), kFail);
    await shell.runAll();
    const notice = mount.querySelector('[data-run-notice]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('按钮0');

    const kOk = makeRunAllKernel();
    const { shell: s2, mount: m2 } = mountShell(makeScript(2), kOk);
    await s2.runAll();
    expect(m2.querySelector('[data-run-notice]')).toBeNull();
  });
});

describe('R3 运行跟随：该步截图（高亮已画进图），不再 locateVisual 叠框', () => {
  it('运行全部不调用 locateVisual（坐标映射会随舞台缩放对不齐）', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(3), k);
    await shell.runAll();
    expect(k.locateCalls).toEqual([]);
  });

  it('运行中与结束后舞台都不叠 [data-highlight] overlay', async () => {
    const k = makeRunAllKernel();
    const { shell, mount } = mountShell(makeScript(3), k);
    const overlayCounts: number[] = [];
    shell.onStepStatusChange = (_id, status) => {
      if (status === 'running') overlayCounts.push(mount.querySelectorAll('[data-highlight]').length);
    };
    await shell.runAll();
    expect(overlayCounts).toEqual([0, 0, 0]);
    expect(mount.querySelectorAll('[data-highlight]').length).toBe(0);
  });

  it('无 locator 的步骤（如纯 wait）不打断运行', async () => {
    const k = makeRunAllKernel();
    const script = makeScript(1);
    script.steps.push({ id: 'w0', type: 'wait', source: 'manual', params: { durationMs: 10 } });
    const { shell } = mountShell(script, k);
    const res = await shell.runAll();
    expect(res.ok).toBe(true);
    expect(k.locateCalls).toEqual([]);
    expect(shell.getStepStatus('w0')).toBe('pass');
  });

  it('locateVisual 抛错时不应中断运行全部（高亮是辅助能力）', async () => {
    const k = makeRunAllKernel();
    k.locateVisual = vi.fn(async () => {
      throw new Error('元素已消失');
    }) as any;
    const { shell } = mountShell(makeScript(2), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(true);
    expect(shell.getStepStatus('s1')).toBe('pass');
  });
});

describe('R3 向后兼容（OCP）', () => {
  it('旧内核（playback 忽略 onStepResult）仍能 runAll，汇总态据结果回填', async () => {
    const k = makeRunAllKernel({ streaming: false, failAt: 1 });
    const { shell } = mountShell(makeScript(3), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(false);
    expect(res.failedStepId).toBe('s1');
    // 无流式回调 → 依据汇总结果回填：失败步 fail，之前的步视为 pass
    expect(shell.getStepStatus('s0')).toBe('pass');
    expect(shell.getStepStatus('s1')).toBe('fail');
    expect(shell.getStepStatus('s2')).toBe('pending');
  });

  it('保留 playback() 方法向后兼容（不破坏既有调用方）', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(1), k);
    const res = await shell.playback();
    expect(res.ok).toBe(true);
  });
});

// 以下三例由「可运行性审查」角色裁定必须补齐（CODEBUDDY.md §4.1）：
// locateVisual 是真实 CDP 往返，耗时不定，fire-and-forget 的异步渲染存在
// 乱序与迟到两类真实缺陷，必须由测试守住；flatten 索引优化亦需功能不变的守护。
describe('R3 运行不再异步 locateVisual，故无乱序幽灵框', () => {
  it('即使 locateVisual 很慢，运行结束后舞台也没有 overlay', async () => {
    const k = makeRunAllKernel();
    k.locateVisual = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { x: 10, y: 20, width: 30, height: 40, visible: true, inViewport: true };
    }) as any;
    const { shell, mount } = mountShell(makeScript(2), k);
    await shell.runAll();
    expect(mount.querySelectorAll('[data-highlight]').length).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(mount.querySelectorAll('[data-highlight]').length).toBe(0);
  });

  it('playback 必须以单参调用（禁止把回调函数塞进 RPC 参数位）', async () => {
    // 回归守卫：函数无法跨 WebSocket 序列化，若再把回调放进参数位，
    // 真机上进度必然静默丢失（tsc/单测却会全绿）——见 CODEBUDDY.md §4.1。
    const k = makeRunAllKernel();
    const script = makeScript(2);
    const { shell } = mountShell(script, k);
    await shell.runAll();
    expect(k.playback).toHaveBeenCalledTimes(1);
    // runAll 现以 (script, fromStepId?) 调用（§2.7）；从头跑时第二参为 undefined（2 个参数）。
    expect(k.playback.mock.calls[0].length).toBe(2);
    expect(k.playback).toHaveBeenCalledWith(script, undefined);
  });

  it('运行结束后退订进度监听，多次 runAll 不叠加回调', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(2), k);
    await shell.runAll();
    await shell.runAll();
    await shell.runAll();
    // 每次运行订阅一次、退订一次 → 监听器集合最终为空
    expect(k.listeners['step-progress']?.size ?? 0).toBe(0);
    expect(k.on?.mock.calls.filter((c: unknown[]) => c[0] === 'step-progress')).toHaveLength(3);
    expect(k.off?.mock.calls.filter((c: unknown[]) => c[0] === 'step-progress')).toHaveLength(3);
  });

  it('内核不支持 on/off（旧内核）时不崩，降级为汇总回填', async () => {
    const k = makeRunAllKernel({ streaming: false });
    expect((k as any).on).toBeUndefined();
    const { shell } = mountShell(makeScript(2), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(true);
    expect(shell.getStepStatus('s1')).toBe('pass');
  });

  it('进度事件载荷缺字段/为 null 时静默忽略，不崩溃（跨 WS 边界兜底）', async () => {
    const k = makeRunAllKernel();
    const { shell } = mountShell(makeScript(1), k);
    k.playback = vi.fn(async () => {
      k.emit('step-progress', null);
      k.emit('step-progress', undefined);
      k.emit('step-progress', {});
      k.emit('step-progress', { stepId: 's0' }); // 缺 status
      k.emit('step-progress', { status: 'pass' }); // 缺 stepId
      k.emit('step-progress', { stepId: 's0', status: 'pass' }); // 合法
      return { ok: true };
    }) as any;
    const res = await shell.runAll();
    expect(res.ok).toBe(true);
    expect(shell.getStepStatus('s0')).toBe('pass');
  });

  it('步骤含 CFG children 时，高亮仍能按 id 命中嵌套子步骤（守住扁平索引优化）', async () => {
    const k = makeRunAllKernel();
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'Nested', version: '1.0.0' },
      steps: [
        {
          id: 'loop0',
          type: 'wait',
          source: 'manual',
          control: { kind: 'while', loopCount: 2 },
          children: [
            { id: 'inner0', type: 'click', source: 'manual', locator: { name: '内层按钮' } },
          ],
        },
      ],
    };
    const { shell } = mountShell(script, k);
    // 内核只上报内层子步骤，验证扁平索引能命中 children
    k.playback = vi.fn(async () => {
      k.emit('step-progress', { stepId: 'inner0', status: 'running' });
      k.emit('step-progress', { stepId: 'inner0', status: 'pass' });
      return { ok: true };
    }) as any;
    await shell.runAll();
    expect(shell.getStepStatus('inner0')).toBe('pass');
    expect(k.locateCalls).toEqual([]);
  });
});

describe('Import + 运行全部：禁止零反馈', () => {
  it('playback 抛错时 runAll 仍返回失败并渲染 [data-run-notice]', async () => {
    const k = makeRunAllKernel();
    k.playback = vi.fn(async () => { throw new Error('assertRunnableScript: bad if'); }) as any;
    const { shell, mount } = mountShell(makeScript(2), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(false);
    expect(mount.querySelector('[data-run-notice]')?.textContent).toMatch(/运行失败|bad if/);
  });

  it('playback 返回失败但没有 failedStepId 时仍有 run-notice（不能静默）', async () => {
    const k = makeRunAllKernel();
    k.playback = vi.fn(async () => ({ ok: false })) as any;
    const { shell, mount } = mountShell(makeScript(1), k);
    const res = await shell.runAll();
    expect(res.ok).toBe(false);
    expect(mount.querySelector('[data-run-notice]')).toBeTruthy();
  });
});
