// 动作映射（M1.5）：将 Step 的 type/params 映射到 CdpAdapter 调用。
// 仅承载"调用转发"，不含控制流（控制流在 executor.ts）。
// OCP 重构（M1.5）：以策略注册表取代 switch，新增动作类型只需追加一项，executor 不变。

import type { CdpAdapter } from '../cdp/adapter';
import type { Step, Locator, StepType } from '../types/step';

export type ActionHandler = (
  adapter: CdpAdapter,
  step: Step & { type: Exclude<StepType, 'assert'> },
) => Promise<void>;

const noLoc = (loc: Locator | undefined): Locator => {
  if (!loc) throw new Error('该步骤缺少 locator');
  return loc;
};

/** 动作类型 → 处理策略的注册表。扩展新动作只需在此追加一项。 */
export const actionHandlers: Record<Exclude<StepType, 'assert'>, ActionHandler> = {
  click: async (adapter, step) => {
    await adapter.click(noLoc(step.locator));
  },
  fill: async (adapter, step) => {
    await adapter.fill(noLoc(step.locator), step.params?.value ?? '');
  },
  select: async (adapter, step) => {
    await adapter.select(noLoc(step.locator), step.params?.optionText ?? step.params?.value ?? '');
  },
  hover: async (adapter, step) => {
    await adapter.hover(noLoc(step.locator));
  },
  wait: async (adapter, step) => {
    await adapter.wait({ text: step.params?.key, durationMs: step.params?.durationMs });
  },
  eval: async (adapter, step) => {
    await adapter.eval(step.params?.code ?? '');
  },
  snapshot: async (adapter) => {
    await adapter.snapshot();
  },
};

/** 依据 step.type 把操作转发给注册表策略。未知 type 抛错（类型系统兜底）。 */
export async function invokeAction(
  adapter: CdpAdapter,
  step: Step & { type: Exclude<StepType, 'assert'> },
): Promise<void> {
  const handler = actionHandlers[step.type];
  if (!handler) {
    throw new Error(`未知步骤类型: ${step.type}`);
  }
  await handler(adapter, step);
}
