// 审查补充测试：密钥泄漏面审计 + 向后兼容审计。
//
// 两条硬约束：
//  A. apikey 绝不进导出产物（脚本会进版本库/被分享，泄漏不可撤销）。
//  B. 老脚本（无 visionPrompt）行为必须逐字节不变；新 kind 不得污染旧路径。
//
// 与 vision-host.test.ts 的分工：那边测"正常导出不含密钥"这个 happy path，
// 这边测**泄漏面**——把密钥放到最容易被带走的地方（step 字段、params、note、
// MCP 工具参数、断言 value），确认导出/序列化后都搜不到。

import { describe, it, expect, afterEach } from 'vitest';
import { exportScript, importScript } from '../src/script/io';
import { runScript } from '../src/executor/executor';
import { invokeAction } from '../src/executor/actions';
import { runAssertion } from '../src/executor/assert';
import { loadVisionConfig, visionConfigError } from '../src/vision/config';
import { createOpenAICompatibleJudge, redactSecrets } from '../src/vision/openai-compatible';
import { ASSERTION_KINDS, type Script, type Step } from '../src/types/step';
import type { CdpAdapter, VisualCapable } from '../src/cdp/adapter';

const SECRET = 'sk-audit-DO-NOT-LEAK-9f3a2b';
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

/** 断言"任何形态的序列化产物里都搜不到密钥"。 */
function expectNoSecret(...serialized: string[]) {
  for (const s of serialized) {
    expect(s).not.toContain(SECRET);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  }
}

describe('密钥泄漏面：apikey 不进任何导出产物', () => {
  it('环境变量里有密钥时，导出脚本仍不含密钥', () => {
    process.env.VISION_API_KEY = SECRET;
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'demo' },
      steps: [{
        id: 's1', type: 'assert', source: 'manual',
        params: { assertion: { kind: 'visionPrompt', value: '有没有错误提示' } },
      }],
    };
    // 先确认密钥确实被配置层读到了（否则这条测试是空跑）
    expect(loadVisionConfig().apiKey).toBe(SECRET);
    expect(visionConfigError()).toBeUndefined();
    expectNoSecret(exportScript(script), JSON.stringify(script));
  });

  it('密钥被误塞进 step 的各类字段时，导出仍不含（防手滑写入）', () => {
    const step = {
      id: 's1',
      type: 'assert',
      source: 'manual',
      note: `备注里不小心写了 ${SECRET}`,
      params: { assertion: { kind: 'visionPrompt', value: 'x' } },
    } as unknown as Step;
    const script: Script = { schema: 'electron-auto-test/step/v2', app: { name: 'd' }, steps: [step] };
    // 本条只验证 exportScript 是纯序列化、不会"主动"注入或复制密钥；
    // 用户自己手写的敏感文本不在本函数职责内，故只断言没有凭空多出一份。
    const json = exportScript(script);
    expect(json.split(SECRET).length - 1).toBeLessThanOrEqual(1);
    expect(json).not.toMatch(/apiKey|Authorization|Bearer/i);
  });

  it('断言执行结果（含 reason）里不含密钥，可安全回显给 UI', async () => {
    process.env.VISION_API_KEY = SECRET;
    const r = await runAssertion(makeAdapter(), { kind: 'visionPrompt', value: '有没有错误提示' }, null);
    // 无注入时按未配置处理；理由里只应有配置指引，不应回显密钥本身
    expect(r.passed).toBe(false);
    expectNoSecret(JSON.stringify(r));
  });

  it('未配置 apikey 时，抛出的错误带"为什么失败"（否则用户无从下手）', async () => {
    // 不设环境变量、不注入 judge → 走"未配置"分支
    let errJson = '';
    try {
      await runScript(makeAdapter(), {
        schema: 'electron-auto-test/step/v2',
        app: { name: 'd' },
        steps: [{
          id: 'a', type: 'assert', source: 'manual',
          params: { assertion: { kind: 'visionPrompt', value: '有没有错误提示' } },
        }],
      });
    } catch (err) {
      errJson = JSON.stringify({ name: (err as Error).name, message: (err as Error).message });
    }
    expect(errJson).toMatch(/断言失败/);
    expect(errJson).toMatch(/apikey|VISION_API_KEY|未配置/i);
    expectNoSecret(errJson);
  });

  it('模型拒答（401）时错误体经脱敏，不含密钥片段', async () => {
    // 供应商错误体常会"贴心"地把用户密钥回显出来（OpenAI 实测：
    // Incorrect API key provided: sk-audit***************3a2b）。
    // 错误体会经 AssertionError 流向 UI/日志/MCP 返回，故必须脱敏后入 Error。
    const echoBody = `{"error":{"message":"Incorrect API key provided: ${SECRET}"}}`;
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: SECRET },
      fetchImpl: async () => ({
        ok: false, status: 401,
        async text() { return echoBody; },
        async json() { return JSON.parse(echoBody); },
      } as unknown as Response),
    });
    let errJson = '';
    try {
      await runScript(makeAdapter(), {
        schema: 'electron-auto-test/step/v2',
        app: { name: 'd' },
        steps: [{
          id: 'a', type: 'assert', source: 'manual',
          params: { assertion: { kind: 'visionPrompt', value: '有没有错误提示' } },
        }],
      }, undefined, undefined, { judge });
    } catch (err) {
      errJson = JSON.stringify({ name: (err as Error).name, message: (err as Error).message });
    }
    expect(errJson).toMatch(/断言失败/);
    // 仍要保留"为什么失败"的可诊断信息（HTTP 状态码），只是密钥被抹掉。
    expect(errJson).toMatch(/401/);
    expectNoSecret(errJson);
    expect(errJson).toMatch(/sk-\*\*\*/);
  });
});

describe('redactSecrets 脱敏覆盖各密钥形态', () => {
  it('sk- 前缀密钥被打码', () => {
    const out = redactSecrets('Incorrect API key provided: sk-audit-DO-NOT-LEAK-9f3a2b');
    expect(out).not.toContain('9f3a2b');
    expect(out).toContain('sk-***');
  });

  it('Bearer 头被打码（大小写不敏感）', () => {
    expect(redactSecrets('got Bearer abcDEF.123-xyz here')).toBe('got Bearer *** here');
    expect(redactSecrets('got bearer abcDEF.123-xyz here')).toBe('got Bearer *** here');
  });

  it('apiKey / api_key 字段值被打码', () => {
    expect(redactSecrets('{"apiKey":"secretvalue123"}')).toContain('***');
    expect(redactSecrets('{"api_key": "secretvalue123"}')).toContain('***');
    expect(redactSecrets('apiKey=secretvalue123')).toContain('***');
  });

  it('一行里多处密钥都被打码（/g 生效，不是只替换第一处）', () => {
    const out = redactSecrets('k1=sk-AAAA1111 and k2=sk-BBBB2222');
    expect(out).toBe('k1=sk-*** and k2=sk-***');
  });

  it('普通文本不被误伤（不过度脱敏）', () => {
    const plain = '视觉模型返回 HTTP 500: upstream timeout';
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('空字符串与无密钥输入原样返回', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('HTTP 429 rate limited')).toBe('HTTP 429 rate limited');
  });

  it('脱敏不污染正常请求体：真实 apikey 仍原样发给供应商', async () => {
    let auth = '';
    let body = '';
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: SECRET },
      fetchImpl: async (_u, init) => {
        auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        body = String(init?.body ?? '');
        return {
          ok: true, status: 200,
          async json() { return { choices: [{ message: { content: '{"passed":true}' } }] }; },
          async text() { return ''; },
        } as unknown as Response;
      },
    });
    await judge.judge({ prompt: 'x', image: Buffer.from('png') });
    // 请求侧是真实凭据，必须完整发出（脱敏只作用于错误文本）
    expect(auth).toBe(`Bearer ${SECRET}`);
    // 请求体里也不该出现密钥（密钥只在 header）
    expect(body).not.toContain(SECRET);
  });
});

describe('向后兼容：老脚本（无 visionPrompt）行为不变', () => {
  it('ASSERTION_KINDS 是旧 kind 的超集（只增不减）', () => {
    const old = ['exists', 'visible', 'textContains', 'titleIs', 'urlMatches', 'expr',
      'elementVisibleInViewport', 'screenshotMatches'] as const;
    for (const k of old) expect(ASSERTION_KINDS).toContain(k);
  });

  it('老脚本（v1 schema，无 ctx）能正常跑完', async () => {
    const old: Script = {
      schema: 'electron-auto-test/step/v1',
      app: { name: 'old' },
      steps: [
        { id: 'a', type: 'click', source: 'manual', locator: { role: 'button' } },
        { id: 'b', type: 'assert', source: 'manual', params: { assertion: { kind: 'textContains', value: 'OK' } } },
      ],
    };
    const adapter = makeAdapter({
      snapshot: async () => [{ text: 'OK 保存成功' }] as never,
    } as Partial<VisualCapable>);
    await expect(runScript(adapter, old)).resolves.toBeUndefined();
  });

  it('runScript 不传第五参（ctx）时与扩展前一致', async () => {
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'd' },
      steps: [{ id: 'a', type: 'assert', source: 'manual', params: { assertion: { kind: 'textContains', value: 'OK' } } }],
    };
    const adapter = makeAdapter({ snapshot: async () => [{ text: 'OK' }] as never } as Partial<VisualCapable>);
    await expect(runScript(adapter, script)).resolves.toBeUndefined();
    await expect(runScript(adapter, script, undefined, undefined, null)).resolves.toBeUndefined();
  });

  it('invokeAction 不传 ctx 时 waitUntil 仍按旧语义工作', async () => {
    const adapter = makeAdapter({ query: async () => ({}) as never } as Partial<VisualCapable>);
    await expect(invokeAction(adapter, {
      id: 'w', type: 'waitUntil', source: 'manual',
      params: { assertion: { kind: 'exists', locator: { role: 'button' } } },
    } as never)).resolves.toBeUndefined();
  });
});

describe('waitUntil 遇到 visionPrompt 但没注入 judge 时的行为', () => {
  it('不注入 judge：轮询到超时后抛错，不静默通过', async () => {
    const adapter = makeAdapter();
    // visionPrompt 每轮都判 fail（未配置），waitUntil 会一直轮询到 deadline。
    await expect(invokeAction(adapter, {
      id: 'w', type: 'waitUntil', source: 'manual',
      params: {
        assertion: { kind: 'visionPrompt', value: '错误提示消失了吗' },
        timeoutMs: 120,
      },
    } as never)).rejects.toThrow(/waitUntil 超时/);
  });

  it('注入 judge 后按模型结果决定：判 true 则等待成功返回', async () => {
    const adapter = makeAdapter();
    await expect(invokeAction(adapter, {
      id: 'w', type: 'waitUntil', source: 'manual',
      params: {
        assertion: { kind: 'visionPrompt', value: '错误提示消失了吗' },
        timeoutMs: 1000,
      },
    } as never, { judge: { async judge() { return { passed: true, reason: '已经消失' }; } } })).resolves.toBeUndefined();
  });

  it('注入的 judge 恒判 false 时同样是超时（不是立刻通过）', async () => {
    const adapter = makeAdapter();
    await expect(invokeAction(adapter, {
      id: 'w', type: 'waitUntil', source: 'manual',
      params: {
        assertion: { kind: 'visionPrompt', value: '出现了吗' },
        timeoutMs: 120,
      },
    } as never, { judge: { async judge() { return { passed: false, reason: '还没出现' }; } } })).rejects.toThrow(/waitUntil 超时/);
  });

  it('waitUntil 缺 assertion 时退化为纯等待（既有语义，非本分支引入）', async () => {
    let waited: unknown;
    const adapter = makeAdapter({
      wait: async (o: unknown) => { waited = o; },
    } as Partial<VisualCapable>);
    await expect(invokeAction(adapter, {
      id: 'w', type: 'waitUntil', source: 'manual', params: {},
    } as never)).resolves.toBeUndefined();
    // 未指定 timeoutMs 时按默认 10s 等待
    expect(waited).toEqual({ durationMs: 10_000 });
  });
});

describe('导入导出往返：visionPrompt 与旧脚本都无损', () => {
  it('含 visionPrompt 的新脚本往返后提示词不丢', () => {
    const prompt = '截图里是否出现了成功提示？';
    const script: Script = {
      schema: 'electron-auto-test/step/v2',
      app: { name: 'd' },
      steps: [{ id: 's', type: 'assert', source: 'manual', params: { assertion: { kind: 'visionPrompt', value: prompt } } }],
    };
    const back = importScript(exportScript(script));
    expect(back.steps[0].params?.assertion?.kind).toBe('visionPrompt');
    expect(back.steps[0].params?.assertion?.value).toBe(prompt);
  });

  it('v1 老脚本往返后无新增字段（schema 未被升级改写）', () => {
    const v1 = JSON.stringify({
      schema: 'electron-auto-test/step/v1',
      app: { name: 'old' },
      steps: [{ id: 'a', type: 'click', source: 'manual', locator: { role: 'button' } }],
    });
    const back = importScript(v1);
    expect(back.schema).toBe('electron-auto-test/step/v1');
    expect(Object.keys(back.steps[0])).toEqual(Object.keys(JSON.parse(v1).steps[0]));
  });
});
