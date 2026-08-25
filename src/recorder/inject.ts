// 录制监听注入脚本（M3）：注入到目标页面的 window，捕获用户交互。
// 主 page 与 webview 内层的注入脚本完全相同（都基于 DOM 事件 + window.__recBuf），
// 区别仅在于执行上下文（由 CdpTarget.evaluate 的 ctxId 决定）。抽到常量避免重复。
//
// 语义化 locator 优先级：aria-label > name > data-testid > textContent(截断)。
// TrustedHTML 兼容：仅用 createElement / 属性赋值，不碰 innerHTML。

export const REC_INSTALL_FLAG = '__recInstalled';
export const REC_BUF = '__recBuf';

/** 在目标上下文内执行的注入脚本（字符串形式，供 CdpTarget.evaluate 使用）。 */
export const RECORD_INJECT = `(() => {
  window.${REC_BUF} = window.${REC_BUF} || [];
  if (window.${REC_INSTALL_FLAG}) return;
  window.${REC_INSTALL_FLAG} = true;
  const emit = (ev) => {
    try {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      const loc = {
        role: el.getAttribute('role') || undefined,
        name: el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('data-testid') || (el.textContent||'').trim().slice(0, 40) || undefined,
        testId: el.getAttribute('data-testid') || undefined,
      };
      // 输入类事件（input/change）统一归并为 fill。
      // 关键：逐字符输入会产生一连串 input 事件（每个字符一次）。
      // 若上一条缓冲事件也是同 locator 的 fill，则就地更新其 value，
      // 而非追加。这样一次「填值」在录制结果中坍缩为单步，
      // 与 Playwright codegen 等录制器的行为一致，避免中间态污染。
      if (ev.type === 'input' || ev.type === 'change') {
        const buf = window.${REC_BUF};
        const last = buf[buf.length - 1];
        if (last && last.type === 'fill' && last.locator && loc.name && last.locator.name === loc.name && (last.locator.testId || null) === (loc.testId || null)) {
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

export const PICK_INJECT = `(() => {
  window.${PICK_RESULT} = null;
  if (window.${PICK_FLAG}) return;
  window.${PICK_FLAG} = true;
  const interactive = (el) => {
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('data-testid')) return true;
    return false;
  };
  const cssPath = (el) => {
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
  const handler = (ev) => {
    if (!window.${PICK_FLAG}) return;
    let el = ev.target;
    if (!(el instanceof Element)) return;
    let node = el;
    while (node && node.nodeType === 1 && !interactive(node)) node = node.parentElement;
    if (!node) node = el;
    window.${PICK_RESULT} = {
      role: node.getAttribute('role') || undefined,
      name: node.getAttribute('aria-label') || node.getAttribute('name') || node.getAttribute('data-testid') || (node.textContent || '').trim().slice(0, 40) || undefined,
      testId: node.getAttribute('data-testid') || undefined,
      css: cssPath(node) || undefined,
    };
    window.${PICK_FLAG} = false;
    document.removeEventListener('click', handler, true);
  };
  document.addEventListener('click', handler, true);
})()`;

export const PICK_DRAIN = `(() => { const r = window.${PICK_RESULT} || null; window.${PICK_RESULT} = null; return r; })()`;

export const PICK_STOP = `(() => { window.${PICK_FLAG} = false; window.${PICK_RESULT} = null; })()`;
