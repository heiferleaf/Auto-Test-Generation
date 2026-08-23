// 测试先行（R3 修正案）：执行器逐步进度钩子。
//
// 背景（可运行性审查裁定）：R3 最初把 onStepResult 回调放进 UiKernel.playback 参数位，
// 但 UiKernel 会被 WsKernel 跨 WebSocket 实现 —— 函数无法 JSON 序列化，真机上流式回显
// 100% 失效（且 tsc/单测全绿，属 CODEBUDDY.md §4.1 盲区）。裁定方案：
//   进度源放在 Node 进程内（executor → cli → adapter），
//   再由 bridge-server 经 R1 已有的 pushEvent 单向推送给浏览器端。
// 本文件守住第一环：executor/cli 的进度钩子（纯进程内函数传递，合法）。

import { describe, it, expect, vi } from 'vitest';
import type { CdpAdapter, Locator, TargetInfo, VisualRect, SerializedNode } from '../src/cdp/adapter';
import type { Script, Step } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';
import { runScript, type StepProgress } from '../src/executor/executor';
import { runCli } from '../src/cli';

/** 最小 adapter 桩：记录动作调用顺序，可指定某步抛错。 */
function makeStubAdapter(failOnName?: string) {
  const calls: string[] = [];
  const adapter = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): TargetInfo[] => []),
    selectTarget: vi.fn((_id: string) => {}),
    click: vi.fn(async (l: Locator) => {
      calls.push(`click:${l.name}`);
      if (failOnName && l.name === failOnName) throw new Error('点击失败');
    }),
    fill: vi.fn(async (l: Locator, v: string) => { calls.push(`fill:${l.name}=${v}`); }),
    select: vi.fn(async (_l: Locator, _o: string) => {}),
    hover: vi.fn(async (_l: Locator) => {}),
    wait: vi.fn(async (_o?: { text?: string; durationMs?: number }) => { calls.push('wait'); }),
    eval: vi.fn(async (_c: string) => undefined),
    snapshot: vi.fn(async (): Promise<SerializedNode[]> => []),
    query: vi.fn(async (_l: Locator) => undefined),
    screenshot: vi.fn(async () => Buffer.from('x')),
    locateVisual: vi.fn(async (_l: Locator): Promise<VisualRect> => ({
      x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true,
    })),
  } as unknown as CdpAdapter & { calls: string[] };
  (adapter as any).calls = calls;
  return adapter as CdpAdapter & { calls: string[] };
}

function scriptOf(steps: Step[]): Script {
  return { schema: SCRIPT_SCHEMA, app: { name: 'Prog', version: '1.0.0' }, steps };
}

const clickStep = (id: string, name: string): Step => ({
  id, type: 'click', source: 'manual', locator: { name },
});

describe('executor 逐步进度钩子', () => {
  it('runScript 对每个叶子步骤依次回调 running 再 pass', async () => {
    const adapter = makeStubAdapter();
    const seen: string[] = [];
    const onStep: StepProgress = (stepId, status) => seen.push(`${stepId}:${status}`);
    await runScript(adapter, scriptOf([clickStep('a', 'A'), clickStep('b', 'B')]), onStep);
    expect(seen).toEqual(['a:running', 'a:pass', 'b:running', 'b:pass']);
  });

  it('步骤抛错时回调 fail，且后续步骤不再回调', async () => {
    const adapter = makeStubAdapter('B');
    const seen: string[] = [];
    await expect(
      runScript(adapter, scriptOf([clickStep('a', 'A'), clickStep('b', 'B'), clickStep('c', 'C')]),
        (id, st) => seen.push(`${id}:${st}`)),
    ).rejects.toThrow();
    expect(seen).toEqual(['a:running', 'a:pass', 'b:running', 'b:fail']);
  });

  it('不传 onStep 时行为完全不变（向后兼容）', async () => {
    const adapter = makeStubAdapter();
    await runScript(adapter, scriptOf([clickStep('a', 'A')]));
    expect(adapter.calls).toEqual(['click:A']);
  });

  it('CFG 循环内的子步骤每轮都回调（进度反映真实执行次数）', async () => {
    const adapter = makeStubAdapter();
    const seen: string[] = [];
    const loop: Step = {
      id: 'loop', type: 'wait', source: 'manual',
      control: { kind: 'while', loopCount: 2 },
      children: [clickStep('in', 'IN')],
    };
    await runScript(adapter, scriptOf([loop]), (id, st) => seen.push(`${id}:${st}`));
    expect(seen).toEqual(['in:running', 'in:pass', 'in:running', 'in:pass']);
  });

  it('控制流节点自身不产生叶子进度（只有可执行叶子步骤上报）', async () => {
    const adapter = makeStubAdapter();
    const ids: string[] = [];
    const seq: Step = {
      id: 'seq', type: 'wait', source: 'manual',
      control: { kind: 'sequence' },
      children: [clickStep('x', 'X')],
    };
    await runScript(adapter, scriptOf([seq]), (id) => { if (!ids.includes(id)) ids.push(id); });
    expect(ids).toEqual(['x']); // 'seq' 不出现
  });
});

// 可运行性审查第四轮追加：执行器侧「双保险」。
// 桥边界已递归校验，但脚本还可能从 CLI 文件导入 / 未来 MCP Tool 进来。
// 若 children 里混入 null，runNode 递归读 `child.control` 会抛
// "Cannot read properties of null" —— 这个报错不带 stepId，
// runCli 只能返回 failedStepId:undefined，UI 显示"(未知)"，根因被掩盖。
// 故 runNode 内加轻量守卫，抛出「带定位信息」的明确错误。
describe('runNode 坏子节点守卫（双保险）', () => {
  it('children 内含 null 时抛出明确错误（而非 null.control 的晦涩 TypeError）', async () => {
    const adapter = makeStubAdapter();
    const seq: Step = {
      id: 'seq', type: 'wait', source: 'manual',
      control: { kind: 'sequence' },
      children: [null as unknown as Step],
    };
    await expect(runScript(adapter, scriptOf([seq]))).rejects.toThrow(/seq/);
  });

  it('错误信息不是 "Cannot read properties of null"（须可定位到父节点）', async () => {
    const adapter = makeStubAdapter();
    const seq: Step = {
      id: 'badParent', type: 'wait', source: 'manual',
      control: { kind: 'while', loopCount: 1 },
      children: [undefined as unknown as Step],
    };
    await expect(runScript(adapter, scriptOf([seq]))).rejects.toThrow(/badParent/);
    await expect(runScript(adapter, scriptOf([seq]))).rejects.not.toThrow(/Cannot read propert/);
  });

  it('runCli 遇到坏子节点时返回 ok:false（不崩进程）', async () => {
    const adapter = makeStubAdapter();
    const seq: Step = {
      id: 'seq', type: 'wait', source: 'manual',
      control: { kind: 'sequence' },
      children: [null as unknown as Step],
    };
    const res = await runCli({ adapter, script: scriptOf([seq]) });
    expect(res.ok).toBe(false);
  });
});

describe('runCli 透传进度钩子', () => {
  it('runCli 把 onStep 透传给 runScript，成功时汇总 ok', async () => {
    const adapter = makeStubAdapter();
    const seen: string[] = [];
    const res = await runCli({
      adapter,
      script: scriptOf([clickStep('a', 'A')]),
      onStep: (id, st) => seen.push(`${id}:${st}`),
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['a:running', 'a:pass']);
  });

  it('失败时既回调 fail 又返回 failedStepId', async () => {
    const adapter = makeStubAdapter('A');
    const seen: string[] = [];
    const res = await runCli({
      adapter,
      script: scriptOf([clickStep('a', 'A')]),
      onStep: (id, st) => seen.push(`${id}:${st}`),
    });
    expect(res.ok).toBe(false);
    expect(res.failedStepId).toBe('a');
    expect(seen).toEqual(['a:running', 'a:fail']);
  });

  it('onStep 自身抛错不得影响脚本执行结果（进度上报是辅助能力）', async () => {
    const adapter = makeStubAdapter();
    const res = await runCli({
      adapter,
      script: scriptOf([clickStep('a', 'A')]),
      onStep: () => { throw new Error('订阅方炸了'); },
    });
    expect(res.ok).toBe(true);
    expect(adapter.calls).toEqual(['click:A']);
  });
});
