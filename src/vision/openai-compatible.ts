// 默认视觉判定实现：走 OpenAI 兼容的 chat/completions 多模态接口。
//
// 为什么选 OpenAI 兼容协议作默认：它是事实上的通用形状（OpenAI / 通义千问兼容模式 /
// 火山方舟 / 智谱 / DeepSeek / 本地 Ollama+OpenWebUI / vLLM 都提供该端点），
// 换供应商只需改 VISION_API_BASE + VISION_MODEL，不动任何代码与脚本。
// 但内核**不绑定**它：宿主可注入任意 VisionJudge 替换本实现。

import { loadVisionConfig, visionConfigError, type VisionConfig } from './config';
import type { VisionJudge, VisionJudgeRequest, VisionJudgeResult } from './judge';

/** 默认端点（OpenAI 官方；用户应显式配置 VISION_API_BASE 指向自己的供应商）。 */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';

/** 判定超时（毫秒）。视觉模型通常比文本慢，但不该无限等。 */
const TIMEOUT_MS = 60_000;

/** 要求模型只回一行 JSON，避免自然语言包裹导致解析失败。 */
const SYSTEM_PROMPT =
  '你是 UI 自动化截图判定器。只根据截图回答用户的判定问题。' +
  '必须且只能输出一行 JSON：{"passed":true|false,"reason":"简短依据，中文，30 字内"}。' +
  '不要输出代码块、不要输出解释。';

/**
 * 密钥形态的常见正则。命中即打码，避免密钥顺着错误信息外泄。
 *
 * 为什么需要：OpenAI 及多数兼容供应商在 401 时会把用户密钥回显到错误体里
 * （实测形态 `Incorrect API key provided: sk-abc***************3a2b`），
 * 而错误信息会一路传到 UI 详情面板、MCP 工具返回与日志 —— 那是密钥被写进
 * 报告/截图/聊天记录的高危路径。
 */
const SECRET_PATTERNS: { re: RegExp; to: string }[] = [
  // OpenAI / 多数兼容供应商的密钥前缀。
  { re: /sk-[A-Za-z0-9_-]{4,}/g, to: 'sk-***' },
  // Authorization 头被回显时（如网关把请求头塞进错误体）。
  { re: /Bearer\s+[A-Za-z0-9._-]+/gi, to: 'Bearer ***' },
  // 结构化错误体里的 apiKey/api_key 字段值。
  { re: /api[-_]?key(["'\s:=]+)[A-Za-z0-9._-]+/gi, to: 'apiKey$1***' },
];

/**
 * 抹掉文本里的密钥形态片段，只用于**进错误/日志的展示文本**。
 *
 * 边界：绝不能用在请求体构造路径上 —— 真实的 apikey 该发出去还得原样发，
 * 这里脱敏的对象是"供应商回给我们的错误原文"，不是"我们发给供应商的凭据"。
 */
export function redactSecrets(text: string): string {
  let out = text ?? '';
  for (const { re, to } of SECRET_PATTERNS) {
    // 每次重建正则字面量不现实（带 /g 的正则有 lastIndex 状态），故显式复位。
    re.lastIndex = 0;
    out = out.replace(re, to);
  }
  return out;
}

/** 从模型文本里抠出第一个 JSON 对象；模型常爱包 ```json 围栏或前后加话。 */
function extractJson(text: string): Record<string, unknown> | undefined {
  const s = (text ?? '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把模型输出收敛为 {passed, reason}。
 *
 * 外部边界纪律：模型返回缺字段/类型不对是常态，不能崩也不能默认通过。
 * 只有 `passed === true`（严格布尔）才算通过，其余一律 false。
 */
function normalizeResult(raw: unknown): VisionJudgeResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const passed = o.passed === true;
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : undefined;
  return passed ? { passed: true, reason } : { passed: false, reason: reason ?? '模型判定为不成立' };
}

export type OpenAICompatibleJudgeOptions = {
  /** 覆盖配置（测试/宿主注入用）。缺省走 loadVisionConfig()。 */
  config?: VisionConfig;
  /** 注入 fetch（测试用，禁止打真实 API）。 */
  fetchImpl?: typeof fetch;
};

/** 构造一个走 OpenAI 兼容端点的 VisionJudge。 */
export function createOpenAICompatibleJudge(
  options: OpenAICompatibleJudgeOptions = {},
): VisionJudge {
  return {
    async judge(req: VisionJudgeRequest): Promise<VisionJudgeResult> {
      const cfg = options.config ?? loadVisionConfig();
      const err = visionConfigError(cfg);
      if (err) throw new Error(err);

      const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      const model = cfg.model ?? DEFAULT_MODEL;
      const doFetch = options.fetchImpl ?? fetch;

      const imageBase64 = req.image.toString('base64');
      const mimeType = req.mimeType ?? 'image/png';

      // AbortController：避免靶机/网关挂起时整个脚本卡死（视觉模型偶发长尾）。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: req.prompt },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
                ],
              },
            ],
          }),
          signal: ac.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // 错误体要脱敏再入 Error：供应商爱在 401 里回显密钥片段，
          // 而 Error 会流向 UI/日志/MCP 返回。（脱敏不影响上面真正发出的请求体。）
          throw new Error(
            `视觉模型返回 HTTP ${res.status}${body ? `: ${redactSecrets(body).slice(0, 200)}` : ''}`,
          );
        }

        const payload: unknown = await res.json().catch(() => null);
        const data = (payload ?? {}) as Record<string, unknown>;
        const choices = (data.choices ?? []) as Record<string, unknown>[];
        const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
        const content = typeof message.content === 'string' ? message.content : '';

        const parsed = extractJson(content);
        if (!parsed) {
          return { passed: false, reason: `模型未返回可解析的 JSON：${content.slice(0, 120)}` };
        }
        return normalizeResult(parsed);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
