// 录制采集器内核（M3 可视化 UI 编辑壳的内置能力之一）。
// 设计：内核只认抽象的 InteractionEvent，不依赖具体 CDP/Playwright 事件源（DIP）。
// 真实事件 → InteractionEvent 的适配（监听 Runtime/DOM/Input）留作 M3 集成层。
//
// 依据：docs/plan/plan.md §M3（高内聚组件：录制是功能之一）。

import type { Script, Step, StepType, Locator, StepSource } from '../types/step';
import { SCRIPT_SCHEMA } from '../types/step';
import { isNonActionableName, isNonActionableRole, sanitizeLocator } from './inject';

/** 一次被捕获的用户交互（抽象，与具体事件源解耦）。 */
export type InteractionEvent = {
  type: StepType;
  /** 触发交互时的目标窗口/webview 标识；缺省=主目标。 */
  target?: string;
  locator?: Locator;
  params?: {
    value?: string;
    optionText?: string;
    durationMs?: number;
    key?: string;
    code?: string;
  };
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `rec-${Date.now().toString(36)}-${seq}`;
}

/**
 * Recorder：累积交互事件，构建为可执行的 Script。
 * 语义化 locator 优先（role/name/text/testId），css/xpath 仅作降级（OCP：扩展新事件不改此处）。
 */
export class Recorder {
  private events: InteractionEvent[] = [];
  private source: StepSource = 'recorded';

  /** 喂入一次交互事件（来自适配层）。 */
  record(ev: InteractionEvent): void {
    this.events.push(ev);
  }

  /** 清空已累积事件（重新开始录制）。 */
  reset(): void {
    this.events = [];
  }

  /** 当前已捕获的步骤数。 */
  get size(): number {
    return this.events.length;
  }

  /** 将累积事件转为 Step[]（不依赖 target 软件的纯逻辑）。 */
  toSteps(): Step[] {
    return this.events.map((ev) => this.toSingleStep(ev));
  }

  /** 将单个交互事件转为 Step（实时录制增量生成，避免全量重建）。 */
  toSingleStep(ev: InteractionEvent): Step {
    const step: Step = {
      id: nextId(),
      type: ev.type,
      source: this.source,
    };
    if (ev.target !== undefined) step.target = ev.target;
    if (ev.locator) step.locator = sanitizeLocator(ev.locator);
    if (ev.params) {
      step.params = { ...ev.params };
    }
    // assert 类型需带 assertion（录制即断言场景），与是否有 params 无关。
    if (ev.type === 'assert') {
      step.params = { ...step.params, assertion: { kind: 'exists', locator: ev.locator } };
    }
    return step;
  }

  /** 构建完整 Script（含 app 元信息）。 */
  buildScript(app: { name: string; version?: string }, note?: string): Script {
    return {
      schema: SCRIPT_SCHEMA,
      app,
      steps: this.toSteps(),
      createdAt: new Date().toISOString(),
      note,
    };
  }
}

/** 两 locator 是否视为同一输入框（跨 drain 窗口合并 fill 用）。 */
export function sameFillLocator(a?: Locator, b?: Locator): boolean {
  if (!a || !b) return false;
  const nameOf = (l: Locator) => (isNonActionableName(l.name) ? null : (l.name ?? null));
  return nameOf(a) === nameOf(b)
    && (a.testId ?? null) === (b.testId ?? null)
    && (a.css ?? null) === (b.css ?? null)
    && (a.xpath ?? null) === (b.xpath ?? null);
}

/** 空 fill、装饰 role 点击不进脚本（宿主侧兜底，注入层已过滤一轮）。 */
export function shouldKeepRecordingEvent(ev: InteractionEvent): boolean {
  if (ev.type === 'fill') {
    const v = ev.params?.value;
    if (typeof v !== 'string' || v.trim().length === 0) return false;
    if (v === '__ATG_EMPTY_FILL__') return false;
    return true;
  }
  if (ev.type === 'click' || ev.type === 'hover' || ev.type === 'select') {
    const role = ev.locator?.role;
    if (isNonActionableRole(role)) return false;
    const r = (role || '').toLowerCase();
    if (r === 'generic' && !ev.locator?.name && !ev.locator?.testId && !ev.locator?.css) return false;
  }
  return true;
}

/**
 * 把新事件并入已推送列表（spec §2.2.2）：同一输入框的连续 fill 就地改 value，
 * 不追加。页面内 250ms 缓冲不够，drain 跨窗口仍必须在这一层合并。
 * 空 fill / presentation 点击直接丢弃（返回原数组同一引用，调用方据此跳过 emit）。
 */
export function mergeRecordingEvent(prev: InteractionEvent[], ev: InteractionEvent): InteractionEvent[] {
  if (!shouldKeepRecordingEvent(ev)) return prev;
  const next: InteractionEvent = ev.locator
    ? { ...ev, locator: sanitizeLocator(ev.locator) }
    : ev;
  if (!shouldKeepRecordingEvent(next)) return prev;
  const last = prev[prev.length - 1];
  if (next.type === 'fill' && last?.type === 'fill' && sameFillLocator(last.locator, next.locator)) {
    const copy = prev.slice();
    copy[copy.length - 1] = { ...last, params: { ...last.params, ...next.params } };
    return copy;
  }
  return [...prev, next];
}

/**
 * 增量 drain 是 async 的：await 回来时 stopRecording 可能已把 listener 置成 null。
 * 直接 `listener(ev)` 会 TypeError 把整个 UI Node 进程打崩。
 */
export function emitRecordingEvent(
  listener: ((e: InteractionEvent) => void) | null | undefined,
  event: InteractionEvent,
): void {
  if (typeof listener === 'function') listener(event);
}
