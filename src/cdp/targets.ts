// 目标（window/webview）枚举与选择，以及 Locator → Playwright 定位解析。
// 设计依据：docs/design/design.md §5（target 选择、Locator 优先级）。

import type { Browser, Frame, Locator as PwLocator, Page } from 'playwright';
import type { WebSocket as WsType } from 'ws';
import type { Locator } from '../types/step';
import { isNonActionableName, isNonActionableRole } from '../recorder/inject';
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
 * 偏差修正：部分 Electron 壳的 webview 在 /json 中以 "iframe" 出现，
 * 需统一归为 "webview"，否则真机枚举会把它们漏掉。
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
 * （部分 Electron 壳的 webview 以 "iframe" 出现）。
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
 * 真机点击：Playwright 指针，而不是 DOM element.click()。
 * 许多桌面壳只认真实鼠标；querySelector+click 会「步骤通过、靶机不动」。
 * 候选顺序：可见文本 / label / css。count() 为 0 立即换下一路，避免每路卡 3s。
 */
export async function clickOnPage(page: Page | Frame, loc: Locator): Promise<void> {
  const l = loc ?? {};
  const text = isNonActionableName(l.text ?? l.name) ? undefined : (l.text ?? l.name);
  const roleOk = !!l.role && !isNonActionableRole(l.role) && (l.role || '').toLowerCase() !== 'generic';
  const candidates: PwLocator[] = [];
  // css/xpath/testId 先于「无可用 name 的 role」：role=textbox 会命中页面上第一个 overlay
  //（主编辑器），把侧栏输入框的回放点飞。有可操作 name 时仍走 role+name。
  // presentation/none 绝不能 getByRole——Playwright 无该交互角色，步骤会直接失败。
  if (l.css) candidates.push(page.locator(l.css));
  if (l.xpath) {
    const xpath = l.xpath.startsWith('xpath=') ? l.xpath : `xpath=${l.xpath}`;
    candidates.push(page.locator(xpath));
  }
  if (l.testId) candidates.push(page.getByTestId(l.testId));
  if (roleOk && text) {
    candidates.push(resolveLocator(page, { role: l.role, name: text, textExact: l.textExact }));
  } else if (roleOk && !l.css && !l.xpath && !l.testId) {
    candidates.push(resolveLocator(page, l));
  }
  if (text) {
    candidates.push(page.getByText(text, { exact: l.textExact ?? false }));
    candidates.push(page.getByLabel(text, { exact: l.textExact ?? false }));
  }
  if (candidates.length === 0) {
    if (l.css || l.testId || l.xpath || (roleOk && l.role) || text) {
      candidates.push(resolveLocator(page, { ...l, role: roleOk ? l.role : undefined }));
    } else {
      throw new Error('CLICK: 未找到元素');
    }
  }

  let lastErr: unknown;
  for (const cand of candidates) {
    try {
      const n = await cand.count();
      if (n === 0) continue;
      for (let i = 0; i < n; i++) {
        const el = cand.nth(i);
        const blocked = await el.evaluate((node) => {
          const e = node as HTMLElement;
          return e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert');
        }).catch(() => false);
        if (blocked) continue;
        const vis = await el.isVisible().catch(() => false);
        if (!vis) continue;
        try {
          await clickNearestInteractive(page, el);
          return;
        } catch (err) {
          lastErr = err;
          const mouse = (page as Page).mouse;
          if (mouse) {
            const box = await boxOfInteractiveAncestor(el);
            if (box) {
              await mouse.click(box.x, box.y);
              return;
            }
          }
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('CLICK: 未找到元素');
}

/** 命中装饰内层时点最近的 button/link/input/textbox 祖先，避免 getByRole(presentation)。 */
async function clickNearestInteractive(page: Page | Frame, el: PwLocator): Promise<void> {
  const walked = await el.evaluate((node) => {
    const interactive = (n: Element | null): boolean => {
      if (!n || n.nodeType !== 1) return false;
      const e = n as HTMLElement;
      const t = e.tagName;
      if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return true;
      if (e.isContentEditable) return true;
      const role = (e.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none' || role === 'generic') return false;
      return /^(button|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|checkbox|switch|tab|treeitem|textbox|searchbox|combobox|slider|spinbutton)$/.test(role);
    };
    let n: HTMLElement | null = node as HTMLElement;
    while (n && !interactive(n)) n = n.parentElement;
    if (!n) return false;
    return true;
  }).catch(() => false);
  if (walked) {
    await el.click({ timeout: 4000 });
    return;
  }
  const mouse = (page as Page).mouse;
  const box = await boxOfInteractiveAncestor(el);
  if (mouse && box) {
    await mouse.click(box.x, box.y);
    return;
  }
  await el.click({ timeout: 4000 });
}

async function boxOfInteractiveAncestor(el: PwLocator): Promise<{ x: number; y: number } | null> {
  return el.evaluate((node) => {
    const interactive = (n: Element | null): boolean => {
      if (!n || n.nodeType !== 1) return false;
      const e = n as HTMLElement;
      const t = e.tagName;
      if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return true;
      if (e.isContentEditable) return true;
      const role = (e.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none' || role === 'generic') return false;
      return /^(button|link|menuitem|option|radio|checkbox|switch|tab|treeitem|textbox|searchbox|combobox|slider|spinbutton)$/.test(role);
    };
    let n: HTMLElement | null = node as HTMLElement;
    while (n && !interactive(n)) n = n.parentElement;
    const t = n ?? (node as HTMLElement);
    const hidden = t.getAttribute('aria-hidden') === 'true' || t.hasAttribute('inert');
    const r = t.getBoundingClientRect();
    if (hidden || r.width < 1 || r.height < 1) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => null);
}

/** 真机填充：可见 input/textarea/contenteditable 走 fill；否则点看得见的节点再 insertText。 */
export async function fillOnPage(page: Page, loc: Locator, value: string): Promise<void> {
  const l = loc ?? {};
  const candidates: PwLocator[] = [];
  if (l.css) candidates.push(page.locator(l.css));
  if (l.xpath) {
    const xpath = l.xpath.startsWith('xpath=') ? l.xpath : `xpath=${l.xpath}`;
    candidates.push(page.locator(xpath));
  }
  if (l.testId) candidates.push(page.getByTestId(l.testId));
  // name 不可用时不要再 getByRole(textbox)：会命中第一个 overlay，把字打进主编辑器。
  // presentation/none 同样不得 getByRole。
  const nameOk = !!l.name && !isNonActionableName(l.name);
  const roleOk = !!l.role && !isNonActionableRole(l.role) && (l.role || '').toLowerCase() !== 'generic';
  if (nameOk) {
    try {
      if (roleOk || l.name) {
        candidates.push(resolveLocator(page, { ...l, css: undefined, xpath: undefined, role: roleOk ? l.role : undefined }));
      }
    } catch {
      /* resolveLocator 在字段全空时抛 */
    }
    const text = l.text ?? l.name;
    if (text && !isNonActionableName(text)) {
      candidates.push(page.getByLabel(text, { exact: false }));
    }
  } else {
    // 多个 textbox 时禁止 getByRole 第一个（会打进主编辑器）。css 失败后由页面内评分兜底。
  }

  let lastErr: unknown;
  for (const cand of candidates) {
    try {
      const n = await cand.count();
      if (n === 0) continue;
      for (let i = 0; i < n; i++) {
        const el = cand.nth(i);
        const visible = await el.isVisible().catch(() => false);
        const blocked = await el.evaluate((node) => {
          const e = node as HTMLElement;
          return e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert');
        }).catch(() => false);
        if (blocked) continue;
        const existingLen = await el.evaluate((node) => {
          const e = node as HTMLInputElement;
          return String(e.value ?? e.innerText ?? e.textContent ?? '').trim().length;
        }).catch(() => 0);
        if (existingLen > 80 && value.trim().length < existingLen / 2) continue;
        const tag = await el.evaluate((node) => (node as HTMLElement).tagName).catch(() => '');
        const fillable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        const editable = await el.evaluate((node) => {
          const e = node as HTMLElement;
          const fillableNode = (n: HTMLElement | null): boolean => {
            if (!n) return false;
            const t = n.tagName;
            if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
            const ce = n.getAttribute('contenteditable');
            if (n.isContentEditable || ce === 'true' || ce === '') return true;
            const role = (n.getAttribute('role') || '').toLowerCase();
            return role === 'textbox' || role === 'searchbox' || role === 'combobox';
          };
          if (fillableNode(e)) return true;
          let p = e.parentElement;
          while (p) {
            if (fillableNode(p)) return true;
            p = p.parentElement;
          }
          return false;
        }).catch(() => false);
        if (visible && (fillable || editable)) {
          try {
            if (fillable) {
              await el.fill(value, { timeout: 1500 });
              return;
            }
          } catch (err) {
            lastErr = err;
          }
          try {
            const box = await boxOfFillableAncestor(el);
            if (box) {
              await page.mouse.click(box.x, box.y);
              await page.keyboard.press('Control+A').catch(() => undefined);
              await page.keyboard.insertText(value);
              return;
            }
          } catch (err) {
            lastErr = err;
          }
        }
        if (visible) {
          try {
            const box = await boxOfFillableAncestor(el);
            if (box) {
              await page.mouse.click(box.x, box.y);
              await page.keyboard.press('Control+A').catch(() => undefined);
              await page.keyboard.insertText(value);
              return;
            }
            await el.click({ timeout: 1500 });
            await page.keyboard.press('Control+A').catch(() => undefined);
            await page.keyboard.insertText(value);
            return;
          } catch (err) {
            lastErr = err;
          }
        }
        try {
          const box = await boxOfFillableAncestor(el);
          if (box) {
            await page.mouse.click(box.x, box.y);
            await page.keyboard.press('Control+A').catch(() => undefined);
            await page.keyboard.insertText(value);
            return;
          }
        } catch (err) {
          lastErr = err;
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }
  // css/name 都没命中时：在页面里挑一个看得见、空的、较宽的可填节点（聊天框通常比离屏镜像 textarea 宽）。
  // 不 getByRole('textbox') 第一个，避免打进主编辑器。
  try {
    const box = await page.evaluate((want) => {
      const sel = 'textarea, input:not([type="hidden"]), [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"]';
      const scored = [];
      for (const e of document.querySelectorAll(sel)) {
        const h = e as HTMLInputElement;
        if (h.getAttribute('aria-hidden') === 'true' || h.hasAttribute('inert')) continue;
        const r = h.getBoundingClientRect();
        if (r.width < 60 || r.height < 10) continue;
        const val = String(h.value ?? h.innerText ?? h.textContent ?? '').trim();
        if (val.length > 80 && want.trim().length < val.length / 2) continue;
        scored.push({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          w: r.width,
          empty: val.length === 0 ? 1 : 0,
        });
      }
      scored.sort((a, b) => (b.empty - a.empty) || (b.w - a.w));
      return scored[0] || null;
    }, value);
    if (box) {
      await page.mouse.click(box.x, box.y);
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.insertText(value);
      return;
    }
  } catch (err) {
    lastErr = err;
  }
  throw lastErr instanceof Error ? lastErr : new Error('FILL: 未找到元素');
}

async function boxOfFillableAncestor(el: PwLocator): Promise<{ x: number; y: number } | null> {
  return el.evaluate((node) => {
    const fillable = (n: HTMLElement | null): boolean => {
      if (!n || n.nodeType !== 1) return false;
      const t = n.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
      const ce = n.getAttribute('contenteditable');
      if (n.isContentEditable || ce === 'true' || ce === '') return true;
      const role = (n.getAttribute('role') || '').toLowerCase();
      return role === 'textbox' || role === 'searchbox' || role === 'combobox';
    };
    let n: HTMLElement | null = node as HTMLElement;
    while (n && !fillable(n)) n = n.parentElement;
    const t = n ?? (node as HTMLElement);
    const hidden = t.getAttribute('aria-hidden') === 'true' || t.hasAttribute('inert');
    const r = t.getBoundingClientRect();
    if (hidden || r.width < 1 || r.height < 1) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => null);
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
  if (loc.role && !isNonActionableRole(loc.role)) attrs.push(`[role="${cssEscape(loc.role)}"]`);
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
