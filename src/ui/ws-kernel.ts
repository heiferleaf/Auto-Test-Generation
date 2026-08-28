// 真机桥（浏览器侧）：UiKernel 的 WebSocket 代理实现。
// 把每一个内核方法调用序列化为 RPC 发往 bridge-server（Node 侧持有 PlaywrightCdpAdapter），
// 收到结果后 resolve。UiShell 完全不感知这是远程调用（DIP：只依赖 UiKernel 接口）。
//
// 注意：浏览器无法运行 Node 的 Buffer；screenshot 结果在桥端转为 base64 字符串回传，
// 本端以 { __base64: string } 形式返回，调用方（演示）按字符串处理即可。

import type { UiKernel, PlaybackResult } from './shell';
import type { Script, Locator } from '../types/step';
import type { ConnectOptions, VisualRect, TargetInfo, SerializedNode } from '../cdp/adapter';
import type { InteractionEvent } from '../recorder/recorder';

type RpcReq = { id: number; method: string; args: unknown[] };
type RpcRes = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };
type WsEventMsg = { type: 'event'; event: string; data: unknown };

export class WsKernel implements UiKernel {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private ready: Promise<void>;

  constructor(private url: string) {
    this.ready = this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: Event) => reject(new Error(`WS 连接失败: ${(e as ErrorEvent).message}`));
      this.ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data as string);
          // 服务端主动推送事件（录制增量等）
          if (msg && msg.type === 'event') {
            const em = msg as WsEventMsg;
            const set = this.eventListeners.get(em.event);
            if (set) for (const cb of set) cb(em.data);
            return;
          }
          const res = msg as RpcRes;
          const p = this.pending.get(res.id);
          if (!p) return;
          this.pending.delete(res.id);
          if (res.ok) p.resolve(res.result);
          else p.reject(new Error(res.error));
        } catch {
          // 单条消息异常不应中断整个 WS 连接
        }
      };
    });
  }

  /** 订阅服务端主动推送的事件（如 'recording' 增量步骤、'step-progress' 运行进度）。 */
  on(event: string, cb: (data: unknown) => void): void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(cb);
  }

  /** 退订：一次性订阅（如单次运行的进度）必须在结束时退订，否则多次运行回调叠加。 */
  off(event: string, cb: (data: unknown) => void): void {
    this.eventListeners.get(event)?.delete(cb);
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.ready.then(() => new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req: RpcReq = { id, method, args };
      this.ws.send(JSON.stringify(req));
    }));
  }

  // ---- CdpAdapter ----
  // 同步方法（listTargets）在 WS 异步环境下用连接后的缓存满足接口签名。
  private targetsCache: TargetInfo[] = [];

  async connect(opts?: ConnectOptions): Promise<void> {
    await this.call('connect', opts);
    // 连接后立即拉取一次目标列表缓存（供同步 listTargets 返回）
    this.targetsCache = (await this.call<TargetInfo[]>('listTargets')) ?? [];
  }
  disconnect(): Promise<void> { return this.call('disconnect'); }
  listTargets(): TargetInfo[] { return this.targetsCache; }
  selectTarget(id: string): Promise<void> { return this.call('selectTarget', id); }
  click(loc: Locator): Promise<void> { return this.call('click', loc); }
  fill(loc: Locator, value: string): Promise<void> { return this.call('fill', loc, value); }
  select(loc: Locator, option: string): Promise<void> { return this.call('select', loc, option); }
  hover(loc: Locator): Promise<void> { return this.call('hover', loc); }
  wait(opts: { text?: string; durationMs?: number }): Promise<void> { return this.call('wait', opts); }
  eval(code: string): Promise<unknown> { return this.call('eval', code); }
  snapshot(): Promise<SerializedNode[]> { return this.call('snapshot'); }
  query(loc: Locator): Promise<unknown> { return this.call('query', loc); }
  // 不传 undefined 参数（JSON 会序列化成 null，让桥端的 selector 默认值失效）。
  pageText(selector?: string): Promise<string | null> {
    return this.call<string | null>('pageText', ...(selector === undefined ? [] : [selector]));
  }

  // ---- VisualCapable ----
  screenshot(opts?: unknown): Promise<Buffer> {
    // 桥端（Node）把 Buffer 序列化为 { __base64: string }；此处还原为 base64 字符串。
    // 浏览器无 Buffer，故以字符串伪装：shell.captureFrame 的 buf.toString('base64')
    // 作用在字符串上会返回字符串自身，从而正确构造 data:image/png;base64,...。
    // 不传 undefined 参数（JSON 会序列化为 null，使服务端默认参数失效）。
    const args = opts === undefined ? [] : [opts];
    return this.call<{ __base64: string }>('screenshot', ...args).then((r) =>
      (r?.__base64 ?? '') as unknown as Buffer,
    );
  }
  locateVisual(loc: Locator): Promise<VisualRect> { return this.call('locateVisual', loc); }

  // ---- Recordable ----
  startRecording(): Promise<void> { return this.call('startRecording'); }
  stopRecording(): Promise<InteractionEvent[]> { return this.call('stopRecording'); }

  // ---- Pickable（spec §2.3，可选；旧内核不实现时 UI 侧按钮禁用）----
  startPick(): Promise<void> { return this.call('startPick'); }
  cancelPick(): Promise<void> { return this.call('cancelPick'); }

  // ---- UiKernel.playback ----
  playback(script: Script, fromStepId?: string): Promise<PlaybackResult> {
    return this.call('playback', script, fromStepId);
  }
}
