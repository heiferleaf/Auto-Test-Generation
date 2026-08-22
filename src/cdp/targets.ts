// 目标（window/webview）枚举与选择，以及 Locator → Playwright 定位解析。
// 设计依据：docs/design/design.md §5（target 选择、Locator 优先级）。

import type { Browser, Frame, Locator as PwLocator, Page } from 'playwright';
import type { WebSocket as WsType } from 'ws';
import type { Locator } from '../types/step';
import { PlaywrightPageTarget, PlaywrightFrameTarget, WebviewCdpTarget, type CdpTarget } from './webview-session';

/** CDP 目标类型：page / webview 为 M1 关注对象，保留字符串以兼容其它 CDP 类型。 */
export type TargetType = 'page' | 'webview' | (string & {});

/** CDP /json 返回的原始 target 结构（只取我们关心的字段）。 */
export type RawCdpTarget = {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export type TargetInfo = {
  id: string;
  type: TargetType;
  title: string;
  isMain?: boolean;
};

/**
 * 将 CDP 原始 type 归类为本项目 TargetType。
 * 偏差修正：VS Code 系 Electron 的 webview 在 /json 中以 "iframe" 出现，
 * 需统一归为 "webview"，否则真机枚举会把它们漏掉（见 test/reports 真机报告）。
 */
export function classifyTargetType(raw: RawCdpTarget): TargetType {
  const t = (raw.type ?? 'page').toLowerCase();
  if (t === 'iframe') return 'webview';
  if (t === 'page' || t === 'webview') return t;
  // worker / other 等透传，保留信息不丢。
  return t;
}

/** 内部记录：TargetInfo 与其对应的统一 CdpTarget 实现绑定（方案 C）。 */
export type TargetEntry = {
  info: TargetInfo;
  target: CdpTarget;
  /** 兼容字段：page 类型时为对应 Page，webview 时为 undefined（走 native CDP）。 */
  page?: Page;
  /** 兼容字段：webview 的 frame（仅 Playwright 回退路径 B 使用）。 */
  frame?: Frame;
};

/**
 * 枚举浏览器中的 page 与 webview（工厂：OCP）。
 * 优先使用 CDP /json 原始 target 列表（rawTargets），因为它能保留真实类型
 * （VS Code 系 Electron 的 webview 以 "iframe" 出现）。
 *   - page   → PlaywrightPageTarget（Playwright 控制稳定）
 *   - webview → WebviewCdpTarget（独立 native CDP，可达内层 UI，方案 C）
 * 未提供 rawTargets 时回退到 Playwright Browser 枚举（路径 B）。
 * wsCtor 仅用于测试注入 mock WebSocket；生产走真实 ws。
 * 首个 page 作为主目标（isMain）。
 */
export async function enumerateTargets(
  browser: Browser,
  rawTargets?: RawCdpTarget[],
  wsCtor?: new (url: string, opts?: any) => WsType,
): Promise<TargetEntry[]> {
  const entries: TargetEntry[] = [];

  // 路径 A：有原始 CDP target 列表（真机推荐路径，能识别 iframe→webview）。
  if (rawTargets && rawTargets.length > 0) {
    // page 目标需要 Playwright Page 句柄；webview 不需要（走 native CDP）。
    const pages = browser ? browser.contexts().flatMap((c) => c.pages()) : [];
    for (const raw of rawTargets) {
      const type = classifyTargetType(raw);
      // 跳过非 UI 目标（如 worker），避免污染操作目标列表。
      if (type !== 'page' && type !== 'webview') continue;

      if (type === 'page') {
        const page = pages.find((p) => p.url() === raw.url) ?? pages[entries.length] ?? pages[0];
        if (!page) continue;
        entries.push({
          info: {
            id: raw.id,
            type,
            title: raw.title ?? raw.url ?? '',
            isMain: entries.length === 0,
          },
          target: new PlaywrightPageTarget(raw.id, page),
          page,
        });
      } else {
        // webview：必须带 webSocketDebuggerUrl 才能建独立会话。
        if (!raw.webSocketDebuggerUrl) continue;
        entries.push({
          info: {
            id: raw.id,
            type,
            title: raw.title ?? raw.url ?? '',
            isMain: false,
          },
          target: new WebviewCdpTarget(raw.id, raw.webSocketDebuggerUrl, wsCtor),
        });
      }
    }
    return entries;
  }

  // 路径 B：回退到 Playwright Browser 枚举（page + 子 frame）。
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const index = entries.length;
      const id = `page-${index}`;
      let title = '';
      try {
        title = await page.title();
      } catch {
        // 页面可能正在导航/已关闭，标题非关键信息，忽略。
        title = '';
      }
      entries.push({
        info: { id, type: 'page', title, isMain: entries.length === 0 },
        target: new PlaywrightPageTarget(id, page),
        page,
      });

      // 子 frame 视为 webview（Electron <webview> / 嵌套内容）。
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const wvId = `webview-${entries.length}`;
        entries.push({
          info: { id: wvId, type: 'webview', title: frame.name() || frame.url() },
          target: new PlaywrightFrameTarget(wvId, frame),
          page,
          frame,
        });
      }
    }
  }

  return entries;
}

/** 按 id 查找目标；找不到返回 undefined，由调用方决定报错。 */
export function findTarget(entries: TargetEntry[], id: string): TargetEntry | undefined {
  return entries.find((e) => e.info.id === id);
}

/** 主目标：优先 isMain，其次首个 page，最后第一个条目。 */
export function mainTarget(entries: TargetEntry[]): TargetEntry | undefined {
  return (
    entries.find((e) => e.info.isMain) ??
    entries.find((e) => e.info.type === 'page') ??
    entries[0]
  );
}

/**
 * 将 Locator 解析为 Playwright Locator。
 * 优先级（design.md §5）：role/name/text/testId → css → xpath。
 */
export function resolveLocator(scope: Page | Frame, loc: Locator): PwLocator {
  // 1) 语义优先：role（可带 name）
  if (loc.role) {
    return scope.getByRole(loc.role as Parameters<Page['getByRole']>[0], {
      ...(loc.name !== undefined ? { name: loc.name, exact: loc.textExact ?? false } : {}),
    });
  }

  // 2) accessibility name（无 role 时按 label/名称匹配）
  if (loc.name) {
    return scope.getByLabel(loc.name, { exact: loc.textExact ?? false });
  }

  // 3) 可见文本
  if (loc.text) {
    return scope.getByText(loc.text, { exact: loc.textExact ?? false });
  }

  // 4) testId（data-testid）
  if (loc.testId) {
    return scope.getByTestId(loc.testId);
  }

  // 5) css
  if (loc.css) {
    return scope.locator(loc.css);
  }

  // 6) xpath
  if (loc.xpath) {
    const xpath = loc.xpath.startsWith('xpath=') ? loc.xpath : `xpath=${loc.xpath}`;
    return scope.locator(xpath);
  }

  throw new Error(
    'LOCATOR_EMPTY: Locator 至少需提供 role/name/text/testId/css/xpath 之一',
  );
}

/**
 * 将 Locator 转为可在 evaluate 内 querySelector 使用的 CSS 选择器（方案 C）。
 * 与 resolveLocator 优先级一致：语义 role/name/text 退化为属性选择器。
 * 返回 { selector, useXpath }：xpath 走 document.evaluate，其余走 querySelector。
 */
export function locatorToSelector(loc: Locator): { selector: string; useXpath: boolean } {
  if (loc.xpath) {
    return { selector: loc.xpath, useXpath: true };
  }
  if (loc.css) {
    return { selector: loc.css, useXpath: false };
  }
  if (loc.testId) {
    return { selector: `[data-testid="${cssEscape(loc.testId)}"]`, useXpath: false };
  }
  const attrs: string[] = [];
  if (loc.role) attrs.push(`[role="${cssEscape(loc.role)}"]`);
  if (loc.name) {
    const exact = loc.textExact ?? false;
    attrs.push(
      exact
        ? `[aria-label="${cssEscape(loc.name)}"]`
        : `[aria-label*="${cssEscape(loc.name)}"],[name*="${cssEscape(loc.name)}"]`,
    );
  }
  if (loc.text) {
    // 文本匹配在 evaluate 内用 :scope 不可靠，交给调用方用 innerText 二次过滤；
    // 这里退化为含该文本属性的近似（多数场景 name/role 已足够）。
    attrs.push(`[aria-label*="${cssEscape(loc.text)}"]`);
  }
  if (attrs.length === 0) {
    throw new Error('LOCATOR_EMPTY: 无法转为选择器，请补充 role/name/testId/css/xpath');
  }
  return { selector: attrs.join(''), useXpath: false };
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
