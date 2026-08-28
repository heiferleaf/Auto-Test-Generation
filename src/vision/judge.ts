// 视觉判定接口（visionPrompt 断言的"判定函数"抽象）。
//
// 为什么不写死供应商（需求文档「以后的插件 / 非本轮」原话要求）：
// 内核只依赖「截图 + 提示词 → 是否成立」这一个契约，不依赖任何一家模型的
// HTTP 接口、SDK 或鉴权方式。具体怎么判定由宿主注入的 `VisionJudge` 决定：
//   - 可以是 src/vision/openai-compatible.ts 的默认 fetch 实现；
//   - 可以是测试里的 mock（禁止单测打真实 API）；
//   - 也可以是宿主自己接的私有模型网关。
// 这样换供应商不需要动 assert.ts 与 Script JSON。

/** 交给判定函数的一次视觉判定请求。 */
export type VisionJudgeRequest = {
  /** 提示词：来自 Assertion.value（零 schema 变更，见决策 2）。 */
  prompt: string;
  /** 截图原始数据（PNG Buffer）。 */
  image: Buffer;
  /** 图片 MIME 类型，默认 image/png。 */
  mimeType?: string;
};

/** 判定结果契约（决策 3：模型返回 {passed: boolean, reason?: string}）。 */
export type VisionJudgeResult = {
  passed: boolean;
  /** 人可读的判定依据，失败时尤其需要（不静默失败）。 */
  reason?: string;
};

/**
 * 判定函数：截图 + 提示词 → 是否成立。
 *
 * 约定：实现**不得**因"没配 apikey"而静默返回 passed:true —— 那等于测试造假。
 * 配置缺失或调用失败时应当抛错，由 assert.ts 统一收敛为 passed:false + 明确 reason。
 */
export type VisionJudge = {
  judge(req: VisionJudgeRequest): Promise<VisionJudgeResult>;
};

/**
 * 宿主注入上下文（assert.ts handler 的第三个可选参数）。
 *
 * 之所以是可选且整体可空：跨 WS/JSON 边界 undefined 会变 null，
 * 且现有调用点（executor / waitUntil / 既有测试）都不传第三参，
 * 必须保持向后兼容。
 */
export type AssertionContext = {
  /** 由宿主注入的判定函数；未注入时 visionPrompt 断言按"未配置"处理并 fail。 */
  judge?: VisionJudge | null;
};

/** 安全读取 ctx.judge：ctx 本身可能是 null/undefined（跨 JSON 边界兜底）。 */
export function judgeOf(ctx?: AssertionContext | null): VisionJudge | undefined {
  const c = ctx ?? {};
  const j = (c as { judge?: unknown }).judge;
  return j && typeof (j as VisionJudge).judge === 'function' ? (j as VisionJudge) : undefined;
}
