// 测试先行：M3-R1 WS 桥主动推送通道 + 边界兜底。
// 重点：sanitizeArgs 把 JSON 序列化产生的 null 还原为 undefined（防 null.target 崩溃）；
// serializeBuffers 把 Buffer 转 base64（跨 WS 安全）。

import { describe, it, expect } from 'vitest';
import { sanitizeArgs, serializeBuffers, assertRunnableScript } from '../src/ui/bridge-server';

describe('sanitizeArgs — WS 边界兜底', () => {
  it('把 null 元素还原为 undefined，其余透传', () => {
    expect(sanitizeArgs([null, { a: 1 }, 'x'])).toEqual([undefined, { a: 1 }, 'x']);
  });
  it('空数组返回空数组', () => {
    expect(sanitizeArgs([])).toEqual([]);
  });
  it('undefined 不会变成 null（保持 undefined）', () => {
    // JSON 序列化时 undefined 元素直接消失，这里验证兜底对已有 undefined 不动
    expect(sanitizeArgs([undefined, 2])).toEqual([undefined, 2]);
  });
});

describe('serializeBuffers — 跨 WS 序列化安全', () => {
  it('Buffer 转为 { __base64 }', () => {
    const r = serializeBuffers(Buffer.from('abc'));
    expect(r).toEqual({ __base64: Buffer.from('abc').toString('base64') });
  });
  it('嵌套数组/对象中的 Buffer 递归转换', () => {
    const r = serializeBuffers({ a: [Buffer.from('x')], b: 1 });
    expect(r).toEqual({ a: [{ __base64: Buffer.from('x').toString('base64') }], b: 1 });
  });
  it('null / 普通值原样返回', () => {
    expect(serializeBuffers(null)).toBeNull();
    expect(serializeBuffers('hi')).toBe('hi');
  });
});

// M3-R3 追加（可运行性审查第二轮打回项）：桥端 playback 分支的入参校验。
// 背景：桥端原先直接 `req.args[0] as Script` 交给 adapter.playback，
// 若客户端传来 null/undefined/缺 steps，会在 runScript 里读 null.steps 抛错，
// 被 runCli 吞成 {ok:false, failedStepId:undefined} → UI 弹"运行中断于步骤:(未知)"，
// 属 CODEBUDDY.md §4.1 清单 1 同类错误（静默误提示）。故须在桥端显式校验并回明确错误。
describe('assertRunnableScript — playback 入参校验（§4.1 清单 1）', () => {
  it('合法脚本：返回该脚本本身', () => {
    const s = { schema: 'electron-auto-test/step/v1', app: { name: 'a', version: '1' }, steps: [] };
    expect(assertRunnableScript(s)).toBe(s);
  });

  it('null / undefined 被拒绝并给出明确错误（而非交给 runScript 崩）', () => {
    expect(() => assertRunnableScript(null)).toThrow(/script/i);
    expect(() => assertRunnableScript(undefined)).toThrow(/script/i);
  });

  it('缺少 steps 数组的对象被拒绝', () => {
    expect(() => assertRunnableScript({})).toThrow(/steps/i);
    expect(() => assertRunnableScript({ steps: 'not-an-array' })).toThrow(/steps/i);
  });

  it('非对象（字符串/数字）被拒绝', () => {
    expect(() => assertRunnableScript('oops')).toThrow(/script/i);
    expect(() => assertRunnableScript(123)).toThrow(/script/i);
  });

  // 终审追加：只校验 steps 是数组还不够 —— 元素为 null 时
  // runNode 读 null.control 会崩，再被 runCli 吞成 failedStepId:undefined（静默误提示）。
  it('steps 元素为 null / undefined 被拒绝（防 runNode 读 null.control 崩溃）', () => {
    expect(() => assertRunnableScript({ steps: [null] })).toThrow(/step/i);
    expect(() => assertRunnableScript({ steps: [undefined] })).toThrow(/step/i);
    expect(() => assertRunnableScript({ steps: [{ id: 'a', type: 'click' }, null] })).toThrow(/step/i);
  });

  it('steps 元素为非对象（字符串/数字）被拒绝', () => {
    expect(() => assertRunnableScript({ steps: ['click'] })).toThrow(/step/i);
    expect(() => assertRunnableScript({ steps: [42] })).toThrow(/step/i);
  });

  it('错误信息指出出错的元素下标，便于排查', () => {
    expect(() => assertRunnableScript({ steps: [{ id: 'a', type: 'click' }, null] })).toThrow(/1/);
  });

  it('合法的多步脚本通过校验', () => {
    const s = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'a', version: '1' },
      steps: [{ id: 'a', type: 'click' }, { id: 'b', type: 'wait' }],
    };
    expect(assertRunnableScript(s)).toBe(s);
  });
});

// M3-R3 追加（可运行性审查第四轮打回项）：递归深度校验。
// 背景：前几轮只补了顶层 steps 元素校验，但 `children:[null]` 与 `steps:[null]` 是
// 同源递归缺陷 —— runNode 递归到 children 时同样读 `child.control` 崩溃，
// 再被 runCli 吞成 {ok:false, failedStepId:undefined} → UI 弹"(未知)"。
// 故必须一次性递归收口：遍历 steps 及每层 children，校验元素形状与 control.kind。
describe('assertRunnableScript — 递归深度校验（CFG children）', () => {
  const wrap = (steps: unknown[]) => ({
    schema: 'electron-auto-test/step/v1',
    app: { name: 'a', version: '1' },
    steps,
  });

  it('children 内含 null 元素被拒绝（防递归 runNode 读 null.control 崩溃）', () => {
    const bad = wrap([
      { id: 'g', type: 'click', control: { kind: 'sequence' }, children: [null] },
    ]);
    expect(() => assertRunnableScript(bad)).toThrow(/children/i);
  });

  it('children 内含非对象元素被拒绝', () => {
    const bad = wrap([
      { id: 'g', type: 'click', control: { kind: 'while', loopCount: 2 }, children: ['click'] },
    ]);
    expect(() => assertRunnableScript(bad)).toThrow(/children/i);
  });

  it('children 不是数组被拒绝', () => {
    const bad = wrap([
      { id: 'g', type: 'click', control: { kind: 'sequence' }, children: 'nope' },
    ]);
    expect(() => assertRunnableScript(bad)).toThrow(/children/i);
  });

  it('深层嵌套（children 的 children）中的坏元素也被拒绝', () => {
    const bad = wrap([
      {
        id: 'g1',
        type: 'click',
        control: { kind: 'sequence' },
        children: [
          { id: 'g2', type: 'click', control: { kind: 'while', loopCount: 1 }, children: [null] },
        ],
      },
    ]);
    expect(() => assertRunnableScript(bad)).toThrow(/children/i);
  });

  it('错误信息带完整路径（steps[i].children[j]），便于定位坏数据', () => {
    const bad = wrap([
      { id: 'ok', type: 'click' },
      { id: 'g', type: 'click', control: { kind: 'sequence' }, children: [{ id: 'c', type: 'click' }, null] },
    ]);
    // 路径需同时体现顶层下标 1 与 children 下标 1
    expect(() => assertRunnableScript(bad)).toThrow(/steps\[1\]\.children\[1\]/);
  });

  it('未知 control.kind 被拒绝（runNode 的 switch 会静默跳过，导致步骤"假通过"）', () => {
    const bad = wrap([{ id: 'g', type: 'click', control: { kind: 'forever' }, children: [] }]);
    expect(() => assertRunnableScript(bad)).toThrow(/control/i);
  });

  it('control 存在但不是对象 / kind 缺失被拒绝', () => {
    expect(() => assertRunnableScript(wrap([{ id: 'g', type: 'click', control: 'sequence' }]))).toThrow(/control/i);
    expect(() => assertRunnableScript(wrap([{ id: 'g', type: 'click', control: {} }]))).toThrow(/control/i);
  });

  it('step.id 非字符串被拒绝（进度事件以 stepId 为键，非字符串会让 UI 找不到步骤）', () => {
    expect(() => assertRunnableScript(wrap([{ id: 1, type: 'click' }]))).toThrow(/id/i);
    expect(() => assertRunnableScript(wrap([{ type: 'click' }]))).toThrow(/id/i);
  });

  it('未知 step.type 被拒绝（invokeAction 无分支可走，会崩在动作分发层）', () => {
    expect(() => assertRunnableScript(wrap([{ id: 'a', type: 'teleport' }]))).toThrow(/type/i);
  });

  it('合法 CFG 脚本（sequence + while + 嵌套 children）通过校验', () => {
    const s = wrap([
      { id: 'a', type: 'click' },
      {
        id: 'g',
        type: 'click',
        control: { kind: 'sequence' },
        children: [
          { id: 'b', type: 'fill' },
          {
            id: 'w',
            type: 'click',
            control: { kind: 'while', loopCount: 3 },
            children: [{ id: 'c', type: 'click' }],
          },
        ],
      },
      { id: 'i', type: 'assert', control: { kind: 'if' }, children: [{ id: 'then', type: 'click' }] },
    ]);
    expect(assertRunnableScript(s)).toBe(s);
  });

  it('叶子步骤省略 children / control 仍合法（向后兼容 v1 扁平脚本）', () => {
    const s = wrap([{ id: 'a', type: 'click', source: 'manual' }]);
    expect(assertRunnableScript(s)).toBe(s);
  });
});
