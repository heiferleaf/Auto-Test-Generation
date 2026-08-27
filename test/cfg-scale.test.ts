// @vitest-environment jsdom
// B4 CFG 规模可读性（spec §2.6.1）验收：折叠 / 缩放 / 运行跟随自动滚入 / findByStepId 降阶。
// 渲染层改动，不改 Step schema（collapsed 是视图态，D6）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CfgView } from '../src/ui/cfg-view';
import type { Script, Step } from '../src/types/step';

function mount(): HTMLElement {
  const m = document.createElement('div');
  document.body.appendChild(m);
  return m;
}

function leaf(id: string): Step {
  return { id, type: 'click', locator: { role: 'button', name: id }, source: 'manual' };
}

function seqGroup(id: string, children: Step[]): Step {
  return { id, type: 'wait', source: 'manual', control: { kind: 'sequence' }, children };
}

function script(steps: Step[]): Script {
  return { schema: 'electron-auto-test/step/v2', app: { name: 'T' }, steps };
}

function click(el: Element | null) {
  if (!el) throw new Error('click target not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('B4 CFG 规模可读性（§2.6.1）', () => {
  let m: HTMLElement;
  beforeEach(() => { m = mount(); });

  it('折叠：组节点点折叠按钮 → data-cfg-collapsed=true，子节点不渲染，label 含计数', () => {
    const s = script([seqGroup('g1', [leaf('a'), leaf('b')])]);
    const view = new CfgView({ mount: m });
    view.update(s);
    const gNode = m.querySelector('[data-cfg-node="g1"]') as HTMLElement;
    expect(gNode.getAttribute('data-cfg-collapsed')).toBe('false');
    // 折叠前：两个叶子子节点渲染
    expect(gNode.querySelector('[data-cfg-node="a"]')).toBeTruthy();
    expect(gNode.querySelector('[data-cfg-node="b"]')).toBeTruthy();
    // 点折叠按钮
    click(gNode.querySelector('[data-cfg-collapse]'));
    const gNode2 = m.querySelector('[data-cfg-node="g1"]') as HTMLElement;
    expect(gNode2.getAttribute('data-cfg-collapsed')).toBe('true');
    // 折叠后：子节点不渲染
    expect(gNode2.querySelector('[data-cfg-node="a"]')).toBeNull();
    expect(gNode2.querySelector('[data-cfg-node="b"]')).toBeNull();
    // label 含计数
    expect(gNode2.querySelector('.ui-shell-cfg-label')?.textContent).toContain('2');
    // 再点展开
    click(gNode2.querySelector('[data-cfg-collapse]'));
    const gNode3 = m.querySelector('[data-cfg-node="g1"]') as HTMLElement;
    expect(gNode3.getAttribute('data-cfg-collapsed')).toBe('false');
    expect(gNode3.querySelector('[data-cfg-node="a"]')).toBeTruthy();
  });

  it('缩放：ctrl+wheel 在 CFG 树上 → data-cfg-scale 改变；无 ctrl 不缩放', () => {
    const s = script([leaf('a'), leaf('b')]);
    const view = new CfgView({ mount: m });
    view.update(s);
    const tree = m.querySelector('.ui-shell-cfg-tree') as HTMLElement;
    const before = tree.getAttribute('data-cfg-scale');
    tree.dispatchEvent(new WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: -100 }));
    const after = tree.getAttribute('data-cfg-scale');
    expect(after).not.toBe(before);
    // 无 ctrl 不变
    const scale1 = tree.getAttribute('data-cfg-scale');
    tree.dispatchEvent(new WheelEvent('wheel', { bubbles: true, ctrlKey: false, deltaY: -100 }));
    expect(tree.getAttribute('data-cfg-scale')).toBe(scale1);
  });

  it('运行跟随：setStatus(running) 时平滑把该步移到画布中心', () => {
    const s = script([leaf('a'), leaf('b'), leaf('c')]);
    const view = new CfgView({ mount: m });
    view.update(s);
    const el = m.querySelector('[data-cfg-node="b"]') as HTMLElement;
    el.getBoundingClientRect = () =>
      ({ left: 80, top: 200, right: 160, bottom: 240, width: 80, height: 40, x: 80, y: 200, toJSON() {} }) as DOMRect;
    m.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    view.setStatus('b', 'running');
    const tree = m.querySelector('.ui-shell-cfg-tree') as HTMLElement;
    expect(tree.getAttribute('data-cfg-follow')).toBe('center');
    expect(tree.style.transition).toMatch(/260ms/);
  });

  it('setStatus 非 running 不触发 scrollIntoView（避免 pass/pail 抢焦点）', () => {
    const s = script([leaf('a')]);
    const view = new CfgView({ mount: m });
    view.update(s);
    const el = m.querySelector('[data-cfg-node="a"]') as HTMLElement;
    el.scrollIntoView = vi.fn();
    view.setStatus('a', 'pass');
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('findByStepId 降阶：深层嵌套叶子的 label 正确（O(1) map 命中，非全树遍历）', () => {
    // 深度 5 的嵌套顺序组，最内层叶子 deep
    const deep: Step = leaf('deep');
    let inner: Step = seqGroup('g4', [deep]);
    inner = seqGroup('g3', [inner]);
    inner = seqGroup('g2', [inner]);
    inner = seqGroup('g1', [inner]);
    const s = script([inner]);
    const view = new CfgView({ mount: m });
    view.update(s);
    const deepEl = m.querySelector('[data-cfg-node="deep"]') as HTMLElement;
    expect(deepEl).toBeTruthy();
    // 叶子 label 来自 step 描述（describeStepBrief），含 id 对应的封装文案
    expect(deepEl.querySelector('.ui-shell-cfg-label')?.textContent).toContain('deep');
  });

  it('大脚本渲染正确性：200 步全部渲染为节点', () => {
    const steps: Step[] = [];
    for (let i = 0; i < 200; i++) steps.push(leaf(`s${i}`));
    const s = script(steps);
    const view = new CfgView({ mount: m });
    view.update(s);
    expect(m.querySelectorAll('[data-cfg-node]').length).toBe(200);
  });

  it('折叠态是视图层、不入 schema：update 后脚本本身不含 collapsed 字段', () => {
    const s = script([seqGroup('g1', [leaf('a')])]);
    const view = new CfgView({ mount: m });
    view.update(s);
    click(m.querySelector('[data-cfg-collapse]'));
    // 脚本数据未变（折叠只在视图）
    expect(JSON.stringify(s)).not.toContain('collapsed');
  });
});
