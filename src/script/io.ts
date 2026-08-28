// 脚本导入/导出：解析 JSON 为 Script 并校验 schema/steps/control.kind，导出则序列化为 JSON 字符串。
// 与 MCP Tool（script.import / script.export）语义一致；校验失败抛 ScriptError（边界硬失败）。

import { SCRIPT_SCHEMAS, CONTROL_KINDS, STEP_TYPES, type Script } from '../types/step';

class ScriptError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ScriptError';
  }
}

// 校验集合与清单一律从 types/step.ts 的运行时常量派生（单一真相源）：
// 新增类型只改那一处，此处自动跟随，不会漂移。禁止在此手写字面量数组。
const STEP_TYPE_SET: ReadonlySet<string> = new Set<string>(STEP_TYPES);
const CONTROL_KIND_SET: ReadonlySet<string> = new Set<string>(CONTROL_KINDS);

/** 合法步骤类型清单（报错与 MCP 工具描述共用）。 */
export const STEP_TYPE_LIST = STEP_TYPES.join('/');

/**
 * 从 Playwright 迁移过来的 Agent 会把 Playwright 的方法名当步骤类型写（press/type/dblclick…）。
 * 只回一句"不是已知步骤类型"不够用：它不知道该换成什么，只能随机重试，来回几轮。
 * 故按实际值给一条有针对性的替换建议。key 一律小写，匹配时再 lower。
 */
const PLAYWRIGHT_TYPE_HINTS: Readonly<Record<string, string>> = {
  press: '键盘按键请在 eval 步骤的 params.code 里调用 evaluate，或在 fill 步骤的 params.value 里直接给最终值',
  type: '逐字输入本平台不支持，请在 fill 步骤的 params.value 里直接给最终值',
  check: '勾选请用 click 步骤点击该控件',
  uncheck: '取消勾选请用 click 步骤点击该控件',
  dblclick: '双击请用 click 步骤（确需双击语义时用 eval 步骤派发 dblclick 事件）',
  tap: '触屏轻点请用 click 步骤',
  selectoption: '下拉选择请用 select 步骤（params.optionText 给选项文本）',
  setinputfiles: '文件上传请用 eval 步骤',
  goto: '页面导航请用 eval 步骤（如 location.href = ...）',
  reload: '页面刷新请用 eval 步骤（如 location.reload()）',
  goback: '后退请用 eval 步骤（如 history.back()）',
  goforward: '前进请用 eval 步骤（如 history.forward()）',
  waitforselector: '等待元素出现请用 waitUntil 步骤（params.assertion）',
  waitfortimeout: '等待固定时长请用 wait 步骤（params.durationMs）',
  waitforresponse: '等待请求请用 waitUntil 步骤（params.assertion）',
  waitfornavigation: '等待导航请用 waitUntil 步骤（params.assertion）',
  focus: '聚焦请用 click 步骤',
  blur: '失焦请用 eval 步骤',
  screenshot: '截图请用 snapshot 步骤',
  innertext: '取文本做断言请用 assert 步骤（expect.kind）',
  textcontent: '取文本做断言请用 assert 步骤（expect.kind）',
  getattribute: '取属性做断言请用 assert 步骤（expect.kind）',
  dragto: '拖拽请用 eval 步骤',
};

/**
 * 格式化"未知步骤类型"错误。**导入期（本文件）与执行期（ui/bridge-server）共用此函数**，
 * 措辞与映射提示只有一份，两边不会各写一套而漂移。
 *
 * 为何要共用而不是各写一份：执行期那份原来只说"不是已知步骤类型"，不告诉 Agent 该换成什么；
 * 而导入期干脆不校验，于是 script.import 返回成功、等到 actions.execute_steps 才炸 ——
 * Agent 拿到的是假绿灯，白跑一整轮。
 */
export function stepTypeErrorMessage(path: string, actual: unknown): string {
  if (actual === undefined || actual === null) {
    return `${path}.type 缺失（实际: ${actual === null ? 'null' : 'undefined'}）；合法值: ${STEP_TYPE_LIST}`;
  }
  const raw = String(actual).trim();
  const hint = PLAYWRIGHT_TYPE_HINTS[raw.toLowerCase()];
  const head = `${path}.type 不是已知步骤类型（实际: ${raw}）；合法值: ${STEP_TYPE_LIST}。`;
  return hint ? `${head}\n本平台没有 ${raw} 步骤；${hint}。` : head;
}

/**
 * 递归收集步骤树里的所有结构性问题到 `errors`，不直接抛。
 *
 * 收集而非遇错即抛：调用方是 Agent，一次只看得到一条错误就得改一次、重跑一次，
 * 脚本里 N 个坏步骤要 N 轮往返。故遍历完整棵树再一次性报全。
 * `path` 带下标（如 `steps[3].children[0]`），嵌套字段是 `children` ——
 * 旧实现拼成 `steps.[].children` 丢了下标，报错定位不到具体哪一步。
 */
function validateSteps(steps: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(steps)) {
    throw new ScriptError(`${path} 必须是数组`);
  }
  (steps as unknown[]).forEach((s, i) => {
    const here = `${path}[${i}]`;
    if (typeof s !== 'object' || s === null) {
      errors.push(`${here} 不是合法 step 对象（实际: ${s === null ? 'null' : typeof s}）`);
      return;
    }
    const step = s as Record<string, unknown>;

    // type 必须在已知集合内。
    //
    // 为何在导入期就拦：未知 type 在这儿不报错，而是一路流到执行期动作分发才炸
    // （script.import 返回成功、actions.execute_steps 才说 press 不是已知类型），
    // Agent 在导入期拿到的是假绿灯。STEP_TYPES 为单一真相源，新增类型自动跟随。
    if (typeof step.type !== 'string' || !STEP_TYPE_SET.has(step.type)) {
      errors.push(stepTypeErrorMessage(here, step.type));
    }

    // control.kind 必须是已知控制流类型。
    //
    // 理由同上：未知 kind 不会崩，而是被下游**静默错渲/错跑** ——
    // CFG 视图会把它当顺序组画（流向丢失、子节点不挂载、标签误标"顺序 sequence"），
    // 执行器 runNode 的 switch 也会跳过它（步骤"看起来通过了"其实没执行）。
    // 静默错误比崩溃更难排查。桥边界 assertRunnableScript 只守 WS 路径，
    // 本地文件导入必须在此设同等门槛。
    if (step.control !== undefined) {
      const ctrl = step.control;
      if (typeof ctrl !== 'object' || ctrl === null) {
        errors.push(`${here} 的 control 必须是对象（实际: ${ctrl === null ? 'null' : typeof ctrl}）`);
      } else {
        const kind = (ctrl as Record<string, unknown>).kind;
        if (typeof kind !== 'string' || !CONTROL_KIND_SET.has(kind)) {
          errors.push(
            `${here} 的 control.kind 非法（实际: ${String(kind)}），合法值: ${CONTROL_KINDS.join(' / ')}`,
          );
        }
      }
    }
    if (step.children !== undefined) {
      if (!Array.isArray(step.children)) {
        errors.push(
          `${here} 的 children 必须是数组（实际: ${step.children === null ? 'null' : typeof step.children}）`,
        );
      } else {
        validateSteps(step.children, `${here}.children`, errors);
      }
    }
  });
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
  const errors: string[] = [];
  validateSteps(obj.steps, 'steps', errors);
  if (obj.shots !== undefined && (typeof obj.shots !== 'object' || obj.shots === null || Array.isArray(obj.shots))) {
    throw new ScriptError('shots 必须是对象（stepId → png data URL）');
  }
  if (errors.length > 0) {
    throw new ScriptError(
      `脚本含 ${errors.length} 个非法步骤：\n${errors.join('\n')}`,
    );
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
