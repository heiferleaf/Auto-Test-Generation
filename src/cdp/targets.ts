// 目标（window/webview）枚举与选择，以及 Locator → Playwright 定位解析。
// 设计依据：docs/设计文档.md §5（target 选择、Locator 优先级）。

import type { Browser, Frame, Locator as PwLocator, Page } from 'playwright';
import type { Locator } from '../types/step';

/** CDP 目标类型：page / webview 为 M1 关注对象，保留字符串以兼容其它 CDP 类型。 */
export type TargetType = 'page' | 'webview' | (string & {});

export type TargetInfo = {
  id: string;
  type: TargetType;
  title: string;
  isMain?: boolean;
};

/** 内部记录：TargetInfo 与其对应的 Playwright Page/Frame 的绑定。 */
export type TargetEntry = {
  info: TargetInfo;
  page: Page;
  /** webview 对应的 frame；page 类型时为 undefined，操作直接作用于 page。 */
  frame?: Frame;
};

/**
 * 枚举浏览器中的 page 与 webview。
 * Electron 下每个窗口是一个 page；<webview> 表现为该 page 的子 frame。
 * 首个 page 作为主目标（isMain）。
 */
export async function enumerateTargets(browser: Browser): Promise<TargetEntry[]> {
  const entries: TargetEntry[] = [];

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
        page,
      });

      // 子 frame 视为 webview（Electron <webview> / 嵌套内容）。
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const wvId = `webview-${entries.length}`;
        entries.push({
          info: { id: wvId, type: 'webview', title: frame.name() || frame.url() },
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
 * 优先级（设计文档 §5）：role/name/text/testId → css → xpath。
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
