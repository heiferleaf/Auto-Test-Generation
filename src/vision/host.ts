// 宿主进程侧的视觉判定注入通道。
//
// 为什么需要它：断言是纯函数式的策略（adapter, assertion, ctx），Script JSON 里
// 不允许出现 apikey（会随脚本导出/分享泄漏）。所以"谁去调模型"这件事必须由宿主
// 进程决定并注入，内核只认 VisionJudge 接口。
//
// 默认通道：`resolveHostJudge()` 读环境变量 / 用户级配置构造默认实现。
// 显式通道：宿主（MCP main.ts、CLI、UI 服务端）可 `setHostJudge()` 塞自己的实现
// （私有网关、mock、离线兜底），优先级高于默认。

import { createOpenAICompatibleJudge } from './openai-compatible';
import type { VisionJudge } from './judge';

let hostJudge: VisionJudge | undefined;

/** 宿主显式注入判定函数（覆盖默认的环境变量/配置实现）。传 undefined 可撤销。 */
export function setHostJudge(judge: VisionJudge | undefined): void {
  hostJudge = judge;
}

/** 取当前宿主注入的判定函数（未注入则为 undefined）。 */
export function getHostJudge(): VisionJudge | undefined {
  return hostJudge;
}

/**
 * 解析出实际使用的判定函数：宿主显式注入优先，否则用默认 OpenAI 兼容实现。
 *
 * 注意：默认实现**总是**返回一个 judge —— 是否可用（有没有 apikey）由它内部在调用时
 * 抛错来表达，这样 assert.ts 能给出"未配置 apikey"的明确原因，而不是在这里静默返回
 * undefined 后被当成"未注入"糊弄过去。
 */
export function resolveHostJudge(): VisionJudge {
  return hostJudge ?? createOpenAICompatibleJudge();
}
