// 录制覆盖率对账（宿主侧）：「漏了要响」的那一层。
// 注入脚本层统计只覆盖**已注入**的页面；某个 webview / 窗口若根本没注入脚本，
// 注入层统计是干净的（全是 0），成片丢失却报不出来。所以宿主侧必须把
// 「本次录制覆盖到哪些 target」与「其中几个真的注入了」对齐，未注入的点名报出来。

import { describe, it, expect } from 'vitest';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import { REC_STATS_DRAIN, RECORD_DRAIN, REC_ACTIVE_OFF } from '../src/recorder/inject';
import {
  buildCoverage,
  formatCoverage,
  normalizeStats,
  type RecStats,
  type TargetCoverage,
} from '../src/recorder/coverage';

const stats = (over: Partial<RecStats> = {}): RecStats => ({
  intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {}, ...over,
});

/** 组装一个不需要真机 CDP 的 adapter 实例：只喂 target 列表与注入记账。 */
function adapterWithTargets(
  entries: Array<{ id: string; title: string; injected: boolean; stats?: RecStats | null; failEval?: boolean }>,
) {
  const a = Object.create(PlaywrightCdpAdapter.prototype) as PlaywrightCdpAdapter;
  // 不走构造函数：避免连真机 CDP。私有字段经索引别名写入（测试内的既有手法）。
  const priv = a as unknown as Record<string, unknown>;
  const evaluated: string[] = [];
  const targets = entries.map((e) => ({
    info: { id: e.id, type: e.id === 'main' ? 'page' : 'webview', title: e.title },
    target: {
      evaluate: async (expr: string) => {
        evaluated.push(expr);
        if (e.failEval) throw new Error('WEBVIEW_NO_CONTEXT');
        if (expr === REC_STATS_DRAIN) return e.stats === undefined ? stats() : e.stats;
        if (expr === RECORD_DRAIN) return [];
        return true;
      },
    },
  }));
  priv.targets = targets;
  priv.injectedTargets = new Set(entries.filter((e) => e.injected).map((e) => e.id));
  priv.lastCoverage = null;
  return { a, evaluated };
}

describe('覆盖率统计的 WS 边界兜底', () => {
  it('null / 缺字段 / 脏类型都兜成 0，不让对账自己先崩', () => {
    expect(normalizeStats(null)).toEqual({ intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} });
    expect(normalizeStats(undefined)).toEqual({ intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} });
    expect(normalizeStats({ intents: '7', reasons: { noNode: null, presentation: 2 } })).toEqual({
      intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: { presentation: 2 },
    });
  });
});

describe('覆盖率汇总', () => {
  it('注入与未注入分开记账，未注入的 target 单独列出', () => {
    const cov = buildCoverage([
      { id: 'main', title: '主窗口', injected: true, stats: stats({ intents: 4, emitted: 3, dropped: 1, reasons: { noNode: 1 } }) },
      { id: 'wv1', title: '设置面板', injected: true, stats: stats({ intents: 2, emitted: 2, recovered: 1 }) },
      { id: 'wv2', title: '新建窗口', injected: false, stats: null },
    ]);
    expect(cov.total).toBe(3);
    expect(cov.injected).toBe(2);
    expect(cov.uninjected).toEqual(['wv2']);
    expect(cov.intents).toBe(6);
    expect(cov.emitted).toBe(5);
    expect(cov.dropped).toBe(1);
    expect(cov.recovered).toBe(1);
    expect(cov.reasons).toEqual({ noNode: 1 });
  });

  it('已注入但统计拉不回来的 target 也要报出来（注入层统计对它们不可信）', () => {
    const cov = buildCoverage([
      { id: 'main', title: '主窗口', injected: true, stats: null },
      { id: 'wv1', title: '设置面板', injected: false, stats: null },
    ]);
    expect(cov.noStats).toEqual(['main']);
    expect(cov.uninjected).toEqual(['wv1']);
  });
});

describe('覆盖率结论文本', () => {
  it('未注入的窗口必须在结论里点名', () => {
    const text = formatCoverage(buildCoverage([
      { id: 'main', title: '主窗口', injected: true, stats: stats({ intents: 12, emitted: 11, dropped: 1, recovered: 2, reasons: { noNode: 1 } }) },
      { id: 'wv2', title: '设置面板', injected: false, stats: null },
    ]));
    expect(text).toContain('已注入 1/2 个窗口');
    expect(text).toContain('意图 12 次');
    expect(text).toContain('产出 11 步');
    expect(text).toContain('丢弃 1 次');
    expect(text).toContain('解析不到可交互节点 1');
    expect(text).toContain('意图回退救回 2 次');
    expect(text).toContain('wv2');
    expect(text).toContain('设置面板');
  });

  it('全部注入且无丢弃时只有一行，不虚报', () => {
    const text = formatCoverage(buildCoverage([
      { id: 'main', title: '主窗口', injected: true, stats: stats({ intents: 3, emitted: 3 }) },
    ]));
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('⚠');
  });
});

describe('适配层对账', () => {
  it('每个 target 都拉一次注入层统计，未注入的进结论', async () => {
    const { a, evaluated } = adapterWithTargets([
      { id: 'main', title: '主窗口', injected: true, stats: stats({ intents: 5, emitted: 5 }) },
      { id: 'wv1', title: '聊天面板', injected: false },
    ]);
    const cov = await a.collectRecordingCoverage();
    expect(evaluated.filter((e) => e === REC_STATS_DRAIN)).toHaveLength(2);
    expect(cov.injected).toBe(1);
    expect(cov.uninjected).toEqual(['wv1']);
    expect(cov.emitted).toBe(5);
  });

  it('注入失败（evaluate 抛错）的 target 记为已注入但无统计，不等于没丢东西', async () => {
    const { a } = adapterWithTargets([
      { id: 'main', title: '主窗口', injected: true, failEval: true },
    ]);
    const cov = await a.collectRecordingCoverage();
    expect(cov.noStats).toEqual(['main']);
    expect(cov.intents).toBe(0);
  });

  it('stopRecording 之后能取到本次录制的覆盖率结论，之前取不到', async () => {
    const { a } = adapterWithTargets([
      { id: 'main', title: '主窗口', injected: true, stats: stats({ intents: 2, emitted: 1, dropped: 1, reasons: { noNode: 1 } }) },
      { id: 'wv1', title: '聊天面板', injected: false },
    ]);
    expect(a.lastRecordingCoverage()).toBeNull();

    await a.stopRecording();

    const cov = a.lastRecordingCoverage();
    expect(cov).not.toBeNull();
    expect(cov?.injected).toBe(1);
    expect(cov?.uninjected).toEqual(['wv1']);
    expect(cov?.dropped).toBe(1);
    expect(formatCoverage(cov!)).toContain('已注入 1/2 个窗口');
  });

  it('REC_ACTIVE_OFF 仍会在停录时下发，对账不取代原有收尾', async () => {
    const { a, evaluated } = adapterWithTargets([{ id: 'main', title: '主窗口', injected: true }]);
    await a.stopRecording();
    expect(evaluated).toContain(REC_ACTIVE_OFF);
  });
});
