// 独立审查补充测试（审查者视角，与实现者自测分开）。
//
// 为什么不复用实现者写的 vision-*.test.ts：那些测试是"实现者证明自己做对了"，
// 审查要的是"换个角度找反例"。这里专挑最容易蒙混过关的地方下手：
//   1. 注册表之外有没有**第二条**通往 passed:true 的路径（OCP 的另一半是"没开后门"）
//   2. 导出产物的**每种序列化形态**（含 shots、control、MCP 返回）都搜不到密钥
//   3. .gitignore 真的覆盖了配置文件名（否则密钥一 commit 就不可撤销）
//   4. 老脚本在"注入了 judge"的新宿主下行为也不变（注入不能反向污染旧路径）
//
// 纪律：不打真实模型 API，全部 mock。

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAssertion, assertionHandlers } from '../src/executor/assert';
import { runScript } from '../src/executor/executor';
import { exportScript } from '../src/script/io';
import { ASSERTION_KINDS, type Assertion, type Script, type Step } from '../src/types/step';
import { loadVisionConfig } from '../src/vision/config';
import { createOpenAICompatibleJudge } from '../src/vision/openai-compatible';
import type { CdpAdapter, VisualCapable } from '../src/cdp/adapter';
import type { VisionJudge } from '../src/vision/judge';

const SECRET = 'sk-independent-audit-Zx9Qw7';
const ENV_KEYS = ['VISION_API_KEY', 'VISION_API_BASE', 'VISION_MODEL', 'VISION_NO_API_KEY'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

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

const va = (prompt = '有登录按钮吗'): Assertion => ({ kind: 'visionPrompt', value: prompt });

const alwaysTrue: VisionJudge = { async judge() { return { passed: true }; } };

describe('OCP：passed:true 只有一条路（judge 明说 true）', () => {
  // 这是"不静默造假"的反面验证：穷举除 judge 返回 true 之外的所有情形，
  // 只要有一条能拿到 passed:true，就是造假后门。
  const scenarios: { name: string; run: () => Promise<{ passed: boolean }> }[] = [
    { name: '不传 ctx', run: () => runAssertion(makeAdapter(), va()) },
    { name: 'ctx = null', run: () => runAssertion(makeAdapter(), va(), null) },
    { name: 'ctx = undefined', run: () => runAssertion(makeAdapter(), va(), undefined) },
    { name: 'ctx = {}', run: () => runAssertion(makeAdapter(), va(), {}) },
    { name: 'ctx.judge = null', run: () => runAssertion(makeAdapter(), va(), { judge: null }) },
    { name: 'ctx.judge = 非函数对象', run: () => runAssertion(makeAdapter(), va(), { judge: {} as never }) },
    { name: 'ctx.judge = 字符串', run: () => runAssertion(makeAdapter(), va(), { judge: 'x' as never }) },
    // JSON 往返：跨 WS 后 undefined 字段会变 null，形态必须同样安全
    { name: 'ctx 经 JSON 往返（undefined→null）', run: () => runAssertion(makeAdapter(), va(), JSON.parse(JSON.stringify({ judge: undefined }))) },
    { name: '提示词为空但 judge 恒真', run: () => runAssertion(makeAdapter(), { kind: 'visionPrompt', value: '' }, { judge: alwaysTrue }) },
    { name: '提示词全空白但 judge 恒真', run: () => runAssertion(makeAdapter(), { kind: 'visionPrompt', value: '   \n ' }, { judge: alwaysTrue }) },
    { name: 'Assertion 缺 value 但 judge 恒真', run: () => runAssertion(makeAdapter(), { kind: 'visionPrompt' } as Assertion, { judge: alwaysTrue }) },
    { name: '截图为空但 judge 恒真', run: () => runAssertion(makeAdapter({ screenshot: async () => Buffer.alloc(0) } as Partial<VisualCapable>), va(), { judge: alwaysTrue }) },
    { name: '无截图能力但 judge 恒真', run: () => runAssertion(makeAdapter({ screenshot: undefined } as Partial<VisualCapable>), va(), { judge: alwaysTrue }) },
  ];

  for (const s of scenarios) {
    it(`${s.name} → 不得返回 passed:true`, async () => {
      const r = await s.run();
      expect(r.passed).toBe(false);
    });
  }

  it('Assertion 为 null 时抛错而不是造绿（跨 JSON 边界的极端形态）', async () => {
    await expect(runAssertion(makeAdapter(), null as never, { judge: alwaysTrue }))
      .rejects.toThrow(/未知断言 kind/);
  });

  it('唯一能拿到 passed:true 的路径：judge 返回 passed 严格等于 true', async () => {
    const r = await runAssertion(makeAdapter(), va(), { judge: alwaysTrue });
    expect(r.passed).toBe(true);
  });

  it('handler 是注册表项，不是分支：表里既有 8 项 + visionPrompt 共 9 项', () => {
    const keys = Object.keys(assertionHandlers).sort();
    expect(keys).toEqual([...ASSERTION_KINDS].sort());
  });
});

describe('密钥泄漏面：导出产物的每种形态都搜不到', () => {
  it('脚本带 shots（base64 截图）导出时也不含密钥', () => {
    process.env.VISION_API_KEY = SECRET;
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [{ id: 's1', type: 'assert', source: 'manual', params: { assertion: va() } }],
      shots: { s1: 'data:image/png;base64,iVBORw0KGgo=' },
    };
    const json = exportScript(script);
    expect(loadVisionConfig().apiKey).toBe(SECRET); // 确认密钥确实进了配置层，否则本条是空跑
    expect(json).not.toContain(SECRET);
    expect(json).not.toMatch(/apiKey|api_key|Authorization|Bearer/i);
  });

  it('control 条件里带 visionPrompt 时导出也不含密钥', () => {
    process.env.VISION_API_KEY = SECRET;
    const step = {
      id: 'g', type: 'control', source: 'manual',
      control: { kind: 'if', condition: { kind: 'visionPrompt', value: '有弹窗吗' } },
      children: [],
    } as unknown as Step;
    const json = exportScript({ schema: 'electron-auto-test/step/v2', app: { name: 'd' }, steps: [step] });
    expect(json).not.toContain(SECRET);
  });

  it('脚本执行失败后，抛出的错误信息里不含密钥（会流向 UI/日志）', async () => {
    process.env.VISION_API_KEY = SECRET;
    let msg = '';
    try {
      await runScript(makeAdapter(), {
        schema: 'electron-auto-test/step/v2',
        app: { name: 'd' },
        steps: [{ id: 'a', type: 'assert', source: 'manual', params: { assertion: va() } }],
      });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).not.toContain(SECRET);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('模型端点返回 200 但内容异常时，结果里也不含密钥', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: SECRET },
      fetchImpl: async () => ({
        ok: true, status: 200,
        async json() { return { choices: [{ message: { content: 'not json at all' } }] }; },
        async text() { return 'not json at all'; },
      } as unknown as Response),
    });
    const r = await runAssertion(makeAdapter(), va(), { judge });
    expect(r.passed).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('注入 judge 不反向污染旧路径（向后兼容的另一半）', () => {
  it('注入恒真 judge 后，老断言 textContains 的失败仍然失败', async () => {
    const adapter = makeAdapter({ snapshot: async () => [{ text: '完全不同的内容' }] as never } as Partial<VisualCapable>);
    const r = await runAssertion(adapter, { kind: 'textContains', value: '目标文本' }, { judge: alwaysTrue });
    expect(r.passed).toBe(false);
  });

  it('注入恒真 judge 后，老脚本整体执行结果不变（该失败仍失败）', async () => {
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'old' },
      steps: [{ id: 'b', type: 'assert', source: 'manual', params: { assertion: { kind: 'textContains', value: '缺失文本' } } }],
    };
    const adapter = makeAdapter({ snapshot: async () => [{ text: '别的' }] as never } as Partial<VisualCapable>);
    await expect(runScript(adapter, script, undefined, undefined, { judge: alwaysTrue }))
      .rejects.toThrow(/断言失败/);
  });

  it('if 条件是旧 kind 时，注入 judge 不影响分支选择', async () => {
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'd' },
      steps: [{
        id: 'g', type: 'control', source: 'manual',
        control: { kind: 'if', condition: { kind: 'textContains', value: 'YES' } },
        children: [
          { id: 't', type: 'assert', source: 'manual', params: { assertion: { kind: 'textContains', value: 'YES' } } },
          { id: 'e', type: 'assert', source: 'manual', params: { assertion: { kind: 'textContains', value: 'NOPE' } } },
        ],
      } as unknown as Step],
    };
    const adapter = makeAdapter({ snapshot: async () => [{ text: 'YES 命中' }] as never } as Partial<VisualCapable>);
    // 走 then 分支（含 YES）应当通过
    await expect(runScript(adapter, script, undefined, undefined, { judge: alwaysTrue }))
      .resolves.toBeUndefined();
  });
});

describe('.gitignore 覆盖配置文件（密钥一 commit 就不可撤销，必须拦住）', () => {
  it('忽略规则含 vision.json / .electron-auto-test / .env 等', () => {
    const gi = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
    for (const pat of ['vision.json', '.vision.json', 'vision.local.json', '*.local.json', '.electron-auto-test/', '.env', '.env.local']) {
      expect(gi, `.gitignore 缺少 ${pat}`).toContain(pat);
    }
  });
});
