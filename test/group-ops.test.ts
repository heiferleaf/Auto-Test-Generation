// @vitest-environment jsdom
// B2 组操作修正与补全（spec §2.5）验收。
// A2 回归：if 打包不得把 N 叶直接塞进 children 当 then/else/丢弃；
//   正确形态：children[0]=含选中步骤的顺序组(True)，children[1]=空顺序组(False)。
// 其余：仅打包顺序组 / 组命名 / 拆包 / 设循环次数 / 选中组改 kind。

import { describe, it, expect } from 'vitest';
import { ScriptEditor } from '../src/editor/editor';
import type { Script, Step } from '../src/types/step';

function script(steps: Step[]): Script {
  return { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps };
}

const leaf = (id: string): Step => ({ id, type: 'click', locator: { role: 'button', name: id }, source: 'manual' });

describe('B2 ScriptEditor 组操作（§2.5）', () => {
  it('A2 回归：包成 if → children[0] 是含两步的顺序组(True)，children[1] 是空顺序组(False)', () => {
    const s = script([leaf('a'), leaf('b')]);
    const out = ScriptEditor.wrap(s, ['a', 'b'], 'if');
    expect(out.steps).toHaveLength(1);
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.children).toHaveLength(2);
    // True 分支：顺序组，含 a、b
    const trueBranch = grp.children![0];
    expect(trueBranch.control?.kind).toBe('sequence');
    expect(trueBranch.children?.map((c) => c.id)).toEqual(['a', 'b']);
    // False 分支：空顺序组
    const falseBranch = grp.children![1];
    expect(falseBranch.control?.kind).toBe('sequence');
    expect(falseBranch.children).toEqual([]);
  });

  it('A2 执行语义：mock 执行器 passed=true 跑 True 体内两步、passed=false 跳过（不丢第 2 步）', () => {
    const s = script([leaf('a'), leaf('b')]);
    const out = ScriptEditor.wrap(s, ['a', 'b'], 'if');
    const grp = out.steps[0];
    const ran: string[] = [];
    const runNode = (node: Step) => {
      if (node.control?.kind === 'sequence') {
        for (const c of node.children ?? []) runNode(c);
        return;
      }
      if (node.control?.kind === 'if') {
        const passed = true; // 模拟条件成立
        const chosen = passed ? node.children![0] : node.children![1];
        if (chosen) runNode(chosen);
        return;
      }
      ran.push(node.id);
    };
    runNode(grp);
    expect(ran).toEqual(['a', 'b']); // True：两步都跑（旧 bug 会只跑 a）
    // False 分支：空，跑不到任何叶子
    const ran2: string[] = [];
    const runNode2 = (node: Step) => {
      if (node.control?.kind === 'sequence') { for (const c of node.children ?? []) runNode2(c); return; }
      if (node.control?.kind === 'if') {
        const passed = false;
        const chosen = passed ? node.children![0] : node.children![1];
        if (chosen) runNode2(chosen);
        return;
      }
      ran2.push(node.id);
    };
    runNode2(grp);
    expect(ran2).toEqual([]); // False：空体，不跑
  });

  it('仅打包顺序组：多选 → sequence 组，子为原步骤（保持相对序），未选步骤留在原位', () => {
    const s = script([leaf('a'), leaf('b'), leaf('c')]);
    const out = ScriptEditor.wrap(s, ['a', 'c'], 'sequence');
    // 选中 a、c 进组；b 未选，留在顶层
    expect(out.steps).toHaveLength(2);
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('sequence');
    expect(grp.children?.map((c) => c.id)).toEqual(['a', 'c']);
    expect(out.steps[1].id).toBe('b');
  });

  it('拆包：选中顺序组 → 子步骤回到原层级，不删内容', () => {
    const s = script([leaf('a'), leaf('b')]);
    const packed = ScriptEditor.wrap(s, ['a', 'b'], 'sequence');
    const grpId = packed.steps[0].id;
    const out = ScriptEditor.unpack(packed, grpId);
    expect(out.steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('拆包：嵌套组也回到正确父层级（不摊平到顶层）', () => {
    const inner = ScriptEditor.wrap(script([leaf('a'), leaf('b')]), ['a', 'b'], 'sequence');
    const outer = ScriptEditor.wrap({ ...inner, steps: [...inner.steps, leaf('c')] }, [inner.steps[0].id], 'sequence');
    const outerGrpId = outer.steps[0].id;
    const out = ScriptEditor.unpack(outer, outerGrpId);
    // 拆外层后：内层 sequence 组 + c 回到顶层
    expect(out.steps.map((s) => s.id)).toEqual([inner.steps[0].id, 'c']);
  });

  it('设循环次数：while 组 → control.loopCount 更新', () => {
    const s = ScriptEditor.wrap(script([leaf('a')]), ['a'], 'while');
    const grpId = s.steps[0].id;
    const out = ScriptEditor.setLoopCount(s, grpId, 5);
    expect(out.steps[0].control?.loopCount).toBe(5);
  });

  it('组命名：control.name 写入（schema v2 加法式字段）', () => {
    const s = ScriptEditor.wrap(script([leaf('a')]), ['a'], 'sequence');
    const grpId = s.steps[0].id;
    const out = ScriptEditor.renameGroup(s, grpId, '登录流程');
    expect(out.steps[0].control?.name).toBe('登录流程');
  });

  it('选中组改 kind：sequence → if（当前 children 进 True，False 空）', () => {
    const s = ScriptEditor.wrap(script([leaf('a'), leaf('b')]), ['a', 'b'], 'sequence');
    const grpId = s.steps[0].id;
    const out = ScriptEditor.setGroupKind(s, grpId, 'if');
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.children).toHaveLength(2);
    expect(grp.children![0].control?.kind).toBe('sequence');
    expect(grp.children![0].children?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(grp.children![1].children).toEqual([]);
  });

  it('选中组改 kind：sequence → while（保留 children 为循环体，loopCount 默认 1）', () => {
    const s = ScriptEditor.wrap(script([leaf('a'), leaf('b')]), ['a', 'b'], 'sequence');
    const grpId = s.steps[0].id;
    const out = ScriptEditor.setGroupKind(s, grpId, 'while');
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('while');
    expect(grp.control?.loopCount).toBe(1);
    expect(grp.children?.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('选中组改 kind：if → sequence（True 分支内容回到顺序体）', () => {
    const s = ScriptEditor.wrap(script([leaf('a'), leaf('b')]), ['a', 'b'], 'if');
    const grpId = s.steps[0].id;
    const out = ScriptEditor.setGroupKind(s, grpId, 'sequence');
    const grp = out.steps[0];
    expect(grp.control?.kind).toBe('sequence');
    expect(grp.children?.map((c) => c.id)).toEqual(['a', 'b']); // True 分支内容
  });

  it('wrap 不可变：原 script 不被修改', () => {
    const s = script([leaf('a'), leaf('b')]);
    const snap = JSON.stringify(s);
    ScriptEditor.wrap(s, ['a', 'b'], 'if');
    expect(JSON.stringify(s)).toBe(snap);
  });
});

// ───────────────────────── UI 主链路 e2e（DOM 事件委托入口）─────────────────────────
import { UiShell } from '../src/ui/shell';

function makeMockKernelUI() {
  return {
    connect: (() => {}) as any,
    disconnect: (() => {}) as any,
    listTargets: (() => [{ id: 'main', type: 'page', title: '主窗口', url: 'app://main' }]) as any,
    selectTarget: (() => {}) as any,
    click: (() => {}) as any, fill: (() => {}) as any, select: (() => {}) as any,
    hover: (() => {}) as any, wait: (() => {}) as any, eval: (() => {}) as any,
    snapshot: (() => []) as any, query: (() => {}) as any,
    screenshot: (() => Buffer.from('f')) as any,
    locateVisual: (() => ({ x: 0, y: 0, width: 0, height: 0, visible: true, inViewport: true })) as any,
    startRecording: (() => {}) as any, stopRecording: (() => []) as any,
    playback: (() => ({ ok: true })) as any,
    startPick: (() => {}) as any, cancelPick: (() => {}) as any,
    on: (() => {}) as any, off: (() => {}) as any,
  } as any;
}

function bootUI(script?: Script) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const kernel = makeMockKernelUI();
  const shell = new UiShell({ kernel, mount, script });
  shell.render();
  return { shell, mount, kernel };
}

function clickEl(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('B2 组操作 UI 主链路（§2.5）', () => {
  it('仅打包：多选 2 步 → 点「仅打包」→ 顶层 1 个顺序组，子含两步', () => {
    const s: Script = {
      schema: 'electron-auto-test/step/v2', app: { name: 'T' },
      steps: [leaf('a'), leaf('b')],
    };
    const { shell, mount } = bootUI(s);
    clickEl(mount.querySelector('[data-step-item][data-step-id="a"]'));
    clickEl(mount.querySelector('[data-step-item][data-step-id="b"]'));
    clickEl(mount.querySelector('[data-action="wrap-sequence"]'));
    expect(shell.getScript().steps).toHaveLength(1);
    expect(shell.getScript().steps[0].control?.kind).toBe('sequence');
    expect(shell.getScript().steps[0].children?.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('拆包：选中顺序组 → 点「拆包」→ 子步骤回到顶层', () => {
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] },
      ['a', 'b'], 'sequence',
    );
    const grpId = packed.steps[0].id;
    const { shell, mount } = bootUI(packed);
    // 选中组打开详情区
    clickEl(mount.querySelector(`[data-step-item][data-step-id="${grpId}"]`));
    clickEl(mount.querySelector('[data-action="unpack"]'));
    expect(shell.getScript().steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('设为选择组：选中顺序组 → 点「设为选择组」→ children[0]=True(含体)，children[1]=False(空)', () => {
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a'), leaf('b')] },
      ['a', 'b'], 'sequence',
    );
    const grpId = packed.steps[0].id;
    const { shell, mount } = bootUI(packed);
    clickEl(mount.querySelector(`[data-step-item][data-step-id="${grpId}"]`));
    clickEl(mount.querySelector('[data-group-kind="if"]'));
    const grp = shell.getScript().steps[0];
    expect(grp.control?.kind).toBe('if');
    expect(grp.children?.[0].children?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(grp.children?.[1].children).toEqual([]);
  });

  it('组命名 + 循环次数：详情区改名与次数 → 保存 → control.name / loopCount 更新', () => {
    const packed = ScriptEditor.wrap(
      { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps: [leaf('a')] },
      ['a'], 'while',
    );
    const grpId = packed.steps[0].id;
    const { shell, mount } = bootUI(packed);
    clickEl(mount.querySelector(`[data-step-item][data-step-id="${grpId}"]`));
    const nameInput = mount.querySelector('[data-edit-field="control.name"]') as HTMLInputElement;
    const loopInput = mount.querySelector('[data-edit-field="control.loopCount"]') as HTMLInputElement;
    nameInput.value = '重试';
    loopInput.value = '7';
    clickEl(mount.querySelector('[data-action="save-edit"]'));
    const grp = shell.getScript().steps[0];
    expect(grp.control?.name).toBe('重试');
    expect(grp.control?.loopCount).toBe(7);
  });
});
