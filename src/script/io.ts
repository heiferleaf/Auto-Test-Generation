// 脚本导入/导出（M1 design.md §7）
// 与 MCP Tool（script.import / script.export）语义一致。

import { SCRIPT_SCHEMAS, type Script } from '../types/step';

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
  return data as Script;
}

export function exportScript(script: Script): string {
  return JSON.stringify(script, null, 2);
}
