// 录制监听注入脚本（M3）：注入到目标页面的 window，捕获用户交互。
// 主 page 与 webview 内层的注入脚本完全相同（都基于 DOM 事件 + window.__recBuf），
// 区别仅在于执行上下文（由 CdpTarget.evaluate 的 ctxId 决定）。抽到常量避免重复。
//
// 语义化 locator 优先级：aria-label > name > data-testid > textContent(截断)。
// 多层 DOM 定位（spec §2.2.1）：点击命中的往往是内层 span/i，需向上走到可交互祖先
// （button/a/input/有 role/有 data-testid），并补 css 祖先链，保证回放能定位到同一元素。
// TrustedHTML 兼容：仅用 createElement / 属性赋值，不碰 innerHTML。

import type { Locator } from '../types/step';

/** 无障碍/帮助文案不能当 locator.name：过长、或像屏幕阅读器说明。不是某款 App 的词表。 */
export function isNonActionableName(name?: string | null): boolean {
  if (!name) return false;
  const t = name.trim();
  if (t.length > 80) return true;
  if (/screen reader|not accessible|to enable|press .+\+|use .+ to /i.test(t)) return true;
  // 「发送 (Ctrl+Enter)」要留；超长且夹带快捷键的才当帮助文案。
  if (/\b(shift|ctrl|control|alt|meta)\s*\+\s*\S+/i.test(t) && t.length > 24) return true;
  return false;
}

/** 多行 aria-label 只取首行，并去掉末尾快捷键括号，得到可点的短名。 */
export function actionableName(name?: string | null): string | undefined {
  if (!name) return undefined;
  const line = name.split(/\r?\n/)[0].trim();
  const stripped = line.replace(/\s*\((?:Ctrl|Control|Shift|Alt|Cmd|Meta|⌘)[^)]*\)\s*$/i, '').trim();
  const candidate = stripped || line;
  if (!candidate || isNonActionableName(candidate)) return undefined;
  return candidate;
}

/**
 * 装饰角色不能当点击/填充目标：Playwright getByRole('presentation') 无意义且会失败。
 * generic 另议（有 name 时可能是自制控件）；这里只钉死 presentation / none。
 */
export function isNonActionableRole(role?: string | null): boolean {
  const r = (role || '').toLowerCase();
  return r === 'presentation' || r === 'none';
}

/** 录制/点选结果落库前去掉帮助文案 name，避免旧注入会话把 overlay 写进步骤。 */
export function sanitizeLocator(loc?: Locator): Locator | undefined {
  if (!loc) return loc;
  const out: Locator = { ...loc };
  const cleaned = actionableName(out.name);
  if (cleaned) out.name = cleaned;
  else delete out.name;
  const cleanedText = actionableName(out.text);
  if (cleanedText) out.text = cleanedText;
  else delete out.text;
  // 回放不得走 getByRole('presentation')：有 css/testId 时丢掉装饰 role，让解析走 css。
  if (isNonActionableRole(out.role)) delete out.role;
  return out;
}

export const REC_INSTALL_FLAG = '__recInstalled';
export const REC_BUF = '__recBuf';
export const PICK_FLAG = '__pickInstalled';
export const PICK_RESULT = '__pickResult';

/**
 * Playwright `page.evaluate(string)` / `frame.evaluate(string)` 把参数当**表达式**，
 * 不是脚本。RECORD_INJECT / PICK_INJECT 是两段 IIFE 语句，直接塞进去会 SyntaxError，
 * 错误再被 injectRecorderIntoTargets 的 catch 吃掉，表现为「点了没步骤」。
 * 用间接 eval 当脚本执行，才能既装上监听，又保住 RECORD_DRAIN 的返回值。
 */
export function asPlaywrightExpression(source: string): string {
  return `(() => (0, eval)(${JSON.stringify(source)}))()`;
}

/**
 * 定位辅助（录制与点选共用，spec §2.2.1）：在页面上下文定义
 * `window.__atgInteractive`（判断可交互祖先）与 `window.__atgCssPath`（祖先链 css）。
 * 幂等：多次注入只定义一次。抽成共享片段，避免录制/点选两份 cssPath 漂移。
 */
const ATG_LOCATOR_HELPERS = `(() => {
  // 每次注入都覆盖：旧会话若把任意 role（含 presentation）当成可交互，必须被新规则换掉。
  window.__atgActionable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('inert')) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r && (r.width === 0 || r.height === 0)) return false;
    } catch (_) {}
    return true;
  };
  window.__atgFillable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const t = (el.tagName || '').toUpperCase();
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  };
  window.__atgInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none' || role === 'generic') return false;
    const R = {button:1,link:1,menuitem:1,menuitemcheckbox:1,menuitemradio:1,option:1,radio:1,checkbox:1,switch:1,tab:1,treeitem:1,textbox:1,searchbox:1,combobox:1,slider:1,spinbutton:1,listbox:1,menu:1,menubar:1,tablist:1,toolbar:1,tree:1,grid:1,gridcell:1,row:1};
    if (R[role]) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
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
  // 由 ev.target 向上取最近的可交互祖先；装饰 role / 0 尺寸 overlay 继续往上。找不到则 null（调用方丢弃该步）。
  window.__atgResolve = (el) => {
    let node = el;
    while (node && node.nodeType === 1 && !window.__atgInteractive(node)) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    if (!window.__atgActionable(node)) {
      let up = node.parentElement;
      while (up && up.nodeType === 1) {
        if (window.__atgInteractive(up) && window.__atgActionable(up)) return up;
        up = up.parentElement;
      }
    }
    return node;
  };
  window.__atgIsHelpName = (s) => {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length > 80) return true;
    if (/screen reader|not accessible|to enable|press .+\\+|use .+ to /i.test(t)) return true;
    if (/\\b(shift|ctrl|control|alt|meta)\\s*\\+\\s*\\S+/i.test(t) && t.length > 24) return true;
    return false;
  };
  window.__atgLocatorHelpers = true;
  // 可访问名的「向下取」：label 挂在子元素而不是自身是通病（菜单项、图标按钮都常见）。
  // 只向上找会取到祖先的名字，于是同一菜单下多个条目录出来重名，看着像「只捕到一次」。
  // 顺序按 WAI-ARIA accname：自身 aria-label/name > 子树（直接子元素）可见文本 > 自身 title。
  // 只取值、不改 locator 指向的元素，避免把 locator 变深。
  window.__atgNameFromBelow = (node) => {
    if (!node || node.nodeType !== 1) return undefined;
    const clean = (s) => {
      if (!s) return undefined;
      const t = String(s).split(/\\r?\\n/)[0].trim().replace(/\\s*\\((?:Ctrl|Control|Shift|Alt|Cmd|Meta)[^)]*\\)\\s*$/i, '').trim();
      if (!t || window.__atgIsHelpName(t)) return undefined;
      return t;
    };
    const own = clean(node.getAttribute('aria-label') || node.getAttribute('name') || node.getAttribute('data-testid'));
    if (own) return own;
    const ownTitle = clean(node.getAttribute('title'));
    // 可填充节点不向下取文本：输入框里的文本是数据不是名字，跟着内容取名会让
    // 同一框的连续输入拿不到同一个 locator，宿主侧的连续 fill 合并因此失效。
    // 菜单项/图标按钮等不可填充节点仍要向下取，那才是 label 挂错位置的主战场。
    if (!window.__atgFillable(node)) {
      const kids = node.children || [];
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.getAttribute('aria-hidden') === 'true') continue;
        let t = '';
        try { t = (k.innerText || k.textContent || '').trim(); } catch (_) { t = (k.textContent || '').trim(); }
        // 确定性：多个子元素时取第一个非空可见文本。
        const kid = clean(t) || clean(k.getAttribute('aria-label') || k.getAttribute('title'));
        if (kid) return kid.slice(0, 40);
      }
    }
    return ownTitle;
  };
  window.__atgLocOf = (el) => {
    const node = window.__atgResolve(el);
    if (!node) return {};
    let named = window.__atgNameFromBelow(node);
    if (!named) {
      let cur = node, depth = 0;
      while (cur && cur.nodeType === 1 && depth < 8) {
        if (cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert')) {
          cur = cur.parentElement; depth++; continue;
        }
        const cand = cur.getAttribute('aria-label') || cur.getAttribute('name') || cur.getAttribute('data-testid');
        if (cand && !window.__atgIsHelpName(cand.split(/\\r?\\n/)[0].trim())) {
          named = cand.split(/\\r?\\n/)[0].trim().replace(/\\s*\\((?:Ctrl|Control|Shift|Alt|Cmd|Meta)[^)]*\\)\\s*$/i, '').trim() || cand.split(/\\r?\\n/)[0].trim();
          break;
        }
        cur = cur.parentElement; depth++;
      }
    }
    const roleAttr = node.getAttribute('role') || undefined;
    const roleLc = (roleAttr || '').toLowerCase();
    const fillable = window.__atgFillable(node);
    const name = named || (fillable ? undefined : ((node.textContent || '').trim().slice(0, 40) || undefined));
    const loc = {
      role: (roleLc === 'presentation' || roleLc === 'none') ? undefined : roleAttr,
      name,
      testId: node.getAttribute('data-testid') || undefined,
      css: window.__atgCssPath(node) || undefined,
    };
    return loc;
  };
})()`;

/** 在目标上下文内执行的注入脚本（字符串形式，供 CdpTarget.evaluate 使用）。 */
export const RECORD_INJECT = ATG_LOCATOR_HELPERS + `;(() => {
  window.${REC_BUF} = window.${REC_BUF} || [];
  if (window.__atgIdleTimer) { try { clearTimeout(window.__atgIdleTimer); } catch (_) {} window.__atgIdleTimer = null; }
  const locOf = (el) => window.__atgLocOf(el);
  const sameLocator = (a, b) => (a.name||null) === (b.name||null) && (a.testId||null) === (b.testId||null) && (a.css||null) === (b.css||null);
  const isFillable = (el) => window.__atgFillable(el);
  const fillableOf = (el) => {
    let node = el;
    while (node && node.nodeType === 1 && !isFillable(node)) node = node.parentElement;
    return (node && node.nodeType === 1) ? node : null;
  };
  const fillValue = (node) => {
    // EditContext（W3C 标准草案，Chromium 新编辑架构）：文本在 element.editContext.text，
    // DOM 的 innerText/textContent 恒空。任何 Electron 应用只要底层 Chromium 升级都会走到
    // 这条路上，所以按标准 API 取、优先级高于 DOM 文本，而不是给某个壳加特例。
    try {
      const ec = node.editContext;
      if (ec && typeof ec.text === 'string' && ec.text.trim()) return ec.text.trim();
    } catch (_) {}
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return node.value ?? '';
    if (node.isContentEditable) return (node.innerText || node.textContent || '').trim();
    return node.value ?? (node.innerText || node.textContent || '').trim();
  };
  // 「漏了要响」的底座：页面内统计。真正的危害不是有漏的，而是漏了没声——
  // 用户录完才发现步骤没新增，Agent 录制路径更是根本没人盯列表。
  // 只统计不提示（不在录制过程中打断用户），由宿主侧在录制结束时报覆盖率结论。
  const stats = () => {
    if (!window.__atgStats || typeof window.__atgStats !== 'object') {
      window.__atgStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} };
    }
    return window.__atgStats;
  };
  const drop = (reason) => {
    const s = stats();
    s.dropped += 1;
    s.reasons[reason] = (s.reasons[reason] || 0) + 1;
  };
  // EditContext 的 textupdate / textformatupdate 由 EditContext 对象派发、不冒泡到 document，
  // 绑在 document 上接不到；必须绑在实例上。焦点不变时 focusin 不会再触发，
  // 所以另外在轮询与 fill 事件里补绑（见 __atgPollFill / __atgOnEvent）。
  const bindEditContext = (el) => {
    try {
      if (!el || el.nodeType !== 1 || el.__atgEcBound) return false;
      const ec = el.editContext;
      if (!ec || typeof ec.addEventListener !== 'function') return false;
      el.__atgEcBound = true;
      const h = () => { try { window.__atgEmitFill(el); } catch (_) {} };
      ec.addEventListener('textupdate', h);
      ec.addEventListener('textformatupdate', h);
      return true;
    } catch (_) { return false; }
  };
  window.__atgBindEditContext = bindEditContext;
  if (!window.__atgFillSeen) window.__atgFillSeen = typeof WeakMap === 'function' ? new WeakMap() : null;
  let pendingFill = window.__atgPendingFill || null;
  let idleTimer = window.__atgIdleTimer || null;
  const flushFill = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; window.__atgIdleTimer = null; }
    if (!pendingFill) return;
    const loc = pendingFill.loc;
    const val = pendingFill.val;
    pendingFill = null;
    window.__atgPendingFill = null;
    if (!val) return;
    const buf = window.${REC_BUF};
    const last = buf[buf.length - 1];
    if (last && last.type === 'fill' && last.locator && sameLocator(last.locator, loc)) {
      // 同一输入框的连续输入就地改值：不是新步骤，不重复计 emitted。
      last.params = { value: val };
      return;
    }
    buf.push({ type: 'fill', locator: loc, params: { value: val } });
    stats().emitted += 1;
  };
  window.__atgFlushFill = flushFill;
  const emitFill = (el) => {
    const node = fillableOf(el);
    if (!node) return;
    const loc = locOf(node);
    const raw = fillValue(node);
    const seen = window.__atgFillSeen;
    if (seen) {
      const prev = seen.get(node);
      if (prev === undefined) seen.set(node, raw);
      else if (raw !== prev) seen.set(node, raw);
    }
    if (!raw) return;
    if (pendingFill && pendingFill.loc && !sameLocator(pendingFill.loc, loc)) flushFill();
    pendingFill = { loc, val: raw };
    window.__atgPendingFill = pendingFill;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(flushFill, 400);
    window.__atgIdleTimer = idleTimer;
  };
  window.__atgEmitFill = emitFill;
  window.__atgOnEvent = (ev) => {
    try {
      if (window.${PICK_FLAG} && ev.type === 'click') return;
      let el = ev.target;
      if (typeof ev.composedPath === 'function') {
        const inner = ev.composedPath()[0];
        if (inner instanceof Element) el = inner;
      }
      if (!(el instanceof Element)) { drop('notElement'); return; }
      if (ev.type === 'submit') {
        const submitter = (ev.submitter instanceof Element) ? ev.submitter : el;
        let node = window.__atgResolve(submitter);
        if (!node && el && el.querySelector) {
          const inner = el.querySelector('button, input[type=submit], [role="button"]');
          node = inner ? (window.__atgResolve(inner) || inner) : null;
        }
        if (!node) { drop('noNode'); return; }
        const loc = locOf(node);
        const role = (loc.role || '').toLowerCase();
        if (role === 'presentation' || role === 'none') { drop('presentation'); return; }
        window.${REC_BUF}.push({ type: 'click', locator: loc });
        stats().emitted += 1;
        return;
      }
      const isFill = ev.type === 'input' || ev.type === 'change' || ev.type === 'compositionend' || ev.type === 'beforeinput' || ev.type === 'textupdate';
      if (isFill) {
        // 元素刚变成可填（或刚挂上 EditContext）时补绑，焦点不变也能接住后续输入。
        const fillNode = fillableOf(el);
        if (fillNode) bindEditContext(fillNode);
        emitFill(el);
        return;
      }
      // 意图锚点：mousedown 时 DOM 还没被壳改写，此刻命中的元素才是用户真正的目标。
      // 只记意图、不产出步骤——产出留给 click，这样解析层怎么失败都不影响对账。
      if (ev.type === 'mousedown') {
        try {
          const inode = window.__atgResolve(el);
          if (inode) {
            window.__atgIntent = { t: Date.now(), node: inode, loc: locOf(inode) };
            stats().intents += 1;
          }
        } catch (_) {}
        return;
      }
      flushFill();
      let node = window.__atgResolve(el);
      let loc = null;
      const intent = window.__atgIntent;
      if (intent && (Date.now() - intent.t) < 1000) {
        const gone = !intent.node || intent.node.isConnected === false;
        // 解析失败有两种：返回 null，或坍缩到意图节点的某个祖先。
        // 后者正是「mousedown 阶段插遮罩 → click 被改写到共同祖先」的表现。
        if (!gone && (!node || (intent.node !== node && node.contains(intent.node)))) {
          node = intent.node;
          loc = intent.loc;
          stats().recovered += 1;
        }
      }
      // 一条意图只服务一次，避免后续 click 复用陈旧意图。
      window.__atgIntent = null;
      if (!node) { drop('noNode'); return; }
      if (!loc) loc = locOf(node);
      const role = (loc.role || '').toLowerCase();
      if (role === 'presentation' || role === 'none') { drop('presentation'); return; }
      if (role === 'generic' && !loc.name && !loc.testId) { drop('generic'); return; }
      window.${REC_BUF}.push({ type: ev.type, locator: loc });
      stats().emitted += 1;
    } catch (_) {}
  };
  window.__atgPollFill = () => {
    try {
      const ae = document.activeElement;
      if (!(ae instanceof Element) || !isFillable(ae)) return;
      // 兜底补绑 EditContext：焦点从未变化（focusin 不再触发）的编辑器也能接住输入。
      bindEditContext(ae);
      if (!window.__recActive) return;
      const raw = fillValue(ae);
      const seen = window.__atgFillSeen;
      if (seen) {
        const prev = seen.get(ae);
        if (prev === undefined) { seen.set(ae, raw); return; }
        if (raw === prev) return;
        seen.set(ae, raw);
      }
      if (!raw) return;
      emitFill(ae);
    } catch (_) {}
  };
  if (window.${REC_INSTALL_FLAG}) return;
  window.${REC_INSTALL_FLAG} = true;
  // mousedown 作为意图锚点（缺陷 2）；textupdate 不在此列——它由 EditContext 对象派发、
  // 不冒泡到 document，绑在这里接不到，只能在 EditContext 实例上绑。
  const TYPES = ['mousedown','click','input','change','submit','compositionend','beforeinput'];
  const bound = typeof WeakSet === 'function' ? new WeakSet() : null;
  const onEv = (ev) => { try { window.__atgOnEvent(ev); } catch (_) {} };
  const bindRoot = (root) => {
    if (bound) {
      if (bound.has(root)) return;
      bound.add(root);
    }
    TYPES.forEach((t) => root.addEventListener(t, onEv, true));
    try {
      root.querySelectorAll('*').forEach((n) => {
        if (n.shadowRoot) bindRoot(n.shadowRoot);
      });
    } catch (_) {}
  };
  bindRoot(document);
  try {
    document.querySelectorAll('iframe').forEach((f) => {
      try { if (f.contentDocument) bindRoot(f.contentDocument); } catch (_) {}
    });
  } catch (_) {}
  try {
    new MutationObserver(() => {
      try {
        document.querySelectorAll('iframe').forEach((f) => {
          try { if (f.contentDocument) bindRoot(f.contentDocument); } catch (_) {}
        });
        document.querySelectorAll('*').forEach((n) => {
          if (n.shadowRoot) bindRoot(n.shadowRoot);
        });
      } catch (_) {}
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
  document.addEventListener('keydown', (ev) => {
    try {
      if (window.${PICK_FLAG}) return;
      const key = ev.key || '';
      if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
      let el = ev.target;
      if (typeof ev.composedPath === 'function') {
        const inner = ev.composedPath()[0];
        if (inner instanceof Element) el = inner;
      }
      if (!(el instanceof Element)) return;
      if (!isFillable(el) && !fillableOf(el)) return;
      window.__atgEmitFill(el);
    } catch (_) {}
  }, true);
  document.addEventListener('focusout', () => { try { window.__atgFlushFill(); } catch (_) {} }, true);
  document.addEventListener('focusin', (ev) => {
    try {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      if (isFillable(el) && window.__atgFillSeen) {
        const raw = fillValue(el);
        if (window.__atgFillSeen.get(el) === undefined) window.__atgFillSeen.set(el, raw);
      }
      bindEditContext(el);
    } catch (_) {}
  }, true);
  if (!window.__atgFillTimer) {
    window.__atgFillTimer = setInterval(() => {
      try { if (typeof window.__atgPollFill === 'function') window.__atgPollFill(); } catch (_) {}
    }, 200);
  }
})()`;

/** 读取并清空缓冲区的脚本。 */
export const RECORD_DRAIN = `(() => { try { if (typeof window.__atgFlushFill === 'function') window.__atgFlushFill(); } catch (_) {} const b = window.${REC_BUF} || []; window.${REC_BUF} = []; return b.filter((e) => { if (e.type === 'fill') { const v = e.params && e.params.value; if (!v || v === '__ATG_EMPTY_FILL__') return false; } const role = (e.locator && e.locator.role || '').toLowerCase(); if ((e.type === 'click' || e.type === 'hover') && (role === 'presentation' || role === 'none')) return false; return true; }); })()`;

/**
 * 取回注入层统计（对账用）。统计**不进 Script JSON** —— Script JSON 是平台唯一不变式，
 * 覆盖率只作为录制结束时的结论文本。未注入过脚本时返回 null，宿主据此区分
 * 「注入了但一条都没捕到」与「根本没注入」（后者是成片丢失，必须在结论里点名）。
 */
export const REC_STATS_DRAIN = `(() => { try { if (typeof window.__atgFlushFill === 'function') window.__atgFlushFill(); } catch (_) {} const s = window.__atgStats; if (!s || typeof s !== 'object') return null; const reasons = {}; const r = s.reasons || {}; for (const k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) reasons[k] = Number(r[k]) || 0; } return { intents: Number(s.intents) || 0, emitted: Number(s.emitted) || 0, dropped: Number(s.dropped) || 0, recovered: Number(s.recovered) || 0, reasons }; })()`;

// ───────────────────────── 嵌入式点选录制（spec §2.3）─────────────────────────
// 点选子模式：waitUntil/assert/选择组条件共用。注入一次性 click 监听，命中后把完整
// locator（含祖先链 css，与 §2.2.1 同源）写入 window.__pickResult，由 adapter 轮询取回。
// 一次性：命中即解绑；cancelPick 设标志位让监听器忽略后续点击。
export const PICK_INJECT = ATG_LOCATOR_HELPERS + `;(() => {
  if (window.${PICK_FLAG}) return;
  window.${PICK_RESULT} = null;
  window.${PICK_FLAG} = true;
  const handler = (ev) => {
    if (!window.${PICK_FLAG}) return;
    let el = ev.target;
    if (!(el instanceof Element)) return;
    // 与录制同源：从事件目标走到可交互祖先，跳过帮助文案 name。
    window.${PICK_RESULT} = window.__atgLocOf(el);
    window.${PICK_FLAG} = false;
    document.removeEventListener('click', handler, true);
  };
  document.addEventListener('click', handler, true);
})()`;

export const PICK_DRAIN = `(() => { const r = window.${PICK_RESULT} || null; window.${PICK_RESULT} = null; return r; })()`;

export const PICK_STOP = `(() => { window.${PICK_FLAG} = false; window.${PICK_RESULT} = null; })()`;

/** 开始录制后才轮询当前可填节点；未录制时打字不得灌进 __recBuf。每次开录重置 fill 基线，避免把已有文档当一次填充。 */
export const REC_ACTIVE_ON = `(() => { window.__recActive = true; window.__atgFillSeen = typeof WeakMap === 'function' ? new WeakMap() : null; window.__atgStats = { intents: 0, emitted: 0, dropped: 0, recovered: 0, reasons: {} }; window.__atgIntent = null; return true; })()`;
export const REC_ACTIVE_OFF = `(() => { window.__recActive = false; return true; })()`;

/** 高亮绘制结果：画没画上、为什么没画上，宿主侧必须拿得到（原来只回一个裸 false）。 */
export type HighlightPaintResult = {
  ok: boolean;
  /** 命中路径：role+name / role / name / text / css / testId / xpath。 */
  via?: string;
  /** 失败原因：no-locator / no-match / ambiguous / detached。宿主侧另有 layer-mismatch / evaluate-failed。 */
  reason?: string;
  /** 命中多个候选，已按「面积最小、层级最深」择优。 */
  multiple?: boolean;
  detail?: string;
};

/** 候选选择器：宿主侧算好、注入页内直接按序尝试，避免两处各自演化出一套查找逻辑。 */
export type LocatorSelector = { selector: string; useXpath: boolean; via: string };

function cssEscapeSelector(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * Locator → 候选选择器。顺序即高亮查找优先级：语义（role+name / role）→ css → testId → xpath。
 *
 * 纯 name / text 没有可靠的选择器形式（包含匹配会命中祖先），交给注入脚本里的排序兜底。
 *
 * 执行路径仍以 targets.ts 的 locatorToSelector 为唯一权威——不动它，避免扰动执行行为；
 * 本列表覆盖它能发出的全部形式，从而保证「执行选得中 ⇒ 高亮画得出」。
 * 这正是用户反馈的「执行没问题但就是没高亮」的成因：旧 findEl 不认 role、不支持 xpath。
 */
export function locatorSelectors(loc: Locator | null | undefined): LocatorSelector[] {
  const l = loc ?? {};
  const out: LocatorSelector[] = [];
  const exact = l.textExact ?? false;
  const nameSel = (n: string) =>
    (exact ? `[aria-label="${cssEscapeSelector(n)}"]` : `[aria-label*="${cssEscapeSelector(n)}"]`);
  const role = l.role && !isNonActionableRole(l.role) ? l.role : undefined;
  if (role && l.name) {
    out.push({ selector: `[role="${cssEscapeSelector(role)}"]${nameSel(l.name)}`, useXpath: false, via: 'role+name' });
  }
  if (l.css) out.push({ selector: l.css, useXpath: false, via: 'css' });
  if (l.testId) out.push({ selector: `[data-testid="${cssEscapeSelector(l.testId)}"]`, useXpath: false, via: 'testId' });
  if (l.xpath) out.push({ selector: l.xpath, useXpath: true, via: 'xpath' });
  // 光有 role 最不具体（同一屏往往有同 role 的多个元素），放最后，且命中多个时会择优。
  if (role) out.push({ selector: `[role="${cssEscapeSelector(role)}"]`, useXpath: false, via: 'role' });
  return out;
}

/**
 * CDP / WS 边界兜底：evaluate 回来的可能是 null、旧会话的裸 false、或字段不全的对象。
 * 统一成 HighlightPaintResult，让宿主侧不必区分「没画上」和「回不来」。
 */
export function normalizeHighlightResult(raw: unknown): HighlightPaintResult {
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<HighlightPaintResult>;
    if (r.ok === true) {
      const out: HighlightPaintResult = { ok: true };
      if (r.via) out.via = r.via;
      if (r.multiple) out.multiple = true;
      return out;
    }
    if (typeof r.reason === 'string') {
      const out: HighlightPaintResult = { ok: false, reason: r.reason };
      if (r.detail) out.detail = r.detail;
      return out;
    }
  }
  // 旧注入会话只回一个裸 false：没画上，且原因不明 —— 也要报，不能当成成功。
  return {
    ok: false,
    reason: 'unknown',
    detail: raw === false ? '注入脚本返回 false（未升级的旧会话，查不到失败原因）' : undefined,
  };
}

/** 拍摄前在靶机 DOM 上画定位框，随后截图，高亮成为 PNG 像素。舞台缩放不再需要坐标映射。 */
export const HIGHLIGHT_CLEAR = `(() => {
  const n = document.getElementById('__atgHl'); if (n) n.remove();
  try {
    const scopes = [document];
    document.querySelectorAll('*').forEach((h) => { if (h.shadowRoot) scopes.push(h.shadowRoot); });
    scopes.forEach((s) => s.querySelectorAll('[data-atg-hl-hit]').forEach((e) => e.removeAttribute('data-atg-hl-hit')));
  } catch (err) {}
  return true;
})()`;

export function highlightPaintSource(loc: Locator | undefined | null): string {
  const l = loc ?? {};
  const cands = locatorSelectors(l);
  return `(() => {
    const loc = ${JSON.stringify(l)};
    const cands = ${JSON.stringify(cands)};
    // 漏了要响：任何一路落空都要带 reason 回宿主侧，原来只 return false。
    const fail = (reason, detail) => {
      const r = { ok: false, reason: reason };
      if (detail) r.detail = String(detail).slice(0, 200);
      window.__atgHighlight = r;
      return r;
    };
    // 查询范围含 open shadow root：许多壳把 UI 装在里面，只查 document 会静默落空。
    const scopes = () => {
      const out = [document];
      const walk = (root, depth) => {
        if (depth > 4) return;
        let all = [];
        try { all = Array.prototype.slice.call(root.querySelectorAll('*')); } catch (err) { return; }
        for (const n of all) if (n.shadowRoot) { out.push(n.shadowRoot); walk(n.shadowRoot, depth + 1); }
      };
      walk(document, 0);
      return out;
    };
    const shown = (e) => {
      if (!e || e.nodeType !== 1) return false;
      if (e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('hidden')) return false;
      const st = e.style || {};
      return st.display !== 'none' && st.visibility !== 'hidden';
    };
    // 取不到矩形的元素画不出框（不可渲染 / 已脱离文档），不参与择优。
    const areaOf = (e) => {
      try { const r = e.getBoundingClientRect(); return (r.width || 0) * (r.height || 0); } catch (err) { return -1; }
    };
    const depthOf = (e) => { let d = 0, c = e; while ((c = c.parentElement)) d++; return d; };
    // 命中多个时：面积最小优先（高亮框不该盖住半个屏幕），面积相同取层级最深。
    const best = (list) => {
      let pick = null, pickArea = -1, pickDepth = -1;
      for (const e of list) {
        const a = areaOf(e), d = depthOf(e);
        if (pick === null || a < pickArea || (a === pickArea && d > pickDepth)) { pick = e; pickArea = a; pickDepth = d; }
      }
      return pick;
    };
    const usable = (list) => list.filter((e) => shown(e) && areaOf(e) >= 0);
    const roleOf = (e) => {
      const r = (e.getAttribute('role') || '').toLowerCase();
      if (r) return r;
      const t = (e.tagName || '').toUpperCase();
      if (t === 'BUTTON') return 'button';
      if (t === 'A') return 'link';
      if (t === 'INPUT' || t === 'TEXTAREA') return 'textbox';
      if (t === 'SELECT') return 'combobox';
      return '';
    };
    // name / text 兜底：精确优先，包含匹配兜底；命中多个按面积与层级择优。
    const nameFallback = (roots) => {
      const want = loc.name || loc.text;
      if (!want) return fail('no-match');
      const pool = [];
      roots.forEach((root) => {
        try {
          root.querySelectorAll('button,a,input,textarea,select,[role],[aria-label],[contenteditable="true"],[contenteditable=""]')
            .forEach((n) => pool.push(n));
        } catch (err) {}
      });
      const roleWant = (loc.role || '').toLowerCase();
      const inRole = (roleWant && roleWant !== 'presentation' && roleWant !== 'none')
        ? usable(pool).filter((e) => roleOf(e) === roleWant)
        : usable(pool);
      const acc = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
      // 返回 { el, via, multiple } 命中，或 { reason } 失败。
      const pick = (list) => {
        if (!list.length) return null;
        const via = loc.name ? 'name' : 'text';
        if (list.length === 1) return { el: list[0], via: via };
        const top = best(list);
        // 互不包含的多个精确匹配：真不知道该高亮谁，宁可报 ambiguous 也不乱画一个。
        const nested = list.every((e) => e === top || top.contains(e) || e.contains(top));
        if (!nested) return { reason: 'ambiguous', detail: list.length + ' 个元素都精确匹配 ' + want };
        return { el: top, via: via, multiple: true };
      };
      const hit = pick(inRole.filter((e) => acc(e) === want))
        || pick(inRole.filter((e) => { const s = acc(e); return s && s.indexOf(want) !== -1; }));
      if (hit && hit.el) return hit;
      if (hit && hit.reason) return fail(hit.reason, hit.detail);
      return fail('no-match');
    };
    const findEl = () => {
      if (!cands.length && !loc.name && !loc.text) return fail('no-locator');
      const roots = scopes();
      for (const c of cands) {
        const hits = [];
        for (const root of roots) {
          try {
            if (c.useXpath) {
              const n = document.evaluate(c.selector, root, null, 9, null).singleNodeValue;
              if (n) hits.push(n);
            } else if (typeof root.querySelectorAll === 'function') {
              root.querySelectorAll(c.selector).forEach((n) => hits.push(n));
            }
          } catch (err) {}
        }
        const list = usable(hits);
        if (list.length) return { el: best(list), via: c.via, multiple: list.length > 1 };
      }
      return nameFallback(roots);
    };
    const old = document.getElementById('__atgHl');
    if (old) old.remove();
    try {
      const scopesNow = scopes();
      scopesNow.forEach((s) => s.querySelectorAll('[data-atg-hl-hit]').forEach((e) => e.removeAttribute('data-atg-hl-hit')));
    } catch (err) {}
    const found = findEl();
    if (!found.el) return found.reason ? found : fail('no-match');
    const el = found.el;
    if (typeof el.isConnected === 'boolean' && !el.isConnected) return fail('detached');
    let r;
    try { r = el.getBoundingClientRect(); } catch (err) { return fail('detached'); }
    // 命中的元素盖章：宿主侧（与测试）可据此核对「高亮的到底是不是执行会点的那个」。
    try { el.setAttribute('data-atg-hl-hit', '1'); } catch (err) {}
    const done = { ok: true, via: found.via };
    if (found.multiple) done.multiple = true;
    window.__atgHighlight = done;
    const d = document.createElement('div');
    d.id = '__atgHl';
    d.setAttribute('data-atg-highlight', 'true');
    d.style.position = 'fixed';
    d.style.left = r.left + 'px';
    d.style.top = r.top + 'px';
    d.style.width = Math.max(r.width, 4) + 'px';
    d.style.height = Math.max(r.height, 4) + 'px';
    d.style.border = '2px solid #3b82f6';
    d.style.background = 'rgba(59,130,246,0.2)';
    d.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.55), 0 0 16px rgba(59,130,246,0.45)';
    d.style.borderRadius = '4px';
    d.style.pointerEvents = 'none';
    d.style.zIndex = '2147483646';
    document.documentElement.appendChild(d);
    return done;
  })()`;
}
