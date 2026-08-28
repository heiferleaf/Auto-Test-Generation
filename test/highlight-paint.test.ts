// @vitest-environment jsdom
// 拍摄时高亮的四个静默失败点（src/recorder/inject.ts 的 highlightPaintSource + src/cdp/adapter.ts 的 screenshot）：
//   1. findEl 找不到元素只 return false，宿主侧无从分辨「画上了」和「没找到」；
//   2. findEl 只认 css/testId/name，忽略 role、不支持 xpath —— 执行能过、高亮画不出；
//   3. name 用 indexOf 包含匹配会命中祖先，高亮框盖住半个屏幕；
//   4. 框画在 webview 层、图拍的主窗口层，catch 静默回退后「图上有框但框不在图上」。
// 本轮核心不变式：**执行路径能选中的元素，高亮路径必须也能画出来**。
// 全部用通用 DOM 结构验证，**不出现任何具体软件的类名/选择器**。

import { describe, it, expect, beforeEach } from 'vitest';
import { highlightPaintSource, HIGHLIGHT_CLEAR, locatorSelectors } from '../src/recorder/inject';
import { locatorToSelector } from '../src/cdp/targets';
import type { Locator } from '../src/types/step';

type PaintResult = {
  ok: boolean;
  via?: string;
  reason?: string;
  multiple?: boolean;
  detail?: string;
};

const w = window as unknown as Record<string, any>;

const paint = (loc: Locator | null): PaintResult =>
  new Function(`return ${highlightPaintSource(loc)}`)() as PaintResult;

/** 执行路径（targets.ts locatorToSelector）在 jsdom 里选中的元素。 */
function execPathElement(loc: Locator): Element | null {
  const sel = locatorToSelector(loc);
  if (sel.useXpath) {
    return document.evaluate(sel.selector, document, null, 9, null).singleNodeValue as Element | null;
  }
  try {
    return document.querySelector(sel.selector);
  } catch {
    return null;
  }
}

/** jsdom 无排版，命中判定需要的矩形要自己给。 */
function stubRect(el: Element, x: number, y: number, width: number, height: number): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect;
}

/** 命中后被盖章的元素；没画上则为 null。shadow root 里的也要找得出来。 */
function hitElement(): Element | null {
  const scopes: Array<Document | ShadowRoot> = [document];
  document.querySelectorAll('*').forEach((h) => {
    if (h.shadowRoot) scopes.push(h.shadowRoot);
  });
  for (const s of scopes) {
    const hit = s.querySelector('[data-atg-hl-hit]');
    if (hit) return hit;
  }
  return null;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete w.__atgHighlight;
  new Function(`return ${HIGHLIGHT_CLEAR}`)();
});

describe('修复点 1：画不上必须带原因，不再静默', () => {
  it('找不到元素返回 { ok:false, reason }，而不是裸 false', () => {
    const btn = document.createElement('button');
    btn.textContent = '存在的按钮';
    document.body.appendChild(btn);

    const res = paint({ name: '压根不存在的名字' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-match');
    expect(document.getElementById('__atgHl')).toBeNull();
    // 结果同时挂在 window 上：宿主侧 evaluate 拿不到返回值时还有这条路。
    expect(w.__atgHighlight).toEqual({ ok: false, reason: 'no-match' });
  });

  it('locator 没有任何可用字段时报 no-locator', () => {
    expect(paint({}).reason).toBe('no-locator');
    expect(paint(null).reason).toBe('no-locator');
  });

  it('css 非法（querySelector 会抛）时不崩，仍给出原因', () => {
    const res = paint({ css: '>>> not a selector <<<' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('命中元素会被盖章，HIGHLIGHT_CLEAR 同时清掉框和章', () => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '保存');
    document.body.appendChild(btn);

    expect(paint({ name: '保存' }).ok).toBe(true);
    expect(hitElement()).toBe(btn);

    new Function(`return ${HIGHLIGHT_CLEAR}`)();
    expect(document.getElementById('__atgHl')).toBeNull();
    expect(hitElement()).toBeNull();
  });
});

describe('修复点 2：执行能过 ⇒ 高亮画得出（本轮核心不变式）', () => {
  const cases: Array<{ title: string; loc: Locator }> = [
    { title: 'role+name', loc: { role: 'button', name: '发送' } },
    { title: '只有 role', loc: { role: 'button' } },
    { title: '只有 name', loc: { name: '发送' } },
    { title: '只有 text', loc: { text: '发送' } },
    { title: 'testId', loc: { testId: 'send-btn' } },
    { title: 'css', loc: { css: '#send' } },
    { title: 'xpath', loc: { xpath: '//*[@id="send"]' } },
  ];

  /** 明确无歧义的 DOM：每种 locator 形状都唯一指向 #send。 */
  function uniqueSendButton(): HTMLElement {
    const other = document.createElement('div');
    other.setAttribute('aria-label', '别的面板');
    const btn = document.createElement('button');
    btn.id = 'send';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', '发送');
    btn.setAttribute('data-testid', 'send-btn');
    btn.textContent = '发送';
    other.appendChild(btn);
    document.body.appendChild(other);
    return btn;
  }

  for (const c of cases) {
    it(`${c.title} 定位器：执行路径选中的元素就是高亮画上的元素`, () => {
      const btn = uniqueSendButton();
      const execEl = execPathElement(c.loc);
      expect(execEl).toBe(btn); // 前置：这个 locator 在执行路径下确实能选中

      const res = paint(c.loc);

      expect(res.ok).toBe(true);
      expect(hitElement()).toBe(btn);
    });
  }

  it('xpath 走 document.evaluate，不再因为不受支持而静默落空', () => {
    const btn = uniqueSendButton();
    const res = paint({ xpath: '//*[@id="send"]' });
    expect(res.ok).toBe(true);
    expect(res.via).toBe('xpath');
    expect(hitElement()).toBe(btn);
  });

  it('role+name 命中时记 via=role+name（原来会被完全忽略）', () => {
    uniqueSendButton();
    expect(paint({ role: 'button', name: '发送' }).via).toBe('role+name');
  });

  it('locatorSelectors 覆盖执行路径能发出的全部形式', () => {
    // locatorToSelector 能选中 ⇒ 候选里必须有一条也能选中同一个元素。
    for (const c of cases) {
      const btn = uniqueSendButton();
      const execEl = execPathElement(c.loc);
      const reached = locatorSelectors(c.loc).some((s) => {
        try {
          if (s.useXpath) return document.evaluate(s.selector, document, null, 9, null).singleNodeValue === execEl;
          return document.querySelector(s.selector) === execEl;
        } catch {
          return false;
        }
      });
      // css/testId/xpath 有直选候选；纯 name/text 走 JS 兜底，不在此列表里断言。
      if (c.loc.css || c.loc.testId || c.loc.xpath) expect(reached).toBe(true);
      expect(btn).toBeTruthy();
    }
  });
});

describe('修复点 3：包含匹配不再命中祖先', () => {
  it('祖先与后代都包含目标词时，选面积更小的那个（高亮框不该盖住半个屏幕）', () => {
    const panel = document.createElement('div');
    panel.setAttribute('aria-label', '文件');
    const item = document.createElement('div');
    item.setAttribute('aria-label', '文件');
    panel.appendChild(item);
    document.body.appendChild(panel);
    stubRect(panel, 0, 0, 1200, 800);
    stubRect(item, 10, 10, 60, 20);

    const res = paint({ name: '文件' });

    expect(res.ok).toBe(true);
    expect(res.multiple).toBe(true);
    expect(hitElement()).toBe(item);
    const hl = document.getElementById('__atgHl');
    expect(hl?.style.width).toBe('60px');
  });

  it('面积相同时取层级更深的', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('span');
    outer.appendChild(inner);
    document.body.appendChild(outer);
    stubRect(outer, 0, 0, 100, 20);
    stubRect(inner, 0, 0, 100, 20);
    outer.setAttribute('aria-label', '同名');
    inner.setAttribute('aria-label', '同名');

    expect(paint({ name: '同名' }).ok).toBe(true);
    expect(hitElement()).toBe(inner);
  });

  it('精确匹配优先于包含匹配', () => {
    const loose = document.createElement('button');
    loose.setAttribute('aria-label', '发送并关闭');
    const exact = document.createElement('button');
    exact.setAttribute('aria-label', '发送');
    document.body.appendChild(loose); // 文档序在前，包含匹配会先撞上它
    document.body.appendChild(exact);

    expect(paint({ name: '发送' }).ok).toBe(true);
    expect(hitElement()).toBe(exact);
  });

  it('名字来自文本而非 aria-label 时，按 role 收敛到按钮本身，不画同名祖先容器', () => {
    // 旧实现只认 aria-label / textContent 的 indexOf：容器文本也「包含」目标词，
    // 又完全不认 role，于是高亮框画在整块容器上（盖住半个屏幕）。
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    const label = document.createElement('span');
    label.textContent = '发送';
    const hint = document.createElement('span');
    hint.textContent = '消息将发送给所有人';
    const btn = document.createElement('button');
    btn.setAttribute('role', 'button');
    btn.appendChild(label);
    group.appendChild(hint);
    group.appendChild(btn);
    document.body.appendChild(group);
    stubRect(group, 0, 0, 1200, 700);
    stubRect(btn, 20, 30, 48, 20);

    const res = paint({ role: 'button', name: '发送' });

    expect(res.ok).toBe(true);
    expect(hitElement()).toBe(btn);
  });

  it('多个互不包含的精确匹配报 ambiguous，而不是随便画一个', () => {
    const a = document.createElement('button');
    a.setAttribute('aria-label', '发送');
    const b = document.createElement('button');
    b.setAttribute('aria-label', '发送');
    const wrapA = document.createElement('div');
    const wrapB = document.createElement('div');
    wrapA.appendChild(a);
    wrapB.appendChild(b);
    document.body.appendChild(wrapA);
    document.body.appendChild(wrapB);

    const res = paint({ name: '发送' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ambiguous');
    expect(hitElement()).toBeNull();
  });
});

describe('修复点 4 附带：shadow root 里的元素也能画（拿不到就不静默）', () => {
  it('open shadow root 内的命中元素会被画框', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '阴影里的按钮');
    shadow.appendChild(btn);

    const res = paint({ name: '阴影里的按钮' });

    expect(res.ok).toBe(true);
    expect(hitElement()).toBe(btn);
  });

  it('完全没命中且目标词只存在于已卸载节点时，仍是 no-match 而非抛错', () => {
    const detached = document.createElement('button');
    detached.setAttribute('aria-label', '游离的按钮');
    // 不 append，document 里查不到它。

    expect(paint({ name: '游离的按钮' }).reason).toBe('no-match');
  });
});
