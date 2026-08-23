// 步骤执行器（M1-C）：按 Script.steps 顺序驱动 CdpAdapter 执行操作与断言。
// 设计依据：docs/design/design.md §6；错误需带 stepId，便于 CLI 输出结构化错误（§8-5）。

import type { CdpAdapter } from '../cdp/adapter';
import type { Script, Step, Locator } from '../types/step';
import { runAssertion, AssertionError } from './assert';
import { invokeAction } from './actions';

/**
 * 逐步进度回调（M3-R3）：叶子步骤开始/结束时上报，供 UI 实时回显与高亮跟随。
 *
 * 为何放在执行器而非 UI 侧传函数给内核：`UiKernel` 会被 WsKernel 跨 WebSocket 实现，
 * 函数无法 JSON 序列化（真机上回调必然丢失）。故进度源必须在 Node 进程内产生，
 * 再由 bridge-server 经单向推送通道下发给浏览器端。详见 CODEBUDDY.md §4.1。
 */
export type StepProgress = (stepId: string, status: 'running' | 'pass' | 'fail') => void;

/**
 * 执行整个脚本：对每条顶层 step 调递归 runNode。
 * @param onStep 可选进度回调；不传则行为与 R3 之前完全一致（向后兼容）。
 */
export async function runScript(
  adapter: CdpAdapter,
  script: Script,
  onStep?: StepProgress,
): Promise<void> {
  // 进度上报是辅助能力：订阅方回调抛错不得中断脚本执行。
  const report: StepProgress = onStep
    ? (id, st) => {
        try {
          onStep(id, st);
        } catch (err) {
          console.warn('[executor] 进度回调抛错（已忽略）:', err instanceof Error ? err.message : err);
        }
      }
    : () => {};
  for (const step of script.steps) {
    await runNode(adapter, step, report);
  }
}

/**
 * 递归执行单个步骤节点（M3-R0 CFG）。
 * - 控制流节点（sequence/if/while）按结构调度 children；
 * - 叶子节点复用 runStep（selectTarget + 断言/动作分发）。
 */
/**
 * 校验并返回控制流节点的子步骤（双保险）。
 *
 * 桥边界（bridge-server.assertRunnableScript）已递归校验，但脚本还可能经
 * CLI 文件导入 / 未来 MCP Tool 进入。若 children 混入 null，直接递归会抛
 * "Cannot read properties of null (reading 'control')" —— 该错误不带 stepId，
 * 被 runCli 吞成 failedStepId:undefined，UI 只能显示"(未知)"，根因被掩盖。
 * 故此处抛出带父节点 id 的明确错误。
 */
function childrenOf(node: Step): Step[] {
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    if (children[i] == null) {
      throw new Error(`step ${node.id} 的 children[${i}] 为空，脚本数据非法`);
    }
  }
  return children;
}

async function runNode(adapter: CdpAdapter, node: Step, onStep: StepProgress): Promise<void> {
  const ctrl = node.control;
  if (!ctrl) {
    // 仅可执行叶子步骤上报进度；控制流节点自身不是用户可见的"一步"。
    onStep(node.id, 'running');
    try {
      await runStep(adapter, node);
    } catch (err) {
      onStep(node.id, 'fail');
      throw err;
    }
    onStep(node.id, 'pass');
    return;
  }
  switch (ctrl.kind) {
    case 'sequence':
      for (const child of childrenOf(node)) {
        await runNode(adapter, child, onStep);
      }
      break;
    case 'if': {
      const result = ctrl.condition
        ? await runAssertion(adapter, ctrl.condition)
        : { passed: true };
      const branches = childrenOf(node);
      // children[0]=then, children[1]=else
      const chosen = result.passed ? branches[0] : branches[1];
      if (chosen) await runNode(adapter, chosen, onStep);
      break;
    }
    case 'while': {
      const count = ctrl.loopCount ?? 1;
      // 复杂度说明：校验一次即可，不必每轮循环重复校验（O(count·n) → O(n + count·n) 的常量项优化）。
      const children = childrenOf(node);
      for (let i = 0; i < count; i++) {
        for (const child of children) {
          await runNode(adapter, child, onStep);
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
