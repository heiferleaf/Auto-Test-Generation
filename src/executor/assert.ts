// 断言引擎（M1.5）：执行单条断言，返回是否通过。
// 设计依据：docs/设计文档.md §6；错误需带明确信息，不静默通过（§8-5）。
// OCP 重构（M1.5）：以策略注册表取代 switch，新增断言 kind 只需追加一项。
// 同时偿还 M1 占位债：visible/titleIs/urlMatches/expr 真实判定，消除"假绿"。

import type { CdpAdapter } from '../cdp/adapter';
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

/** 断言 kind → 判定策略的注册表。扩展新断言只需在此追加一项。 */
export const assertionHandlers: Record<AssertionKind, AssertionHandler> = {
  textContains: async (adapter, assertion) => {
    const nodes = await adapter.snapshot();
    const haystack = nodes
      .map((n) => [n.text, n.name, n.role].filter(Boolean).join(' '))
      .join('\n');
    return { passed: haystack.includes(assertion.value ?? '') };
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
};

/** 执行单条断言，返回是否通过。未知 kind 抛出含 /kind/i 的错误。 */
export async function runAssertion(
  adapter: CdpAdapter,
  assertion: Assertion,
): Promise<{ passed: boolean }> {
  const handler = assertionHandlers[assertion.kind];
  if (!handler) {
    throw new Error(`未知断言 kind: ${assertion.kind}`);
  }
  return handler(adapter, assertion);
}
