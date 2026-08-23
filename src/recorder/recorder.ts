// 录制采集器内核（M3 可视化 UI 编辑壳的内置能力之一）。
// 设计：内核只认抽象的 InteractionEvent，不依赖具体 CDP/Playwright 事件源（DIP）。
// 真实事件 → InteractionEvent 的适配（监听 Runtime/DOM/Input）留作 M3 集成层。
//
// 依据：docs/plan/plan.md §M3（高内聚组件：录制是功能之一）。

import type { Script, Step, StepType, Locator, StepSource } from '../types/step';
import { SCRIPT_SCHEMA } from '../types/step';

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
    if (ev.locator) step.locator = ev.locator;
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
