// 步骤展示文案（UI 展示关注点，与内核语义解耦）。
//
// 为何独立成模块：步骤列表（shell.ts）与控制流图（cfg-view.ts）是**两个同级视图**，
// 都要把 Step 渲染成人话。此前各自维护一份 TYPE_LABEL 与描述函数，
// 属重复真相源（CODEBUDDY.md §4.1 清单 5）：改了一处另一处不跟随，
// 同一步骤在列表与图上显示不一致。故收敛到此处，两个视图共用。

import type { Locator, Step, StepType } from '../types/step';

/** step.type → 用户友好动词。键类型绑定 StepType，新增步骤类型时编译期提醒补文案。 */
export const TYPE_LABEL: Record<StepType, string> = {
  click: '点击',
  fill: '填充',
  select: '选择',
  wait: '等待',
  assert: '断言',
  hover: '悬停',
  eval: '执行',
  snapshot: '快照',
  waitUntil: '等待条件',
  repeat: '循环',
};

/** 把 locator 转成人类可读的简短描述：role + [name] + 截断 css。
 * 空 name 时不要只留下 `<textbox>`——那看起来像整段定位就是一个标签。
 */
export function truncateCss(css: string, max = 40): string {
  if (css.length <= max) return css;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${css.slice(0, keep)}…${css.slice(-keep)}`;
}

export function describeLocator(loc?: Locator): string {
  if (!loc) return '';
  const parts: string[] = [];
  const name = loc.name?.trim();
  if (loc.role) parts.push(loc.role);
  if (name) parts.push(`[${name}]`);
  else if (loc.text?.trim()) parts.push(`文本"${loc.text.trim()}"`);
  else if (loc.testId) parts.push(`[data-testid=${loc.testId}]`);
  if (loc.css) parts.push(truncateCss(loc.css));
  else if (!parts.length && loc.xpath) parts.push(loc.xpath);
  return parts.join(' ');
}

/**
 * 简短描述（供 CFG 节点这类窄空间使用）：动词 + 定位目标。
 * 无定位信息时回退到 step.id，保证节点上永远有可读文字而非空白。
 */
export function describeStepBrief(step: Step): string {
  const verb = TYPE_LABEL[step.type] ?? step.type;
  const loc = describeLocator(step.locator);
  if (step.type === 'fill' && step.params?.value !== undefined) {
    return `${verb} ${loc} = ${step.params.value}`.trim();
  }
  if (step.type === 'wait' && step.params?.durationMs !== undefined) {
    return `${verb} ${step.params.durationMs}ms`;
  }
  return `${verb} ${loc}`.trim() || step.id;
}
