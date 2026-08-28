// 测试先行：截图 + 提示词断言（visionPrompt）。
// 先于 src/vision/ 与 assert.ts 的 visionPrompt handler 实现存在。
//
// 目标（用户 2026-08-28 拍板）：
//   1. kind 名 = visionPrompt
//   2. 提示词复用 assertion.value（零 schema 变更）
//   3. 模型返回 {passed: boolean, reason?: string}；**无 apikey / 调用失败一律 fail 并明确报错，不静默 skip**
//   4. apikey 由宿主注入（环境变量优先 + 本地文件兜底），绝不进 Script JSON
//
// 纪律：禁止在单测里打真实模型 API，全部用 mock judge（同 test/visual.test.ts makeVisualMock 形制）。

import { describe, it, expect, afterEach } from 'vitest';
import type { CdpAdapter, VisualCapable } from '../src/cdp/adapter';
import type { Assertion } from '../src/types/step';
import { runAssertion, assertionHandlers } from '../src/executor/assert';
import type { VisionJudge, VisionJudgeRequest, VisionJudgeResult } from '../src/vision/judge';

/** 记录型 mock judge：返回可控结果，并记录收到的请求。 */
function makeJudge(
  impl?: (req: VisionJudgeRequest) => Promise<VisionJudgeResult>,
): VisionJudge & { requests: VisionJudgeRequest[] } {
  const requests: VisionJudgeRequest[] = [];
  return {
    requests,
    async judge(req: VisionJudgeRequest) {
      requests.push(req);
      if (impl) return impl(req);
      return { passed: true, reason: 'ok' };
    },
  };
}

/** 带 screenshot 的 mock adapter。 */
function makeShotAdapter(over: Partial<VisualCapable> = {}): CdpAdapter {
  return {
    async connect() {}, async disconnect() {}, listTargets: () => [],
    selectTarget() {}, async click() {}, async fill() {}, async select() {},
    async hover() {}, async wait() {}, async eval() { return null; },
    async snapshot() { return []; }, async query() { return null; },
    async screenshot() { return Buffer.from('fake-png'); },
    ...over,
  } as unknown as CdpAdapter;
}

const visionAssert = (prompt: string, extra: Partial<Assertion> = {}): Assertion =>
  ({ kind: 'visionPrompt', value: prompt, ...extra }) as Assertion;

afterEach(() => {
  delete process.env.VISION_API_KEY;
  delete process.env.VISION_API_BASE;
  delete process.env.VISION_MODEL;
});

describe('visionPrompt 注册（OCP：只追加，不动核心）', () => {
  it('已注册到 assertionHandlers', () => {
    expect(typeof assertionHandlers.visionPrompt).toBe('function');
  });

  it('runAssertion 能分发（不抛未知 kind）', async () => {
    const a = makeShotAdapter();
    const r = await runAssertion(a, visionAssert('页面上有登录按钮吗'), { judge: makeJudge() } as never);
    expect(r).toHaveProperty('passed');
  });
});

describe('visionPrompt 判定结果', () => {
  it('judge 返回 passed:true 时断言通过', async () => {
    const judge = makeJudge(async () => ({ passed: true, reason: '看到登录按钮' }));
    const r = await runAssertion(makeShotAdapter(), visionAssert('有登录按钮'), { judge } as never);
    expect(r.passed).toBe(true);
  });

  it('judge 返回 passed:false 时断言失败（不静默通过）', async () => {
    const judge = makeJudge(async () => ({ passed: false, reason: '没找到登录按钮' }));
    const r = await runAssertion(makeShotAdapter(), visionAssert('有登录按钮'), { judge } as never);
    expect(r.passed).toBe(false);
  });

  it('judge 抛错时 fail 并明确报错（不静默 skip）', async () => {
    const judge = makeJudge(async () => { throw new Error('模型服务 500'); });
    const r = await runAssertion(makeShotAdapter(), visionAssert('有登录按钮'), { judge } as never);
    expect(r.passed).toBe(false);
    // 失败原因要能被上层看到，不能是空壳
    expect(JSON.stringify(r)).toMatch(/500|失败|error/i);
  });

  it('judge 返回缺字段（undefined/null）时不崩，按 fail 处理', async () => {
    const judge = makeJudge(async () => (undefined as unknown as VisionJudgeResult));
    const r = await runAssertion(makeShotAdapter(), visionAssert('有登录按钮'), { judge } as never);
    expect(r.passed).toBe(false);
  });

  it('judge 返回的 passed 不是布尔值（字符串 "true"）时不视为通过', async () => {
    const judge = makeJudge(async () => ({ passed: 'true' } as unknown as VisionJudgeResult));
    const r = await runAssertion(makeShotAdapter(), visionAssert('x'), { judge } as never);
    expect(r.passed).toBe(false);
  });
});

describe('visionPrompt 提示词传递', () => {
  it('assertion.value 原样作为提示词传给 judge', async () => {
    const judge = makeJudge(async () => ({ passed: true }));
    const prompt = '截图里是否有红色错误提示？只回答是或否';
    await runAssertion(makeShotAdapter(), visionAssert(prompt), { judge } as never);
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0].prompt).toBe(prompt);
  });

  it('提示词为空时不调 judge，直接 fail 并报错', async () => {
    const judge = makeJudge(async () => ({ passed: true }));
    const r = await runAssertion(makeShotAdapter(), visionAssert(''), { judge } as never);
    expect(r.passed).toBe(false);
    expect(judge.requests).toHaveLength(0);
    expect(JSON.stringify(r)).toMatch(/提示词|prompt/i);
  });

  it('传给 judge 的请求带上截图（非空 image）', async () => {
    const judge = makeJudge(async () => ({ passed: true }));
    await runAssertion(makeShotAdapter(), visionAssert('有按钮吗'), { judge } as never);
    const req = judge.requests[0];
    expect(req.image).toBeDefined();
    expect(req.image.length).toBeGreaterThan(0);
  });
});

describe('visionPrompt 无 judge 注入时的降级行为（用户拍板：fail，不静默 skip）', () => {
  it('完全不注入 judge 时按无 apikey 处理：fail 且报错信息提示未配置', async () => {
    const r = await runAssertion(makeShotAdapter(), visionAssert('有按钮吗'));
    expect(r.passed).toBe(false);
    const msg = JSON.stringify(r);
    expect(msg).toMatch(/apikey|API_KEY|未配置|未注入|vision/i);
  });

  it('传入空 ctx 时也 fail（跨 WS/JSON 边界 undefined 会变 null，必须兜底）', async () => {
    const r = await runAssertion(makeShotAdapter(), visionAssert('有按钮吗'), null as never);
    expect(r.passed).toBe(false);
  });

  it('ctx 里 judge 字段为 null 时 fail（JSON 往返 undefined→null）', async () => {
    const r = await runAssertion(makeShotAdapter(), visionAssert('有按钮吗'), { judge: null } as never);
    expect(r.passed).toBe(false);
  });
});

describe('visionPrompt 向后兼容', () => {
  it('无 ctx 时现有 handler 行为不变（textContains 仍正常）', async () => {
    const a = makeShotAdapter({
      snapshot: async () => [{ text: 'Welcome Dashboard' }] as never,
    } as Partial<VisualCapable>);
    const r = await runAssertion(a, { kind: 'textContains', value: 'Dashboard' });
    expect(r.passed).toBe(true);
  });

  it('有 ctx 时现有 handler 行为不变（第三参对旧 handler 无副作用）', async () => {
    const a = makeShotAdapter({
      query: async () => ({}) as never,
    } as Partial<VisualCapable>);
    const r = await runAssertion(a, { kind: 'exists', locator: { css: '#btn' } }, { judge: makeJudge() } as never);
    expect(r.passed).toBe(true);
  });
});
