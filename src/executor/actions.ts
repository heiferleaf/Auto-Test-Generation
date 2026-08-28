// 动作映射（M1.5）：将 Step 的 type/params 映射到 CdpAdapter 调用。
// 仅承载"调用转发"，不含控制流（控制流在 executor.ts）。
// OCP 重构（M1.5）：以策略注册表取代 switch，新增动作类型只需追加一项，executor 不变。

import type { CdpAdapter } from '../cdp/adapter';
import type { Assertion, Step, Locator, StepType } from '../types/step';
import { runAssertion } from './assert';
import type { AssertionContext } from '../vision/judge';

// 第三参 ctx 可选：waitUntil 等动作内部会轮询断言，需要把宿主注入透传下去。
// 放在末尾是为了不破坏现有 handler（注册表单参/双参写法照旧）。
export type ActionHandler = (
  adapter: CdpAdapter,
  step: Step & { type: Exclude<StepType, 'assert'> },
  ctx?: AssertionContext | null,
) => Promise<void>;

const noLoc = (loc: Locator | undefined): Locator => {
  if (!loc) throw new Error('该步骤缺少 locator');
  return loc;
};

/** 预览文本：截断并归一化空白，让超时信息能看清"页面上现在到底有什么"。 */
const preview = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return '(空)';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * 描述"这一轮为什么没匹配上"。
 *
 * 只报"超时 N ms"没法区分两种完全不同的故障：目标还没渲染出来（该等/该调大超时），
 * 还是判定来源不对（例如要找的文字在无 role 的 div 里，压根不在 snapshot 视野内）。
 * 这里按断言 kind 给出可判别的上下文，且必须容错——诊断失败不能把超时变成另一个异常。
 */
async function describeMismatch(adapter: CdpAdapter, assertion: Assertion): Promise<string> {
  try {
    if (assertion.kind === 'textContains') {
      const loc = assertion.locator;
      const hasLoc = !!(loc && (loc.role || loc.name || loc.text || loc.testId || loc.css || loc.xpath));
      const text = await adapter.pageText().catch(() => null);
      const body = text == null ? '(取不到整页文本)' : preview(text);
      return hasLoc
        ? `整页文本为「${body}」，其中可能不含该 locator(${JSON.stringify(loc)}) 限定范围内的文字`
        : `整页文本为「${body}」`;
    }
    if (assertion.kind === 'titleIs') {
      return `当前标题为「${preview(asString(await adapter.eval('document.title').catch(() => null), '(取不到)'))}」`;
    }
    if (assertion.kind === 'urlMatches') {
      return `当前 URL 为「${preview(asString(await adapter.eval('location.href').catch(() => null), '(取不到)'))}」`;
    }
    if (assertion.kind === 'exists' || assertion.kind === 'visible') {
      const loc = assertion.locator;
      const hit = loc ? await adapter.query(loc).catch(() => null) : null;
      return hit
        ? `节点存在但不可见（locator=${JSON.stringify(loc ?? null)}）`
        : `未找到节点（locator=${JSON.stringify(loc ?? null)}）`;
    }
    if (assertion.kind === 'expr') {
      return `表达式求值不为真：${preview(assertion.value ?? '')}`;
    }
    return `期望 ${JSON.stringify(assertion.value ?? null)} 未满足`;
  } catch {
    // 诊断是尽力而为：取不到上下文也要给出"超时 + 期望值"，不能让 waitUntil 抛别的错。
    return `期望 ${JSON.stringify(assertion.value ?? null)} 未满足（无法取得诊断上下文）`;
  }
}

const asString = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));

/** 动作类型 → 处理策略的注册表。扩展新动作只需在此追加一项。 */
export const actionHandlers: Record<Exclude<StepType, 'assert'>, ActionHandler> = {
  click: async (adapter, step) => {
    await adapter.click(noLoc(step.locator));
  },
  fill: async (adapter, step) => {
    await adapter.fill(noLoc(step.locator), step.params?.value ?? '');
  },
  select: async (adapter, step) => {
    await adapter.select(noLoc(step.locator), step.params?.optionText ?? step.params?.value ?? '');
  },
  hover: async (adapter, step) => {
    await adapter.hover(noLoc(step.locator));
  },
  wait: async (adapter, step) => {
    await adapter.wait({ text: step.params?.key, durationMs: step.params?.durationMs });
  },
  eval: async (adapter, step) => {
    await adapter.eval(step.params?.code ?? '');
  },
  snapshot: async (adapter) => {
    await adapter.snapshot();
  },
  // waitUntil：等待某断言条件成立（轮询至 timeoutMs）。本期以 wait 语义兜底，
  // 真实"轮询断言"由后续断言引擎接入（避免 actions 反向依赖 executor）。
  waitUntil: async (adapter, step, ctx) => {
    const assertion = step.params?.assertion;
    const timeout = step.params?.timeoutMs ?? 10_000;
    if (!assertion) {
      await adapter.wait({ durationMs: timeout });
      return;
    }
    const deadline = Date.now() + timeout;
    // 记住最后一轮"为什么没匹配上"：只报"超时 5000ms"会让人无从下手——
    // 到底是等待的目标还没渲染，还是断言的取值来源不对（如文本不在 snapshot 视野内）。
    let lastWhy = '';
    let rounds = 0;
    for (;;) {
      let result: { passed: boolean } | undefined;
      try {
        result = await runAssertion(adapter, assertion, ctx ?? null);
      } catch (err) {
        // 断言自身抛错（缺 locator / 不支持的能力）不是"还没等到"，继续等也没用，直接抛。
        throw new Error(`waitUntil 断言执行失败（${assertion.kind}）: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (result.passed) return;
      rounds += 1;
      lastWhy = await describeMismatch(adapter, assertion);
      if (Date.now() >= deadline) {
        throw new Error(
          `waitUntil 超时（${timeout}ms，轮询 ${rounds} 次）: ${assertion.kind}；` +
          `期望 ${JSON.stringify(assertion.value ?? null)}，最后一次未匹配原因：${lastWhy}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  },
  // repeat 是 while 循环组的表达（带 children），不应作为叶子执行；
  // 若作为叶子到达此处，说明脚本结构非法（缺 children）。
  repeat: async (_adapter, step) => {
    throw new Error(`repeat 步骤 ${step.id} 必须作为循环组（带 children），不应作为叶子执行`);
  },
};

/** 依据 step.type 把操作转发给注册表策略。未知 type 抛错（类型系统兜底）。 */
export async function invokeAction(
  adapter: CdpAdapter,
  step: Step & { type: Exclude<StepType, 'assert'> },
  ctx?: AssertionContext | null,
): Promise<void> {
  const handler = actionHandlers[step.type];
  if (!handler) {
    throw new Error(`未知步骤类型: ${step.type}`);
  }
  await handler(adapter, step, ctx ?? null);
}
