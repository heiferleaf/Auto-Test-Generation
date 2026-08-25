// 录制监听注入脚本（M3）：注入到目标页面的 window，捕获用户交互。
// 主 page 与 webview 内层的注入脚本完全相同（都基于 DOM 事件 + window.__recBuf），
// 区别仅在于执行上下文（由 CdpTarget.evaluate 的 ctxId 决定）。抽到常量避免重复。
//
// 语义化 locator 优先级：aria-label > name > data-testid > textContent(截断)。
// 多层 DOM 定位（spec §2.2.1）：点击命中的往往是内层 span/i，需向上走到可交互祖先
// （button/a/input/有 role/有 data-testid），并补 css 祖先链，保证回放能定位到同一元素。
// TrustedHTML 兼容：仅用 createElement / 属性赋值，不碰 innerHTML。

export const REC_INSTALL_FLAG = '__recInstalled';
export const REC_BUF = '__recBuf';

/**
 * 定位辅助（录制与点选共用，spec §2.2.1）：在页面上下文定义
 * `window.__atgInteractive`（判断可交互祖先）与 `window.__atgCssPath`（祖先链 css）。
 * 幂等：多次注入只定义一次。抽成共享片段，避免录制/点选两份 cssPath 漂移。
 */
const ATG_LOCATOR_HELPERS = `(() => {
  if (window.__atgLocatorHelpers) return;
  window.__atgLocatorHelpers = true;
  window.__atgInteractive = (el) => {
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('data-testid')) return true;
    return false;
  };
  window.__atgCssPath = (el) => {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 10) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent; depth++;
    }
    return parts.join(' > ');
  };
  // 由 ev.target 向上取最近的可交互祖先；找不到则回退到原 target（不丢事件）。
  window.__atgResolve = (el) => {
    let node = el;
    while (node && node.nodeType === 1 && !window.__atgInteractive(node)) node = node.parentElement;
    return node || el;
  };
})()`;

/** 在目标上下文内执行的注入脚本（字符串形式，供 CdpTarget.evaluate 使用）。 */
export const RECORD_INJECT = ATG_LOCATOR_HELPERS + `;(() => {
  window.${REC_BUF} = window.${REC_BUF} || [];
  if (window.${REC_INSTALL_FLAG}) return;
  window.${REC_INSTALL_FLAG} = true;
  const locOf = (el) => {
    // 多层 DOM：向上取可交互祖先，再补 css 祖先链（spec §2.2.1）。
    const node = window.__atgResolve(el);
    return {
      role: node.getAttribute('role') || undefined,
      name: node.getAttribute('aria-label') || node.getAttribute('name') || node.getAttribute('data-testid') || (node.textContent||'').trim().slice(0, 40) || undefined,
      testId: node.getAttribute('data-testid') || undefined,
      css: window.__atgCssPath(node) || undefined,
    };
  };
  const sameLocator = (a, b) => (a.name||null) === (b.name||null) && (a.testId||null) === (b.testId||null) && (a.css||null) === (b.css||null);
  const emit = (ev) => {
    try {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      const loc = locOf(el);
      // 输入类事件（input/change）统一归并为 fill。
      // 关键：逐字符输入会产生一连串 input 事件（每个字符一次）。
      // 若上一条缓冲事件也是同 locator 的 fill，则就地更新其 value，
      // 而非追加。这样一次「填值」在录制结果中坍缩为单步，
      // 与 Playwright codegen 等录制器的行为一致，避免中间态污染。
      // 同 locator 判定加入 css：两个无名无 testId 的不同输入框不会误坍缩成一步。
      if (ev.type === 'input' || ev.type === 'change') {
        const buf = window.${REC_BUF};
        const last = buf[buf.length - 1];
        if (last && last.type === 'fill' && last.locator && sameLocator(last.locator, loc)) {
          last.params = { value: el.value ?? '' };
          return;
        }
        const fe = { type: 'fill', locator: loc, params: { value: el.value ?? '' } };
        buf.push(fe);
        return;
      }
      const e = { type: ev.type, locator: loc };
      window.${REC_BUF}.push(e);
    } catch (_) {}
  };
  ['click','input','change','submit'].forEach((t) =>
    document.addEventListener(t, emit, true));
})()`;

/** 读取并清空缓冲区的脚本。 */
export const RECORD_DRAIN = `(() => { const b = window.${REC_BUF} || []; window.${REC_BUF} = []; return b; })()`;

// ───────────────────────── 嵌入式点选录制（spec §2.3）─────────────────────────
// 点选子模式：waitUntil/assert/选择组条件共用。注入一次性 click 监听，命中后把完整
// locator（含祖先链 css，与 §2.2.1 同源）写入 window.__pickResult，由 adapter 轮询取回。
// 一次性：命中即解绑；cancelPick 设标志位让监听器忽略后续点击。
export const PICK_FLAG = '__pickInstalled';
export const PICK_RESULT = '__pickResult';

export const PICK_INJECT = ATG_LOCATOR_HELPERS + `;(() => {
  window.${PICK_RESULT} = null;
  if (window.${PICK_FLAG}) return;
  window.${PICK_FLAG} = true;
  const handler = (ev) => {
    if (!window.${PICK_FLAG}) return;
    let el = ev.target;
    if (!(el instanceof Element)) return;
    // 多层 DOM：向上取可交互祖先（与录制同源，spec §2.2.1），再补 css 祖先链。
    const node = window.__atgResolve(el);
    window.${PICK_RESULT} = {
      role: node.getAttribute('role') || undefined,
      name: node.getAttribute('aria-label') || node.getAttribute('name') || node.getAttribute('data-testid') || (node.textContent || '').trim().slice(0, 40) || undefined,
      testId: node.getAttribute('data-testid') || undefined,
      css: window.__atgCssPath(node) || undefined,
    };
    window.${PICK_FLAG} = false;
    document.removeEventListener('click', handler, true);
  };
  document.addEventListener('click', handler, true);
})()`;

export const PICK_DRAIN = `(() => { const r = window.${PICK_RESULT} || null; window.${PICK_RESULT} = null; return r; })()`;

export const PICK_STOP = `(() => { window.${PICK_FLAG} = false; window.${PICK_RESULT} = null; })()`;
