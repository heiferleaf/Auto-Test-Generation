// 真机桥（Node 侧）：WebSocket server + 持有 PlaywrightCdpAdapter。
// 浏览器页面无法直接运行 PlaywrightCdpAdapter（依赖 Node 原生模块），
// 故由本 Node 进程持有真机 adapter，页面通过 WS 把 UiKernel 调用转交此处执行并回传结果。
//
// 这是 M3「UI 壳真实录制 CODEBUDDY」的关键桥接层（DIP：页面只认 UiKernel 接口，
// 真机能力由桥内的 PlaywrightCdpAdapter 提供）。

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { PlaywrightCdpAdapter } from '../cdp/adapter';
import type { CdpAdapter, VisualRect } from '../cdp/adapter';
import type { StepProgress } from '../executor/executor';
import type { UiKernel } from './shell';
import type { Script, Locator } from '../types/step';
import { STEP_TYPES, CONTROL_KINDS } from '../types/step';

type RpcReq = { id: number; method: keyof UiKernel; args: unknown[] };
type RpcRes = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };
/** 服务端主动推送消息（非请求/响应），用于录制增量事件、运行进度等。 */
type WsEvent = { type: 'event'; event: string; data: unknown };

/** 把结果中的 Node Buffer 递归转为 base64 字符串（跨 WS 序列化安全）。 */
export function serializeBuffers(v: unknown): unknown {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return { __base64: v.toString('base64') };
  if (Array.isArray(v)) return v.map(serializeBuffers);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = serializeBuffers(val);
    }
    return out;
  }
  return v;
}

/** WS 边界兜底：JSON.stringify 把 undefined 元素变 null，服务端默认参数对 null 不生效，
 * 会导致 null.target 等崩溃（CODEBUDDY.md §4.1 血泪教训）。此处把 null 还原为 undefined，
 * 让各方法体内 `x ?? {}` 兜底生效。 */
export function sanitizeArgs(args: unknown[]): unknown[] {
  return (args ?? []).map((a) => (a === null ? undefined : a));
}

// 校验用集合从 types/step.ts 的运行时常量派生（单一真相源）：
// 新增 StepType / ControlKind 时只改 types/step.ts 一处，此处自动跟随，不会漂移。
const STEP_TYPE_SET: ReadonlySet<string> = new Set<string>(STEP_TYPES);
const CONTROL_KIND_SET: ReadonlySet<string> = new Set<string>(CONTROL_KINDS);

const describeValue = (v: unknown): string =>
  v === null ? 'null' : v === undefined ? 'undefined' : typeof v;

/**
 * 递归校验单个步骤节点。`path` 形如 `steps[1].children[0]`，用于把错误定位到具体坏数据。
 *
 * 为何要递归到 children：`steps:[null]` 与 `children:[null]` 是**同源缺陷** ——
 * 执行器 runNode 递归调度 children 时同样读 `child.control`，
 * 只补顶层等于治症不治因（可运行性审查第 3→4 轮正是被这一层复发打回）。
 */
function assertStepNode(node: unknown, path: string): void {
  if (node == null || typeof node !== 'object') {
    throw new Error(`playback 的 script.${path} 不是合法 step 对象（实际: ${describeValue(node)}）`);
  }
  const s = node as Record<string, unknown>;

  // id 必须是字符串：进度事件以 stepId 为键回传给 UI，非字符串会让 UI 匹配不到步骤，
  // 表现为"运行了但状态不更新"，同属静默失效。
  if (typeof s.id !== 'string' || s.id === '') {
    throw new Error(`playback 的 script.${path}.id 必须是非空字符串（实际: ${describeValue(s.id)}）`);
  }

  // type 必须在已知集合内：未知 type 会一路流到 invokeAction 才崩在动作分发层。
  if (typeof s.type !== 'string' || !STEP_TYPE_SET.has(s.type)) {
    throw new Error(
      `playback 的 script.${path}.type 不是已知步骤类型（实际: ${String(s.type)}）；` +
      `合法值: ${STEP_TYPES.join('/')}`,
    );
  }

  // control 可省略（叶子步骤）；给了就必须是合法控制结构。
  // 未知 kind 会被 runNode 的 switch 静默跳过 —— 步骤"看起来通过了"其实没执行，比崩溃更危险。
  if (s.control !== undefined) {
    const ctrl = s.control;
    if (ctrl === null || typeof ctrl !== 'object') {
      throw new Error(
        `playback 的 script.${path}.control 必须是对象（实际: ${describeValue(ctrl)}）`,
      );
    }
    const kind = (ctrl as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !CONTROL_KIND_SET.has(kind)) {
      throw new Error(
        `playback 的 script.${path}.control.kind 不是已知控制流类型（实际: ${String(kind)}）；` +
        `合法值: ${CONTROL_KINDS.join('/')}`,
      );
    }
  }

  // children 可省略；给了就必须是数组，且每个元素递归合法。
  if (s.children !== undefined) {
    if (!Array.isArray(s.children)) {
      throw new Error(
        `playback 的 script.${path}.children 必须是数组（实际: ${describeValue(s.children)}）`,
      );
    }
    for (let j = 0; j < s.children.length; j++) {
      assertStepNode(s.children[j], `${path}.children[${j}]`);
    }
  }
}

/**
 * 校验跨 WS 送来的 script 可被执行（§4.1 清单 1）。
 *
 * 不加此校验时：`adapter.playback(null)` → `runScript` 读 `null.steps` 抛 TypeError
 * → 被 `runCli` catch 吞成 `{ ok:false, failedStepId:undefined }`
 * → UI 弹"运行中断于步骤:(未知)"，问题被静默掩盖、无从排查。
 * 故在桥边界（不可信 JSON 的唯一入口）一次性递归收口，并回带路径的明确错误。
 */
export function assertRunnableScript(v: unknown): Script {
  if (v == null || typeof v !== 'object') {
    throw new Error(`playback 需要 script 对象，实际收到: ${describeValue(v)}`);
  }
  const steps = (v as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) {
    throw new Error('playback 的 script.steps 必须是数组');
  }
  for (let i = 0; i < steps.length; i++) {
    assertStepNode(steps[i], `steps[${i}]`);
  }
  return v as Script;
}

/** 桥端所需的 adapter 能力（DIP：桥只依赖此抽象，不绑定 Playwright 实现）。 */
export type BridgeAdapter = CdpAdapter & {
  screenshot(opts?: unknown): Promise<Buffer>;
  locateVisual(loc: Locator): Promise<VisualRect>;
  startRecording(onEvent?: (ev: unknown) => void): void;
  stopRecording(): Promise<unknown[]>;
  startPick(onPick: (locator: Locator) => void): void;
  cancelPick(): void;
  playback(script: Script, onStep?: StepProgress): Promise<{ ok: boolean; failedStepId?: string }>;
};

/**
 * 在已有 http server 上升级出 /kernel-ws 端点，桥接真机 adapter。
 *
 * @param adapter 可选注入（DIP）。缺省构造 `PlaywrightCdpAdapter`，生产调用方
 *   （`src/ui/serve.ts`）无需改动。开放此参数是为了让「真实 WS 线路」可被测试覆盖 ——
 *   此前桥内部直接 `new PlaywrightCdpAdapter()`，导致 WS 线路必须有 9222 靶机才能测，
 *   于是 `step-progress` 跨 WS 传输这段（恰是 CODEBUDDY.md §4.1 的出事点）长期无测试。
 *   不可测本身即是设计缺陷，故在此收口。
 */
export function attachKernelBridge(
  server: import('node:http').Server,
  port = 9222,
  // 直接赋值（不用 as unknown as 强转）：若将来 BridgeAdapter 收窄而
  // PlaywrightCdpAdapter 未跟上，此处会**编译期报错**，而非被强转静默掩盖。
  adapter: BridgeAdapter = new PlaywrightCdpAdapter(),
): { close: () => Promise<void> } {
  let connected = false;
  const clients = new Set<WebSocket>();

  const wss = new WebSocketServer({ noServer: true });

  /** 向所有已连接客户端广播服务端事件（录制增量 / 运行进度）。 */
  const pushEvent = (event: string, data: unknown) => {
    const msg: WsEvent = { type: 'event', event, data };
    const payload = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  };

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url === '/kernel-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('error', () => { /* 单连接错误不应影响 server 进程 */ });
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw: Buffer) => {
      let req: RpcReq;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const send = (r: RpcRes) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(r));
      };
      try {
        const method = req.method;
        // connect 需真连；其余直接转发到 adapter 实例。
        if (method === 'connect') {
          const opts = (req.args[0] as { port?: number }) ?? {};
          await adapter.connect({ ...opts, port: opts.port ?? port });
          connected = true;
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'disconnect') {
          await adapter.disconnect();
          connected = false;
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'startRecording') {
          // 注册实时回调：录制中每捕获一个交互即广播给所有客户端（边操作边长步骤）。
          adapter.startRecording((ev) => pushEvent('recording', ev));
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'startPick') {
          // 点选子模式（spec §2.3）：命中后把完整 locator 经 'pick' 事件推给浏览器端，
          // 由 UiShell 写回当前编辑步骤的 assertion.locator / control.condition.locator。
          adapter.startPick((locator) => pushEvent('pick', { locator }));
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'cancelPick') {
          adapter.cancelPick();
          send({ id: req.id, ok: true, result: undefined });
          return;
        }
        if (method === 'playback') {
          // 运行全部（R3）：函数不可跨 WS 传递，故在桥端注册进度回调，
          // 用 R1 的单向推送通道把每步 running/pass/fail 下发给浏览器端。
          // 必须走专门分支（同 startRecording），不能落到下方通用 fn.apply。
          // 边界校验：null/undefined/缺 steps 直接回明确错误，
          // 不让它流到 runScript 里变成 "failedStepId:undefined" 的静默误提示。
          const script = assertRunnableScript(sanitizeArgs(req.args as unknown[])[0]);
          const res = await adapter.playback(script, (stepId, status) =>
            pushEvent('step-progress', { stepId, status }),
          );
          send({ id: req.id, ok: true, result: res });
          return;
        }
        const fn = (adapter as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        if (typeof fn !== 'function') {
          send({ id: req.id, ok: false, error: `未知方法: ${String(method)}` });
          return;
        }
        let result: unknown;
        try {
          // WS 边界兜底：null 入参还原为 undefined，避免服务端默认参数失效（§4.1）。
          result = await fn.apply(adapter, sanitizeArgs(req.args as unknown[]));
        } catch (err) {
          send({ id: req.id, ok: false, error: (err as Error).message });
          return;
        }
        // 跨进程序列化：Node Buffer 经 JSON.stringify 会变成 {type:'Buffer',data:[...]}，
        // 浏览器无法解码为 PNG。故在桥端（Node 侧）把 Buffer 转 base64 字符串，
        // ws-kernel 端再还原为浏览器可用的 base64，供截图流渲染。
        send({ id: req.id, ok: true, result: serializeBuffers(result) });
      } catch (err) {
        send({ id: req.id, ok: false, error: (err as Error).message });
      }
    });
  });

  return {
    close: () => new Promise<void>((resolve) => {
      wss.close(() => resolve());
    }),
  };
}

export type { Locator, Script };
