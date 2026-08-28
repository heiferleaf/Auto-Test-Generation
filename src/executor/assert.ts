// 断言引擎（M1.5）：执行单条断言，返回是否通过。
// 设计依据：docs/design/design.md §6；错误需带明确信息，不静默通过（§8-5）。
// OCP 重构（M1.5）：以策略注册表取代 switch，新增断言 kind 只需追加一项。
// 同时偿还 M1 占位债：visible/titleIs/urlMatches/expr 真实判定，消除"假绿"。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CdpAdapter, VisualCapable } from '../cdp/adapter';
import type { Assertion, AssertionKind, Locator } from '../types/step';

export class AssertionError extends Error {
  constructor(
    public readonly stepId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

export type AssertionHandler = (
  adapter: CdpAdapter,
  assertion: Assertion,
) => Promise<{ passed: boolean }>;

const noLoc = (loc: Locator | undefined): Locator => {
  if (!loc) throw new Error('该断言缺少 locator');
  return loc;
};

// 按 locator 字段宽松匹配 snapshot 节点（任一字段匹配即视为命中）。
const nodeMatches = (
  n: { role?: string; name?: string; text?: string; tag?: string; testId?: string },
  loc: Locator,
): boolean => {
  if (loc.role !== undefined && loc.role !== n.role) return false;
  if (loc.name !== undefined && loc.name !== n.name) return false;
  if (loc.testId !== undefined && loc.testId !== n.testId) return false;
  if (loc.css !== undefined && loc.css !== n.tag) return false;
  if (loc.text !== undefined) {
    const t = loc.textExact ? n.text === loc.text : (n.text ?? '').includes(loc.text);
    if (!t) return false;
  }
  return true;
};

const asString = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));

/** 把 locator 降级成能对整页文本做子树限定的 CSS 选择器；无法降级返回 undefined。 */
const subtreeSelectorOf = (loc: Locator | undefined): string | undefined => {
  if (!loc) return undefined;
  // 只有 css 是确定的选择器；role/name/text 之类的语义 locator 无法可靠映射到 CSS，
  // 硬猜会把"只搜该节点"变成"搜错节点"，故一律不降级——宁可走整页，也不猜错范围。
  return loc.css || undefined;
};

/**
 * textContains 的判定：先搜 snapshot，未命中再回落到整页文本。
 *
 * 为什么必须回落：snapshot 的 SELECTOR 只收 a/button/input/[role]... 等可交互元素，
 * 而"操作产生的新结果"最常见的载体是纯 <p>/<div>/<span> 状态提示——它们进不了 snapshot。
 * 于是出现"页面上有字、断言却一直超时"。这与「断言必须验证操作产生的新结果」直接冲突。
 *
 * 判定顺序刻意是"先用 snapshot 判，判不中才兜底"，而不是"snapshot 空才兜底"：
 * 页面上通常既有控件又有纯文本节点，snapshot 非空但恰好不含目标文字才是常态——
 * 若按"snapshot 空才兜底"，纯文本提示永远落不到兜底分支，缺陷照旧。
 *
 * locator 仍然起限定作用：带 locator 时，只有 locator 能表达为 CSS 选择器才去取该子树，
 * role/name 这类无法可靠映射的语义 locator 不降级——宁可不兜底，也不把"只搜该节点"
 * 架空成"整页随便哪处有就算过"。
 */
const textContainsPassed = async (adapter: CdpAdapter, assertion: Assertion): Promise<boolean> => {
  const a = assertion ?? {};
  const want = a.value ?? '';
  const nodes = await adapter.snapshot();
  const loc = a.locator;
  const hasLoc = !!(loc && (loc.role || loc.name || loc.text || loc.testId || loc.css || loc.xpath));
  const pool = hasLoc ? nodes.filter((n) => nodeMatches(n, loc!)) : nodes;
  const fromNodes = pool
    .map((n) => [n.text, n.name, n.role].filter(Boolean).join(' '))
    .join('\n');
  if (fromNodes.includes(want)) return true;

  const selector = hasLoc ? subtreeSelectorOf(loc) : undefined;
  // locator 存在但无法映射成 CSS（如 role/name）时不兜底：
  // 否则"只搜该 button"会被架空成"整页随便哪处有就算过"。
  if (hasLoc && !selector) return false;

  const text = await adapter.pageText(selector).catch(() => null);
  return text != null && text.includes(want);
};

/** 断言 kind → 判定策略的注册表。扩展新断言只需在此追加一项。 */
export const assertionHandlers: Record<AssertionKind, AssertionHandler> = {
  textContains: async (adapter, assertion) => {
    return { passed: await textContainsPassed(adapter, assertion ?? {}) };
  },

  exists: async (adapter, assertion) => {
    const hit = await adapter.query(noLoc(assertion.locator));
    return { passed: hit !== null && hit !== undefined };
  },

  // 真实可见性判定：基于 snapshot 的可见性（rect 面积）做真判断，按 locator 匹配。
  visible: async (adapter, assertion) => {
    const loc = noLoc(assertion.locator);
    const nodes = await adapter.snapshot();
    const matched = nodes.filter((n) => nodeMatches(n, loc));
    if (matched.length === 0) return { passed: false };
    return { passed: matched.some((n) => n.visible === true) };
  },

  titleIs: async (adapter, assertion) => {
    const title = asString(await adapter.eval('document.title'));
    return { passed: title === (assertion.value ?? '') };
  },

  urlMatches: async (adapter, assertion) => {
    const href = asString(await adapter.eval('location.href'));
    const pattern = assertion.value ?? '';
    // 支持正则（/.../ 或 /.../i）或普通包含比对。
    const reMatch = pattern.match(/^\/(.+)\/([a-z]*)$/);
    if (reMatch) {
      return { passed: new RegExp(reMatch[1], reMatch[2]).test(href) };
    }
    return { passed: href.includes(pattern) };
  },

  expr: async (adapter, assertion) => {
    const result = await adapter.eval(assertion.value ?? 'false');
    return { passed: Boolean(result) };
  },

  // 视觉断言：元素整体位于视口内且可见（M2 §3.2/§3.3）。
  // 依赖 VisualCapable.locateVisual；非可视化 adapter 抛明确错误（ISP 兼容）。
  elementVisibleInViewport: async (adapter, assertion) => {
    const visual = adapter as Partial<VisualCapable>;
    if (typeof visual.locateVisual !== 'function') {
      throw new Error('当前适配器不支持可视化定位（需 VisualCapable）');
    }
    if (!assertion.locator) throw new Error('elementVisibleInViewport 缺少 locator');
    const box = await visual.locateVisual(assertion.locator);
    return { passed: box.visible && box.inViewport };
  },

  // 截图比对：与基线图（scripts/baselines/<name>）比对。
  // M2 轻量实现：基线不存在则自动建立（首次运行）；存在则比对字节长度差异阈值。
  // 真像素/结构比对可在 M4/M5 接入多模态模型增强（design.md §3.3）。
  screenshotMatches: async (adapter, assertion) => {
    const visual = adapter as Partial<VisualCapable>;
    if (typeof visual.screenshot !== 'function') {
      throw new Error('当前适配器不支持截图（需 VisualCapable）');
    }
    const name = assertion.value ?? 'default';
    const baselinePath = `scripts/baselines/${name}.png`;
    const buf = await visual.screenshot(
      assertion.locator ? { element: assertion.locator } : {},
    );
    if (!existsSync(baselinePath)) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, buf);
      // 首次运行建立基线，视为通过。
      return { passed: true };
    }
    const base = readFileSync(baselinePath);
    // 阈值：字节长度差异不超过 5%（轻量结构比对，非像素级）。
    const diff = Math.abs(buf.length - base.length) / Math.max(base.length, 1);
    return { passed: diff <= 0.05 };
  },
};

/** 执行单条断言，返回是否通过。未知 kind 抛出含 /kind/i 的错误。 */
export async function runAssertion(
  adapter: CdpAdapter,
  assertion: Assertion,
): Promise<{ passed: boolean }> {
  const a = assertion ?? ({} as Assertion);
  const handler = assertionHandlers[a.kind];
  if (!handler) {
    throw new Error(`未知断言 kind: ${a.kind}`);
  }
  return handler(adapter, a);
}
