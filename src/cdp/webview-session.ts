// 方案 C 核心：沙箱 webview 的独立 CDP 会话（native WebSocket）。
// VS Code 系 Electron webview 的 UI 在 webview 的"内层 iframe execution context"中，
// Playwright 的 page.frames() 拿不到。本模块直连 webview 的 webSocketDebuggerUrl，
// 维护 execution contexts，并把 evaluate/fill 转发到内层 UI context。
//
// 设计：Adapter（原生 CDP → 统一 CdpTarget 接口）+ 内部 context 策略选择。
// 依据：docs/design/m2-webview-cdp.md §3。

import WebSocket from 'ws';
import type { TargetType } from './targets';
import type { SerializedNode } from './adapter';
import type { Page, Frame } from 'playwright';
import { asPlaywrightExpression } from '../recorder/inject';

/** 一个执行上下文（含 webview host 默认 context 与内层 iframe context）。 */
export type ExecContext = {
  id: number;
  auxData?: { isDefault?: boolean; frameId?: string };
};

/** 判定是否为构造器（类/函数），用于区分"ws 实例"与"ws 构造器"。 */
function isConstructor(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    // 类/构造器有 prototype；实例（如 EventEmitter）prototype 链不同但仍有 prototype。
    // 用更稳妥的判据：有 prototype 且 prototype 含 constructor 指向自身。
    return !!(fn as any).prototype && (fn as any).prototype.constructor === fn;
  } catch {
    return false;
  }
}

/**
 * 可交互节点切片（主 page / webview / frame 共用）。
 * rect 来自 getBoundingClientRect，便宜；没有完整视觉框时仍给 x/y/width/height。
 */
export const SNAPSHOT_COLLECT = `(() => {
  const SELECTOR = 'a,button,input,select,textarea,[role],[data-testid],[contenteditable="true"],[contenteditable=""],textarea';
  const out = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    const he = el;
    const r = he.getBoundingClientRect();
    out.push({
      role: he.getAttribute('role') || undefined,
      name: he.getAttribute('aria-label') || he.getAttribute('name') || undefined,
      text: (he.innerText || he.textContent || '').trim().slice(0, 200),
      tag: he.tagName.toLowerCase(),
      testId: he.getAttribute('data-testid') || undefined,
      enabled: !he.disabled,
      visible: (() => {
        if (r.width <= 0 || r.height <= 0) return false;
        if (he.getAttribute('aria-hidden') === 'true' || he.hasAttribute('inert')) return false;
        if (typeof he.checkVisibility === 'function') {
          try { return he.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); }
          catch (_) { return true; }
        }
        const st = getComputedStyle(he);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      })(),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    });
  }
  return out;
})()`;

/** 统一目标操作接口（ISP）：page 与 webview 各自实现，避免 fat adapter。 */
export interface CdpTarget {
  readonly id: string;
  readonly type: TargetType;
  listContexts(): ExecContext[];
  /** 在目标作用域内求值；webview 默认转发到内层 UI context。 */
  evaluate<T = unknown>(expr: string, ctxId?: number): Promise<T>;
  snapshot(): Promise<SerializedNode[]>;
  fill(locatorExpr: string, value: string): Promise<void>;
  /** 断开底层会话（webview 关 ws，page 关浏览器上下文由 Playwright 管）。 */
  dispose?(): void;
}

/** 原生 CDP 会话封装：发请求、收响应、监听事件（executionContextCreated）。 */
class CdpSession {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private eventListeners: Array<(m: any) => void> = [];

  constructor(
    wsUrl: string,
    wsOrCtor?: WebSocket | (new (url: string, opts?: any) => WebSocket),
  ) {
    // 允许测试直接注入现成 ws 实例（mock）；生产走真实 ws 构造器。
    if (wsOrCtor && typeof (wsOrCtor as WebSocket).on === 'function' && !isConstructor(wsOrCtor)) {
      this.ws = wsOrCtor as WebSocket;
    } else {
      const Ctor = (wsOrCtor as new (url: string, opts?: any) => WebSocket) ?? WebSocket;
      // 兼容箭头函数工厂（如测试 mock）：箭头不可 new，改为直接调用。
      const constructed = isConstructor(Ctor)
        ? new Ctor(wsUrl, { perMessageDeflate: false })
        : (Ctor as any)(wsUrl, [], { perMessageDeflate: false });
      this.ws = constructed as WebSocket;
    }
    this.ws.on('message', (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString());
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${m.error.data ?? ''})`));
        else resolve(m.result);
        return;
      }
      if (m.method) for (const l of this.eventListeners) l(m);
    });
    // 必须在 ws 'open' 之后才能发送 Runtime.enable，否则服务端丢弃，
    // 导致 executionContextCreated 永远不来（真机 WEBVIEW_NO_CONTEXT 根因）。
    if (typeof (this.ws as WebSocket).on === 'function') {
      (this.ws as WebSocket).once('open', () => {
        this.send('Runtime.enable').catch(() => undefined);
        this.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      });
    }
  }

  on(fn: (m: any) => void) {
    this.eventListeners.push(fn);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

export class WebviewCdpTarget implements CdpTarget {
  readonly id: string;
  readonly type: TargetType = 'webview';
  private session: CdpSession;
  private contexts: ExecContext[] = [];
  private uiContextId?: number;

  constructor(
    id: string,
    wsUrl: string,
    wsCtor?: new (url: string, opts?: any) => WebSocket,
  ) {
    this.id = id;
    this.session = new CdpSession(wsUrl, wsCtor);
    this.session.on((m) => {
      if (m.method === 'Runtime.executionContextCreated') {
        this.contexts.push(m.params.context as ExecContext);
      } else if (m.method === 'Runtime.executionContextDestroyed') {
        const id = m.params.context?.id;
        this.contexts = this.contexts.filter((c) => c.id !== id);
        if (this.uiContextId === id) this.uiContextId = undefined;
      }
    });
    // 注意：Runtime.enable 改由 CdpSession 在 ws 'open' 后发送，
    // 避免真机下"未 open 就发指令被丢弃"导致内层 context 永不抵达。
  }

  listContexts(): ExecContext[] {
    return [...this.contexts];
  }

  /** 选一个"承载 UI"的 context：默认优先内层（非 isDefault），否则首个非空 context。 */
  private async resolveContext(hint?: number): Promise<number> {
    if (hint !== undefined) return hint;
    if (this.uiContextId !== undefined) return this.uiContextId;

    // 没有 context 信息：轮询稍候（webview 内层可能延迟创建）。
    if (this.contexts.length === 0) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (this.contexts.length > 0) break;
      }
    }
    // 优先非默认 context（内层 UI 通常不在 host 默认 context）。
    const inner = this.contexts.find((c) => !c.auxData?.isDefault);
    const chosen = inner ?? this.contexts[0];
    if (!chosen) throw new Error('WEBVIEW_NO_CONTEXT: 该 webview 暂无可用执行上下文');
    this.uiContextId = chosen.id;
    return chosen.id;
  }

  /** 暴露给测试/上层：返回当前内层 UI context id（无则解析并缓存）。 */
  async findUiContext(): Promise<number> {
    return this.resolveContext();
  }

  async evaluate<T = unknown>(expr: string, ctxId?: number): Promise<T> {
    const ctx = await this.resolveContext(ctxId);
    const r = await this.session.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      contextId: ctx,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`WEBVIEW_EVAL: ${desc}`);
    }
    return r.result.value as T;
  }

  async snapshot(): Promise<SerializedNode[]> {
    return this.evaluate<SerializedNode[]>(SNAPSHOT_COLLECT).catch(() => []);
  }

  async fill(locatorExpr: string, value: string): Promise<void> {
    // 先定位元素类型：input/textarea 用设值+事件；contenteditable 用 Input.insertText。
    const tag = await this.evaluate<string>(
      `(() => { const e = document.querySelector(${JSON.stringify(locatorExpr)}); return e ? (e.tagName.toLowerCase()) : 'none'; })()`,
    );
    if (tag === 'none') throw new Error(`WEBVIEW_FILL: 未找到元素 ${locatorExpr}`);

    if (tag === 'input' || tag === 'textarea') {
      await this.evaluate(
        `(() => {
          const e = document.querySelector(${JSON.stringify(locatorExpr)});
          const setter = Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set;
          setter.call(e, ${JSON.stringify(value)});
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
      );
      return;
    }

    // contenteditable（如对话输入框 <div role=textbox>）：真实键盘输入语义。
    await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(locatorExpr)}); e.focus(); e.textContent = ''; })()`,
    );
    const ctx = await this.resolveContext();
    await this.session.send('Input.insertText', { text: value, contextId: ctx });
    await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(locatorExpr)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  }

  dispose() {
    this.session.close();
  }

  /** webview 内层没有 Playwright 指针，用 CDP Input 在坐标点一下。 */
  async mouseClick(x: number, y: number): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
}

/**
 * page 目标的 CdpTarget 实现：委托 Playwright Page 的 evaluate。
 * 保持 page 路径稳定（Playwright 对主窗口控制成熟），仅 webview 走 native CDP。
 * 这是 OCP 的体现：新增目标类型只需新增一个 CdpTarget 实现，操作核心不变。
 */
export class PlaywrightPageTarget implements CdpTarget {
  readonly id: string;
  readonly type: TargetType = 'page';
  private page: Page;

  constructor(id: string, page: Page) {
    this.id = id;
    this.page = page;
  }

  listContexts(): ExecContext[] {
    // Playwright Page 默认单一主 context。
    return [{ id: 0, auxData: { isDefault: true } }];
  }

  async evaluate<T = unknown>(expr: string, _ctxId?: number): Promise<T> {
    // Playwright 把 string 当表达式。注入脚本是多段语句，必须经 asPlaywrightExpression
    // 才能在 VS Code 主窗口（page 目标，含右侧聊天）装上监听。
    return this.page.evaluate(asPlaywrightExpression(expr)) as Promise<T>;
  }

  async snapshot(): Promise<SerializedNode[]> {
    return this.evaluate<SerializedNode[]>(SNAPSHOT_COLLECT);
  }

  async fill(locatorExpr: string, value: string): Promise<void> {
    await this.page.evaluate(
      ({ locatorExpr, value }) => {
        const e = document.querySelector(locatorExpr) as HTMLElement | null;
        if (!e) throw new Error(`PAGE_FILL: 未找到元素 ${locatorExpr}`);
        e.focus();
        const tag = e.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
          const proto = Object.getPrototypeOf(e);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(e, value);
          else (e as HTMLInputElement).value = value;
        } else {
          e.textContent = value;
        }
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { locatorExpr, value },
    );
  }

  dispose() {
    /* Page 生命周期由 Playwright Browser 管理，这里不关。 */
  }
}

/** 回退路径 B 的子 frame webview：委托 Playwright Frame 的 evaluate。 */
export class PlaywrightFrameTarget implements CdpTarget {
  readonly id: string;
  readonly type: TargetType = 'webview';
  private frame: Frame;

  constructor(id: string, frame: Frame) {
    this.id = id;
    this.frame = frame;
  }

  listContexts(): ExecContext[] {
    return [{ id: 0, auxData: { isDefault: true } }];
  }

  async evaluate<T = unknown>(expr: string, _ctxId?: number): Promise<T> {
    return this.frame.evaluate(asPlaywrightExpression(expr)) as Promise<T>;
  }

  async snapshot(): Promise<SerializedNode[]> {
    return this.evaluate<SerializedNode[]>(SNAPSHOT_COLLECT);
  }

  async fill(locatorExpr: string, value: string): Promise<void> {
    await this.frame.evaluate(
      ({ locatorExpr, value }) => {
        const e = document.querySelector(locatorExpr) as HTMLInputElement | null;
        if (!e) throw new Error(`FRAME_FILL: 未找到元素 ${locatorExpr}`);
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set;
        if (setter) setter.call(e, value);
        else (e as unknown as HTMLDivElement).textContent = value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { locatorExpr, value },
    );
  }

  dispose() {
    /* Frame 生命周期由 Playwright 管理。 */
  }
}
