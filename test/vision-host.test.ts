// 测试先行：宿主注入通道 + 「apikey 绝不进 Script JSON」的硬约束。
//
// 守的是用户 2026-08-28 拍板的决策 4：密钥只存在宿主进程侧，绝不写进脚本。
// 脚本是要导出/分享/入库的产物，密钥一旦进去就是泄漏事故，且不可撤销。

import { describe, it, expect, afterEach } from 'vitest';
import { setHostJudge, getHostJudge, resolveHostJudge } from '../src/vision/host';
import { ASSERTION_KINDS, type Script } from '../src/types/step';
import { exportScript, importScript } from '../src/script/io';
import { runAssertion } from '../src/executor/assert';
import type { CdpAdapter } from '../src/cdp/adapter';
import type { VisionJudge } from '../src/vision/judge';

afterEach(() => {
  setHostJudge(undefined);
});

function stubAdapter(): CdpAdapter {
  return {
    async connect() {}, async disconnect() {}, listTargets: () => [],
    selectTarget() {}, async click() {}, async fill() {}, async select() {},
    async hover() {}, async wait() {}, async eval() { return null; },
    async snapshot() { return []; }, async query() { return null; },
    async screenshot() { return Buffer.from('fake-png'); },
  } as unknown as CdpAdapter;
}

describe('宿主注入通道（src/vision/host.ts）', () => {
  it('未注入时 resolveHostJudge 仍返回可用 judge（不返回 undefined 把问题藏起来）', () => {
    expect(typeof resolveHostJudge().judge).toBe('function');
  });

  it('注入后 getHostJudge / resolveHostJudge 都返回该实例', () => {
    const mine: VisionJudge = { async judge() { return { passed: true }; } };
    setHostJudge(mine);
    expect(getHostJudge()).toBe(mine);
    expect(resolveHostJudge()).toBe(mine);
  });

  it('注入的 judge 能被断言实际用上', async () => {
    let called = 0;
    setHostJudge({
      async judge() { called++; return { passed: true, reason: '宿主网关判定' }; },
    });
    const r = await runAssertion(
      stubAdapter(),
      { kind: 'visionPrompt', value: '有按钮吗' },
      { judge: resolveHostJudge() },
    );
    expect(called).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.reason).toBe('宿主网关判定');
  });

  it('setHostJudge(undefined) 可撤销注入', () => {
    setHostJudge({ async judge() { return { passed: true }; } });
    setHostJudge(undefined);
    expect(getHostJudge()).toBeUndefined();
  });
});

describe('apikey 不进 Script JSON（决策 4 硬约束）', () => {
  it('含 visionPrompt 的脚本导出后不含任何密钥字段', () => {
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [
        {
          id: 's1',
          type: 'assert',
          source: 'manual',
          params: {
            assertion: {
              kind: 'visionPrompt',
              value: '截图里是否有红色错误提示？',
              locator: { role: 'status' },
            },
          },
        },
      ],
    };
    const json = exportScript(script);
    expect(json).toContain('visionPrompt');
    expect(json).toContain('截图里是否有红色错误提示？');
    // 不得出现任何密钥痕迹
    expect(json).not.toMatch(/apiKey|api_key|apikey|Authorization|Bearer|sk-/i);
  });

  it('ASSERTION_KINDS 含 visionPrompt 且全集与旧脚本兼容（旧 kind 都还在）', () => {
    expect(ASSERTION_KINDS).toContain('visionPrompt');
    for (const k of ['exists', 'visible', 'textContains', 'titleIs', 'urlMatches', 'expr',
      'elementVisibleInViewport', 'screenshotMatches']) {
      expect(ASSERTION_KINDS).toContain(k);
    }
  });

  it('不含 visionPrompt 的旧脚本照常导入（v1 与 v2 都行）', () => {
    const v1 = JSON.stringify({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'old' },
      steps: [{ id: 'a', type: 'click', source: 'manual', locator: { role: 'button' } }],
    });
    const v2 = v1.replace('/v1', '/v2');
    expect(importScript(v1).steps).toHaveLength(1);
    expect(importScript(v2).steps).toHaveLength(1);
  });

  it('含 visionPrompt 的新脚本可导入并原样往返（提示词不丢）', () => {
    const prompt = '页面上是否出现了成功提示？';
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [{
        id: 's1', type: 'assert', source: 'manual',
        params: { assertion: { kind: 'visionPrompt', value: prompt } },
      }],
    };
    const back = importScript(exportScript(script));
    expect(back.steps[0].params?.assertion?.kind).toBe('visionPrompt');
    expect(back.steps[0].params?.assertion?.value).toBe(prompt);
  });
});
