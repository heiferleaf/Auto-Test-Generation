// 步骤执行器（M1-C）：按 Script.steps 顺序驱动 CdpAdapter 执行操作与断言。
// 设计依据：docs/design/design.md §6；错误需带 stepId，便于 CLI 输出结构化错误（§8-5）。

import type { CdpAdapter } from '../cdp/adapter';
import type { Script, Step, Locator } from '../types/step';
import { runAssertion, AssertionError } from './assert';
import { invokeAction } from './actions';
import type { AssertionContext } from '../vision/judge';

/**
 * 逐步进度回调（M3-R3）：叶子步骤开始/结束时上报，供 UI 实时回显与高亮跟随。
 *
 * 为何放在执行器而非 UI 侧传函数给内核：`UiKernel` 会被 WsKernel 跨 WebSocket 实现，
 * 函数无法 JSON 序列化（真机上回调必然丢失）。故进度源必须在 Node 进程内产生，
 * 再由 bridge-server 经单向推送通道下发给浏览器端。详见 CODEBUDDY.md §4.1。
 */
/**
 * 返回值允许是 Promise，且**只有 `running` 会被 await**（见 runNode）。
 *
 * 为什么必须等：逐步高亮截图挂在 running 上报上（桥端在这一步执行**之前**拍一张）。
 * 不等的话，截图请求会和该步的执行动作赛跑 —— 真机上常常拍到执行**之后**的画面，
 * 那时这一步要操作的元素可能已经变了或没了，高亮框必然画不上，且单测看不出来。
 *
 * 返回类型用 `unknown` 而不是 `void | Promise<void>`：既有调用方里有
 * `(id, st) => seen.push(x)` 这种顺手把回调体写成表达式的写法（返回 number），
 * 收窄成 void 会把它们全打成类型错误 —— 那些写法本身没有错，返回值我们并不关心。
 * 同步回调返回 undefined，`await` 它是无操作，故既有调用方行为完全不变。
 */
export type StepProgress = (stepId: string, status: 'running' | 'pass' | 'fail') => unknown;

/**
 * 执行整个脚本：对每条顶层 step 调递归 runNode。
 * @param onStep 可选进度回调；不传则行为与 R3 之前完全一致（向后兼容）。
 * @param fromStepId 可选「从此处运行」起点（spec §2.7）：按前序跳过该步之前的所有步骤，
 *   从该步（含其子树）起继续执行其后所有兄弟。未传时从头执行（向后兼容）。
 *   语义：前序遍历到该 id 才置 started=true；未 started 的节点整棵跳过、不上报进度。
 *   限制：若 fromStepId 落在 if 未选中分支或不存在，则其本身不执行（无步可跑），不报错。
 * @param ctx 可选宿主注入上下文（如视觉判定函数），透传给断言引擎；不传时行为不变。
 */
export async function runScript(
  adapter: CdpAdapter,
  script: Script,
  onStep?: StepProgress,
  fromStepId?: string,
  ctx?: AssertionContext | null,
): Promise<void> {
  // 进度上报是辅助能力：订阅方回调抛错不得中断脚本执行。
  const report: StepProgress = onStep
    ? async (id, st) => {
        try {
          await onStep(id, st);
        } catch (err) {
          console.warn('[executor] 进度回调抛错（已忽略）:', err instanceof Error ? err.message : err);
        }
      }
    : () => {};
  // started：未指定 fromStepId 时一开始就执行；指定后等到前序命中该 id 才开始。
  const state = { started: fromStepId === undefined, fromStepId };
  for (const step of script.steps) {
    await runNode(adapter, step, report, state, ctx ?? null);
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

async function runNode(
  adapter: CdpAdapter,
  node: Step,
  onStep: StepProgress,
  state: { started: boolean; fromStepId?: string },
  ctx?: AssertionContext | null,
): Promise<void> {
  // 「从此处运行」：命中起点 id（叶或组）即置 started；此后该节点及其后序节点正常执行。
  // 关键：未 started 时不能整棵跳过控制节点 —— fromStepId 可能在组内，
  //   故对 sequence/while 仍需下钻寻找起点，仅在叶子处 gate 执行。
  if (!state.started && node.id === state.fromStepId) state.started = true;

  const ctrl = node.control;
  // 叶子，或「原子顺序组」（spec §2.5：一步默认就是一个组，control.sequence 且无 children）：
  // 节点自身仍是可执行动作，不能当成空 sequence 跳过，否则录制步全部不跑。
  const atomicGroup = ctrl?.kind === 'sequence' && !(node.children?.length);
  if (!ctrl || atomicGroup) {
    // 叶子：未到起点则跳过（不执行、不上报进度）。
    if (!state.started) return;
    // 必须 await：这一步的高亮截图挂在 running 上报上，拍完才允许动靶机。
    await onStep(node.id, 'running');
    try {
      await runStep(adapter, node, ctx ?? null);
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
        await runNode(adapter, child, onStep, state, ctx);
      }
      break;
    case 'if': {
      // 未 started 且起点不在本 if 子树时，整棵跳过 —— 避免无谓地求值条件（副作用/可能失败）。
      if (!state.started && state.fromStepId && !containsId(node, state.fromStepId)) break;
      // 求值条件前先标 running：snapshot/定位可能很慢，不能让「运行全部」看起来没反应。
      // 同样要 await：选择组条件的高亮截图也挂在这一次上报上。
      if (state.started) await onStep(node.id, 'running');
      try {
        const result = ctrl.condition
          ? await runAssertion(adapter, ctrl.condition, ctx ?? null)
          : { passed: true };
        if (state.started) onStep(node.id, 'pass');
        const branches = childrenOf(node);
        // children[0]=then, children[1]=else
        const chosen = result.passed ? branches[0] : branches[1];
        if (chosen) await runNode(adapter, chosen, onStep, state, ctx);
      } catch (err) {
        if (state.started) onStep(node.id, 'fail');
        if (err instanceof AssertionError) throw err;
        const wrapped = new Error(`step ${node.id} failed: ${(err as Error).message}`);
        (wrapped as Error & { stepId?: string }).stepId = node.id;
        throw wrapped;
      }
      break;
    }
    case 'while': {
      const count = ctrl.loopCount ?? 1;
      // 复杂度说明：校验一次即可，不必每轮循环重复校验（O(count·n) → O(n + count·n) 的常量项优化）。
      const children = childrenOf(node);
      // 已知限制（罕见组合）：fromStepId 落在循环体内时，仅在首轮定位起点；
      //   一旦 started，后续每一轮整轮执行（含起点之前的步）。循环+fromStepId 不强求严格语义。
      for (let i = 0; i < count; i++) {
        for (const child of children) {
          await runNode(adapter, child, onStep, state, ctx);
        }
      }
      break;
    }
  }
}

/** 节点子树（含自身）是否包含某 id —— 仅供 fromStepId 在 if 子树内的判定，O(n) 一次遍历。 */
function containsId(node: Step, id: string): boolean {
  if (node.id === id) return true;
  const ch = node.children;
  if (!ch) return false;
  for (const c of ch) if (containsId(c, id)) return true;
  return false;
}

async function runStep(
  adapter: CdpAdapter,
  step: Step,
  ctx?: AssertionContext | null,
): Promise<void> {
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
      const result = await runAssertion(adapter, assertion, ctx ?? null);
      if (!result.passed) {
        // reason 是判定者给的人读依据（尤其视觉判定）；带上它，避免只看到 kind 不知道为什么失败。
        const why = result.reason ? `（${result.reason}）` : '';
        throw new AssertionError(step.id, `断言失败 @ step ${step.id}: ${assertion.kind}${why}`);
      }
      return;
    }

    // 其余类型映射到 adapter 调用。
    await invokeAction(adapter, step as Step & { type: Exclude<Step['type'], 'assert'> }, ctx ?? null);
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
