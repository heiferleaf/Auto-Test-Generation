// CDP 适配层：基于 Playwright connectOverCDP 控制 Electron 应用。
// 设计依据：docs/设计文档.md §5；错误需带明确错误码，不静默崩溃（§8-5）。

import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import type { Locator } from '../types/step';
import {
  enumerateTargets,
  findTarget,
  mainTarget,
  resolveLocator,
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
};

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

/** 带错误码的适配层异常，便于上层区分处理（设计文档 §8-5）。 */
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

export class PlaywrightCdpAdapter implements CdpAdapter {
  private browser?: Browser;
  private child?: ChildProcess;
  private targets: TargetEntry[] = [];
  private current?: TargetEntry;

  async connect(opts: ConnectOptions = {}): Promise<void> {
    const port = opts.port ?? DEFAULT_CDP_PORT;

    if (opts.appPath) {
      this.child = this.launchApp(opts.appPath, port, opts.launchArgs);
      await this.waitForPort(port);
    }

    const endpoint = `http://localhost:${port}`;
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
    this.browser = undefined;
    this.targets = [];
    this.current = undefined;
    await this.killChild();
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
    this.targets = await enumerateTargets(browser);
    if (this.current && !findTarget(this.targets, this.current.info.id)) {
      this.current = mainTarget(this.targets);
    }
    return this.listTargets();
  }

  async click(loc: Locator): Promise<void> {
    await resolveLocator(this.scope(), loc).click();
  }

  async fill(loc: Locator, value: string): Promise<void> {
    await resolveLocator(this.scope(), loc).fill(value);
  }

  async select(loc: Locator, option: string): Promise<void> {
    await resolveLocator(this.scope(), loc).selectOption(option);
  }

  async hover(loc: Locator): Promise<void> {
    await resolveLocator(this.scope(), loc).hover();
  }

  async wait(opts: { text?: string; durationMs?: number }): Promise<void> {
    if (opts.text !== undefined) {
      const scope = this.scope();
      await scope.getByText(opts.text).first().waitFor({
        state: 'visible',
        ...(opts.durationMs !== undefined ? { timeout: opts.durationMs } : {}),
      });
      return;
    }
    if (opts.durationMs !== undefined) {
      await this.page().waitForTimeout(opts.durationMs);
      return;
    }
    throw new CdpError('CDP_WAIT_INVALID', 'wait 需提供 text 或 durationMs');
  }

  async eval(code: string): Promise<unknown> {
    // 以表达式求值语义执行，贴合 assertion 的 expr 用法。
    return this.scope().evaluate(`(() => (${code}))()`);
  }

  async snapshot(): Promise<SerializedNode[]> {
    return this.scope().evaluate(() => {
      const SELECTOR = 'a,button,input,select,textarea,[role],[data-testid],[onclick]';
      const out: Array<Record<string, unknown>> = [];
      for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
        const he = el as HTMLElement;
        const rect = he.getBoundingClientRect();
        out.push({
          role: he.getAttribute('role') ?? undefined,
          name:
            he.getAttribute('aria-label') ??
            he.getAttribute('name') ??
            undefined,
          text: (he.innerText ?? he.textContent ?? '').trim().slice(0, 200),
          tag: he.tagName.toLowerCase(),
          testId: he.getAttribute('data-testid') ?? undefined,
          enabled: !(he as HTMLButtonElement).disabled,
          visible: rect.width > 0 && rect.height > 0,
        });
      }
      return out;
    }) as Promise<SerializedNode[]>;
  }

  /** 返回首个匹配的 ElementHandle，未命中返回 null。 */
  async query(loc: Locator): Promise<unknown> {
    return resolveLocator(this.scope(), loc).first().elementHandle();
  }

  // ---- 内部辅助 ----

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new CdpError('CDP_NOT_CONNECTED', '尚未 connect()，无可用 CDP 连接');
    }
    return this.browser;
  }

  /** 当前操作作用域：webview 目标用其 frame，否则用 page。 */
  private scope(): Page | Frame {
    this.requireBrowser();
    const target = this.current ?? mainTarget(this.targets);
    if (!target) {
      throw new CdpError('CDP_NO_TARGET', '无当前目标，请先 connect()/selectTarget()');
    }
    return target.frame ?? target.page;
  }

  private page(): Page {
    this.requireBrowser();
    const target = this.current ?? mainTarget(this.targets);
    if (!target) {
      throw new CdpError('CDP_NO_TARGET', '无当前目标，请先 connect()/selectTarget()');
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
        const res = await fetch(`http://localhost:${port}/json/version`);
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
