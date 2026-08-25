// 脚本编辑操作（可视化 UI 编辑壳的内置能力之一）。
// 设计：对内管理 Script 的增/删/改/重排/分组，全部返回**新** Script（不可变更新，
// 便于撤销/重做，也契合 M5 Agent 改写脚本"生成新脚本"的语义）。
// 导入/导出校验复用 src/script/io.ts（单一真相源，避免重复 schema 检查逻辑）。

import type { Script, Step } from '../types/step';
import { importScript, exportScript } from '../script/io';

/**
 * 取一个组的「体」子步骤（供 setGroupKind 转换时保留语义）：
 * - if 组：体 = True 分支（children[0]）的 children（False 丢弃，因目标 kind 无分支语义）。
 * - 其余：体 = children。
 */
function groupBody(group: Step): Step[] {
  if (group.control?.kind === 'if') {
    const trueBranch = (group.children ?? [])[0];
    return trueBranch?.children ?? [];
  }
  return group.children ?? [];
}

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
   * 把若干步骤整体包成一个控制流组（sequence/if/while），其余步骤保持原位。
   * 不可变：返回新 Script，原 script 不被修改。
   *
   * 三方一致（与 cfg-view / executor）：
   *   - sequence：children = 选中步骤（保持相对序）。
   *   - while：children = 选中步骤（循环体），loopCount 默认 1。
   *   - if：children[0] = 含选中步骤的顺序组（True），children[1] = 空顺序组（False）。
   *     **不得**把 N 叶直接塞进 children 当「第 1 条 then、第 2 条 else、其余丢弃」
   *     （spec §2.5 反复强调的最危险缺陷：图与真实执行相反）。
   * 空集合或不含合法 id 时原样返回。
   */
  static wrap(script: Script, ids: string[], kind: 'sequence' | 'if' | 'while'): Script {
    if (kind !== 'sequence' && kind !== 'if' && kind !== 'while') throw new Error('wrap: 仅支持 sequence/if/while 包组');
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
    // 选中步骤整体作为一个顺序子组（if 的 True 分支体；sequence/while 直接用 picked）。
    const seqBody: Step = {
      id: `${groupId}-seq`,
      type: 'wait', source: 'manual',
      control: { kind: 'sequence' },
      children: picked,
    };
    let group: Step;
    if (kind === 'if') {
      // children[0]=True（含选中步骤的顺序组）、children[1]=False（空顺序组）。
      const falseBranch: Step = {
        id: `${groupId}-else`, type: 'wait', source: 'manual',
        control: { kind: 'sequence' }, children: [],
      };
      group = {
        id: groupId, type: 'assert', source: 'manual',
        control: { kind: 'if' }, children: [seqBody, falseBranch],
      };
    } else if (kind === 'while') {
      group = {
        id: groupId, type: 'wait', source: 'manual',
        control: { kind: 'while', loopCount: 1 }, children: picked,
      };
    } else {
      // sequence：直接以选中步骤为子（不再多套一层顺序组，避免无意义嵌套）。
      group = {
        id: groupId, type: 'wait', source: 'manual',
        control: { kind: 'sequence' }, children: picked,
      };
    }
    return { ...script, steps: [group, ...remaining] };
  }

  /**
   * 拆包：把组的 children 提升回原父层级，组节点本身移除，不删任何内容（spec §2.5）。
   * 嵌套组只提升到其直接父级，不摊平到顶层。找不到 id 时原样返回。
   */
  static unpack(script: Script, groupId: string): Script {
    if (!ScriptEditor.flatten(script).some((s) => s.id === groupId)) return script;
    const lift = (steps: Step[]): Step[] => {
      const out: Step[] = [];
      for (const s of steps) {
        if (s.id === groupId) {
          if (s.children) out.push(...s.children);
          continue;
        }
        if (s.children) out.push({ ...s, children: lift(s.children) });
        else out.push(s);
      }
      return out;
    };
    return { ...script, steps: lift(script.steps) };
  }

  /**
   * 选中组改 kind（spec §2.5「选中组再设为选择组或循环组」）。
   * 转换时按目标结构重建 children，保留语义：
   *   - → sequence：取当前组「体」（if 取 True 分支内容）作为顺序子。
   *   - → while：取当前组「体」作为循环体，loopCount 保留或默认 1。
   *   - → if：当前「体」整体进 True（顺序组），False 置空顺序组。
   * 保留原 control.name（改名不随 kind 转换丢失）。
   */
  static setGroupKind(script: Script, groupId: string, kind: 'sequence' | 'if' | 'while'): Script {
    const found = ScriptEditor.flatten(script).find((s) => s.id === groupId);
    if (!found) return script;
    const body = groupBody(found);
    const name = found.control?.name;
    let control: Step['control'];
    let children: Step[];
    if (kind === 'if') {
      const seqId = `${groupId}-seq-${Date.now().toString(36)}`;
      const elseId = `${groupId}-else-${Date.now().toString(36)}`;
      control = { kind: 'if', ...(name ? { name } : {}) };
      children = [
        { id: seqId, type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: body },
        { id: elseId, type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: [] },
      ];
    } else if (kind === 'while') {
      control = { kind: 'while', loopCount: found.control?.loopCount ?? 1, ...(name ? { name } : {}) };
      children = body;
    } else {
      control = { kind: 'sequence', ...(name ? { name } : {}) };
      children = body;
    }
    const patch: Partial<Step> = { control, children };
    return ScriptEditor.updateNested(script, groupId, patch);
  }

  /** 设循环组的循环次数（spec §2.5）。非 while 组或不存在时原样返回。 */
  static setLoopCount(script: Script, groupId: string, loopCount: number): Script {
    const found = ScriptEditor.flatten(script).find((s) => s.id === groupId);
    if (!found || !found.control) return script;
    const ctrl = { ...found.control, loopCount };
    return ScriptEditor.updateNested(script, groupId, { control: ctrl });
  }

  /** 组命名（spec §2.5/D5）。不存在时原样返回。 */
  static renameGroup(script: Script, groupId: string, name: string): Script {
    const found = ScriptEditor.flatten(script).find((s) => s.id === groupId);
    if (!found || !found.control) return script;
    const ctrl = { ...found.control, name };
    return ScriptEditor.updateNested(script, groupId, { control: ctrl });
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
