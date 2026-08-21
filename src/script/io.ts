// 脚本导入/导出（M1 设计文档 §7）
// 与 MCP Tool（script.import / script.export）语义一致。

import { SCRIPT_SCHEMA, type Script } from '../types/step';

class ScriptError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ScriptError';
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
  if (obj.schema !== SCRIPT_SCHEMA) {
    throw new ScriptError(`schema 不匹配，期望 ${SCRIPT_SCHEMA}`);
  }
  if (!Array.isArray(obj.steps)) {
    throw new ScriptError('缺少 steps 数组');
  }
  return data as Script;
}

export function exportScript(script: Script): string {
  return JSON.stringify(script, null, 2);
}
