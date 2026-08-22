// CDP 适配层：基于 Playwright connectOverCDP 控制 Electron 应用。
// 设计依据：docs/design/design.md §5；错误需带明确错误码，不静默崩溃（§8-5）。

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import WebSocket from 'ws';
import type { Locator, Script } from '../types/step';
import { runCli } from '../cli';
export type { Locator } from '../types/step';
import type { InteractionEvent } from '../recorder/recorder';
import { RECORD_INJECT, RECORD_DRAIN } from '../recorder/inject';
import {
  enumerateTargets,
  findTarget,
  mainTarget,
  resolveLocator,
  locatorToSelector,
  type TargetEntry,
  type TargetInfo,
} from './targets.js';

export type { TargetInfo, TargetType } from './targets.js';

export const DEFAULT_CDP_PORT = 9222;

/** 快照节点：可交互元素清单（UC-02 雏形）。 */
export type SerializedNode = {
  role?: string;
  name?: string;
  text?: string;
  tag?: string;
  testId?: string;
  enabled?: boolean;
  visible?: boolean;
  /** 视觉 rect（M2）：渲染坐标与尺寸，DOM 树无此信息。 */
  rect?: { x: number; y: number; width: number; height: number };
};

/** 视觉位置：基于渲染进程的 bounding box + 视口判定（M2 §3.2）。 */
export type VisualRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  /** 元素整体是否落在视口内（M2 视觉断言用）。 */
  inViewport: boolean;
};

export type ScreenshotOptions = {
  target?: string;
  element?: Locator;
  fullPage?: boolean;
  /**
   * 落盘路径（可选）：提供则将截图写入该文件并返回其路径（除 Buffer 外）。
   * 不提供则仅返回 Buffer。用于人工验证（见 test/reports/ 或自定义目录）。
   */
  savePath?: string;
};

/**
 * 可视化能力派生接口（ISP：避免让所有 CdpAdapter 强制实现截图/视觉定位）。
 * 仅"可视化场景"的实现（如 PlaywrightCdpAdapter）实现本接口（M2 §4 偿还 ISP 债）。
 */
export interface VisualCapable {
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  locateVisual(loc: Locator): Promise<VisualRect>;
}

/**
 * 录制能力派生接口（ISP：仅"录制场景"的实现才需具备）。
 * M3 可视化 UI 编辑壳的内置录制功能依赖此能力；非录制适配器无需实现。
 */
export interface Recordable {
  /** 在当前 target 注入交互监听，开始捕获用户操作。 */
  startRecording(): void;
  /** 停止监听并异步收集期间捕获的交互事件（抽象 InteractionEvent，与具体事件源解耦）。 */
  stopRecording(): Promise<InteractionEvent[]>;
}

export type ConnectOptions = {
  port?: number;
  appPath?: string;
  launchArgs?: string[];
};

export interface CdpAdapter {
  // opts 可选：默认端口 9222（测试契约 test/cdp.test.ts 以无参形式调用）。
  connect(opts?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  listTargets(): TargetInfo[];
  selectTarget(id: string): void;
  click(loc: Locator): Promise<void>;
  fill(loc: Locator, value: string): Promise<void>;
  select(loc: Locator, option: string): Promise<void>;
  hover(loc: Locator): Promise<void>;
  wait(opts: { text?: string; durationMs?: number }): Promise<void>;
  eval(code: string): Promise<unknown>;
  snapshot(): Promise<SerializedNode[]>;
  query(loc: Locator): Promise<unknown>;
}

/** 带错误码的适配层异常，便于上层区分处理（design.md §8-5）。 */
export class CdpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CdpError';
  }
}

export class PlaywrightCdpAdapter implements CdpAdapter, VisualCapable, Recordable {
  private browser?: Browser;
  private child?: ChildProcess;
  private targets: TargetEntry[] = [];
  private current?: TargetEntry;
  private port = DEFAULT_CDP_PORT;

  // M3 录制：累积当前 target 捕获的交互事件（仅在 startRecording 后生效）。
  private recording = false;
  private recorded: InteractionEvent[] = [];
  /** 浏览器级 CDP 会话（监听 Target.targetCreated，捕捉录制中途动态新增的 webview）。 */
  private recordBrowserWs?: WebSocket;
  /** 本轮录制已注入监听器的 target id 集合，避免重复注入。 */
  private injectedTargets = new Set<string>();

  async connect(opts: ConnectOptions = {}): Promise<void> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    this.port = port;

    if (opts.appPath) {
      this.child = this.launchApp(opts.appPath, port, opts.launchArgs);
      await this.waitForPort(port);
    }

    const endpoint = `http://127.0.0.1:${port}`;
    try {
      this.browser = await chromium.connectOverCDP(endpoint);
    } catch (err) {
      await this.killChild();
      throw new CdpError(
        'CDP_CONNECT_FAILED',
        `无法连接 ${endpoint}；请确认应用已开启 --remote-debugging-port=${port}（生产包可能禁用调试）`,
        err,
      );
    }

    await this.refreshTargets();
    this.current = mainTarget(this.targets);
    if (!this.current) {
      throw new CdpError('CDP_NO_TARGET', `连接成功但未发现任何 page/webview 目标（${endpoint}）`);
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // 关闭失败不应掩盖主流程结果。
    }
    // 释放 webview 的独立 CDP 会话（native WebSocket）。
    for (const t of this.targets) t.target.dispose?.();
    this.browser = undefined;
    this.targets = [];
    this.current = undefined;
    this.recording = false;
    this.recorded = [];
    this.stopTargetWatch();
    await this.killChild();
  }

  /**
   * 回放能力（UiKernel.playback）：编排 runCli 按脚本驱动本适配器。
   * UI 壳只调用此方法，不直接依赖执行器/playwright 链（DIP）。
   */
  async playback(script: Script): Promise<{ ok: boolean; failedStepId?: string }> {
    return runCli({ adapter: this, script });
  }

  listTargets(): TargetInfo[] {
    return this.targets.map((t) => t.info);
  }

  selectTarget(id: string): void {
    const found = findTarget(this.targets, id);
    if (!found) {
      throw new CdpError(
        'CDP_TARGET_NOT_FOUND',
        `未找到目标 ${id}；可用：${this.targets.map((t) => t.info.id).join(', ') || '(空)'}`,
      );
    }
    this.current = found;
  }

  /** 重新枚举目标（窗口/webview 可能动态增减）。 */
  async refreshTargets(): Promise<TargetInfo[]> {
    const browser = this.requireBrowser();
    const raw = await this.fetchRawTargets().catch(() => undefined);
    const prevId = this.current?.info.id;
    this.targets = await enumerateTargets(browser, raw);
    // 重新枚举会产生全新的 TargetEntry 对象；把 this.current 重新指向同 id 的新条目，
    // 避免其悬空在旧列表上（录制中途 refresh 若悬空，后续 fill/click 会作用于失效目标）。
    if (prevId) {
      const same = findTarget(this.targets, prevId);
      this.current = same ?? mainTarget(this.targets);
    } else {
      this.current = mainTarget(this.targets);
    }
    return this.listTargets();
  }

  /** 从 CDP /json 拉取原始 target 列表（保留 iframe 等真实类型）。 */
  private async fetchRawTargets(): Promise<import('./targets.js').RawCdpTarget[]> {
    const port = this.port;
    if (!port) return [];
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (!res.ok) return [];
    const list = (await res.json()) as import('./targets.js').RawCdpTarget[];
    return Array.isArray(list) ? list : [];
  }

  async click(loc: Locator): Promise<void> {
    const sel = locatorToSelector(loc);
    await this.currentTarget().evaluate(
      `(() => { const e = ${this.queryExpr(sel)}; if(!e) throw new Error('CLICK: 未找到元素'); e.click(); })()`,
    );
  }

  async fill(loc: Locator, value: string): Promise<void> {
    const sel = locatorToSelector(loc);
    await this.currentTarget().fill(this.selectorString(sel), value);
  }

  async select(loc: Locator, option: string): Promise<void> {
    const sel = locatorToSelector(loc);
    await this.currentTarget().evaluate(
      `(() => {
        const e = ${this.queryExpr(sel)};
        if(!e) throw new Error('SELECT: 未找到元素');
        const setter = Object.getOwnPropertyDescriptor(e.constructor.prototype,'value').set;
        setter.call(e, ${JSON.stringify(option)});
        e.dispatchEvent(new Event('change',{bubbles:true}));
      })()`,
    );
  }

  async hover(loc: Locator): Promise<void> {
    const sel = locatorToSelector(loc);
    await this.currentTarget().evaluate(
      `(() => { const e = ${this.queryExpr(sel)}; if(!e) throw new Error('HOVER: 未找到元素'); e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); })()`,
    );
  }

  async wait(opts: { text?: string; durationMs?: number }): Promise<void> {
    if (opts.text !== undefined) {
      const target = this.currentTarget();
      const deadline = Date.now() + (opts.durationMs ?? 10_000);
      for (;;) {
        const found = await target.evaluate<boolean>(
          `(() => { const els=[...document.querySelectorAll('*')]; return els.some(e=>(e.innerText||'').includes(${JSON.stringify(opts.text)})); })()`,
        ).catch(() => false);
        if (found) return;
        if (Date.now() > deadline) throw new CdpError('CDP_WAIT_TIMEOUT', `等待文本「${opts.text}」超时`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (opts.durationMs !== undefined) {
      await new Promise((r) => setTimeout(r, opts.durationMs));
      return;
    }
    throw new CdpError('CDP_WAIT_INVALID', 'wait 需提供 text 或 durationMs');
  }

  async eval(code: string): Promise<unknown> {
    // 以表达式求值语义执行，贴合 assertion 的 expr 用法。
    return this.currentTarget().evaluate(`(() => (${code}))()`);
  }

  async snapshot(): Promise<SerializedNode[]> {
    return this.currentTarget().snapshot();
  }

  /** 返回首个匹配的 ElementHandle，未命中返回 null。 */
  async query(loc: Locator): Promise<unknown> {
    const sel = locatorToSelector(loc);
    const found = await this.currentTarget().evaluate<boolean>(
      `(() => !!${this.queryExpr(sel)})()`,
    );
    return found ? { selector: this.selectorString(sel) } : null;
  }

  /**
   * M3 录制：对所有已枚举 target（主 page + 每个 webview）注入交互监听器。
   * 事件累积在各自的 window.__recBuf；webview 内层通过 CdpTarget.evaluate 的 ctxId 注入。
   * 同时开启浏览器级 Target 监听，录制中途动态新增的 webview 也会被自动注入。
   */
  startRecording(): void {
    // 先清理可能残留的监听 ws（防止连续两次 startRecording 未 stop 时句柄泄漏）。
    this.stopTargetWatch();
    this.recording = true;
    this.recorded = [];
    this.injectedTargets.clear();
    // 会话开始：先排空所有 target 的残留缓冲（监听器常驻，跨会话可能已累积），
    // 再注入录制脚本。后续 refreshTargets 触发的重复注入只注入不排空，避免清掉已捕获事件。
    for (const t of this.targets) {
      void t.target.evaluate(RECORD_DRAIN).catch(() => undefined);
    }
    this.injectRecorderIntoTargets();
    // 再开启动态监听：中途新开的 webview 也能被录到。
    this.startTargetWatch();
  }

  /** M3 录制：停止监听并异步取回所有 target 累积的 InteractionEvent[]（按 target 标注）。 */
  async stopRecording(): Promise<InteractionEvent[]> {
    this.recording = false;
    this.stopTargetWatch();
    const out: InteractionEvent[] = [];
    for (const t of this.targets) {
      const buf = await t.target.evaluate<any[]>(RECORD_DRAIN).catch(() => []);
      if (Array.isArray(buf)) {
        for (const e of buf) out.push({ ...(e as InteractionEvent), target: t.info.id });
      }
    }
    this.recorded = out;
    return out;
  }

  /**
   * 把录制监听器注入到「本轮尚未注入」的 target（page + webview）。
   * 注意：本方法只注入，不排空缓冲——排空只在 startRecording 会话开始时做一次，
   * 否则录制中途 refreshTargets 触发的重复注入会清空已捕获的事件（见 targetCreated 处理）。
   * 仅依赖 CdpTarget.evaluate（保持抽象一致，不引入 exposeFunction）。
   */
  private injectRecorderIntoTargets(): void {
    for (const t of this.targets) {
      if (this.injectedTargets.has(t.info.id)) continue;
      void t.target.evaluate(RECORD_INJECT).catch(() => undefined);
      this.injectedTargets.add(t.info.id);
    }
  }

  /**
   * 开启浏览器级 CDP 监听：录制中途若应用动态新增 webview（Target.targetCreated），
   * 重新枚举并自动注入录制监听器。这样「操作触发新开 webview」的用例也能录到。
   * 仅监听事件、不改动核心录制逻辑（OCP）。静默容错：建连/订阅失败不影响既有录制。
   */
  private startTargetWatch(): void {
    // 先清理可能残留的监听 ws（防止连续两次 startRecording 未 stop 时句柄泄漏）。
    this.stopTargetWatch();
    const port = this.port;
    if (!port) return;
    try {
      // 浏览器级 CDP 端点不在根路径，需从 /json/version 取 webSocketDebuggerUrl。
      void fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => (r.ok ? r.json() : null))
        .then((v: any) => {
          const wsUrl: string | undefined = v?.webSocketDebuggerUrl;
          if (!wsUrl) return; // 取不到则不开启动态监听，降级为仅录制已枚举 target。
          this.openTargetWatch(wsUrl);
        })
        .catch(() => undefined);
    } catch {
      // 取端点失败：降级为仅录制已枚举 target，不阻断录制。
    }
  }

  /** 用浏览器级 webSocketDebuggerUrl 建立 CDP 会话并监听 Target.targetCreated。 */
  private openTargetWatch(wsUrl: string): void {
    try {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.recordBrowserWs = ws;
      ws.on('open', () => {
        // 启用 Target 域以接收 targetCreated 事件。
        ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      });
      ws.on('message', (data: WebSocket.RawData) => {
        let m: any;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        // 仅关心新 target 创建事件；其余（含自身响应）忽略。
        if (m.method !== 'Target.targetCreated') return;
        const info = m.params?.targetInfo;
        if (!info || (info.type !== 'page' && info.type !== 'iframe' && info.type !== 'webview')) {
          return;
        }
        // 重新枚举（新 target 此刻通常已出现在 /json，含 webSocketDebuggerUrl）。
        // 注入可能短暂失败（ws 未就绪），用几次重试兜底。
        void this.refreshTargets()
          .then(() => this.injectRecorderIntoTargets())
          .catch(() => undefined);
        // 若首次刷新时 ws url 尚未就绪，稍后重试补齐（最多 5 次，间隔 300ms）。
        const newId = info.targetId as string;
        for (let i = 1; i <= 5; i++) {
          setTimeout(() => {
            if (!this.recording) return;
            if (this.injectedTargets.has(newId)) return;
            void this.refreshTargets()
              .then(() => this.injectRecorderIntoTargets())
              .catch(() => undefined);
          }, i * 300);
        }
      });
      ws.on('error', () => {
        // 浏览器级监听不可用：既有录制不受影响，仅失去动态 webview 自动注入能力。
      });
    } catch {
      // 创建 ws 失败：降级为「仅录制已枚举 target」，不阻断录制。
    }
  }

  /** 关闭浏览器级 Target 监听（停止录制 / 断开时调用）。 */
  private stopTargetWatch(): void {
    try {
      this.recordBrowserWs?.close();
    } catch {
      /* 已关闭 */
    }
    this.recordBrowserWs = undefined;
    this.injectedTargets.clear();
  }

  /** Locator 转 querySelector/Document.evaluate 调用表达式（供 evaluate 内使用）。 */
  private queryExpr(sel: { selector: string; useXpath: boolean }): string {
    if (sel.useXpath) {
      return `document.evaluate(${JSON.stringify(sel.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
    }
    return `document.querySelector(${JSON.stringify(sel.selector)})`;
  }

  private selectorString(sel: { selector: string; useXpath: boolean }): string {
    return sel.selector;
  }

  /**
   * 截图：整窗 / 指定 webview(target) / 指定元素(element) 三种粒度（M2 §3.1）。
   * 若提供 opts.savePath，则额外把 PNG 写入该路径（用于人工验证），文件已存在则覆盖。
   */
  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    let buf: Buffer;
    const scope = this.scopeFor(opts.target) as Page;
    if (opts.element) {
      const handle = resolveLocator(scope, opts.element).first();
      try {
        buf = (await handle.screenshot()) as Buffer;
      } catch (err) {
        throw new CdpError('CDP_SCREENSHOT_ELEMENT', '元素截图失败（可能不可见或不在 DOM）', err);
      }
    } else {
      try {
        buf = (await scope.screenshot(opts.fullPage ? { fullPage: true } : {})) as Buffer;
      } catch (err) {
        throw new CdpError('CDP_SCREENSHOT_FAILED', '整窗/视口截图失败', err);
      }
    }

    // 落盘（可选）：让截图可被人工打开验证（test/reports/ 已被 gitignore）。
    if (opts.savePath) {
      const dir = dirname(opts.savePath);
      if (dir) mkdirSync(dir, { recursive: true });
      writeFileSync(opts.savePath, buf);
    }
    return buf;
  }

  /** 视觉定位：取元素 bounding box + 视口内判定（M2 §3.2，作用于 Playwright Page）。 */
  async locateVisual(loc: Locator): Promise<VisualRect> {
    const scope = this.page();
    const box = await resolveLocator(scope, loc)
      .first()
      .boundingBox()
      .catch(() => null);
    if (!box) {
      return { x: 0, y: 0, width: 0, height: 0, visible: false, inViewport: false };
    }
    // 视口判定：元素四角均落在 window 视口范围内。
    const vp = await scope
      .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      .catch(() => ({ w: 0, h: 0 }));
    const inViewport =
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= vp.w &&
      box.y + box.height <= vp.h;
    const visible = box.width > 0 && box.height > 0;
    return { x: box.x, y: box.y, width: box.width, height: box.height, visible, inViewport };
  }

  /** 按 target 选作用域：截图/locateVisual 作用于 Playwright Page（主窗口路径）。 */
  private scopeFor(target?: string): Page | Frame {
    if (target) {
      const found = findTarget(this.targets, target);
      if (!found) {
        throw new CdpError(
          'CDP_TARGET_NOT_FOUND',
          `截图指定目标 ${target} 未找到；可用：${this.targets.map((t) => t.info.id).join(', ') || '(空)'}`,
        );
      }
      if (!found.page) {
        throw new CdpError(
          'CDP_SCREENSHOT_WEBVIEW_UNSUPPORTED',
          `webview 目标 ${target} 暂不支持 Playwright 截图（方案 C 下截图走 CDP，后续扩展）`,
        );
      }
      return found.page;
    }
    return this.page();
  }

  // ---- 内部辅助 ----

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new CdpError('CDP_NOT_CONNECTED', '尚未 connect()，无可用 CDP 连接');
    }
    return this.browser;
  }

  /** 当前操作的统一 CdpTarget（page 或 webview）。 */
  private currentTarget(): import('./webview-session').CdpTarget {
    const target = this.current ?? mainTarget(this.targets);
    if (!target) {
      throw new CdpError('CDP_NO_TARGET', '无当前目标，请先 connect()/selectTarget()');
    }
    return target.target;
  }

  private page(): Page {
    this.requireBrowser();
    const target = this.current ?? mainTarget(this.targets);
    if (!target) {
      throw new CdpError('CDP_NO_TARGET', '无当前目标，请先 connect()/selectTarget()');
    }
    if (!target.page) {
      throw new CdpError('CDP_PAGE_ONLY', '该操作仅适用于 page 目标（webview 走 CdpTarget）');
    }
    return target.page;
  }

  private launchApp(appPath: string, port: number, launchArgs?: string[]): ChildProcess {
    try {
      return spawn(appPath, [`--remote-debugging-port=${port}`, ...(launchArgs ?? [])], {
        stdio: 'ignore',
        detached: false,
      });
    } catch (err) {
      throw new CdpError('CDP_LAUNCH_FAILED', `启动应用失败：${appPath}`, err);
    }
  }

  /** 轮询 /json/version 直到调试端口就绪，超时报明确错误。 */
  private async waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.killChild();
    throw new CdpError(
      'CDP_PORT_TIMEOUT',
      `等待调试端口 ${port} 就绪超时（${timeoutMs}ms）`,
      lastErr,
    );
  }

  private async killChild(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }
}

/** 便捷入口：创建并连接一个适配器。 */
export async function connectCdp(opts: ConnectOptions = {}): Promise<PlaywrightCdpAdapter> {
  const adapter = new PlaywrightCdpAdapter();
  await adapter.connect(opts);
  return adapter;
}
