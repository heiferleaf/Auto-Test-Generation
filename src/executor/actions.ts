// 动作映射（M1-C）：将 Step 的 type/params 映射到 CdpAdapter 调用。
// 仅承载"调用转发"，不含控制流（控制流在 executor.ts）。

import type { CdpAdapter } from '../cdp/adapter';
import type { Step, Locator } from '../types/step';

type ActionStep = Step & { type: Exclude<Step['type'], 'assert'> };

/** 依据 step.type 把操作转发给 adapter。 */
export async function invokeAction(adapter: CdpAdapter, step: ActionStep): Promise<void> {
  const loc: Locator | undefined = step.locator;
  const p = step.params ?? {};

  switch (step.type) {
    case 'click':
      await adapter.click(loc!);
      break;
    case 'fill':
      await adapter.fill(loc!, p.value ?? '');
      break;
    case 'select':
      await adapter.select(loc!, p.optionText ?? p.value ?? '');
      break;
    case 'hover':
      await adapter.hover(loc!);
      break;
    case 'wait':
      await adapter.wait({ text: p.key, durationMs: p.durationMs });
      break;
    case 'eval':
      await adapter.eval(p.code ?? '');
      break;
    case 'snapshot':
      await adapter.snapshot();
      break;
    default:
      // 理论上类型系统已收窄，运行时兜底。
      throw new Error(`未知步骤类型: ${step.type}`);
  }
}
