// @vitest-environment jsdom
// 测试先行（M3-R4）：CFG 图形化视图（控制流图）。
//
// 需求依据（原文）：docs/design/visual-mask-ui-spec.md §2.7：
//   · 控制流图：「节点=组/步；边=执行流向；顺序组竖向排列，选择组分叉为真假两枝，循环组画回环边」
//   · 选中节点：「点击图节点↔点击列表项双向联动；选中后 §2.6 详情区可编辑」
//   · 运行态高亮：「执行到某节点→图中该节点高亮（失败变红），与 §2.5 截图流高亮同步」
// 以及 docs/plan/plan.md 阶段 M3-R4（新增 `src/ui/cfg-view.ts`，SRP；`index.html` 加 `.ui-shell-cfg` 区）。
//
// 本文件为新增独立测试，自带 mock kernel，不修改既有 ui-shell.test.ts /
// ui-shell-run-all.test.ts / ui-shell-live-recording.test.ts 的 mock 契约
// （CODEBUDDY.md：测试代码权威性，既有基建不得为迁就实现而改）。
//
// 关键约定（与执行器保持一致，不可自行发明）：
//   `if` 组的 children[0] = then 分支、children[1] = else 分支。
//   依据 src/executor/executor.ts 的 runNode：`const chosen = result.passed ? branches[0] : branches[1]`。
//   若图把两枝画反，用户看到的流向就与真实执行相反 —— 属最危险的 UI 谬误，故必须测。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import type { Locator, Script, Step } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';
import { UiShell } from '../src/ui/shell';
import { buildCfgGraph, CfgView, branchEdgeLine, loopEdgePath, isInwardVIntoGroup } from '../src/ui/cfg-view';
import { importScript } from '../src/script/io';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../scripts/fixtures');
const CFG_CONNECTORS_JSON = readFileSync(join(FIXTURE_DIR, 'cfg-connectors-sample.json'), 'utf8');

// ───────────────────────── 测试夹具 ─────────────────────────

const leaf = (id: string, type: Step['type'] = 'click'): Step => ({
  id, type, source: 'manual', locator: { name: `元素${id}` },
});

const group = (
  id: string,
  kind: 'sequence' | 'if' | 'while',
  children: Step[],
  extra: Partial<Step['control']> = {},
): Step => ({
  id,
  type: kind === 'if' ? 'assert' : 'wait',
  source: 'manual',
  control: { kind, ...extra } as Step['control'],
  children,
});

const scriptOf = (steps: Step[]): Script => ({
  schema: SCRIPT_SCHEMA, app: { name: 'Cfg', version: '1.0.0' }, steps,
});

function makeKernel() {
  const listeners: Record<string, Set<(d: unknown) => void>> = {};
  const emit = (event: string, data: unknown) => listeners[event]?.forEach((cb) => cb(data));
  return {
    listeners,
    emit,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => []),
    selectTarget: vi.fn(() => {}),
    click: vi.fn(async (_l: Locator) => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async (): Promise<any[]> => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async (): Promise<Buffer> => Buffer.from('x')),
    locateVisual: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1, visible: true, inViewport: true })),
    startRecording: vi.fn(() => {}),
    stopRecording: vi.fn(async () => []),
    playback: vi.fn(async (script: Script) => {
      // 逐叶子推进度（与真机 bridge 行为一致：单参 playback + step-progress 事件）
      const walk = (steps: Step[]): void => {
        for (const s of steps) {
          if (s.control) { walk(s.children ?? []); continue; }
          emit('step-progress', { stepId: s.id, status: 'running' });
          emit('step-progress', { stepId: s.id, status: 'pass' });
        }
      };
      walk(script.steps);
      return { ok: true };
    }),
    on: vi.fn((event: string, cb: (d: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(cb);
    }),
    off: vi.fn((event: string, cb: (d: unknown) => void) => { listeners[event]?.delete(cb); }),
  };
}

function mountShell(script: Script) {
  const kernel = makeKernel();
  const mount = document.createElement('div');
  const shell = new UiShell({ kernel: kernel as any, mount, script });
  shell.render();
  return { shell, mount, kernel };
}

const nodeEls = (mount: HTMLElement) => [...mount.querySelectorAll('[data-cfg-node]')];
const nodeIds = (mount: HTMLElement) =>
  nodeEls(mount).map((el) => el.getAttribute('data-cfg-node'));

// ───────────────── 1. 图模型构建（纯函数，与 DOM 解耦）─────────────────

describe('buildCfgGraph：从 Script 构建控制流图模型', () => {
  it('扁平顺序脚本：节点按序、边为链式流向', () => {
    const g = buildCfgGraph(scriptOf([leaf('a'), leaf('b'), leaf('c')]));
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(g.edges).toEqual([
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'b', to: 'c', kind: 'flow' },
    ]);
  });

  it('顺序组：组节点携带 children，且子节点内部链式相连', () => {
    const g = buildCfgGraph(scriptOf([group('g', 'sequence', [leaf('x'), leaf('y')])]));
    const gn = g.nodes.find((n) => n.id === 'g');
    expect(gn?.kind).toBe('sequence');
    expect(gn?.children.map((c) => c.id)).toEqual(['x', 'y']);
    expect(g.edges).toContainEqual({ from: 'x', to: 'y', kind: 'flow' });
  });

  it('选择组：分叉为真假两枝，children[0]=then / children[1]=else（与执行器一致）', () => {
    const g = buildCfgGraph(scriptOf([
      group('i', 'if', [leaf('t'), leaf('f')]),
    ]));
    // 两条从判断节点出发的分支边，分别标注 true / false
    expect(g.edges).toContainEqual({ from: 'i', to: 't', kind: 'true' });
    expect(g.edges).toContainEqual({ from: 'i', to: 'f', kind: 'false' });
    expect(g.edges).not.toContainEqual({ from: 't', to: 'f', kind: 'flow' });
  });

  it('选择组只有 then 分支时，不臆造 else 边', () => {
    const g = buildCfgGraph(scriptOf([group('i', 'if', [leaf('t')])]));
    expect(g.edges).toContainEqual({ from: 'i', to: 't', kind: 'true' });
    expect(g.edges.some((e) => e.kind === 'false')).toBe(false);
  });

  it('循环组：画回环边（末子节点回到循环头）', () => {
    const g = buildCfgGraph(scriptOf([
      group('w', 'while', [leaf('p'), leaf('q')], { loopCount: 3 }),
    ]));
    expect(g.edges).toContainEqual({ from: 'p', to: 'q', kind: 'flow' });
    // 回环：循环体最后一步回到循环头。不从组头再拉 flow 进第一个子节点。
    expect(g.edges).not.toContainEqual({ from: 'w', to: 'p', kind: 'flow' });
    expect(g.edges).toContainEqual({ from: 'q', to: 'w', kind: 'loop' });
  });

  it('循环组的 loopCount 暴露在节点上（供图上显示"×N"）', () => {
    const g = buildCfgGraph(scriptOf([group('w', 'while', [leaf('p')], { loopCount: 5 })]));
    const w = g.nodes.find((n) => n.id === 'w');
    // CfgNode 是判别联合（isLeaf 判别位）：先收窄到组节点才有 loopCount。
    expect(w && !w.isLeaf ? w.loopCount : undefined).toBe(5);
  });

  it('嵌套（循环内含选择）：层级与边同时正确', () => {
    const g = buildCfgGraph(scriptOf([
      group('w', 'while', [group('i', 'if', [leaf('t'), leaf('f')])], { loopCount: 2 }),
    ]));
    const w = g.nodes.find((n) => n.id === 'w');
    expect(w?.children.map((c) => c.id)).toEqual(['i']);
    expect(w?.children[0].children.map((c) => c.id)).toEqual(['t', 'f']);
    expect(g.edges).toContainEqual({ from: 'i', to: 't', kind: 'true' });
    expect(g.edges).toContainEqual({ from: 'i', to: 'f', kind: 'false' });
  });

  it('空脚本：返回空图而非抛错', () => {
    const g = buildCfgGraph(scriptOf([]));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('叶子节点标注 isLeaf，组节点不标（供渲染区分形状）', () => {
    const g = buildCfgGraph(scriptOf([leaf('a'), group('g', 'sequence', [leaf('b')])]));
    expect(g.nodes.find((n) => n.id === 'a')?.isLeaf).toBe(true);
    expect(g.nodes.find((n) => n.id === 'g')?.isLeaf).toBe(false);
  });

  it('坏数据（children 含 null）不致崩溃（防御性，与桥边界校验同族）', () => {
    const bad = scriptOf([
      { ...group('g', 'sequence', []), children: [null as unknown as Step] },
    ]);
    expect(() => buildCfgGraph(bad)).not.toThrow();
  });

  // 可运行性审查终审打回：`assertNeverControlKind` 会在运行时 throw，
  // 而 io.ts 的导入期校验只覆盖 importScript（本地文件）这一条路径。
  // 录制直接构造 Script、Agent 经 MCP 构造、R5 版本层还原旧数据，
  // 都能让未知 kind 绕过校验直达渲染层 → 同步栈抛错 → **整页白屏**。
  // 渲染层必须降级（画"未知控制结构"占位 + warn），把硬失败留给导入期。
  it('未知 control.kind 直达 buildCfgGraph 时降级而不抛错（防白屏）', () => {
    const dirty = scriptOf([
      { ...group('g', 'sequence', [leaf('x')]), control: { kind: 'switch' as never } },
    ]);
    expect(() => buildCfgGraph(dirty)).not.toThrow();
    const g = buildCfgGraph(dirty);
    // 节点仍在图中（不静默消失），但被标为未知结构
    expect(g.nodes.map((n) => n.id)).toEqual(['g']);
  });
});

// ───────────────── 2. DOM 渲染（§2.7 顺序竖向 / 分叉 / 回环）─────────────────

describe('CfgView 渲染：节点与边', () => {
  it('在 .ui-shell-cfg 区渲染出每个步骤/组的节点（带 data-cfg-node=stepId）', () => {
    const { mount } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    expect(mount.querySelector('.ui-shell-cfg')).toBeTruthy();
    expect(nodeIds(mount)).toEqual(['a', 'b']);
  });

  it('组节点用 data-cfg-kind 标注控制结构（sequence/if/while）', () => {
    const { mount } = mountShell(scriptOf([
      group('g', 'sequence', [leaf('x')]),
      group('w', 'while', [leaf('y')], { loopCount: 2 }),
      group('i', 'if', [leaf('t')]),
    ]));
    const kindOf = (id: string) =>
      mount.querySelector(`[data-cfg-node="${id}"]`)?.getAttribute('data-cfg-kind');
    expect(kindOf('g')).toBe('sequence');
    expect(kindOf('w')).toBe('while');
    expect(kindOf('i')).toBe('if');
  });

  it('选择组的两枝在 DOM 上可区分真假（data-cfg-branch=true/false）', () => {
    const { mount } = mountShell(scriptOf([group('i', 'if', [leaf('t'), leaf('f')])]));
    const branchOf = (id: string) =>
      mount.querySelector(`[data-cfg-node="${id}"]`)?.closest('[data-cfg-branch]')
        ?.getAttribute('data-cfg-branch');
    expect(branchOf('t')).toBe('true');
    expect(branchOf('f')).toBe('false');
  });

  it('循环组渲染回环标记与次数（×N）', () => {
    const { mount } = mountShell(scriptOf([group('w', 'while', [leaf('p')], { loopCount: 4 })]));
    const el = mount.querySelector('[data-cfg-node="w"]');
    expect(el?.querySelector('[data-cfg-loop]')).toBeTruthy();
    expect(el?.textContent).toContain('4');
  });

  it('嵌套结构在 DOM 上体现为嵌套包含关系（子节点在父节点内部）', () => {
    const { mount } = mountShell(scriptOf([group('g', 'sequence', [leaf('x')])]));
    const parent = mount.querySelector('[data-cfg-node="g"]')!;
    expect(parent.querySelector('[data-cfg-node="x"]')).toBeTruthy();
  });

  it('未知 control.kind 直达渲染层时不白屏，降级为「未知控制结构」占位节点', () => {
    const dirty = scriptOf([
      { ...group('g', 'sequence', [leaf('x')]), control: { kind: 'switch' as never } },
    ]);
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });

    // 关键：渲染层同步栈内不得抛错（抛了就是整页白屏）
    expect(() => view.update(dirty)).not.toThrow();

    const node = host.querySelector('[data-cfg-node="g"]');
    expect(node).toBeTruthy();
    // 标记为未知，让问题可见（既不静默按顺序组错渲，也不崩）
    expect(node!.getAttribute('data-cfg-kind')).toBe('unknown');
    expect(node!.textContent).toContain('未知');
  });

  it('未知 control.kind 的脚本经 UiShell 渲染也不崩（真实入口）', () => {
    const dirty = scriptOf([
      { ...group('g', 'sequence', [leaf('x')]), control: { kind: 'switch' as never } },
    ]);
    expect(() => mountShell(dirty)).not.toThrow();
  });

  it('脚本为空时渲染空态提示而非空白/报错', () => {
    const { mount } = mountShell(scriptOf([]));
    expect(mount.querySelector('.ui-shell-cfg')).toBeTruthy();
    expect(nodeEls(mount).length).toBe(0);
    expect(mount.querySelector('[data-cfg-empty]')).toBeTruthy();
  });
});

// ───────────────── 3. 双向联动（§2.7「点击图节点↔点击列表项」）─────────────────

describe('双向联动：图节点选中', () => {

  it('选中切换时，旧选中态被清除（同时只有一个选中）', () => {
    const { mount } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    (mount.querySelector('[data-cfg-node="a"]') as HTMLElement).click();
    (mount.querySelector('[data-cfg-node="b"]') as HTMLElement).click();

    expect(mount.querySelectorAll('[data-cfg-selected="true"]').length).toBe(1);
    expect(mount.querySelector('[data-cfg-node="b"]')!.getAttribute('data-cfg-selected')).toBe('true');
  });

  // 可运行性审查打回项：stepId 含 CSS 特殊字符时，用模板串拼 querySelector
  // （`[data-step-id="${id}"]`）在真实 Chromium 会抛 SyntaxError 使整页 JS 中断；
  // jsdom 下则静默选空。步骤 id 由脚本自由命名（可能含引号/空格/括号），必须能消纳。
  it('stepId 含 CSS 特殊字符（引号/反斜杠/括号/空格）时选中不崩且能正确命中', () => {
    const weird = ['a"b', 'a\\b', 'a]b', 'a b', 'a.b#c', "a'b"];
    const { mount, shell } = mountShell(scriptOf(weird.map((id) => leaf(id))));

    for (const id of weird) {
      expect(() => shell.selectStep(id)).not.toThrow();
      expect(shell.getSelectedStepId()).toBe(id);
      // 选中态必须真的落到该节点上（而非静默选空）
      const selected = [...mount.querySelectorAll('[data-cfg-selected="true"]')]
        .map((el) => el.getAttribute('data-cfg-node'));
      expect(selected).toEqual([id]);
    }
  });

  it('stepId 含特殊字符时，点击图节点仍能正确联动选中', () => {
    const id = 'btn "确定" (1)';
    const { mount, shell } = mountShell(scriptOf([leaf(id), leaf('plain')]));
    const node = mount.querySelector(`[data-cfg-node]`) as HTMLElement;
    expect(node.getAttribute('data-cfg-node')).toBe(id);
    expect(() => node.click()).not.toThrow();
    expect(shell.getSelectedStepId()).toBe(id);
  });

  // code-review 复核轮打回：`resetRunStatus` 会调 `cfgView.update()`，
  // 而 update 内部把自己的 selectedId 清空 —— 但 UiShell.selectedStepId 没变，
  // 结果整个运行期间"列表显示选中、图上丢失"，两个兄弟视图状态分叉。
  it('运行全部之后选中态在 CFG 上保留（重建图不得丢选中）', async () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    shell.selectStep('b');
    await shell.runAll();

    expect(shell.getSelectedStepId()).toBe('b');
    expect(mount.querySelector('[data-cfg-node="b"]')!.getAttribute('data-cfg-selected')).toBe('true');
  });

  it('选中态在 CFG 上可见（不再并排维护步骤列表）', () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    shell.selectStep('a');
    const cfgSel = [...mount.querySelectorAll('[data-cfg-selected="true"]')]
      .map((el) => el.getAttribute('data-cfg-node'));
    expect(cfgSel).toEqual(['a']);
  });

  it('选中的 CFG 节点带 is-selected class（属性之外还要有可见样式挂点）', () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    shell.selectStep('a');
    expect(mount.querySelector('[data-cfg-node="a"]')!.className).toContain('is-selected');
    expect(mount.querySelector('[data-cfg-node="b"]')!.className).not.toContain('is-selected');
  });

  it('UiShell 暴露 selectStep / getSelectedStepId 作为唯一选中态真相源', () => {
    const { shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    expect(shell.getSelectedStepId()).toBeUndefined();
    shell.selectStep('b');
    expect(shell.getSelectedStepId()).toBe('b');
  });

  it('选中组节点也可行（组也是节点，§2.7 "高亮某组/步"）', () => {
    const { mount, shell } = mountShell(scriptOf([group('g', 'sequence', [leaf('x')])]));
    (mount.querySelector('[data-cfg-node="g"]') as HTMLElement).click();
    expect(shell.getSelectedStepId()).toBe('g');
  });

  it('选中不存在的步骤 id 时不产生选中态（防脏数据）', () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a')]));
    shell.selectStep('nope');
    expect(mount.querySelectorAll('[data-cfg-selected="true"]').length).toBe(0);
  });
});

// ───────────────── 4. 运行态高亮同步（§2.7「失败变红」）─────────────────

describe('运行态高亮：CFG 节点随执行进度联动', () => {
  it('运行中 running 步在图上标注运行态（且同时只有一个 running）', async () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    const seen: string[] = [];
    // 用 UiShell 的公开状态钩子观察 —— 它在状态落到 DOM 之后触发。
    //
    // 为何不用 `kernel.on('step-progress')` 直接观察：那是**内核层**事件，
    // 与 shell 自己的处理器同为订阅者，触发顺序取决于注册先后。测试若抢先注册，
    // 读到的必然是 shell 尚未更新的 DOM —— 那是监听器顺序的产物，不是需求。
    // 需求（spec §2.7）是"执行到某节点→图中该节点高亮"，应从 shell 的对外可观测点验证。
    shell.onStepStatusChange = (stepId, status) => {
      if (status !== 'running') return;
      seen.push(
        [...mount.querySelectorAll('[data-cfg-status="running"]')]
          .map((el) => el.getAttribute('data-cfg-node'))
          .join(','),
      );
      // 顺带守住"同时只有一个 running"：上一步的 running 必须已被清除
      expect(stepId).toBeTruthy();
    };
    await shell.runAll();
    expect(seen).toEqual(['a', 'b']);
  });

  it('运行结束后各节点标注最终状态（pass）', async () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    await shell.runAll();
    const statusOf = (id: string) =>
      mount.querySelector(`[data-cfg-node="${id}"]`)?.getAttribute('data-cfg-status');
    expect(statusOf('a')).toBe('pass');
    expect(statusOf('b')).toBe('pass');
  });

  it('失败步在图上标红（data-cfg-status=fail，§2.7 "失败变红"）', async () => {
    const { mount, shell, kernel } = mountShell(scriptOf([leaf('a'), leaf('b')]));
    kernel.playback = vi.fn(async () => {
      kernel.emit('step-progress', { stepId: 'a', status: 'running' });
      kernel.emit('step-progress', { stepId: 'a', status: 'pass' });
      kernel.emit('step-progress', { stepId: 'b', status: 'running' });
      kernel.emit('step-progress', { stepId: 'b', status: 'fail' });
      return { ok: false, failedStepId: 'b' };
    }) as any;

    await shell.runAll();
    const el = mount.querySelector('[data-cfg-node="b"]')!;
    expect(el.getAttribute('data-cfg-status')).toBe('fail');
    expect(el.className).toContain('is-fail');
  });

  it('CFG 节点运行态写在图上（不再对照已删除的步骤列表）', async () => {
    const { mount, shell } = mountShell(scriptOf([leaf('a')]));
    await shell.runAll();
    expect(mount.querySelector('[data-cfg-node="a"]')!.getAttribute('data-cfg-status')).toBe('pass');
  });

  it('循环体内子步骤的运行态也反映到图上（嵌套节点不遗漏）', async () => {
    const { mount, shell } = mountShell(scriptOf([
      group('w', 'while', [leaf('p')], { loopCount: 2 }),
    ]));
    await shell.runAll();
    expect(mount.querySelector('[data-cfg-node="p"]')!.getAttribute('data-cfg-status')).toBe('pass');
  });

  it('重跑时旧状态被重置（不残留上一轮的 pass/fail）', async () => {
    const { mount, shell, kernel } = mountShell(scriptOf([leaf('a')]));
    await shell.runAll();
    expect(mount.querySelector('[data-cfg-node="a"]')!.getAttribute('data-cfg-status')).toBe('pass');

    // 第二轮：只发 running 不发结果，验证起点已被重置为 running 而非残留 pass
    kernel.playback = vi.fn(async () => {
      kernel.emit('step-progress', { stepId: 'a', status: 'running' });
      return { ok: true };
    }) as any;
    await shell.runAll();
    expect(mount.querySelector('[data-cfg-node="a"]')!.getAttribute('data-cfg-status')).not.toBe('pass');
  });
});

// ───────────────── 5. SRP / 解耦（CfgView 可独立使用）─────────────────

describe('CfgView 组件边界（SRP / DIP）', () => {
  it('CfgView 可独立挂载到任意容器，不依赖 UiShell 的 DOM 结构', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update(scriptOf([leaf('a'), group('w', 'while', [leaf('p')], { loopCount: 2 })]));
    expect(host.querySelectorAll('[data-cfg-node]').length).toBe(3);
  });

  it('CfgView 不 import 执行器/内核（仅依赖 Script/Step 类型）', () => {
    // 以行为证明解耦：仅给 Script，无 kernel 也能渲染
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    expect(() => view.update(scriptOf([leaf('a')]))).not.toThrow();
  });

  it('update 幂等：同一脚本重复 update 不产生重复节点', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    const s = scriptOf([leaf('a'), leaf('b')]);
    view.update(s);
    view.update(s);
    expect(host.querySelectorAll('[data-cfg-node]').length).toBe(2);
  });

  it('onSelect 回调把点击的节点 id 交给外部（由 UiShell 决定如何联动）', () => {
    const host = document.createElement('div');
    const picked: string[] = [];
    const view = new CfgView({ mount: host, onSelect: (id) => picked.push(id) });
    view.update(scriptOf([leaf('a'), leaf('b')]));
    (host.querySelector('[data-cfg-node="b"]') as HTMLElement).click();
    expect(picked).toEqual(['b']);
  });

  // ── 以下 3 例由 code-review / 可运行性审查打回后补 ──
  // 教训：`el.click()` 会让 e.target === el，而真实用户点的是节点**内部的文字**，
  // 此时 e.target 是子元素。仅用 el.click() 测事件委托会掩盖"点文字不生效"的缺陷。

  it('点击节点内部的文字（而非节点本身）也能选中（真实用户的点击落点）', () => {
    const host = document.createElement('div');
    const picked: string[] = [];
    const view = new CfgView({ mount: host, onSelect: (id) => picked.push(id) });
    view.update(scriptOf([leaf('a')]));

    // 模拟真实点击：事件目标是节点内的子元素（标签文字），而非节点本身
    const node = host.querySelector('[data-cfg-node="a"]') as HTMLElement;
    const inner = node.querySelector('*') as HTMLElement;
    expect(inner).toBeTruthy(); // 节点确实有内部元素，否则本测试无意义
    inner.click();

    expect(picked).toEqual(['a']);
  });

  it('点击嵌套子节点只选中该子节点，不误选外层组（就近命中）', () => {
    const host = document.createElement('div');
    const picked: string[] = [];
    const view = new CfgView({ mount: host, onSelect: (id) => picked.push(id) });
    view.update(scriptOf([group('g', 'sequence', [leaf('x')])]));

    const child = host.querySelector('[data-cfg-node="x"]') as HTMLElement;
    (child.querySelector('*') as HTMLElement ?? child).click();

    expect(picked).toEqual(['x']);
  });

  it('空态提示在脚本由空变非空后被清除（不残留"流程图为空"）', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update(scriptOf([]));
    expect(host.querySelector('[data-cfg-empty]')).toBeTruthy();

    view.update(scriptOf([leaf('a')]));
    expect(host.querySelector('[data-cfg-empty]')).toBeNull();
    expect(host.querySelectorAll('[data-cfg-node]').length).toBe(1);
  });

  // 可运行性审查复核轮打回：`const exhaustive: never` 只是**编译期**守卫，
  // 运行时脏数据（本地导入的脚本含未知 control.kind）会走进 default 分支且不抛错，
  // 后果是 edges 全空 + 子节点不挂载 + 文字误标"顺序 sequence" —— 静默错渲，
  // 比崩溃更难发现。桥边界 assertRunnableScript 只拦 WS 路径，拦不住本地导入。
  // 故在导入期（io.ts）就拦下，与既有 schema 校验同族。
  it('导入含未知 control.kind 的脚本时被拒绝（本地导入路径也要有边界）', () => {
    const bad = JSON.stringify({
      schema: SCRIPT_SCHEMA,
      app: { name: 'Bad', version: '1' },
      steps: [{ id: 'g', type: 'click', source: 'manual', control: { kind: 'switch' }, children: [] }],
    });
    expect(() => importScript(bad)).toThrow(/control|kind/i);
  });

  it('导入嵌套 children 内的未知 control.kind 也被拒绝（递归校验）', () => {
    const bad = JSON.stringify({
      schema: SCRIPT_SCHEMA,
      app: { name: 'Bad', version: '1' },
      steps: [{
        id: 'g', type: 'click', source: 'manual', control: { kind: 'sequence' },
        children: [{ id: 'c', type: 'click', source: 'manual', control: { kind: 'forever' }, children: [] }],
      }],
    });
    expect(() => importScript(bad)).toThrow(/control|kind/i);
  });

  it('导入合法的 CFG 脚本仍然通过（不误伤正常数据）', () => {
    const good = JSON.stringify({
      schema: SCRIPT_SCHEMA,
      app: { name: 'Good', version: '1' },
      steps: [
        { id: 'a', type: 'click', source: 'manual' },
        {
          id: 'w', type: 'wait', source: 'manual', control: { kind: 'while', loopCount: 2 },
          children: [{ id: 'p', type: 'click', source: 'manual' }],
        },
      ],
    });
    expect(() => importScript(good)).not.toThrow();
    expect(importScript(good).steps).toHaveLength(2);
  });

  it('setStatus 只更新状态属性，不整树重建（避免高频重渲染，§4.1 清单 7）', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update(scriptOf([leaf('a')]));
    const before = host.querySelector('[data-cfg-node="a"]');
    view.setStatus('a', 'running');
    const after = host.querySelector('[data-cfg-node="a"]');
    // 同一 DOM 节点被原地更新（引用不变），而非被重建替换
    expect(after).toBe(before);
    expect(after!.getAttribute('data-cfg-status')).toBe('running');
  });
});

// ───────────────── 6. 边几何：同层分支头 / 回环绕组框 / 不倒插入组 ─────────────────

function asBox(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

describe('CFG 边几何（与执行同层，不倒插入组框）', () => {
  const origin = asBox(0, 0, 400, 400);
  const ifGroup = asBox(10, 10, 300, 280);
  const ifHead = asBox(10, 10, 300, 24);
  const trueHead = asBox(10, 40, 140, 16);
  const falseHead = asBox(160, 40, 140, 16);

  it('选择组：True/False 边从条件头底边到同层分支头，不从组外框底边出发', () => {
    const t = branchEdgeLine(ifHead, trueHead, origin);
    const f = branchEdgeLine(ifHead, falseHead, origin);
    expect(t.y1).toBe(ifHead.top + ifHead.height);
    expect(t.y1).toBeLessThan(trueHead.top);
    expect(t.y2).toBe(trueHead.top);
    expect(f.x2).not.toBe(t.x2);
    expect(isInwardVIntoGroup(ifGroup, t, origin)).toBe(false);
    expect(isInwardVIntoGroup(ifGroup, f, origin)).toBe(false);
  });

  it('旧几何（组底→组内子节点）被识别为倒插入盒的 V', () => {
    const oldV = {
      x1: ifGroup.left + ifGroup.width / 2,
      y1: ifGroup.top + ifGroup.height,
      x2: trueHead.left + trueHead.width / 2,
      y2: trueHead.top,
    };
    expect(isInwardVIntoGroup(ifGroup, oldV, origin)).toBe(true);
  });

  it('True 与 False 之间没有顺序边（并列分支，不是先后）', () => {
    const g = buildCfgGraph(scriptOf([group('i', 'if', [leaf('t'), leaf('f')])]));
    expect(g.edges.filter((e) => e.kind === 'flow')).toEqual([]);
    expect(g.edges).not.toContainEqual({ from: 't', to: 'f', kind: 'flow' });
    expect(g.edges).toContainEqual({ from: 'i', to: 't', kind: 'true' });
    expect(g.edges).toContainEqual({ from: 'i', to: 'f', kind: 'false' });
  });

  it('True 分支是顺序组时，true 边连到该组（同层分支头），不连到组内叶子', () => {
    const g = buildCfgGraph(scriptOf([
      group('i', 'if', [group('tg', 'sequence', [leaf('x'), leaf('y')]), leaf('f')]),
    ]));
    expect(g.edges).toContainEqual({ from: 'i', to: 'tg', kind: 'true' });
    expect(g.edges).not.toContainEqual({ from: 'i', to: 'x', kind: 'true' });
    expect(g.edges).not.toContainEqual({ from: 'tg', to: 'f', kind: 'flow' });
  });

  it('回环路径从末步右侧绕出组框再回到循环头，不穿过组内', () => {
    const groupBox = asBox(10, 10, 200, 220);
    const head = asBox(10, 10, 200, 24);
    const last = asBox(20, 180, 160, 40);
    const d = loopEdgePath(last, head, groupBox, origin);
    const xOut = groupBox.left + groupBox.width + 14;
    expect(d).toContain(`L ${xOut} `);
    expect(xOut).toBeGreaterThan(groupBox.left + groupBox.width);
    // 路径含循环头高度，而不是组底
    expect(d).toContain(` ${head.top + head.height / 2}`);
    expect(d).not.toMatch(new RegExp(`L \\d+ ${groupBox.top + groupBox.height}($| )`));
  });

  it('DOM：if 的 SVG 边 data-from/to 是同层节点；没有 minimap；没有 flow SVG', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update(scriptOf([group('i', 'if', [leaf('t'), leaf('f')])]));
    const trueE = host.querySelector('[data-cfg-edge="true"]');
    const falseE = host.querySelector('[data-cfg-edge="false"]');
    expect(trueE?.getAttribute('data-from')).toBe('i');
    expect(trueE?.getAttribute('data-to')).toBe('t');
    expect(falseE?.getAttribute('data-from')).toBe('i');
    expect(falseE?.getAttribute('data-to')).toBe('f');
    expect(host.querySelector('[data-cfg-edge="flow"]')).toBeNull();
    expect(host.querySelector('[data-cfg-minimap]')).toBeNull();
  });

  it('DOM：循环 SVG 是绕行 path，data-to 是循环头', () => {
    const host = document.createElement('div');
    const view = new CfgView({ mount: host });
    view.update(scriptOf([group('w', 'while', [leaf('p'), leaf('q')], { loopCount: 2 })]));
    const loop = host.querySelector('[data-cfg-edge="loop"]');
    expect(loop?.tagName.toLowerCase()).toBe('path');
    expect(loop?.getAttribute('data-from')).toBe('q');
    expect(loop?.getAttribute('data-to')).toBe('w');
    expect(host.querySelector('[data-cfg-minimap]')).toBeNull();
  });

  it('mock 布局下：分支线从条件头出发，y1 远小于组外框底边（不是倒插 V）', () => {
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains('ui-shell-cfg-tree')) {
        return { x: 0, y: 0, left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, toJSON() {} } as DOMRect;
      }
      const nodeId = this.getAttribute('data-cfg-node')
        ?? this.closest('[data-cfg-node]')?.getAttribute('data-cfg-node');
      if (this.getAttribute('data-cfg-anchor') === 'head' && nodeId === 'i') {
        return { x: 10, y: 10, left: 10, top: 10, width: 300, height: 24, right: 310, bottom: 34, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute('data-cfg-anchor') === 'branch-head') {
        const br = this.closest('[data-cfg-branch]')?.getAttribute('data-cfg-branch');
        if (br === 'true') {
          return { x: 10, y: 40, left: 10, top: 40, width: 140, height: 16, right: 150, bottom: 56, toJSON() {} } as DOMRect;
        }
        if (br === 'false') {
          return { x: 160, y: 40, left: 160, top: 40, width: 140, height: 16, right: 300, bottom: 56, toJSON() {} } as DOMRect;
        }
      }
      if (this.getAttribute('data-cfg-node') === 'i') {
        return { x: 10, y: 10, left: 10, top: 10, width: 300, height: 280, right: 310, bottom: 290, toJSON() {} } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect;
    };
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const view = new CfgView({ mount: host });
      view.update(scriptOf([group('i', 'if', [leaf('t'), leaf('f')])]));
      const t = host.querySelector('[data-cfg-edge="true"]')!;
      const y1 = Number(t.getAttribute('y1'));
      expect(y1).toBe(34);
      expect(y1).toBeLessThan(100);
      expect(isInwardVIntoGroup(
        ifGroup,
        {
          x1: Number(t.getAttribute('x1')),
          y1,
          x2: Number(t.getAttribute('x2')),
          y2: Number(t.getAttribute('y2')),
        },
        origin,
      )).toBe(false);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });
});

// 截图打回：Import cfg-connectors-sample 后，True/False 是 sequence 包装。
// 旧 paintEdges 从 if 组外框底边拉线，箭头从组下方朝上插进两枝，呈 V。
// 既有用例只 mock 了叶子 then/else，测不到这条真实 fixture 路径。
describe('截图回归：cfg-connectors-sample 的 if 不得从组底倒插 V', () => {
  const origin = asBox(0, 0, 400, 520);
  const ifGroup = asBox(20, 80, 360, 280); // 底边 y=360，包住 True/False
  const ifHead = asBox(20, 80, 360, 24);   // 底边 y=104，条件头
  const trueColHead = asBox(20, 120, 170, 16);
  const falseColHead = asBox(200, 120, 170, 16);

  function lineOf(el: Element) {
    return {
      x1: Number(el.getAttribute('x1')),
      y1: Number(el.getAttribute('y1')),
      x2: Number(el.getAttribute('x2')),
      y2: Number(el.getAttribute('y2')),
    };
  }

  it('jsdom boot UiShell 导入 fixture 后：没有从 if 组下方指向 True/False 头的向上边', () => {
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains('ui-shell-cfg-tree')) {
        return { x: 0, y: 0, left: 0, top: 0, width: 400, height: 520, right: 400, bottom: 520, toJSON() {} } as DOMRect;
      }
      const nodeId = this.getAttribute('data-cfg-node')
        ?? this.closest('[data-cfg-node]')?.getAttribute('data-cfg-node');
      if (this.getAttribute('data-cfg-anchor') === 'head' && nodeId === 'if-send') {
        return { x: 20, y: 80, left: 20, top: 80, width: 360, height: 24, right: 380, bottom: 104, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute('data-cfg-anchor') === 'branch-head') {
        const br = this.closest('[data-cfg-branch]')?.getAttribute('data-cfg-branch');
        if (br === 'true') {
          return { x: 20, y: 120, left: 20, top: 120, width: 170, height: 16, right: 190, bottom: 136, toJSON() {} } as DOMRect;
        }
        if (br === 'false') {
          return { x: 200, y: 120, left: 200, top: 120, width: 170, height: 16, right: 370, bottom: 136, toJSON() {} } as DOMRect;
        }
      }
      // sequence 包装整盒：在条件头下方、组底上方。若误用它当 from，也会倒插。
      if (this.getAttribute('data-cfg-node') === 'if-send-true') {
        return { x: 24, y: 140, left: 24, top: 140, width: 162, height: 80, right: 186, bottom: 220, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute('data-cfg-node') === 'if-send-false') {
        return { x: 204, y: 140, left: 204, top: 140, width: 162, height: 80, right: 366, bottom: 220, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute('data-cfg-node') === 'if-send') {
        return { x: 20, y: 80, left: 20, top: 80, width: 360, height: 280, right: 380, bottom: 360, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute('data-cfg-node') === 'while-retry') {
        return { x: 20, y: 380, left: 20, top: 380, width: 360, height: 120, right: 380, bottom: 500, toJSON() {} } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect;
    };
    try {
      const script = importScript(CFG_CONNECTORS_JSON);
      const { mount } = mountShell(script);

      const trueE = mount.querySelector('[data-cfg-edge="true"]')!;
      const falseE = mount.querySelector('[data-cfg-edge="false"]')!;
      expect(trueE).toBeTruthy();
      expect(falseE).toBeTruthy();
      expect(trueE.getAttribute('data-from')).toBe('if-send');
      expect(trueE.getAttribute('data-to')).toBe('if-send-true');
      expect(falseE.getAttribute('data-to')).toBe('if-send-false');

      const t = lineOf(trueE);
      const f = lineOf(falseE);
      // 从条件头底边向下进列头，而不是从组外框底边朝上插。
      expect(t.y1).toBe(ifHead.top + ifHead.height);
      expect(f.y1).toBe(ifHead.top + ifHead.height);
      expect(t.y2).toBe(trueColHead.top);
      expect(f.y2).toBe(falseColHead.top);
      expect(t.y1).toBeLessThan(t.y2);
      expect(f.y1).toBeLessThan(f.y2);
      expect(t.y1).toBeLessThan(ifGroup.top + ifGroup.height - 50);
      expect(isInwardVIntoGroup(ifGroup, t, origin)).toBe(false);
      expect(isInwardVIntoGroup(ifGroup, f, origin)).toBe(false);
      // True/False 并列，不得有顺序 SVG。
      expect(mount.querySelector('[data-cfg-edge="flow"]')).toBeNull();

      const svg = mount.querySelector('[data-cfg-edges]') as SVGElement;
      // 边画布必须用像素钉在树原点：CSS inset/100% 会把 viewBox 压扁，箭头看起来像从组底朝上插。
      expect(svg.style.position).toBe('absolute');
      expect(svg.style.left).toBe('0px');
      expect(svg.style.top).toBe('0px');
      expect(svg.style.width).toMatch(/px$/);
      expect(svg.style.height).toMatch(/px$/);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });
});
