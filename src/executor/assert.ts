// 断言引擎（M1.5）：执行单条断言，返回是否通过。
// 设计依据：docs/design/design.md §6；错误需带明确信息，不静默通过（§8-5）。
// OCP 重构（M1.5）：以策略注册表取代 switch，新增断言 kind 只需追加一项。
// 同时偿还 M1 占位债：visible/titleIs/urlMatches/expr 真实判定，消除"假绿"。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CdpAdapter, VisualCapable } from '../cdp/adapter';
import type { Assertion, AssertionKind, Locator } from '../types/step';
import { judgeOf, type AssertionContext, type VisionJudgeResult } from '../vision/judge';
import { createOpenAICompatibleJudge } from '../vision/openai-compatible';
import { visionConfigError } from '../vision/config';

export class AssertionError extends Error {
  constructor(
    public readonly stepId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

/** 断言结果：passed 为是否通过，reason 为人可读依据（失败时给上层展示）。 */
export type AssertionOutcome = { passed: boolean; reason?: string };

/**
 * 断言策略签名。第三参 ctx 是**可选**的宿主注入位（visionPrompt 需要判定函数）。
 *
 * 为什么加在末尾且可选：现有 handler 与全部调用点（executor / waitUntil / 测试）
 * 都只传两个参数，加必填参数会破坏向后兼容；可选参数让旧策略零改动。
 * ctx 整体可能为 null（跨 WS/JSON 边界 undefined→null），实现内必须 ?? {} 兜底。
 */
export type AssertionHandler = (
  adapter: CdpAdapter,
  assertion: Assertion,
  ctx?: AssertionContext | null,
) => Promise<AssertionOutcome>;

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
    const a = assertion ?? {};
    const nodes = await adapter.snapshot();
    const loc = a.locator;
    const hasLoc = !!(loc && (loc.role || loc.name || loc.text || loc.testId || loc.css || loc.xpath));
    const pool = hasLoc ? nodes.filter((n) => nodeMatches(n, loc!)) : nodes;
    const haystack = pool
      .map((n) => [n.text, n.name, n.role].filter(Boolean).join(' '))
      .join('\n');
    return { passed: haystack.includes(a.value ?? '') };
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

  // 截图 + 提示词断言（模型视觉判定）：screenshotMatches 的"多模态增强"版。
  // 形制照 screenshotMatches：先拿截图，再交给判定者；判定者由宿主注入，
  // 内核不绑定任何供应商（需求「以后的插件」原话要求）。
  visionPrompt: async (adapter, assertion, ctx) => {
    const a = assertion ?? {};
    const prompt = (a.value ?? '').trim();

    // 空提示词：调模型也问不出东西，直接失败并说明，别浪费一次调用。
    if (!prompt) {
      return { passed: false, reason: 'visionPrompt 缺少提示词（Assertion.value 为空）' };
    }

    const visual = adapter as Partial<VisualCapable>;
    if (typeof visual.screenshot !== 'function') {
      return { passed: false, reason: '当前适配器不支持截图（需 VisualCapable）' };
    }

    const buf = await visual.screenshot(
      a.locator ? { element: a.locator } : {},
    );
    if (!buf || buf.length === 0) {
      return { passed: false, reason: '截图为空，无法做视觉判定' };
    }

    // 判定函数优先级：宿主注入 > 按环境变量/本地配置构造的默认实现。
    // 注入优先是为了让宿主能塞自己的网关或 mock，内核不写死供应商。
    const judge = judgeOf(ctx) ?? createOpenAICompatibleJudge();
    // 防御性兜底：当前 createOpenAICompatibleJudge() 恒返回对象，故此分支不可达。
    // 保留它是因为 judge 可能来自宿主注入，而跨 WS/JSON 边界时 undefined 会变 null；
    // 若将来默认构造改为"配置缺失则返回 undefined"，这里就是最后一道不静默造假的闸。
    // 请勿当作死代码删掉，也不要指望它会命中。
    if (!judge) {
      const why = visionConfigError() ?? '视觉判定函数未注入';
      return { passed: false, reason: `visionPrompt 未配置：${why}` };
    }

    let result: VisionJudgeResult;
    try {
      result = await judge.judge({ prompt, image: buf });
    } catch (err) {
      // 调用失败一律算失败并带原因 —— 静默跳过等于测试造假（用户拍板决策 3）。
      return {
        passed: false,
        reason: `visionPrompt 调用失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 外部边界兜底：模型/宿主可能返回 null 或非布尔 passed，
    // 只有严格 true 才算通过，其余按失败处理并保留原因。
    const r = (result ?? {}) as Partial<VisionJudgeResult>;
    if (r.passed === true) {
      return { passed: true, reason: r.reason };
    }
    return {
      passed: false,
      reason: r.reason ? `visionPrompt 判定不成立：${r.reason}` : 'visionPrompt 判定不成立',
    };
  },
};

/**
 * 执行单条断言，返回是否通过。未知 kind 抛出含 /kind/i 的错误。
 * @param ctx 可选宿主注入上下文（如视觉判定函数）；不传时行为与扩展前一致。
 */
export async function runAssertion(
  adapter: CdpAdapter,
  assertion: Assertion,
  ctx?: AssertionContext | null,
): Promise<AssertionOutcome> {
  const a = assertion ?? ({} as Assertion);
  const handler = assertionHandlers[a.kind];
  if (!handler) {
    throw new Error(`未知断言 kind: ${a.kind}`);
  }
  return handler(adapter, a, ctx ?? null);
}
