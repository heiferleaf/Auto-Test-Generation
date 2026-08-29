// 步骤级编辑纯函数单测（测试先行）。
// 覆盖 9 个纯函数 + 不可变性断言（调用后入参引用/内容不变）+ 跨组前序顺序。

import { describe, it, expect } from 'vitest';
import type { Script, Step } from '../src/types/step';
import {
  insertStep, removeStep, updateStep, moveStep,
  wrap, unwrap, addElse, removeElse, clearSteps,
} from '../src/script/edit';

function leaf(id: string, over: Partial<Step> = {}): Step {
  return { id, type: 'click', source: 'manual', ...over };
}

// 嵌套树：g1(sequence)[ a, g2(sequence)[ b, c ], d ]
function nestedScript(): Script {
  return {
    schema: 'electron-auto-test/step/v1',
    app: { name: 'CodeBuddy', version: '1.0.0' },
    steps: [
      leaf('a'),
      { id: 'g2', type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: [leaf('b'), leaf('c')] },
      leaf('d'),
    ],
  };
}

function baseScript(): Script {
  return {
    schema: 'electron-auto-test/step/v2',
    app: { name: 'WorkBuddy' },
    createdAt: '2026-08-29',
    note: 'meta',
    steps: [leaf('s1', { locator: { name: 'U' }, params: { value: 'x' } }), leaf('s2')],
  };
}

/** 深比较辅助：确认入参原样未被修改。 */
function expectUntouched(orig: unknown, snapshot: unknown): void {
  expect(orig).toEqual(snapshot);
}

describe('insertStep', () => {
  it('默认插到末尾', () => {
    const b = baseScript();
    const s = insertStep(b, leaf('s3'));
    expect(s.steps.map((x) => x.id)).toEqual(['s1', 's2', 's3']);
    expectUntouched(b, baseScript());
  });
  it('指定位置插入', () => {
    const b = baseScript();
    const s = insertStep(b, leaf('s3'), 1);
    expect(s.steps.map((x) => x.id)).toEqual(['s1', 's3', 's2']);
    expectUntouched(b, baseScript());
  });
  it('负数索引从末尾数', () => {
    const b = baseScript();
    const s = insertStep(b, leaf('s3'), -1); // 末尾之前
    expect(s.steps.map((x) => x.id)).toEqual(['s1', 's3', 's2']);
    expectUntouched(b, baseScript());
  });
});

describe('removeStep', () => {
  it('删除顶层叶子', () => {
    const b = baseScript();
    const s = removeStep(b, 's1');
    expect(s.steps.map((x) => x.id)).toEqual(['s2']);
    expectUntouched(b, baseScript());
  });
  it('递归删除嵌套深处的步骤', () => {
    const b = nestedScript();
    const s = removeStep(b, 'c');
    const ids = s.steps.flatMap((x) => [x.id, ...(x.children?.map((c) => c.id) ?? [])]);
    expect(ids).toEqual(['a', 'g2', 'b', 'd']);
    expectUntouched(b, nestedScript());
  });
  it('不存在的 id 抛错', () => {
    const b = baseScript();
    expect(() => removeStep(b, 'nope')).toThrow(/step not found: nope/);
    expectUntouched(b, baseScript());
  });
});

describe('updateStep', () => {
  it('部分字段合并', () => {
    const b = baseScript();
    const s = updateStep(b, 's2', { type: 'fill' });
    expect(s.steps[1].type).toBe('fill');
    expectUntouched(b, baseScript());
  });
  it('嵌套 locator 深合并', () => {
    const b = baseScript();
    const s = updateStep(b, 's1', { locator: { role: 'textbox' } });
    // locator 应合并：原 name 保留 + 新增 role。
    expect(s.steps[0].locator).toEqual({ name: 'U', role: 'textbox' });
    expect(b.steps[0].locator).toEqual({ name: 'U' }); // 原样
  });
  it('不存在的 id 抛错', () => {
    const b = baseScript();
    expect(() => updateStep(b, 'zzz', { type: 'fill' })).toThrow(/step not found: zzz/);
    expectUntouched(b, baseScript());
  });
});

describe('moveStep', () => {
  it('同组内调序（顶层）', () => {
    const b = baseScript();
    const s = moveStep(b, 's2', 0);
    expect(s.steps.map((x) => x.id)).toEqual(['s2', 's1']);
    expectUntouched(b, baseScript());
  });
  it('跨组移动：从嵌套组提到顶层', () => {
    const b = nestedScript();
    const s = moveStep(b, 'b', 0);
    expect(s.steps[0].id).toBe('b');
    const rest = s.steps.slice(1).flatMap((x) => [x.id, ...(x.children?.map((c) => c.id) ?? [])]);
    expect(rest).toEqual(['a', 'g2', 'c', 'd']);
    expectUntouched(b, nestedScript());
  });
  it('不存在的 id 抛错', () => {
    const b = baseScript();
    expect(() => moveStep(b, 'xx', 0)).toThrow(/step not found: xx/);
    expectUntouched(b, baseScript());
  });
});

describe('wrap', () => {
  it('sequence 包装，children 顺序=原树前序', () => {
    const b = baseScript();
    const s = wrap(b, ['s1', 's2'], 'sequence');
    expect(s.steps).toHaveLength(1);
    const g = s.steps[0];
    expect(g.control?.kind).toBe('sequence');
    expect(g.children?.map((c) => c.id)).toEqual(['s1', 's2']);
    expectUntouched(b, baseScript());
  });
  it('if 包装默认建 then/else 两个分支', () => {
    const b = baseScript();
    const s = wrap(b, ['s1'], 'if');
    const g = s.steps[0];
    expect(g.control?.kind).toBe('if');
    expect(g.children).toHaveLength(2);
    expect(g.children?.[0].control?.kind).toBe('sequence');
    expect(g.children?.[0].children?.map((c) => c.id)).toEqual(['s1']);
    expect(g.children?.[1].control?.kind).toBe('sequence');
    expect(g.children?.[1].children).toHaveLength(0); // else 空
    expectUntouched(b, baseScript());
  });
  it('while 包装，children 为循环体', () => {
    const b = baseScript();
    const s = wrap(b, ['s1', 's2'], 'while');
    const g = s.steps[0];
    expect(g.control?.kind).toBe('while');
    expect(g.control?.loopCount).toBe(1);
    expect(g.children?.map((c) => c.id)).toEqual(['s1', 's2']);
    expectUntouched(b, baseScript());
  });
  it('跨父组选中：children 按前序遍历顺序', () => {
    const b = nestedScript(); // a, g2[b,c], d
    const s = wrap(b, ['d', 'b', 'a'], 'sequence');
    // 第一个被选中项 a 在顶层 index 0，新组取代其位；同层未选中兄弟 g2 保留（children 已被摘除选中项）。
    expect(s.steps[0].control?.kind).toBe('sequence');
    expect(s.steps[0].children?.map((c) => c.id)).toEqual(['a', 'b', 'd']);
    expect(s.steps.map((x) => x.id)).toEqual([s.steps[0].id, 'g2']);
    expectUntouched(b, nestedScript());
  });
  it('空集合/找不到 id 抛错', () => {
    const b = baseScript();
    expect(() => wrap(b, [], 'sequence')).toThrow();
    expect(() => wrap(b, ['ghost'], 'if')).toThrow(/step not found/);
    expectUntouched(b, baseScript());
  });
});

describe('unwrap', () => {
  it('拆包摊平回父级', () => {
    const b = nestedScript();
    const s = unwrap(b, 'g2');
    // g2 的 children b,c 摊平到顶层，替换 g2 位置。
    expect(s.steps.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expectUntouched(b, nestedScript());
  });
  it('找不到 id 抛错', () => {
    const b = nestedScript();
    expect(() => unwrap(b, 'ghost')).toThrow(/step not found: ghost/);
    expectUntouched(b, nestedScript());
  });
});

describe('addElse / removeElse', () => {
  it('addElse 补空 else 分支', () => {
    const b = baseScript();
    const w = wrap(b, ['s1'], 'if');
    const gid = w.steps[0].id;
    const s = addElse(w, gid);
    const g = findById(s, gid);
    expect(g?.children).toHaveLength(2);
    expect(g?.children?.[1].children).toHaveLength(0);
    expectUntouched(w, w);
  });
  it('addElse 已有时不重复加', () => {
    const b = baseScript();
    const w = wrap(b, ['s1'], 'if');
    const gid = w.steps[0].id;
    const once = addElse(w, gid);
    const twice = addElse(once, gid);
    expect(twice.steps[0].children).toHaveLength(2);
  });
  it('removeElse 删除 else', () => {
    const b = baseScript();
    const w = wrap(b, ['s1'], 'if');
    const gid = w.steps[0].id;
    const withElse = addElse(w, gid);
    const s = removeElse(withElse, gid);
    expect(findById(s, gid)?.children).toHaveLength(1);
    expectUntouched(withElse, withElse);
  });
  it('非 if 组抛错', () => {
    const b = baseScript();
    const w = wrap(b, ['s1', 's2'], 'sequence');
    const gid = w.steps[0].id;
    expect(() => addElse(w, gid)).toThrow(/非 if 组/);
    expectUntouched(w, w);
  });
  it('不存在 id 抛错', () => {
    const b = baseScript();
    expect(() => addElse(b, 'ghost')).toThrow(/step not found: ghost/);
  });
});

describe('clearSteps', () => {
  it('清空步骤但保留元信息', () => {
    const b = baseScript();
    const s = clearSteps(b);
    expect(s.steps).toEqual([]);
    expect(s.app).toEqual({ name: 'WorkBuddy' });
    expect(s.schema).toBe('electron-auto-test/step/v2');
    expect(s.createdAt).toBe('2026-08-29');
    expect(s.note).toBe('meta');
    expectUntouched(b, baseScript());
  });
});

describe('不可变性（引用级）', () => {
  it('所有函数不修改入参引用', () => {
    const b = nestedScript();
    const ref = b.steps;
    insertStep(b, leaf('z'));
    removeStep(b, 'a');
    updateStep(b, 'a', { type: 'fill' });
    moveStep(b, 'b', 0);
    wrap(b, ['a', 'b'], 'if');
    unwrap(b, 'g2');
    clearSteps(b);
    expect(b.steps).toBe(ref); // 同一数组引用
    expect(b).toEqual(nestedScript());
  });
});

function findById(script: Script, id: string): Step | undefined {
  const stack: Step[] = [...script.steps];
  while (stack.length) {
    const s = stack.pop()!;
    if (s.id === id) return s;
    if (s.children) stack.push(...s.children);
  }
  return undefined;
}
