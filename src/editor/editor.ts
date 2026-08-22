// 脚本编辑操作（M3 可视化 UI 编辑壳的内置能力之一）。
// 设计：对内管理 Script 的增/删/改/重排，全部返回**新** Script（不可变更新，
// 便于撤销/重做，也契合 M5 Agent 改写脚本"生成新脚本"的语义）。
// 导入/导出校验复用 src/script/io.ts（单一真相源，避免重复 schema 检查逻辑）。
//
// 依据：docs/plan/plan.md §M3。

import type { Script, Step } from '../types/step';
import { importScript, exportScript } from '../script/io';

export class ScriptEditor {
  /** 不可变插入：在 index 处插入 step，返回新 Script。 */
  static insert(script: Script, step: Step, index?: number): Script {
    const steps = [...script.steps];
    const at = index === undefined ? steps.length : index;
    steps.splice(at, 0, step);
    return { ...script, steps };
  }

  /** 不可变删除：按 step.id 删除，返回新 Script。 */
  static remove(script: Script, stepId: string): Script {
    return { ...script, steps: script.steps.filter((s) => s.id !== stepId) };
  }

  /** 不可变更新：按 step.id 合并补丁，返回新 Script。 */
  static update(script: Script, stepId: string, patch: Partial<Step>): Script {
    return {
      ...script,
      steps: script.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    };
  }

  /** 不可变重排：把 stepId 移动到 toIndex，返回新 Script。 */
  static move(script: Script, stepId: string, toIndex: number): Script {
    const from = script.steps.findIndex((s) => s.id === stepId);
    if (from === -1) return script;
    const steps = [...script.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(toIndex, 0, moved);
    return { ...script, steps };
  }

  /** 导入（校验 schema/steps），失败抛 ScriptError。 */
  static load(json: string): Script {
    return importScript(json);
  }

  /** 导出为可读 JSON 字符串。 */
  static save(script: Script): string {
    return exportScript(script);
  }

  /** 往返一致性：export → import 后结构等价。 */
  static roundTrip(script: Script): Script {
    return importScript(exportScript(script));
  }
}
