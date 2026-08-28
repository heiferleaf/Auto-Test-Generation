// CLI 入口（M1-D）：编排 adapter.connect + runScript，对外返回结构化结果。
// 设计依据：docs/design/design.md §8；失败路径需暴露 failedStepId（§8-5）。

import type { CdpAdapter, ConnectOptions } from './cdp/adapter';
import type { Script } from './types/step';
import { runScript, type StepProgress } from './executor/executor';
import type { AssertionContext } from './vision/judge';

export type CliResult = { ok: boolean; failedStepId?: string };

export type RunCliOpts = {
  adapter: CdpAdapter;
  script: Script;
  /** 可选连接参数；注入已连接的 adapter 时可省略（如测试桩）。 */
  connectOpts?: ConnectOptions;
  /** 可选逐步进度回调（M3-R3），透传给 runScript；仅进程内有效。 */
  onStep?: StepProgress;
  /** 可选「从此处运行」起点（spec §2.7），透传给 runScript。 */
  fromStepId?: string;
  /** 可选宿主注入上下文（如视觉判定函数），透传给 runScript；不传时行为不变。 */
  ctx?: AssertionContext | null;
};

/**
 * 运行一个脚本：先连接已建立/注入的 adapter，再按序执行。
 * - 成功：{ ok: true }
 * - 失败（AssertionError 或任何 Error）：{ ok: false, failedStepId }
 *   failedStepId 来自错误上的 stepId 字段（executor 已为普通 Error 追加 stepId）。
 */
export async function runCli(opts: RunCliOpts): Promise<CliResult> {
  const { adapter, script, connectOpts, onStep, fromStepId, ctx } = opts;

  await adapter.connect(connectOpts);

  try {
    await runScript(adapter, script, onStep, fromStepId, ctx ?? null);
    return { ok: true };
  } catch (err) {
    const stepId = (err as { stepId?: string }).stepId;
    return { ok: false, failedStepId: stepId ?? undefined };
  }
}
