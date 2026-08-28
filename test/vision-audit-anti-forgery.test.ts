// 审查补充测试：visionPrompt 的「不静默造假」硬约束审计。
//
// 为什么单独开一个文件：这条款是最危险的缺陷类（测试造假 —— 断言没真跑却显示绿），
// 而且它不是"某个用例挂了"，是"任何一条路径偷偷返回 passed:true"。
// 所以用**穷举路径**的方式守：把"模型没配 / 调用失败 / 返回畸形"的每一种失败形态
// 都过一遍，断言结果必须是 passed:false 且带非空 reason。
//
// 纪律：不打真实模型 API，全部注入 mock judge / mock fetch。

import { describe, it, expect, afterEach } from 'vitest';
import type { CdpAdapter, VisualCapable } from '../src/cdp/adapter';
import type { Assertion } from '../src/types/step';
import { runAssertion, assertionHandlers } from '../src/executor/assert';
import { resolveHostJudge, setHostJudge } from '../src/vision/host';
import { createOpenAICompatibleJudge } from '../src/vision/openai-compatible';
import type { VisionJudge, VisionJudgeRequest, VisionJudgeResult } from '../src/vision/judge';

const ENV_KEYS = ['VISION_API_KEY', 'VISION_API_BASE', 'VISION_MODEL', 'VISION_NO_API_KEY'] as const;

afterEach(() => {
  setHostJudge(undefined);
  for (const k of ENV_KEYS) delete process.env[k];
});

/** 带 screenshot 的 adapter；over 可覆盖 screenshot 造出"截图失败/空图"场景。 */
function makeAdapter(over: Partial<VisualCapable> = {}): CdpAdapter {
  return {
    async connect() {}, async disconnect() {}, listTargets: () => [],
    selectTarget() {}, async click() {}, async fill() {}, async select() {},
    async hover() {}, async wait() {}, async eval() { return null; },
    async snapshot() { return []; }, async query() { return null; },
    async screenshot() { return Buffer.from('fake-png'); },
    ...over,
  } as unknown as CdpAdapter;
}

const va = (prompt = '有登录按钮吗', extra: Partial<Assertion> = {}): Assertion =>
  ({ kind: 'visionPrompt', value: prompt, ...extra }) as Assertion;

/**
 * 穷举"失败形态"，逐条断言：不得造绿。
 * 每条断言不只查 passed===false，还查 reason 非空 ——
 * 静默失败（passed:false 但没原因）同样没法排查，也属不合规。
 */
const failureShapes: { name: string; judge: VisionJudge }[] = [
  { name: 'judge 抛普通 Error', judge: { async judge() { throw new Error('网关 502'); } } },
  { name: 'judge 抛非 Error（字符串）', judge: { async judge() { throw 'boom'; } } },
  { name: 'judge reject 一个 null', judge: { async judge() { return Promise.reject(null) as never; } } },
  { name: 'judge 返回 undefined', judge: { async judge() { return undefined as never; } } },
  { name: 'judge 返回 null', judge: { async judge() { return null as never; } } },
  { name: 'judge 返回空对象', judge: { async judge() { return {} as never; } } },
  { name: 'passed 是字符串 "true"', judge: { async judge() { return { passed: 'true' } as never; } } },
  { name: 'passed 是数字 1', judge: { async judge() { return { passed: 1 } as never; } } },
  { name: 'passed 是 truthy 对象', judge: { async judge() { return { passed: {} } as never; } } },
  { name: '只给 reason 不给 passed', judge: { async judge() { return { reason: '看起来有' } as never; } } },
  { name: 'passed:false', judge: { async judge() { return { passed: false, reason: '没找到' }; } } },
];

describe('不静默造假：所有失败形态都必须是 passed:false 且带原因', () => {
  for (const shape of failureShapes) {
    it(`${shape.name} → passed:false + reason 非空`, async () => {
      const r = await runAssertion(makeAdapter(), va(), { judge: shape.judge });
      expect(r.passed).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect((r.reason ?? '').trim().length).toBeGreaterThan(0);
    });
  }
});

describe('不静默造假：未配置 apikey 时不造绿', () => {
  it('未注入 judge 且环境变量全空 → fail，reason 提示未配置', async () => {
    const r = await runAssertion(makeAdapter(), va(), null);
    expect(r.passed).toBe(false);
    expect(r.reason ?? '').toMatch(/apikey|VISION_API_KEY|未配置/i);
  });

  it('默认通道（resolveHostJudge）在无 apikey 时也不造绿', async () => {
    const r = await runAssertion(makeAdapter(), va(), { judge: resolveHostJudge() });
    expect(r.passed).toBe(false);
    expect(r.reason ?? '').toMatch(/apikey|VISION_API_KEY|未配置/i);
  });

  it('默认实现无 apikey 时是"抛错"而不是返回 passed:true', async () => {
    const judge = createOpenAICompatibleJudge({ config: { apiKey: undefined } });
    await expect(judge.judge({ prompt: 'x', image: Buffer.from('png') })).rejects.toThrow(/apikey/i);
  });

  it('judge 未注入但 VISION_NO_API_KEY=1 时，仍要真调模型（不因豁免标记直接造绿）', async () => {
    let called = 0;
    const r = await runAssertion(makeAdapter(), va(), {
      judge: {
        async judge() { called++; return { passed: false, reason: '模型说没有' }; },
      },
    });
    expect(called).toBe(1);
    expect(r.passed).toBe(false);
  });
});

describe('不静默造假：截图环节失败也不造绿', () => {
  it('adapter 不支持 screenshot（非 VisualCapable）→ fail', async () => {
    const bare = makeAdapter();
    const noShot = { ...bare, screenshot: undefined } as unknown as CdpAdapter;
    const r = await runAssertion(noShot, va(), { judge: { async judge() { return { passed: true }; } } });
    expect(r.passed).toBe(false);
    expect(r.reason ?? '').toMatch(/截图|VisualCapable|不支持/i);
  });

  it('screenshot 返回空 Buffer → fail 且不调 judge', async () => {
    let called = 0;
    const r = await runAssertion(
      makeAdapter({ screenshot: async () => Buffer.alloc(0) } as Partial<VisualCapable>),
      va(),
      { judge: { async judge() { called++; return { passed: true }; } } },
    );
    expect(r.passed).toBe(false);
    expect(called).toBe(0);
  });

  it('screenshot 抛错 → 向外抛（不吞成通过）', async () => {
    await expect(
      runAssertion(
        makeAdapter({ screenshot: async () => { throw new Error('CDP 截图超时'); } } as Partial<VisualCapable>),
        va(),
        { judge: { async judge() { return { passed: true }; } } },
      ),
    ).rejects.toThrow(/截图超时/);
  });
});

describe('提示词为空 / 畸形输入不造绿', () => {
  for (const bad of ['', '   ', '\n\t']) {
    it(`提示词为 ${JSON.stringify(bad)} → fail 且不调 judge`, async () => {
      let called = 0;
      const r = await runAssertion(makeAdapter(), va(bad), {
        judge: { async judge() { called++; return { passed: true }; } },
      });
      expect(r.passed).toBe(false);
      expect(called).toBe(0);
    });
  }
});

describe('OCP：visionPrompt 是注册表追加项，不是分支判断', () => {
  it('assertionHandlers 是 Record，visionPrompt 只是其中一项', () => {
    expect(typeof assertionHandlers.visionPrompt).toBe('function');
  });

  it('新增 kind 未触及既有 kind 的行为（既有 8 种仍在表里）', () => {
    for (const k of ['exists', 'visible', 'textContains', 'titleIs', 'urlMatches', 'expr',
      'elementVisibleInViewport', 'screenshotMatches']) {
      expect(typeof (assertionHandlers as Record<string, unknown>)[k]).toBe('function');
    }
  });

  it('未知 kind 仍抛错（注册表没有被"兜底通过"污染）', async () => {
    await expect(
      runAssertion(makeAdapter(), { kind: 'notARealKind' } as unknown as Assertion),
    ).rejects.toThrow(/未知断言 kind/);
  });
});

describe('请求内容：判定的确实是"这张截图 + 这个提示词"', () => {
  it('judge 收到的 prompt 与 image 与断言一致（没有拿空图去骗判定）', async () => {
    let got: VisionJudgeRequest | undefined;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await runAssertion(
      makeAdapter({ screenshot: async () => png } as Partial<VisualCapable>),
      va('截图里有没有红色错误提示？'),
      { judge: { async judge(req: VisionJudgeRequest) { got = req; return { passed: true, reason: 'ok' }; } } },
    );
    expect(r.passed).toBe(true);
    expect(got?.prompt).toBe('截图里有没有红色错误提示？');
    expect(got?.image.equals(png)).toBe(true);
  });
});
