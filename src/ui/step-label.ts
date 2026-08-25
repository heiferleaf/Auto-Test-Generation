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
  fill: '填写',
  select: '选择',
  wait: '等待',
  assert: '断言',
  hover: '悬停',
  eval: '执行',
  snapshot: '快照',
  waitUntil: '等待条件',
  repeat: '循环',
};

/** 把 locator 转成人类可读的简短描述。 */
export function describeLocator(loc?: Locator): string {
  if (!loc) return '';
  if (loc.name) return `"${loc.name}"`;
  if (loc.text) return `文本"${loc.text}"`;
  if (loc.testId) return `[data-testid=${loc.testId}]`;
  if (loc.role) return `<${loc.role}>`;
  if (loc.css) return loc.css;
  if (loc.xpath) return loc.xpath;
  return '';
}

/**
 * 简短描述（供 CFG 节点这类窄空间使用）：动词 + 定位目标。
 * 无定位信息时回退到 step.id，保证节点上永远有可读文字而非空白。
 */
export function describeStepBrief(step: Step): string {
  const verb = TYPE_LABEL[step.type] ?? step.type;
  return `${verb} ${describeLocator(step.locator)}`.trim() || step.id;
}
