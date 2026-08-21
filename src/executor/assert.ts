// 断言引擎（M1 执行器断言引擎）。
// 设计依据：docs/设计文档.md §6；错误需带明确信息，不静默通过（§8-5）。

import type { CdpAdapter } from '../cdp/adapter';
import type { Assertion } from '../types/step';
import type { SerializedNode } from '../cdp/adapter';

export class AssertionError extends Error {
  constructor(
    public readonly stepId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

/** 执行单条断言，返回是否通过。未知 kind 抛出含 /kind/i 的错误。 */
export async function runAssertion(
  adapter: CdpAdapter,
  assertion: Assertion,
): Promise<{ passed: boolean }> {
  switch (assertion.kind) {
    case 'textContains': {
      const nodes: SerializedNode[] = await adapter.snapshot();
      const haystack = nodes
        .map((n) => [n.text, n.name, n.role].filter(Boolean).join(' '))
        .join('\n');
      return { passed: haystack.includes(assertion.value ?? '') };
    }
    case 'exists': {
      const hit = await adapter.query(assertion.locator!);
      return { passed: hit !== null && hit !== undefined };
    }
    case 'visible': {
      // M1 简化：query 非空即视为可见。
      const hit = await adapter.query(assertion.locator!);
      return { passed: hit !== null && hit !== undefined };
    }
    case 'titleIs':
    case 'urlMatches':
    case 'expr':
      // M1 占位：测试未覆盖，保持简单返回不通过。
      return { passed: false };
    default:
      throw new Error(`未知断言 kind: ${(assertion as Assertion & { kind: string }).kind}`);
  }
}
