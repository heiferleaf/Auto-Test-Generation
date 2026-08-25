// @vitest-environment jsdom
// M3-R5 version-panel 组件测试（测试先行，先于实现）。
//
// 验证 SRP 组件 VersionPanel：
//   - 从 VersionStore 渲染分支列表 / 当前分支高亮 / 标签 / 历史；
//   - 点击分支 chip 经 mount 级委托上报 onSwitch（点内部文字也算，复用 CfgView 的
//     closest 模式，避免 e.target===currentTarget 掩盖真实点击）；
//   - update 幂等（重复 update 不产生重复节点）；
//   - 不依赖 UiKernel / 执行器（DIP，仅依赖 VersionStore 类型）。
//   - 边界：空历史不崩（入口已建 main，至少有 1 条）。

import { describe, it, expect, vi } from 'vitest';
import type { Script, Step } from '../src/types/step';
import { VersionPanel } from '../src/ui/version-panel';
import {
  createStore,
  branch,
  switchTo,
  commit,
  tag,
  getHistory,
  type VersionStore,
} from '../src/script/version-store';

function seqStep(id: string, children: Step[] = []): Step {
  return {
    id,
    type: 'click',
    target: { kind: 'selector', selector: `#${id}` },
    source: 'manual',
    control: { kind: 'sequence' },
    children,
  } as unknown as Step;
}

function scriptOf(steps: Step[]): Script {
  return { schema: 'electron-auto-test/step/v2', app: { name: 'demo' }, steps };
}

function makeStore(): VersionStore {
  let s = createStore(scriptOf([seqStep('g1', [])]), 'base');
  s = branch(s, 'feature');
  s = switchTo(s, 'feature');
  s = commit(s, 'feat work', scriptOf([seqStep('g1', [seqStep('g2', [])])]));
  s = switchTo(s, 'main');
  s = tag(s, 'v1.0');
  return s;
}

function mountEl(): HTMLElement {
  return document.createElement('div');
}

describe('VersionPanel 渲染', () => {
  it('渲染所有分支，当前分支标 is-current', () => {
    const store = makeStore();
    const p = new VersionPanel({ mount: mountEl(), store });
    const chips = p['mount'].querySelectorAll('[data-branch]');
    expect(chips.length).toBe(2);
    const mainChip = Array.from(chips).find((c) => c.getAttribute('data-branch') === 'main')!;
    expect(mainChip.classList.contains('is-current')).toBe(true);
    const featChip = Array.from(chips).find((c) => c.getAttribute('data-branch') === 'feature')!;
    expect(featChip.classList.contains('is-current')).toBe(false);
  });

  it('渲染标签与历史条数', () => {
    const store = makeStore();
    const p = new VersionPanel({ mount: mountEl(), store });
    const tagEls = p['mount'].querySelectorAll('[data-tag]');
    expect(tagEls.length).toBe(1);
    expect(tagEls[0].getAttribute('data-tag')).toBe('v1.0');
    const hist = p['mount'].querySelectorAll('[data-commit]');
    expect(hist.length).toBe(getHistory(store).length);
  });
});

describe('VersionPanel 交互（mount 级委托）', () => {
  it('点击分支 chip（含内部文字）上报 onSwitch', () => {
    const store = makeStore();
    const onSwitch = vi.fn();
    const p = new VersionPanel({ mount: mountEl(), store, onSwitch });
    const featChip = Array.from(p['mount'].querySelectorAll('[data-branch]')).find(
      (c) => c.getAttribute('data-branch') === 'feature',
    )!;
    // 真实用户点的是 chip 内部的文字节点 → e.target 是子元素，不是 chip 本身。
    const label = featChip.querySelector('[data-branch-label]') as HTMLElement;
    label.click();
    expect(onSwitch).toHaveBeenCalledWith('feature');
  });

  it('点击历史条 cherry-pick 按钮上报 onCherryPick(hash)', () => {
    const store = makeStore();
    const onCherryPick = vi.fn();
    const p = new VersionPanel({
      mount: mountEl(),
      store,
      onCherryPick,
      canCherryPick: () => true,
    });
    const btn = p['mount'].querySelector('[data-action="cherry-pick"]') as HTMLElement;
    const hash = btn.getAttribute('data-cp-commit')!;
    btn.click();
    expect(onCherryPick).toHaveBeenCalledWith(hash);
  });

  it('canCherryPick 返回 false 时不渲染 cherry-pick 按钮', () => {
    const store = makeStore();
    const p = new VersionPanel({
      mount: mountEl(),
      store,
      canCherryPick: () => false,
    });
    const btns = p['mount'].querySelectorAll('[data-action="cherry-pick"]');
    expect(btns.length).toBe(0);
  });
});

describe('VersionPanel update 幂等 + 不依赖内核', () => {
  it('重复 update 不产生重复分支节点', () => {
    const store = makeStore();
    const p = new VersionPanel({ mount: mountEl(), store });
    p.update(store);
    p.update(store);
    expect(p['mount'].querySelectorAll('[data-branch]').length).toBe(2);
  });

  it('update 接受新 store 后反映新分支集合', () => {
    let store = makeStore();
    const p = new VersionPanel({ mount: mountEl(), store });
    store = branch(store, 'hotfix');
    p.update(store);
    expect(p['mount'].querySelectorAll('[data-branch]').length).toBe(3);
  });

  it('空脚本 / 单提交也不崩', () => {
    const store = createStore(scriptOf([seqStep('g1', [])]), 'only');
    expect(() => new VersionPanel({ mount: mountEl(), store })).not.toThrow();
  });
});
