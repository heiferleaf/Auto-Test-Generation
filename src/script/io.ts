// 脚本导入/导出：解析 JSON 为 Script 并校验 schema/steps/control.kind，导出则序列化为 JSON 字符串。
// 与 MCP Tool（script.import / script.export）语义一致；校验失败抛 ScriptError（边界硬失败）。

import { SCRIPT_SCHEMAS, CONTROL_KINDS, type Script } from '../types/step';

class ScriptError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ScriptError';
  }
}

function validateSteps(steps: unknown, path: string): void {
  if (!Array.isArray(steps)) {
    throw new ScriptError(`${path} 必须是数组`);
  }
  for (const s of steps as unknown[]) {
    if (typeof s !== 'object' || s === null) {
      throw new ScriptError(`${path} 含非法步骤`);
    }
    const step = s as Record<string, unknown>;
    // control.kind 必须是已知控制流类型。
    //
    // 为何在导入期就拦：未知 kind 不会崩，而是被下游**静默错渲/错跑** ——
    // CFG 视图会把它当顺序组画（流向丢失、子节点不挂载、标签误标"顺序 sequence"），
    // 执行器 runNode 的 switch 也会跳过它（步骤"看起来通过了"其实没执行）。
    // 静默错误比崩溃更难排查。桥边界 assertRunnableScript 只守 WS 路径，
    // 本地文件导入必须在此设同等门槛（CONTROL_KINDS 为单一真相源，新增类型自动跟随）。
    if (step.control !== undefined) {
      const ctrl = step.control;
      if (typeof ctrl !== 'object' || ctrl === null) {
        throw new ScriptError(`${path} 的 control 必须是对象`);
      }
      const kind = (ctrl as Record<string, unknown>).kind;
      if (typeof kind !== 'string' || !(CONTROL_KINDS as readonly string[]).includes(kind)) {
        throw new ScriptError(
          `${path} 的 control.kind 非法（实际: ${String(kind)}），合法值: ${CONTROL_KINDS.join(' / ')}`,
        );
      }
    }
    if (step.children !== undefined) {
      validateSteps(step.children, `${path}.[].children`);
    }
  }
}

export function importScript(json: string): Script {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ScriptError('脚本不是合法 JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new ScriptError('脚本必须是对象');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.schema !== 'string' || !(SCRIPT_SCHEMAS as readonly string[]).includes(obj.schema)) {
    throw new ScriptError(`schema 不匹配，期望 ${SCRIPT_SCHEMAS.join(' / ')}`);
  }
  if (!Array.isArray(obj.steps)) {
    throw new ScriptError('缺少 steps 数组');
  }
  validateSteps(obj.steps, 'steps');
  if (obj.shots !== undefined && (typeof obj.shots !== 'object' || obj.shots === null || Array.isArray(obj.shots))) {
    throw new ScriptError('shots 必须是对象（stepId → png data URL）');
  }
  return data as Script;
}

export function exportScript(script: Script): string {
  return JSON.stringify(script, null, 2);
}

/** 从脚本 JSON 或侧车 `{ shots }` / 扁平 map 取出 stepId→png。跨 JSON 边界用 ?? {}。 */
export function parseShotsMap(raw: unknown): Record<string, string> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const src = (obj.shots !== undefined && obj.shots !== null && typeof obj.shots === 'object' && !Array.isArray(obj.shots))
    ? (obj.shots as Record<string, unknown>)
    : obj;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src ?? {})) {
    if (k === 'schema' || k === 'app' || k === 'steps' || k === 'note' || k === 'createdAt') continue;
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}

/** 导入用：data URL 或裸 base64 都收成舞台可用的裸 base64。 */
export function shotToBase64(value: string): string {
  const s = (value ?? '').trim();
  const m = s.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i);
  return (m ? m[1] : s).replace(/\s+/g, '');
}

export function shotToDataUrl(value: string): string {
  const b64 = shotToBase64(value);
  if (!b64) return '';
  if (/^data:image\//i.test((value ?? '').trim())) return (value ?? '').trim();
  return `data:image/png;base64,${b64}`;
}
