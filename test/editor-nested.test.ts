// 测试先行（UI 主链路重构）：ScriptEditor 嵌套控制流 API。
// 覆盖「多选步骤包成组」这一本期核心交互的纯函数底座：
//   wrap(script, ids, kind)      —— 把选中步骤整体包进 if/while 组
//   updateNested(script, id, patch) —— 递归定位任意深度步骤并不可变更新
//   flatten(script)              —— 递归展平（测试断言辅助）
// 契约约束：children[0]=then / children[1]=else（与 cfg-view / executor 三方一致）。

import { describe, it, expect } from 'vitest';
import { ScriptEditor } from '../src/editor/editor';
import type { Script, Step, ControlKind } from '../src/types/step';

const base: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'CodeBuddy', version: '1.0.0' },
  steps: [
    { id: 's1', type: 'click', locator: { role: 'button', name: 'A' }, source: 'manual' },
    { id: 's2', type: 'fill', locator: { name: 'B' }, params: { value: 'x' }, source: 'manual' },
    { id: 's3', type: 'click', locator: { role: 'button', name: 'C' }, source: 'manual' },
  ],
};

function ids(s: Script): string[] {
  return ScriptEditor.flatten(s).map((x) => x.id);
}

describe('ScriptEditor.wrap（包成控制流组）', () => {
  it('wrap if：选中步骤进入 children，children[0]=then，children[1]=空 else', () => {
    const next = ScriptEditor.wrap(base, ['s1', 's2'], 'if');
    expect(base.steps).toHaveLength(3); // 原对象不可变
    expect(next.steps).toHaveLength(2); // 原 2 步 + 余下 1 步
    const grp = next.steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.children).toHaveLength(2);
    expect(grp.children![0].id).toBe('s1'); // then 分支
    expect(grp.children![1].id).toBe('s2'); // else 分支（当前空，复用同批步骤）
    // 余下步骤保持顺序
    expect(next.steps[1].id).toBe('s3');
  });

  it('wrap while：包成循环组，control.loopCount 默认 1，children=选中步', () => {
    const next = ScriptEditor.wrap(base, ['s2', 's3'], 'while');
    const grp = next.steps[0];
    expect(grp.control?.kind).toBe('while');
    expect(grp.control?.loopCount).toBe(1);
    expect(grp.children?.map((c) => c.id)).toEqual(['s2', 's3']);
    expect(next.steps[1].id).toBe('s1');
  });

  it('wrap 顺序保持：选中步骤按原树序收入 children（深优展平序）', () => {
    const next = ScriptEditor.wrap(base, ['s3', 's1'], 'if');
    expect(next.steps[0].children?.map((c) => c.id)).toEqual(['s1', 's3']);
  });

  it('wrap 空集合：不创建组、原样返回（边界安全）', () => {
    const next = ScriptEditor.wrap(base, [], 'if');
    expect(next.steps).toEqual(base.steps);
  });

  it('wrap 生成唯一组 id，且原步移入 children（flatten 仍可见原步）', () => {
    const next = ScriptEditor.wrap(base, ['s1'], 'if');
    expect(next.steps[0].id).toMatch(/^grp-/);
    expect(next.steps[0].children?.map((c) => c.id)).toEqual(['s1']);
    // 原步 s1 已存在于 children 内（不再作为顶层兄弟）
    expect(next.steps.some((s) => s.id === 's1')).toBe(false);
    // flatten 仍能展平出全部 3 步（含组内 s1）
    expect(ids(next).filter((x) => x.startsWith('s')).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('wrap 支持嵌套：可对已分组外的步骤再包（深度递归）', () => {
    const once = ScriptEditor.wrap(base, ['s1', 's2'], 'if');
    // 把 s3 包进 while，与既有 if 组并列（while 放首位）
    const twice = ScriptEditor.wrap(once, ['s3'], 'while');
    expect(twice.steps).toHaveLength(2);
    expect(twice.steps[0].control?.kind).toBe('while');
    expect(twice.steps[1].control?.kind).toBe('if');
  });
});

describe('ScriptEditor.updateNested（深层不可变更新）', () => {
  it('更新顶层步骤', () => {
    const next = ScriptEditor.updateNested(base, 's1', { params: { value: 'z' } });
    expect(base.steps[0].params?.value).toBeUndefined(); // 原对象不变
    expect(next.steps[0].params?.value).toBe('z');
  });

  it('更新 if 组 children 内的步骤（递归定位）', () => {
    const wrapped = ScriptEditor.wrap(base, ['s1', 's2'], 'if');
    const next = ScriptEditor.updateNested(wrapped, 's2', { params: { value: 'edited' } });
    expect(next.steps[0].children![1].params?.value).toBe('edited');
    expect(wrapped.steps[0].children![1].params?.value).toBe('x'); // 原不可变
  });

  it('更新不存在的 id：原样返回', () => {
    const next = ScriptEditor.updateNested(base, 'nope', { params: {} });
    expect(next).toEqual(base);
  });
});

describe('ScriptEditor.flatten（递归展平）', () => {
  it('展平含嵌套组的脚本', () => {
    const wrapped = ScriptEditor.wrap(base, ['s1', 's2'], 'if');
    // flatten 包含组节点自身 + 其 children（深度优先）
    expect(ids(wrapped).filter((x) => x.startsWith('s')).sort()).toEqual(['s1', 's2', 's3']);
  });
});

// 契约断言：wrap 仅接受 if/while（防止误加 choice 等分裂约定）
describe('控制流组契约', () => {
  it('wrap 拒绝非法 kind', () => {
    expect(() => (ScriptEditor.wrap as any)(base, ['s1'], 'sequence')).toThrow();
  });
});
