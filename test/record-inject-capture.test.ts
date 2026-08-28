// @vitest-environment jsdom
// 录制捕获四个缺陷的回归（注入脚本层）：
//   1. EditContext 编辑器：文本在 element.editContext.text，DOM 文本恒空 → fillValue 取不到值；
//      且 textupdate 由 EditContext 对象派发、不冒泡到 document，绑 document 无效。
//   2. mousedown 阶段插遮罩 → click 被改写到共同祖先 → 原按钮静默丢失。
//   3. 菜单项 label 挂在子元素上 → name 只向上找会取到祖先的名字，两步同名像「只捕到一次」。
//   4. 丢弃静默：注入层统计 + REC_STATS_DRAIN，让宿主侧在录制结束时能报覆盖率。
// 全部按通用机制验证，**不出现任何具体软件的类名/选择器**（平台严禁针对特定软件特化）。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { RECORD_INJECT, RECORD_DRAIN, REC_STATS_DRAIN, REC_ACTIVE_ON } from '../src/recorder/inject';

type BufEntry = {
  type: string;
  locator?: { role?: string; name?: string; testId?: string; css?: string; text?: string };
  params?: { value?: string };
};
type Stats = { intents: number; emitted: number; dropped: number; recovered: number; reasons: Record<string, number> };

const w = window as unknown as Record<string, any>;

/** 按脚本求值安装（与 CDP Runtime.evaluate 语义一致）。 */
const install = () => { new Function(RECORD_INJECT)(); };
const drain = (): BufEntry[] => new Function(`return (${RECORD_DRAIN})`)() as BufEntry[];
const drainStats = (): Stats | null => new Function(`return (${REC_STATS_DRAIN})`)() as Stats | null;

const clicks = (buf: BufEntry[]) => buf.filter((e) => e.type === 'click');
const fills = (buf: BufEntry[]) => buf.filter((e) => e.type === 'fill');

/**
 * 构造一个 EditContext 替身（W3C EditContext 由宿主提供，jsdom 无实现）：
 * 既是 EventTarget（能派发 textupdate/textformatupdate），又带标准 text 字段。
 */
function stubEditContext(text: string): EventTarget & { text: string } {
  const ec = new EventTarget() as EventTarget & { text: string };
  ec.text = text;
  return ec;
}

/** 把替身挂到元素上（jsdom 无 EditContext 实现，宿主侧由浏览器提供）。 */
function attachEditContext(el: Element, ec: unknown): void {
  (el as unknown as { editContext?: unknown }).editContext = ec;
}

describe('录制注入：EditContext 编辑器（缺陷 1）', () => {
  beforeAll(() => {
    // 只装一次：重复注入会在 document 上叠加多份监听，统计会被重复计数，测不准。
    install();
  });
  beforeEach(() => {
    document.body.innerHTML = '';
    w.__recBuf = [];
    w.__atgIntent = null;
    w.__atgStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} };
    new Function(`return (${REC_ACTIVE_ON})`)();
  });

  it('editContext.text 有值时 fillValue 取得到（DOM 文本为空也能取到）', () => {
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('aria-label', 'Chat');
    attachEditContext(ed, stubEditContext('hello from editcontext'));
    document.body.appendChild(ed);
    // DOM 侧恒空：这正是 EditContext 架构下 innerText/textContent 的表现。
    expect((ed.textContent || '').length).toBe(0);

    ed.dispatchEvent(new Event('input', { bubbles: true }));

    const buf = drain();
    expect(fills(buf).some((e) => e.params?.value === 'hello from editcontext')).toBe(true);
  });

  it('editContext 与 DOM 文本同时存在时，EditContext 优先', () => {
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('aria-label', 'Chat');
    ed.textContent = 'stale dom text';
    attachEditContext(ed, stubEditContext('authoritative ec text'));
    document.body.appendChild(ed);

    ed.dispatchEvent(new Event('input', { bubbles: true }));

    expect(fills(drain()).some((e) => e.params?.value === 'authoritative ec text')).toBe(true);
  });

  it('textupdate 绑在 EditContext 实例上后能记成 fill', () => {
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('aria-label', 'Chat');
    const ec = stubEditContext('typed via editcontext');
    attachEditContext(ed, ec);
    document.body.appendChild(ed);

    // 焦点变化触发绑定（原来的唯一入口）。
    ed.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    ec.dispatchEvent(new Event('textupdate'));

    expect(fills(drain()).some((e) => e.params?.value === 'typed via editcontext')).toBe(true);
  });

  it('焦点事件之后再挂上 EditContext 时，轮询兜底会补绑（focusin 之外的入口）', () => {
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('aria-label', 'Chat');
    document.body.appendChild(ed);
    w.__recActive = true;
    // 焦点先到位：此时元素还没有 editContext，focusin 那次绑定必然落空。
    ed.focus();

    // 编辑器随后挂上 EditContext（壳初始化顺序不定，这很常见）。
    const ec = stubEditContext('bound by poll');
    attachEditContext(ed, ec);
    // 注入脚本 200ms 轮询干的就是这件事（这里直接调，不等定时器）。
    w.__atgPollFill();

    ec.dispatchEvent(new Event('textformatupdate'));

    expect(fills(drain()).some((e) => e.params?.value === 'bound by poll')).toBe(true);
    // 幂等：已绑过的元素不会重复绑。
    expect(w.__atgBindEditContext(ed)).toBe(false);
  });

  it('负例：没有 EditContext 实例时，往元素上派发 textupdate 不再被记成 fill（原 document 绑定无效）', () => {
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    ed.setAttribute('aria-label', 'Chat');
    ed.textContent = 'plain dom text';
    document.body.appendChild(ed);

    ed.dispatchEvent(new Event('textupdate', { bubbles: true }));

    expect(fills(drain())).toHaveLength(0);
  });
});

describe('录制注入：mousedown 意图锚点（缺陷 2）', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    install();
  });
  beforeEach(() => {
    document.body.innerHTML = '';
    w.__recBuf = [];
    w.__atgIntent = null;
    w.__atgStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} };
  });

  /** 通用下拉结构：容器 > 触发按钮。遮罩是「mousedown 阶段改 DOM」这类壳的通病，与具体软件无关。 */
  function dropdown(buttonLabel: string) {
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', buttonLabel);
    const inner = document.createElement('span');
    inner.textContent = buttonLabel;
    btn.appendChild(inner);
    container.appendChild(btn);
    document.body.appendChild(container);
    return { container, btn };
  }

  it('mousedown 命中按钮 → 插遮罩 → click 被改写到共同祖先，仍能产出指向原按钮的步骤', () => {
    const { container, btn } = dropdown('更多操作');

    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // 壳在 mousedown 阶段插入遮罩：mouseup 命中的已是遮罩，
    // 浏览器把 click 派发到 mousedown/mouseup 目标的最近共同祖先（容器）。
    const mask = document.createElement('div');
    mask.className = 'overlay';
    container.appendChild(mask);
    mask.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const buf = drain();
    const hit = clicks(buf);
    expect(hit).toHaveLength(1);
    expect(hit[0].locator?.name).toBe('更多操作');
    expect(hit[0].locator?.css ?? '').toMatch(/button/);
    // 这条是「解析层失败 → 意图回退」救回来的。
    expect((w.__atgStats as Stats).recovered).toBe(1);
  });

  it('意图锚点带时间窗：超过 1s 的旧意图不再回退', () => {
    const { container, btn } = dropdown('更多操作');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // 把意图时间戳往前拨，模拟用户按下后很久才有 click。
    w.__atgIntent = { ...(w.__atgIntent as Record<string, unknown>), t: Date.now() - 1500 };

    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(clicks(drain())).toHaveLength(0);
    expect((w.__atgStats as Stats).recovered).toBe(0);
  });

  it('负例：没有 mousedown 的程序化 click 行为与改动前一致——不回退、不误报', () => {
    const container = document.createElement('div');
    container.className = 'workbench';
    document.body.appendChild(container);

    // 直接对不可解析的祖先派发 click（程序化点击没有 mousedown 前置）。
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(clicks(drain())).toHaveLength(0);
    const s = w.__atgStats as Stats;
    expect(s.recovered).toBe(0);
    expect(s.dropped).toBe(1);
    expect(s.reasons.noNode).toBe(1);
  });

  it('正常点击（解析成功）不走意图回退，不重复计 recovered', () => {
    const { btn } = dropdown('设置');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const hit = clicks(drain());
    expect(hit).toHaveLength(1);
    expect(hit[0].locator?.name).toBe('设置');
    const s = w.__atgStats as Stats;
    expect(s.intents).toBe(1);
    expect(s.recovered).toBe(0);
  });
});

describe('录制注入：菜单项 name 向下取（缺陷 3）', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    install();
  });
  beforeEach(() => {
    document.body.innerHTML = '';
    w.__recBuf = [];
    w.__atgIntent = null;
  });

  /** 通用菜单结构：容器带 name，菜单项的 label 挂在子元素上（label 挂载位置不定是通病）。 */
  function menu() {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'menu');
    bar.setAttribute('aria-label', '文件');
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = '新建文件';
    item.appendChild(label);
    bar.appendChild(item);
    document.body.appendChild(bar);
    return { bar, item, label };
  }

  it('点在菜单项上时 name 取菜单项自己的名字，不是祖先的', () => {
    const { item } = menu();
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const hit = clicks(drain());
    expect(hit).toHaveLength(1);
    expect(hit[0].locator?.name).toBe('新建文件');
  });

  it('点在菜单项的子元素（label 挂的地方）上，name 同样取菜单项自己的名字，且 locator 不会变深', () => {
    const { label } = menu();
    label.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const hit = clicks(drain());
    expect(hit).toHaveLength(1);
    expect(hit[0].locator?.name).toBe('新建文件');
    // 只取名，不把 locator 指向那个 span。
    expect(hit[0].locator?.css ?? '').not.toMatch(/span/);
  });

  it('多个子元素时取第一个非空可见文本，结果确定', () => {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'menu');
    bar.setAttribute('aria-label', '文件');
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    const first = document.createElement('span');
    first.textContent = '打开';
    const second = document.createElement('span');
    second.textContent = 'Ctrl+O';
    item.appendChild(first);
    item.appendChild(second);
    bar.appendChild(item);
    document.body.appendChild(bar);

    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(clicks(drain())[0].locator?.name).toBe('打开');
  });
});

describe('录制注入：注入层统计与 REC_STATS_DRAIN（缺陷 4）', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    install();
  });
  beforeEach(() => {
    document.body.innerHTML = '';
    w.__recBuf = [];
    w.__atgIntent = null;
    w.__atgStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} };
  });

  it('捕获/产出/丢弃/回退计数正确，且能经 REC_STATS_DRAIN 拉出', () => {
    // 1) 正常点击：intents +1、emitted +1
    const ok = document.createElement('button');
    ok.setAttribute('aria-label', '保存');
    document.body.appendChild(ok);
    ok.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ok.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // 2) 遮罩改写：intents +1、emitted +1、recovered +1
    const container = document.createElement('div');
    const more = document.createElement('button');
    more.setAttribute('aria-label', '更多操作');
    container.appendChild(more);
    document.body.appendChild(container);
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const mask = document.createElement('div');
    container.appendChild(mask);
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // 3) 解析不到的祖先：dropped +1、reasons.noNode +1
    const bare = document.createElement('div');
    document.body.appendChild(bare);
    bare.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    drain();
    const s = drainStats();
    expect(s).toEqual({
      intents: 2,
      emitted: 2,
      dropped: 1,
      recovered: 1,
      reasons: { noNode: 1 },
    });
  });

  it('空 fill 不算丢弃（是「无事发生」，不是漏）', () => {
    const ta = document.createElement('textarea');
    ta.setAttribute('aria-label', '备注');
    ta.value = '';
    document.body.appendChild(ta);
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    drain();
    const s = drainStats();
    expect(s?.dropped).toBe(0);
    expect(s?.emitted).toBe(0);
  });

  it('同一输入框连续输入只算一次产出（就地合并不重复计数）', () => {
    const ta = document.createElement('textarea');
    ta.setAttribute('aria-label', '备注');
    document.body.appendChild(ta);
    for (const v of ['h', 'hi', 'hi!']) {
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    drain();
    expect(drainStats()?.emitted).toBe(1);
  });

  it('未注入统计时 REC_STATS_DRAIN 返回 null 而不是抛错', () => {
    delete w.__atgStats;
    expect(() => drainStats()).not.toThrow();
    expect(drainStats()).toBeNull();
  });

  it('REC_ACTIVE_ON 会把统计归零（每次录制会话的统计是干净的）', () => {
    w.__atgStats = { intents: 9, emitted: 9, dropped: 9, recovered: 9, reasons: { noNode: 9 } };
    new Function(`return (${REC_ACTIVE_ON})`)();
    expect(drainStats()).toEqual({ intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} });
  });
});
