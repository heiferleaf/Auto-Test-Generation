// 脚本编辑操作（可视化 UI 编辑壳的内置能力之一）。
// 设计：对内管理 Script 的增/删/改/重排/分组，全部返回**新** Script（不可变更新，
// 便于撤销/重做，也契合 M5 Agent 改写脚本"生成新脚本"的语义）。
// 导入/导出校验复用 src/script/io.ts（单一真相源，避免重复 schema 检查逻辑）。

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

  /** 不可变更新：按 step.id 合并补丁，返回新 Script（仅顶层）。 */
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

  /** 递归展平：把嵌套 children 全部摊平为单层步骤列表（顺序 = 深度优先）。 */
  static flatten(script: Script): Step[] {
    const out: Step[] = [];
    const walk = (steps: Step[]) => {
      for (const s of steps) {
        out.push(s);
        if (s.children) walk(s.children);
      }
    };
    walk(script.steps);
    return out;
  }

  /**
   * 把若干步骤整体包成一个控制流组（if/while），其余步骤保持原位。
   * 不可变：返回新 Script，原 script 不被修改。
   * 约定：if 组的 children[0]=then / children[1]=else（与 cfg-view / executor 三方一致）。
   * 选中步骤按原相对顺序移入 children；空集合或不含合法 id 时原样返回。
   */
  static wrap(script: Script, ids: string[], kind: 'if' | 'while'): Script {
    if (kind !== 'if' && kind !== 'while') throw new Error('wrap: 仅支持 if/while 包组');
    if (ids.length === 0) return script;

    const idSet = new Set(ids);
    // 按原树顺序收集被选中的步骤（深度优先展平后过滤，保留相对序）。
    const picked: Step[] = ScriptEditor.flatten(script).filter((s) => idSet.has(s.id));
    if (picked.length === 0) return script;

    // 递归从树中剔除被抽出的步骤，返回新 steps（其余原样保留引用）。
    const dropPicked = (steps: Step[]): Step[] =>
      steps
        .filter((s) => !idSet.has(s.id))
        .map((s) => (s.children ? { ...s, children: dropPicked(s.children) } : s));

    const remaining = dropPicked(script.steps);
    const groupId = `grp-${kind}-${Date.now().toString(36)}-${picked.length}`;
    const group: Step = {
      id: groupId,
      type: kind === 'if' ? 'assert' : 'wait', // 组节点占位 type（控制节点，执行器按 control 分流）
      source: 'manual',
      control: kind === 'if' ? { kind: 'if' } : { kind: 'while', loopCount: 1 },
      children: picked,
    };
    return { ...script, steps: [group, ...remaining] };
  }

  /** 递归定位任意深度的步骤并合并补丁，返回新 Script（不可变）。找不到 id 时原样返回。 */
  static updateNested(script: Script, stepId: string, patch: Partial<Step>): Script {
    const mapTree = (steps: Step[]): Step[] =>
      steps.map((s) => {
        if (s.id === stepId) return { ...s, ...patch };
        if (s.children) return { ...s, children: mapTree(s.children) };
        return s;
      });
    if (!ScriptEditor.flatten(script).some((s) => s.id === stepId)) return script;
    return { ...script, steps: mapTree(script.steps) };
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
