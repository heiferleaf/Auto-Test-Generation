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
import { mergeRecordingEvent, emitRecordingEvent } from '../recorder/recorder';
import { RECORD_INJECT, RECORD_DRAIN, PICK_INJECT, PICK_DRAIN, PICK_STOP, REC_ACTIVE_ON, REC_ACTIVE_OFF, highlightPaintSource, HIGHLIGHT_CLEAR, sanitizeLocator } from '../recorder/inject';
import {
  enumerateTargets,
  findTarget,
  mainTarget,
  resolveLocator,
  locatorToSelector,
  clickOnPage,
  fillOnPage,
  type TargetEntry,
  type TargetInfo,
} from './targets.js';
import { WebviewCdpTarget } from './webview-session';
import { probeLiveCdpPort, parseCdpProbeList } from '../ui/cdp-port';
import { resolveHostJudge } from '../vision/host';

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
  /** CSS 视口宽（给预览 overlay 做 object-fit 映射）。 */
  viewportWidth?: number;
  /** CSS 视口高。 */
  viewportHeight?: number;
  devicePixelRatio?: number;
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
  /** 拍摄前在靶机上画出定位框，高亮成为 PNG 像素（舞台缩放不再映射坐标）。 */
  highlight?: Locator;
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

/**
 * 点选能力派生接口（ISP，spec §2.3）：仅"点选场景"的实现才需具备。
 * waitUntil/assert/选择组条件共用一套点选子模式，命中后回调一次性触发。
 * 旧内核可不实现，UI 侧点选按钮据此降级为禁用。
 */
export interface Pickable {
  /** 进入点选态：注入一次性监听，用户在靶机点击元素后回调 onPick 并自动停止。 */
  startPick(onPick: (locator: Locator) => void): void;
  /** 取消点选：移除监听，丢弃未命中的会话。 */
  cancelPick(): void;
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

export class PlaywrightCdpAdapter implements CdpAdapter, VisualCapable, Recordable, Pickable {
  private browser?: Browser;
  private child?: ChildProcess;
  private targets: TargetEntry[] = [];
  private current?: TargetEntry;
  private port = DEFAULT_CDP_PORT;
  private lastSuccessfulPort?: number;

  // M3 录制：累积当前 target 捕获的交互事件（仅在 startRecording 后生效）。
  private recording = false;
  private recorded: InteractionEvent[] = [];
  /** 录制实时回调（边操作边长步骤）：startRecording 传入，stop 时置空。 */
  private recordingListener: ((e: InteractionEvent) => void) | null = null;
  /** 增量 drain 定时器句柄。 */
  private recordingTimer: number | null = null;
  /** 浏览器级 CDP 会话（监听 Target.targetCreated，捕捉录制中途动态新增的 webview）。 */
  private recordBrowserWs?: WebSocket;
  /** 本轮录制已注入监听器的 target id 集合，避免重复注入。 */
  private injectedTargets = new Set<string>();

  async connect(opts?: ConnectOptions): Promise<void> {
    // WS 边界：opts 可能是 null；已连接时 playback/runCli 会再调 connect() 且不带 port，
    // 不得回落到默认 9222 把用户刚连上的活口冲掉。
    const o = opts ?? {};
    const port = o.port ?? (this.browser ? this.port : DEFAULT_CDP_PORT);
    if (this.browser && !o.appPath && port === this.port) {
      // 已连同一端口：runCli/playback 会再调 connect() 且不带 port。
      // 录制过程中 refreshTargets 可能把 current 冲掉，这里补回主目标，避免回放 CDP_NO_TARGET。
      if (!this.current) {
        await this.refreshTargets();
        this.current = mainTarget(this.targets);
      }
      return;
    }
    this.port = port;

    if (o.appPath) {
      this.child = this.launchApp(o.appPath, port, o.launchArgs);
      await this.waitForPort(port);
    }

    const endpoint = `http://127.0.0.1:${port}`;
    try {
      this.browser = await chromium.connectOverCDP(endpoint);
    } catch (err) {
      const extra = parseCdpProbeList(process.env.CDP_PROBE_PORTS);
      const live = await probeLiveCdpPort({
        skip: port,
        preferred: port,
        lastSuccessful: this.lastSuccessfulPort,
        extra,
      });
      if (live !== undefined) {
        this.port = live;
        try {
          this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${live}`);
        } catch (err2) {
          await this.killChild();
          throw new CdpError(
            'CDP_CONNECT_FAILED',
            `无法连接 ${endpoint}，自动探测到 ${live} 也无法 connectOverCDP`,
            err2,
          );
        }
      } else {
        await this.killChild();
        throw new CdpError(
          'CDP_CONNECT_FAILED',
          `无法连接 ${endpoint}；已探测本机调试端口号段与 CDP_PROBE_PORTS 的 /json，均无 DevTools`,
          err,
        );
      }
    }

    await this.refreshTargets();
    this.current = mainTarget(this.targets);
    if (!this.current) {
      throw new CdpError('CDP_NO_TARGET', `连接成功但未发现任何 page/webview 目标（${endpoint}）`);
    }
    this.lastSuccessfulPort = this.port;
  }

  async disconnect(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // 关闭失败不应掩盖主流程结果。
    }
    this.recording = false;
    this.recorded = [];
    this.stopTargetWatch();
    this.cancelPick();
    for (const t of this.targets) t.target.dispose?.();
    this.browser = undefined;
    this.targets = [];
    this.current = undefined;
    await this.killChild();
  }

  /**
   * 回放能力（UiKernel.playback）：编排 runCli 按脚本驱动本适配器。
   * UI 壳只调用此方法，不直接依赖执行器/playwright 链（DIP）。
   */
  async playback(
    script: Script,
    onStep?: import('../executor/executor').StepProgress,
    fromStepId?: string,
  ): Promise<{ ok: boolean; failedStepId?: string }> {
    // onStep 仅在同进程内调用（bridge-server 传入以转推给浏览器端）；
    // 跨 WS 的 WsKernel 不传此参数——函数不可序列化，详见 CODEBUDDY.md §4.1。
    // ctx 同理只在服务端进程内构造：apikey 从不出服务端，更不会进 Script JSON。
    return runCli({ adapter: this, script, onStep, fromStepId, ctx: { judge: resolveHostJudge() } });
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
    const entry = this.current ?? mainTarget(this.targets);
    if (!entry) {
      throw new CdpError('CDP_NO_TARGET', '无当前目标，请先 connect()/selectTarget()');
    }
    // 主窗口：Playwright 真实指针。许多 Electron 壳只认鼠标，DOM e.click() 会「调用成功、界面不动」。
    if (entry.page) {
      await clickOnPage(entry.page, loc);
      return;
    }
    const sel = locatorToSelector(loc);
    const box = await this.currentTarget().evaluate<{ x: number; y: number } | null>(
      `(() => { const e = ${this.queryExpr(sel)}; if(!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    ).catch(() => null);
    if (box && entry.target instanceof WebviewCdpTarget) {
      await entry.target.mouseClick(box.x, box.y);
      return;
    }
    await this.currentTarget().evaluate(
      `(() => { const e = ${this.queryExpr(sel)}; if(!e) throw new Error('CLICK: 未找到元素'); e.click(); })()`,
    );
  }

  async fill(loc: Locator, value: string): Promise<void> {
    const entry = this.current ?? mainTarget(this.targets);
    if (entry?.page) {
      await fillOnPage(entry.page, loc, value);
      return;
    }
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
    const entry = this.current ?? mainTarget(this.targets);
    if (entry?.page) {
      try {
        if (await resolveLocator(entry.page, loc).count() > 0) return { hit: true };
      } catch { /* 字段不全时 resolveLocator 会抛，改走文本 */ }
      const text = loc.text ?? loc.name;
      if (text) {
        try {
          if (await entry.page.getByText(text, { exact: false }).count() > 0) return { hit: true };
        } catch { /* ignore */ }
      }
    }
    const sel = locatorToSelector(loc);
    const found = await this.currentTarget().evaluate<boolean>(
      `(() => !!${this.queryExpr(sel)})()`,
    );
    return found ? { selector: this.selectorString(sel) } : null;
  }

  /**
   * M3 录制：对所有已枚举 target（主 page + 每个 webview）注入交互监听器。
   * 与顶栏「当前窗口」下拉无关：用户不必先切下拉再去软件里点。
   * 事件累积在各自的 window.__recBuf，drain 时带上该 target id 写入步骤。
   * 同时开启浏览器级 Target 监听，录制中途动态新增的 webview 也会被自动注入。
   * @param onEvent 可选实时回调：录制中每捕获一个增量事件即调用（支撑"边操作边长步骤"）。
   */
  startRecording(onEvent?: (e: InteractionEvent) => void): void {
    // 先清理可能残留的监听 ws（防止连续两次 startRecording 未 stop 时句柄泄漏）。
    this.stopTargetWatch();
    this.recording = true;
    this.recorded = [];
    this.injectedTargets.clear();
    this.recordingListener = onEvent ?? null;
    this.recordingTimer = null;
    // 会话开始：先排空所有 target 的残留缓冲（监听器常驻，跨会话可能已累积），
    // 再注入录制脚本。后续 refreshTargets 触发的重复注入只注入不排空，避免清掉已捕获事件。
    for (const t of this.targets) {
      void t.target.evaluate(RECORD_DRAIN).catch(() => undefined);
    }
    this.injectRecorderIntoTargets();
    for (const t of this.targets) {
      void t.target.evaluate(REC_ACTIVE_ON).catch(() => undefined);
    }
    // 再开启动态监听：中途新开的 webview 也能被录到。
    this.startTargetWatch();
    // 实时增量轮询：周期性 drain 各 target 缓冲，把新增事件通过 onEvent 推给订阅者。
    // 同时重试尚未注入成功的 webview（聊天面板 iframe 常比 startRecording 更晚才有 UI context）。
    if (this.recordingListener) {
      this.recordingTimer = setInterval(() => {
        this.injectRecorderIntoTargets();
        void this.drainIncremental();
      }, 250) as unknown as number;
    }
  }

  /** 增量取回：drain 每个 target 缓冲，新增事件追加到 recorded 并推给 onEvent。 */
  private async drainIncremental(): Promise<void> {
    if (!this.recording || !this.recordingListener) return;
    for (const t of this.targets) {
      const buf = await t.target.evaluate<any[]>(RECORD_DRAIN).catch(() => []);
      if (!Array.isArray(buf)) continue;
      for (const e of buf) {
        const ev: InteractionEvent = { ...(e as InteractionEvent), target: t.info.id };
        // 跨 250ms drain 窗口合并同一输入框的 fill（spec §2.2.2）。
        const prevLast = this.recorded[this.recorded.length - 1];
        const prevLen = this.recorded.length;
        this.recorded = mergeRecordingEvent(this.recorded, ev);
        if (this.recorded.length === prevLen && this.recorded[this.recorded.length - 1] === prevLast) {
          continue;
        }
        const last = this.recorded[this.recorded.length - 1];
        emitRecordingEvent(this.recordingListener, last);
      }
    }
  }

  /** M3 录制：停止监听并异步取回所有 target 累积的 InteractionEvent[]（按 target 标注）。 */
  async stopRecording(): Promise<InteractionEvent[]> {
    this.recording = false;
    this.stopTargetWatch();
    if (this.recordingTimer !== null) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    this.recordingListener = null;
    for (const t of this.targets) {
      void t.target.evaluate(REC_ACTIVE_OFF).catch(() => undefined);
    }
    const out: InteractionEvent[] = [];
    for (const t of this.targets) {
      const buf = await t.target.evaluate<any[]>(RECORD_DRAIN).catch(() => []);
      if (Array.isArray(buf)) {
        for (const e of buf) out.push({
          ...(e as InteractionEvent),
          target: t.info.id,
          locator: sanitizeLocator((e as InteractionEvent).locator) ?? (e as InteractionEvent).locator,
        });
      }
    }
    this.recorded = out;
    return out;
  }

  // ---- 点选（spec §2.3）----
  /** 点选态：一次性会话，命中即停。与录制会话互斥（UI 侧保证不并发）。 */
  private picking = false;
  private pickListener: ((locator: Locator) => void) | null = null;
  private pickTimer: number | null = null;
  /** 本轮点选已注入的 target id，失败不写入，轮询里重试（WEBVIEW_NO_CONTEXT）。 */
  private pickInjected = new Set<string>();

  /**
   * 进入点选态：向**全部**已枚举 target 注入一次性 click 监听，命中后构造完整 locator。
   * 不必先在工作台切「当前窗口」再去软件里点；哪个窗口收到点击就用哪个。
   * 手动 snapshot() 仍看当前下拉（多 webview 点选快照才需要切窗口）。
   */
  startPick(onPick: (locator: Locator) => void): void {
    this.cancelPick();
    this.picking = true;
    this.pickListener = onPick;
    this.pickInjected.clear();
    for (const t of this.targets) {
      void t.target.evaluate(PICK_INJECT)
        .then(() => { this.pickInjected.add(t.info.id); })
        .catch(() => undefined);
    }
    this.pickTimer = setInterval(() => {
      if (!this.picking) return;
      for (const t of this.targets) {
        if (!this.pickInjected.has(t.info.id)) {
          void t.target.evaluate(PICK_INJECT)
            .then(() => { this.pickInjected.add(t.info.id); })
            .catch(() => undefined);
        }
        void t.target
          .evaluate<any>(PICK_DRAIN)
          .catch(() => null)
          .then((r) => {
            if (!this.picking || !r) return;
            this.picking = false;
            this.stopPickTimer();
            const loc = sanitizePickLocator(r);
            this.pickListener?.(loc);
            this.pickListener = null;
          });
      }
    }, 200) as unknown as number;
  }

  /** 取消点选：移除监听、清缓冲、停轮询。已回调的会话不受影响（picking 已 false）。 */
  cancelPick(): void {
    this.picking = false;
    this.stopPickTimer();
    this.pickListener = null;
    this.pickInjected.clear();
    for (const t of this.targets) {
      void t.target.evaluate(PICK_STOP).catch(() => undefined);
    }
  }

  private stopPickTimer(): void {
    if (this.pickTimer !== null) {
      clearInterval(this.pickTimer);
      this.pickTimer = null;
    }
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
      void t.target.evaluate(RECORD_INJECT)
        .then(() => {
          this.injectedTargets.add(t.info.id);
        })
        .catch((err) => {
          // 失败不得写入 injectedTargets：VS Code 右侧聊天常是 iframe webview，
          // 第一次 evaluate 会 WEBVIEW_NO_CONTEXT，250ms 后再试才能装上监听。
          console.warn('[adapter] 录制注入失败', t.info.id, err instanceof Error ? err.message : err);
        });
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
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    // 注意：经 WS 桥调用时，undefined 参数会被 JSON 序列化为 null，导致默认参数 = {} 失效。
    // 故不能用默认参数，而要在函数体内兜底（opts 可能为 null/undefined）。
    const o = opts ?? {};
    let buf: Buffer;
    const paintTarget = o.target
      ? (findTarget(this.targets, o.target)?.target ?? this.currentTarget())
      : this.currentTarget();
    if (o.highlight) {
      await paintTarget.evaluate(highlightPaintSource(o.highlight)).catch(() => false);
    }
    try {
    let scope: Page;
    try {
      scope = this.scopeFor(o.target) as Page;
    } catch {
      scope = this.page();
    }
    if (o.element) {
      const handle = resolveLocator(scope, o.element).first();
      try {
        buf = (await handle.screenshot()) as Buffer;
      } catch (err) {
        throw new CdpError('CDP_SCREENSHOT_ELEMENT', '元素截图失败（可能不可见或不在 DOM）', err);
      }
    } else {
      try {
        buf = (await scope.screenshot(o.fullPage ? { fullPage: true } : {})) as Buffer;
      } catch (err) {
        throw new CdpError('CDP_SCREENSHOT_FAILED', '整窗/视口截图失败', err);
      }
    }

    // 落盘（可选）：让截图可被人工打开验证（test/reports/ 已被 gitignore）。
    if (o.savePath) {
      const dir = dirname(o.savePath);
      if (dir) mkdirSync(dir, { recursive: true });
      writeFileSync(o.savePath, buf);
    }
    return buf;
    } finally {
      if (o.highlight) {
        await paintTarget.evaluate(HIGHLIGHT_CLEAR).catch(() => undefined);
      }
    }
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
      .evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      }))
      .catch(() => ({ w: 0, h: 0, dpr: 1 }));
    const inViewport =
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= vp.w &&
      box.y + box.height <= vp.h;
    const visible = box.width > 0 && box.height > 0;
    return {
      x: box.x, y: box.y, width: box.width, height: box.height,
      visible, inViewport,
      viewportWidth: vp.w, viewportHeight: vp.h, devicePixelRatio: vp.dpr,
    };
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

/** 跨 CDP/JSON 边界兜底：页面内构造的 locator 经 JSON 序列化后 undefined 字段被丢弃，但 null 不会；
 *  把 null 字段还原为 undefined，避免下游 `loc.name ?? ''` 之类兜底失效（§4.1）。 */
function sanitizePickLocator(loc: unknown): Locator {
  const l = (loc ?? {}) as Record<string, unknown>;
  const out: Locator = {};
  if (l.role) out.role = String(l.role);
  if (l.name) out.name = String(l.name);
  if (l.text) out.text = String(l.text);
  if (l.testId) out.testId = String(l.testId);
  if (l.css) out.css = String(l.css);
  if (l.xpath) out.xpath = String(l.xpath);
  return sanitizeLocator(out) ?? out;
}

/** 便捷入口：创建并连接一个适配器。 */
export async function connectCdp(opts: ConnectOptions = {}): Promise<PlaywrightCdpAdapter> {
  const adapter = new PlaywrightCdpAdapter();
  await adapter.connect(opts);
  return adapter;
}
