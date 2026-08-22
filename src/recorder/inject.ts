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
