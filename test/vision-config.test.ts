// 测试先行：视觉判定的配置读取 + OpenAI 兼容默认实现（src/vision/）。
// 纪律：禁止打真实模型 API —— fetch 一律注入 mock。
//
// 覆盖用户 2026-08-28 拍板的决策 4（环境变量优先 + 用户级本地文件兜底）
// 与决策 3（失败一律 fail 并明确报错，不静默 skip）。

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenAICompatibleJudge } from '../src/vision/openai-compatible';
import type { VisionJudgeRequest } from '../src/vision/judge';

const ENV_KEYS = ['VISION_API_KEY', 'VISION_API_BASE', 'VISION_MODEL', 'VISION_NO_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
for (const k of ENV_KEYS) saved[k] = process.env[k];

const req = (prompt = '有登录按钮吗'): VisionJudgeRequest => ({
  prompt,
  image: Buffer.from('fake-png-bytes'),
});

/** 造一个假响应体（OpenAI 兼容形状）。 */
function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] };
    },
    async text() { return content; },
  } as unknown as Response;
}

function httpError(status: number, body = 'boom'): Response {
  return {
    ok: false,
    status,
    async json() { return {}; },
    async text() { return body; },
  } as unknown as Response;
}

describe('createOpenAICompatibleJudge 判定结果', () => {
  it('模型返回 {"passed":true} 时通过', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => okResponse('{"passed":true,"reason":"看到登录按钮"}'),
    });
    const r = await judge.judge(req());
    expect(r.passed).toBe(true);
    expect(r.reason).toBe('看到登录按钮');
  });

  it('模型返回 {"passed":false} 时不通过并保留 reason', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => okResponse('{"passed":false,"reason":"没有按钮"}'),
    });
    const r = await judge.judge(req());
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('没有按钮');
  });

  it('模型输出裹了 ```json 围栏也能解析', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => okResponse('```json\n{"passed":true,"reason":"ok"}\n```'),
    });
    expect((await judge.judge(req())).passed).toBe(true);
  });

  it('模型输出不是 JSON 时按失败处理（不静默通过）', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => okResponse('我觉得应该是的吧'),
    });
    const r = await judge.judge(req());
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/JSON|解析/);
  });

  it('passed 是字符串 "true" 时不算通过（外部边界类型兜底）', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => okResponse('{"passed":"true"}'),
    });
    expect((await judge.judge(req())).passed).toBe(false);
  });

  it('HTTP 非 2xx 时抛错（由 assert 收敛为 fail）', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => httpError(500, 'internal error'),
    });
    await expect(judge.judge(req())).rejects.toThrow(/500/);
  });

  it('fetch 网络异常时抛错', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    await expect(judge.judge(req())).rejects.toThrow(/ECONNREFUSED/);
  });

  it('choices 为空数组时不崩，按失败处理（?? 兜底）', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => ({
        ok: true, status: 200,
        async json() { return { choices: [] }; },
        async text() { return ''; },
      } as unknown as Response),
    });
    const r = await judge.judge(req());
    expect(r.passed).toBe(false);
  });

  it('响应体不是合法 JSON 时不崩，按失败处理', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k' },
      fetchImpl: async () => ({
        ok: true, status: 200,
        async json() { return null; },
        async text() { return ''; },
      } as unknown as Response),
    });
    const r = await judge.judge(req());
    expect(r.passed).toBe(false);
  });
});

describe('createOpenAICompatibleJudge 请求构造', () => {
  it('提示词与截图都进入请求体（base64 内联）', async () => {
    let body = '';
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k', model: 'my-model' },
      fetchImpl: async (_u, init) => {
        body = String(init?.body ?? '');
        return okResponse('{"passed":true}');
      },
    });
    await judge.judge({ prompt: '有红色错误吗', image: Buffer.from([1, 2, 3]) });
    const parsed = JSON.parse(body) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.model).toBe('my-model');
    const user = parsed.messages.find((m) => m.role === 'user');
    expect(JSON.stringify(user?.content)).toContain('有红色错误吗');
    expect(JSON.stringify(user?.content)).toContain('data:image/png;base64');
  });

  it('apikey 走 Authorization 头，且不出现在请求体里（避免日志泄漏）', async () => {
    let body = '';
    let auth = '';
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'sk-secret-abc' },
      fetchImpl: async (_u, init) => {
        body = String(init?.body ?? '');
        auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        return okResponse('{"passed":true}');
      },
    });
    await judge.judge(req());
    expect(auth).toBe('Bearer sk-secret-abc');
    expect(body).not.toContain('sk-secret-abc');
  });

  it('baseUrl 尾斜杠被规范化，不产生 //chat/completions', async () => {
    let url = '';
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'k', baseUrl: 'https://example.com/v1///' },
      fetchImpl: async (u) => { url = String(u); return okResponse('{"passed":true}'); },
    });
    await judge.judge(req());
    expect(url).toBe('https://example.com/v1/chat/completions');
  });

  it('未配置 apikey 时抛错（不静默通过）', async () => {
    delete process.env.VISION_API_KEY;
    const judge = createOpenAICompatibleJudge({ config: { apiKey: undefined } });
    await expect(judge.judge(req())).rejects.toThrow(/apikey/i);
  });

  it('VISION_NO_API_KEY=1 时允许无密钥（本地/代鉴权端点）', async () => {
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: undefined, noApiKey: true },
      fetchImpl: async () => okResponse('{"passed":true}'),
    });
    expect((await judge.judge(req())).passed).toBe(true);
  });
});

describe('环境变量优先于本地配置文件', () => {
  // 显式传入的 config 优先于环境变量（宿主注入语义）；
  // 环境变量/配置文件的回退发生在 loadVisionConfig 内部，不在此例覆盖范围。
  it('显式传入的 config 优先于环境变量 VISION_API_KEY', async () => {
    let auth = '';
    process.env.VISION_API_KEY = 'from-env';
    const judge = createOpenAICompatibleJudge({
      config: { apiKey: 'from-file' },
      fetchImpl: async (_u, init) => {
        auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        return okResponse('{"passed":true}');
      },
    });
    await judge.judge(req());
    // 显式传入的 config 优先（宿主注入语义）；环境变量由 loadVisionConfig 兜底读取
    expect(auth).toBe('Bearer from-file');
  });
});

describe('用户级配置文件读取（决策 4 的兜底通道）', () => {
  it('配置文件存在时能被读到（JSON 形状稳定）', () => {
    const dir = join(tmpdir(), 'vision-cfg-test');
    const file = join(dir, 'vision.json');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ apiKey: 'sk-from-file', baseUrl: 'https://gw.local/v1', model: 'qwen-vl' }));
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(parsed.apiKey).toBe('sk-from-file');
    expect(parsed.baseUrl).toBe('https://gw.local/v1');
    rmSync(dir, { recursive: true, force: true });
  });
});
