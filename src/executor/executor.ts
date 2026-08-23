// 步骤执行器（M1-C）：按 Script.steps 顺序驱动 CdpAdapter 执行操作与断言。
// 设计依据：docs/design/design.md §6；错误需带 stepId，便于 CLI 输出结构化错误（§8-5）。

import type { CdpAdapter } from '../cdp/adapter';
import type { Script, Step, Locator } from '../types/step';
import { runAssertion, AssertionError } from './assert';
import { invokeAction } from './actions';

/** 执行整个脚本：对每条顶层 step 调递归 runNode。 */
export async function runScript(adapter: CdpAdapter, script: Script): Promise<void> {
  for (const step of script.steps) {
    await runNode(adapter, step);
  }
}

/**
 * 递归执行单个步骤节点（M3-R0 CFG）。
 * - 控制流节点（sequence/if/while）按结构调度 children；
 * - 叶子节点复用 runStep（selectTarget + 断言/动作分发）。
 */
async function runNode(adapter: CdpAdapter, node: Step): Promise<void> {
  const ctrl = node.control;
  if (!ctrl) {
    await runStep(adapter, node);
    return;
  }
  switch (ctrl.kind) {
    case 'sequence':
      for (const child of node.children ?? []) {
        await runNode(adapter, child);
      }
      break;
    case 'if': {
      const result = ctrl.condition
        ? await runAssertion(adapter, ctrl.condition)
        : { passed: true };
      const branches = node.children ?? [];
      // children[0]=then, children[1]=else
      const chosen = result.passed ? branches[0] : branches[1];
      if (chosen) await runNode(adapter, chosen);
      break;
    }
    case 'while': {
      const count = ctrl.loopCount ?? 1;
      for (let i = 0; i < count; i++) {
        for (const child of node.children ?? []) {
          await runNode(adapter, child);
        }
      }
      break;
    }
  }
}

async function runStep(adapter: CdpAdapter, step: Step): Promise<void> {
  // 多窗口：切换到指定目标。
  if (step.target !== undefined) {
    adapter.selectTarget(step.target);
  }

  try {
    // assert 类型或带 expect 的步骤走断言引擎。
    if (step.type === 'assert' || step.expect) {
      const assertion = step.expect ?? step.params?.assertion;
      if (!assertion) {
        throw new AssertionError(step.id, `步骤 ${step.id} 缺少断言内容`);
      }
      const result = await runAssertion(adapter, assertion);
      if (!result.passed) {
        throw new AssertionError(step.id, `断言失败 @ step ${step.id}: ${assertion.kind}`);
      }
      return;
    }

    // 其余类型映射到 adapter 调用。
    await invokeAction(adapter, step as Step & { type: Exclude<Step['type'], 'assert'> });
  } catch (err) {
    // adapter 抛出的普通 Error 不带 stepId；统一附加上下文，供 CLI 报告 failedStepId。
    if (err instanceof AssertionError) {
      throw err;
    }
    const wrapped = new Error(`step ${step.id} failed: ${(err as Error).message}`);
    (wrapped as Error & { stepId?: string }).stepId = step.id;
    throw wrapped;
  }
}

export { AssertionError };
