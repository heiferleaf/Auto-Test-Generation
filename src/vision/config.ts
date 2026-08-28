// 视觉判定用的配置读取（决策 4：环境变量优先 + 用户级本地配置文件兜底）。
//
// 硬约束：**apikey 绝不进 Script JSON**（脚本是导出的产物，会进版本库/分享给他人）。
// 故密钥只存在于宿主进程侧：环境变量为首选，其次读用户家目录下的本地配置文件。
// 配置文件路径刻意放在用户家目录而非项目内，配合 .gitignore 双重保险防误提交。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 环境变量名（优先级最高）。 */
export const VISION_ENV = {
  apiKey: 'VISION_API_KEY',
  baseUrl: 'VISION_API_BASE',
  model: 'VISION_MODEL',
} as const;

/** 用户级本地配置文件（兜底）。文件名以 . 开头，属"本机私密配置"。 */
export const VISION_CONFIG_FILE = join(homedir(), '.electron-auto-test', 'vision.json');

/** 无鉴权也能用的本地端点（如 Ollama）时，可用该标记显式声明跳过密钥检查。 */
export const VISION_NO_KEY_ENV = 'VISION_NO_API_KEY';

export type VisionConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 显式声明该端点不需要密钥（本地自建/网关代鉴权）。 */
  noApiKey?: boolean;
};

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/** 读取用户级配置文件；文件不存在/损坏时静默返回空（不因配置问题让脚本崩）。 */
function readConfigFile(): VisionConfig {
  try {
    const raw = readFileSync(VISION_CONFIG_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const o = (parsed ?? {}) as Record<string, unknown>;
    return {
      apiKey: str(o.apiKey),
      baseUrl: str(o.baseUrl) ?? str(o.baseURL),
      model: str(o.model),
      noApiKey: o.noApiKey === true,
    };
  } catch {
    return {};
  }
}

/**
 * 解析最终配置：环境变量 > 用户级配置文件。
 * 返回 undefined 表示"该文件里没有对应项"，逐项回退而不是整体二选一。
 */
export function loadVisionConfig(): VisionConfig {
  const file = readConfigFile();
  const noKeyEnv = str(process.env[VISION_NO_KEY_ENV]);
  return {
    apiKey: str(process.env[VISION_ENV.apiKey]) ?? file.apiKey,
    baseUrl: str(process.env[VISION_ENV.baseUrl]) ?? file.baseUrl,
    model: str(process.env[VISION_ENV.model]) ?? file.model,
    noApiKey: noKeyEnv === '1' || noKeyEnv === 'true' || file.noApiKey === true,
  };
}

/**
 * 是否具备调用条件。
 * 返回 undefined = 可用；返回字符串 = 不可用且该串就是给人看的原因。
 */
export function visionConfigError(cfg: VisionConfig = loadVisionConfig()): string | undefined {
  if (cfg.apiKey) return undefined;
  // 本地/代鉴权端点可显式豁免，否则一律视为未配置（fail，不静默 skip）。
  if (cfg.noApiKey) return undefined;
  return (
    '未配置视觉模型 apikey：请设置环境变量 VISION_API_KEY，' +
    `或写入 ${VISION_CONFIG_FILE}（{\"apiKey\":\"...\"}）；` +
    `若端点无需鉴权请设 ${VISION_NO_KEY_ENV}=1`
  );
}
