// 录制覆盖率对账（宿主侧）：把「注入层统计」与「哪些 target 真的注入了脚本」合成一条结论。
//
// 为什么不只看注入层统计：某个 target 若**根本没注入脚本**（新建窗口、webview 的 UI context
// 一直没就绪），它自己的注入层统计是干净的（全是 0），成片丢失却报不出来。所以对账必须
// 由宿主侧把「覆盖到的 target」与「已注入的 target」对齐，未注入的要在结论里点名。
//
// 统计不进 Script JSON —— Script JSON 是平台唯一不变式，覆盖率只作为录制结束时的结论文本。

/** 单个 target 内注入脚本上报的统计（`window.__atgStats` 的快照）。 */
export type RecStats = {
  /** 意图事件数：以 mousedown 为锚点，解析到可交互节点的次数。 */
  intents: number;
  /** 成功产出到缓冲区的事件数（fill 的就地合并值不重复计数）。 */
  emitted: number;
  /** 被丢弃的事件数（解析不到节点、装饰 role 等）。 */
  dropped: number;
  /** 解析层失败、靠 mousedown 意图记录回退救回的次数。 */
  recovered: number;
  /** 丢弃原因分类计数，如 noNode / presentation / generic。 */
  reasons: Record<string, number>;
};

/** 单个 target 的覆盖情况。stats 为 null 表示注入层统计取不回来（通常是没注入成功）。 */
export type TargetCoverage = {
  id: string;
  title?: string;
  type?: string;
  /** 宿主侧是否确认注入成功（PlaywrightCdpAdapter.injectedTargets 记账）。 */
  injected: boolean;
  stats: RecStats | null;
};

export type RecordingCoverage = {
  /** 本次录制覆盖到的 target 总数。 */
  total: number;
  /** 其中确认已注入脚本的数量。 */
  injected: number;
  /** 未注入脚本的 target id：这些窗口里的操作没有被录到。 */
  uninjected: string[];
  /** 宿主认为已注入、但统计拉不回来的 target id（注入层统计对它们不可信）。 */
  noStats: string[];
  intents: number;
  emitted: number;
  dropped: number;
  recovered: number;
  reasons: Record<string, number>;
  targets: TargetCoverage[];
};

export const EMPTY_STATS: RecStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} };

/**
 * CDP / WS 边界兜底：跨进程回来的统计字段可能是 null / undefined / 非数字
 * （JSON 不保类型，旧注入会话也没有这些字段）。统一兜成 0，不让对账自己先崩。
 */
export function normalizeStats(raw: unknown): RecStats {
  const s = (raw ?? {}) as Partial<Record<keyof RecStats, unknown>>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const reasons: Record<string, number> = {};
  const src = (s.reasons ?? {}) as unknown;
  if (src && typeof src === 'object') {
    for (const k of Object.keys(src as Record<string, unknown>)) {
      const v = num((src as Record<string, unknown>)[k]);
      if (v > 0) reasons[k] = v;
    }
  }
  return {
    intents: num(s.intents),
    emitted: num(s.emitted),
    dropped: num(s.dropped),
    recovered: num(s.recovered),
    reasons,
  };
}

/** 汇总各 target 的覆盖情况为一条对账结论。 */
export function buildCoverage(targets: TargetCoverage[] | null | undefined): RecordingCoverage {
  const list = (targets ?? []).filter(Boolean);
  const reasons: Record<string, number> = {};
  let intents = 0;
  let emitted = 0;
  let dropped = 0;
  let recovered = 0;
  let injected = 0;
  const uninjected: string[] = [];
  const noStats: string[] = [];
  for (const t of list) {
    if (t.injected) injected += 1;
    else uninjected.push(t.id);
    if (t.injected && !t.stats) noStats.push(t.id);
    const s = t.stats;
    if (!s) continue;
    intents += s.intents;
    emitted += s.emitted;
    dropped += s.dropped;
    recovered += s.recovered;
    for (const k of Object.keys(s.reasons ?? {})) {
      reasons[k] = (reasons[k] ?? 0) + s.reasons[k];
    }
  }
  return { total: list.length, injected, uninjected, noStats, intents, emitted, dropped, recovered, reasons, targets: list };
}

/** 丢弃原因 → 中文短句（按计数降序）。 */
export function describeReasons(reasons: Record<string, number> | null | undefined): string {
  const r = reasons ?? {};
  const keys = Object.keys(r).filter((k) => r[k] > 0).sort((a, b) => r[b] - r[a]);
  if (!keys.length) return '';
  const LABELS: Record<string, string> = {
    noNode: '解析不到可交互节点',
    presentation: '装饰 role 被过滤',
    generic: '无名 generic 节点被过滤',
    notElement: '事件目标不是元素',
  };
  return keys.map((k) => `${LABELS[k] ?? k} ${r[k]}`).join('、');
}

/**
 * 录制结束时给人看的对账结论。只报事实与漏点，不做实时提示（不打断录制过程）。
 * 未注入的 target 必须点名，否则「成片丢失」会被「注入层统计干净」掩盖。
 */
export function formatCoverage(c: RecordingCoverage): string {
  const lines: string[] = [];
  const reasonsText = describeReasons(c.reasons);
  lines.push(
    `录制对账：已注入 ${c.injected}/${c.total} 个窗口；`
    + `意图 ${c.intents} 次 → 产出 ${c.emitted} 步、丢弃 ${c.dropped} 次`
    + (reasonsText ? `（${reasonsText}）` : '')
    + (c.recovered > 0 ? `；意图回退救回 ${c.recovered} 次` : ''),
  );
  if (c.uninjected.length) {
    const names = c.uninjected.map((id) => {
      const t = c.targets.find((x) => x.id === id);
      return t?.title ? `${id}「${t.title}」` : id;
    });
    lines.push(`⚠ 未注入脚本的窗口（其中的操作没有被录到）：${names.join('、')}`);
  }
  if (c.noStats.length) {
    lines.push(`⚠ 已注入但统计拉不回来的窗口：${c.noStats.join('、')}`);
  }
  return lines.join('\n');
}
