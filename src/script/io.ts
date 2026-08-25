// 脚本导入/导出（M1 design.md §7）
// 与 MCP Tool（script.import / script.export）语义一致。

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
  return data as Script;
}

export function exportScript(script: Script): string {
  return JSON.stringify(script, null, 2);
}
