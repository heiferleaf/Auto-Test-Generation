// M3-R5 Git 式版本层 —— 测试先行。
//
// 本文件在 src/script/version-store.ts 实现之前编写（红条预期：模块/导出尚不存在）。
// 覆盖架构文档 §2.2 的 7 项操作（commit/branch/switch/cherry-pick/history/tag/diff），
// 并锚定两条纪律：
//   - 不可变性：所有写操作返回新 store，入参 Script 引用不变（防版本层静默改写历史）。
//   - 边界硬失败（§4.1）：脏数据在"版本库入口"抛 VersionStoreError，而非在 UI 层白屏；
//     diff 两个相同脚本则返回空数组（不崩）。
//
// 不改动任何既有测试（测试代码权威性）。

import { describe, it, expect } from 'vitest';
import type { Script, Step } from '../src/types/step';
import {
  VersionStoreError,
  type VersionStore,
  isVersionNode,
  createStore,
  commit,
  branch,
  switchTo,
  cherryPick,
  tag,
  getBranches,
  getTags,
  getHistory,
  getCurrentScript,
  diffScripts,
} from '../src/script/version-store';

// ── 测试夹具 ──────────────────────────────────────────────────────────

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

function leaf(id: string): Step {
  return {
    id,
    type: 'click',
    target: { kind: 'selector', selector: `#${id}` },
    source: 'manual',
  } as unknown as Step;
}

function scriptOf(steps: Step[]): Script {
  return {
    schema: 'electron-auto-test/step/v2',
    app: { name: 'demo' },
    steps,
  };
}

// ── 1. 版本节点识别 ─────────────────────────────────────────────────

describe('isVersionNode：版本节点 = 最外层顺序组', () => {
  it('顶层 sequence 组判定为版本节点', () => {
    const s = seqStep('g1', [leaf('a')]);
    expect(isVersionNode(s, 0)).toBe(true);
  });

  it('顶层叶子步不是版本节点', () => {
    expect(isVersionNode(leaf('a'), 0)).toBe(false);
  });

  it('顶层 if/while 组不是版本节点', () => {
    const ifStep = { ...leaf('x'), control: { kind: 'if' }, children: [leaf('a')] } as unknown as Step;
    const whileStep = { ...leaf('y'), control: { kind: 'while', loopCount: 3 }, children: [leaf('b')] } as unknown as Step;
    expect(isVersionNode(ifStep, 0)).toBe(false);
    expect(isVersionNode(whileStep, 0)).toBe(false);
  });

  it('嵌套 sequence（非顶层）不是版本节点', () => {
    const nested = seqStep('inner', [leaf('a')]);
    const outer = seqStep('outer', [nested]);
    // 顶层约束由调用方按 index 传入；此处断言"非顶层即 false"的判定语义：
    expect(isVersionNode(nested, 1)).toBe(false);
    expect(isVersionNode(outer, 0)).toBe(true);
  });
});

// ── 2. commit / history（不可变）───────────────────────────────────

describe('commit：追加提交 + 不可变性', () => {
  it('首次 commit 自动建 main 分支，history 含一条', () => {
    const store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'init');
    const hist = getHistory(store);
    expect(hist).toHaveLength(1);
    expect(hist[0].message).toBe('init');
    expect(getBranches(store)).toEqual(['main']);
  });

  it('commit 返回新 store，不改入参 Script（不可变）', () => {
    const original = scriptOf([seqStep('g1', [leaf('a')])]);
    const snapshot = JSON.parse(JSON.stringify(original));
    const store1 = createStore(original, 'c1');
    const store2 = commit(store1, 'c2', scriptOf([seqStep('g1', [leaf('a'), leaf('b')])]));
    // 原 store1 的当前脚本未被 store2 改写
    expect(getHistory(store1)).toHaveLength(1);
    expect(getHistory(store2)).toHaveLength(2);
    // 入参 original 引用未被 mutate
    expect(original).toEqual(snapshot);
  });

  it('history 按时间倒序（最新在前）', () => {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'first');
    store = commit(store, 'second', scriptOf([seqStep('g1', [leaf('a'), leaf('b')])]));
    const hist = getHistory(store);
    expect(hist[0].message).toBe('second');
    expect(hist[1].message).toBe('first');
  });
});

// ── 3. branch ───────────────────────────────────────────────────────

describe('branch：从 HEAD 派生新分支', () => {
  it('branch 后列出两条分支，当前仍停在源分支', () => {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    store = branch(store, 'feature');
    expect(getBranches(store).sort()).toEqual(['feature', 'main']);
    expect(store.currentBranch).toBe('main');
  });

  it('同名分支抛 VersionStoreError', () => {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    store = branch(store, 'feature');
    expect(() => branch(store, 'feature')).toThrow(VersionStoreError);
  });

  it('branch 不改原分支历史（不可变）', () => {
    const store0 = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    const store1 = branch(store0, 'feature');
    expect(getHistory(store0)).toHaveLength(1);
    expect(getHistory(store1)).toHaveLength(1);
  });
});

// ── 4. switch ───────────────────────────────────────────────────────

describe('switchTo：切换当前分支并还原脚本', () => {
  it('切到 feature 后，getCurrentScript 还原 feature 末次提交', () => {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'base');
    store = branch(store, 'feature');
    store = switchTo(store, 'feature');
    store = commit(store, 'feat work', scriptOf([seqStep('g1', [leaf('a'), leaf('b')])]));
    const onFeature = getCurrentScript(store);
    expect(onFeature.steps[0].children).toHaveLength(2);
    // 切回 main 还原 base
    store = switchTo(store, 'main');
    const onMain = getCurrentScript(store);
    expect(onMain.steps[0].children).toHaveLength(1);
  });

  it('切到不存在分支抛 VersionStoreError', () => {
    const store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    expect(() => switchTo(store, 'ghost')).toThrow(VersionStoreError);
  });
});

// ── 5. cherry-pick（跨分支摘节点，源不变，改参落新提交）──────────────

describe('cherryPick：跨分支摘取版本节点（按提交 hash 定位）', () => {
  /** 建 main + feature，feature 提交一次，返回 store 与 feature 那次提交的 hash。 */
  function buildWithFeature(): { store: VersionStore; featHash: string } {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'base');
    store = branch(store, 'feature');
    store = switchTo(store, 'feature');
    store = commit(store, 'feat add b', scriptOf([seqStep('g1', [leaf('a'), leaf('b')])]));
    const featHash = getHistory(store)[0].hash; // feature 的最新提交
    store = switchTo(store, 'main');
    return { store, featHash };
  }

  it('把 feature 的提交摘到 main 为新提交，源分支不受影响', () => {
    const { store: s0, featHash } = buildWithFeature();
    const store = s0;
    const beforeMainHist = getHistory(store).length;
    const store2 = cherryPick(store, featHash);
    expect(getHistory(store2)).toHaveLength(beforeMainHist + 1);
    // 源分支 feature 历史长度不变（不可变：cherry-pick 不改源）
    const store3 = switchTo(store2, 'feature');
    expect(getHistory(store3)).toHaveLength(2);
  });

  it('cherry-pick 改参落入新提交而非改写源', () => {
    const { store: s0, featHash } = buildWithFeature();
    const patch = (n: Step): Step => ({ ...n, id: `${n.id}-cp` });
    const store2 = cherryPick(s0, featHash, patch);
    const picked = getCurrentScript(store2).steps[0];
    expect(picked.id).toBe('g1-cp'); // 改参生效于新提交
    // 源 feature 的 g1 仍是原 id（未被改写）
    const store3 = switchTo(store2, 'feature');
    const srcG1 = getCurrentScript(store3).steps[0];
    expect(srcG1.id).toBe('g1');
  });

  it('cherry-pick 不存在的提交 hash 抛 VersionStoreError', () => {
    const main = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'base');
    expect(() => cherryPick(main, 'nope')).toThrow(VersionStoreError);
  });
});

// ── 6. tag ───────────────────────────────────────────────────────────

describe('tag：给 HEAD 打标签', () => {
  it('tag 后可列出，重复 tag 报错', () => {
    let store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    store = tag(store, 'v1.0');
    expect(getTags(store)).toContain('v1.0');
    expect(() => tag(store, 'v1.0')).toThrow(VersionStoreError);
  });

  it('空 tag 名抛 VersionStoreError（边界硬失败）', () => {
    const store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    expect(() => tag(store, '')).toThrow(VersionStoreError);
  });
});

// ── 7. diff ─────────────────────────────────────────────────────────

describe('diffScripts：结构化差异', () => {
  it('相同脚本返回空差异（不崩）', () => {
    const a = scriptOf([seqStep('g1', [leaf('a')])]);
    const b = scriptOf([seqStep('g1', [leaf('a')])]);
    expect(diffScripts(a, b)).toEqual({ added: [], removed: [], modified: [] });
  });

  it('新增/删除/修改步骤均被捕获', () => {
    const a = scriptOf([seqStep('g1', [leaf('a')])]);
    const b = scriptOf([seqStep('g1', [leaf('a'), leaf('b')]), leaf('standalone')]);
    const d = diffScripts(a, b);
    expect(d.added).toContain('b');
    expect(d.added).toContain('standalone');
    expect(d.removed).toEqual([]);
  });

  it('改参（id 相同字段不同）记为 modified', () => {
    const a = scriptOf([seqStep('g1', [leaf('a')])]);
    const b = scriptOf([seqStep('g1', [leaf('a')])]);
    // 改 a 的 source 字段
    (b.steps[0].children![0] as Step).source = 'agent';
    const d = diffScripts(a, b);
    expect(d.modified).toContain('a');
  });
});

// ── 8. 边界硬失败（§4.1：入口抛错而非 UI 白屏）────────────────────

describe('边界硬失败：脏数据在版本库入口抛 VersionStoreError', () => {
  it('commit(undefined script) 抛错', () => {
    const store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    expect(() => commit(store, 'x', undefined as unknown as Script)).toThrow(VersionStoreError);
  });

  it('branch(store, "") 抛错', () => {
    const store = createStore(scriptOf([seqStep('g1', [leaf('a')])]), 'c1');
    expect(() => branch(store, '')).toThrow(VersionStoreError);
  });

  it('diff 两个相同脚本不崩（空数组）已覆盖；空脚本 diff 也不崩', () => {
    expect(diffScripts(scriptOf([]), scriptOf([]))).toEqual({ added: [], removed: [], modified: [] });
  });
});
