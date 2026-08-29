// 步骤级编辑纯函数层（不可变、递归、CFG 树感知）。
// 为后续暴露成 MCP tool 做准备：本模块只产出新 Script/Step，不碰 src/mcp/。
// 设计原则见 CODEBUDDY.md / engineering.mdc：不可变返回新对象、递归遍历整棵 CFG 树、
// id 查找失败抛明确错误（不静默返回原样）、跨 WS/JSON/CDP 边界用 ?? {} 兜底。

import type { ControlKind, Script, Step } from '../types/step';

/** 唯一 id 生成：依赖 Node/浏览器全局 crypto.randomUUID（项目运行环境均已具备）。 */
function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** 深度优先（前序）展平整棵 CFG 树，保留相对顺序。 */
function flatten(steps: Step[]): Step[] {
  const out: Step[] = [];
  const walk = (list: Step[]): void => {
    for (const s of list) {
      out.push(s);
      if (s.children) walk(s.children);
    }
  };
  walk(steps);
  return out;
}

/** 递归查找 id 对应步骤。 */
function findStep(steps: Step[], stepId: string): Step | undefined {
  for (const s of steps) {
    if (s.id === stepId) return s;
    if (s.children) {
      const hit = findStep(s.children, stepId);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 不可变 insertStep。 */
export function insertStep(script: Script, step: Step, atIndex?: number): Script {
  const steps = [...script.steps];
  let at = atIndex ?? steps.length;
  // 支持负数：从末尾数（-1 表示插到末尾之前，即最后一步前）。
  if (at < 0) at = Math.max(0, steps.length + at);
  at = Math.min(at, steps.length);
  steps.splice(at, 0, step);
  return { ...script, steps };
}

/** 不可变 removeStep：递归删除任意深度节点。找不到抛错。 */
export function removeStep(script: Script, stepId: string): Script {
  if (!findStep(script.steps, stepId)) throw new Error(`step not found: ${stepId}`);
  const drop = (steps: Step[]): Step[] =>
    steps
      .filter((s) => s.id !== stepId)
      .map((s) => (s.children ? { ...s, children: drop(s.children) } : s));
  return { ...script, steps: drop(script.steps) };
}

/** 不可变 updateStep：递归按 id 深合并 patch。找不到抛错。 */
export function updateStep(script: Script, stepId: string, patch: Partial<Step>): Script {
  if (!findStep(script.steps, stepId)) throw new Error(`step not found: ${stepId}`);
  const deepMerge = (target: Step): Step => {
    const merged: Step = { ...target };
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof Step;
      const prev = (target as Record<string, unknown>)[key];
      const next = v as unknown;
      if (
        next && typeof next === 'object' && !Array.isArray(next) &&
        prev && typeof prev === 'object' && !Array.isArray(prev)
      ) {
        (merged as Record<string, unknown>)[key] = { ...(prev as object), ...(next as object) };
      } else {
        (merged as Record<string, unknown>)[key] = next;
      }
    }
    return merged;
  };
  const map = (steps: Step[]): Step[] =>
    steps.map((s) => {
      if (s.id === stepId) return deepMerge(s);
      if (s.children) return { ...s, children: map(s.children) };
      return s;
    });
  return { ...script, steps: map(script.steps) };
}

/** 不可变 moveStep：从任意深度摘除，插入顶层 steps[toIndex]。负数索引从末尾数。 */
export function moveStep(script: Script, stepId: string, toIndex: number): Script {
  const moved = findStep(script.steps, stepId);
  if (!moved) throw new Error(`step not found: ${stepId}`);
  // 先从原树（任意深度）摘除，再插到顶层目标位置。
  const without = (steps: Step[]): Step[] =>
    steps
      .filter((s) => s.id !== stepId)
      .map((s) => (s.children ? { ...s, children: without(s.children) } : s));
  const base = without(script.steps);
  let at = toIndex < 0 ? Math.max(0, base.length + toIndex) : toIndex;
  at = Math.min(at, base.length);
  base.splice(at, 0, moved);
  return { ...script, steps: base };
}

/**
 * 不可变 wrap：把选中步骤包成一个控制流组。
 * children 按原树**前序遍历顺序**排列（符合「框选一段→打包」预期，跨父组也成立）。
 * 新组替换这些步骤在原树中的第一个出现位置（其余选中项从原父级摘除）。
 * - sequence：children = 选中步骤。
 * - while：children = 选中步骤，loopCount 默认 1。
 * - if：children = [then 顺序组(含选中步骤), else 空顺序组]。
 * 找不到任何选中 id 抛错。
 */
export function wrap(script: Script, stepIds: string[], kind: ControlKind): Script {
  if (!(kind === 'sequence' || kind === 'if' || kind === 'while')) {
    throw new Error(`wrap: 不支持的 kind: ${String(kind)}`);
  }
  if (stepIds.length === 0) throw new Error('wrap: stepIds 为空');
  const idSet = new Set(stepIds);
  // 前序遍历收集，保持原树相对序。
  const picked = flatten(script.steps).filter((s) => idSet.has(s.id));
  if (picked.length === 0) throw new Error(`step not found: ${stepIds.join(', ')}`);

  const groupId = genId('grp');
  let group: Step;
  if (kind === 'if') {
    const thenId = genId('then');
    const elseId = genId('else');
    group = {
      id: groupId,
      type: 'assert',
      source: 'manual',
      control: { kind: 'if', name: `选择组 ${picked.length}` },
      children: [
        { id: thenId, type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: picked },
        { id: elseId, type: 'wait', source: 'manual', control: { kind: 'sequence' }, children: [] },
      ],
    };
  } else if (kind === 'while') {
    group = {
      id: groupId,
      type: 'wait',
      source: 'manual',
      control: { kind: 'while', loopCount: 1, name: `循环组 ${picked.length}` },
      children: picked,
    };
  } else {
    group = {
      id: groupId,
      type: 'wait',
      source: 'manual',
      control: { kind: 'sequence', name: `顺序组 ${picked.length}` },
      children: picked,
    };
  }

  // 计算第一个被选中步骤所在的兄弟列表位置，作为新组插入点。
  let insertAt = -1;
  const locate = (steps: Step[], idx: number): void => {
    if (insertAt !== -1) return;
    for (let i = 0; i < steps.length; i++) {
      if (idSet.has(steps[i].id)) {
        insertAt = idx + i;
        return;
      }
      const kids = steps[i].children;
      if (kids) locate(kids, 0);
    }
  };
  locate(script.steps, 0);

  // 从原树（任意深度）摘除所有选中项，再在插入点放入新组。
  const without = (steps: Step[]): Step[] =>
    steps
      .filter((s) => !idSet.has(s.id))
      .map((s) => (s.children ? { ...s, children: without(s.children) } : s));
  const base = without(script.steps);
  if (insertAt < 0 || insertAt > base.length) insertAt = base.length;
  base.splice(insertAt, 0, group);
  return { ...script, steps: base };
}

/** 不可变 unwrap：把组 children 摊平回直接父级，组本身删除。找不到抛错。 */
export function unwrap(script: Script, groupId: string): Script {
  const found = findStep(script.steps, groupId);
  if (!found) throw new Error(`step not found: ${groupId}`);
  const lift = (steps: Step[]): Step[] => {
    const out: Step[] = [];
    for (const s of steps) {
      if (s.id === groupId) {
        if (s.children?.length) out.push(...s.children);
        else out.push(s); // 原子组无 children，保留自身而非丢步。
        continue;
      }
      if (s.children) out.push({ ...s, children: lift(s.children) });
      else out.push(s);
    }
    return out;
  };
  return { ...script, steps: lift(script.steps) };
}

/** 不可变 addElse：给 if 组补 else 空分支（已有时不重复加）。找不到或非 if 抛错。 */
export function addElse(script: Script, groupId: string): Script {
  const found = findStep(script.steps, groupId);
  if (!found) throw new Error(`step not found: ${groupId}`);
  if (found.control?.kind !== 'if') throw new Error(`addElse: 非 if 组: ${groupId}`);
  if ((found.children ?? []).length >= 2) return script; // 已有 else，原样返回。
  const trueBranch = (found.children ?? [])[0] ?? {
    id: genId('then'), type: 'wait' as const, source: 'manual' as const,
    control: { kind: 'sequence' as const }, children: [],
  };
  const elseBranch: Step = {
    id: genId('else'), type: 'wait', source: 'manual',
    control: { kind: 'sequence' }, children: [],
  };
  return updateStep(script, groupId, { children: [trueBranch, elseBranch] });
}

/** 不可变 removeElse：删 if 组的 else 分支。找不到或非 if 抛错。 */
export function removeElse(script: Script, groupId: string): Script {
  const found = findStep(script.steps, groupId);
  if (!found) throw new Error(`step not found: ${groupId}`);
  if (found.control?.kind !== 'if') throw new Error(`removeElse: 非 if 组: ${groupId}`);
  const kids = found.children ?? [];
  if (kids.length < 2) return script; // 没有 else，原样返回。
  return updateStep(script, groupId, { children: [kids[0]] });
}

/** 不可变 clearSteps：清空 steps，保留 app/schema 等元信息。 */
export function clearSteps(script: Script): Script {
  return { ...script, steps: [] };
}
