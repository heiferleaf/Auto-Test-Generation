// 可视化蒙版 UI 壳（M3.3）：控制台样式面板的内核编排层。
//
// 职责边界（SRP）：
//  - 本文件只做「UI 状态管理 + 内核编排 + DOM 渲染」，不实现任何 CDP/录制/执行细节。
//  - 所有内核能力通过构造注入（CdpAdapter & VisualCapable & Recordable & Player），满足 DIP：
//    单测可注入 MockKernel，真机注入 PlaywrightCdpAdapter；浏览器演示可注入 DemoKernel。
//  - 关键解耦：UI 壳不 import 执行器/playwright 链（否则浏览器无法加载本模块）。
//    回放交由内核的 playback() 能力，UI 壳只负责编排与结果展示。
//
// 设计依据：docs/plan/plan.md §M3.3；docs/test/visual-overlay-ui.md（UI 规格）。

import type { CdpAdapter, VisualCapable, Recordable, ConnectOptions, Locator, VisualRect } from '../cdp/adapter';
import type { Script, Step, StepType } from '../types/step';
import { Recorder } from '../recorder/recorder';
import { ScriptEditor } from '../editor/editor';
import { SCRIPT_SCHEMA } from '../types/step';

/** 回放结果（与 cli.CliResult 同构，但由内核产生，UI 壳不依赖 cli 模块）。 */
export type PlaybackResult = { ok: boolean; failedStepId?: string };

/** UI 壳所需的完整内核能力（抽象接口并集）。 */
export type UiKernel = CdpAdapter & VisualCapable & Recordable & {
  /** 按脚本回放（内核职责：真机驱动 adapter / 演示返回假结果）。 */
  playback(script: Script): Promise<PlaybackResult>;
};

export type UiShellOptions = {
  kernel: UiKernel;
  /** 挂载根节点（测试可注入 detached div，宿主可注入页面 #app）。 */
  mount: HTMLElement;
  /** 初始脚本（可选，如从文件载入）。 */
  script?: Script;
};

/** step.type → 用户友好动词（展示关注点，与内核语义中立解耦）。 */
const TYPE_LABEL: Record<StepType, string> = {
  click: '点击',
  fill: '填写',
  select: '选择',
  wait: '等待',
  assert: '断言',
  hover: '悬停',
  eval: '执行',
  snapshot: '快照',
};

/** 把 locator 转成人类可读的简短描述。 */
function describeLocator(loc?: Locator): string {
  if (!loc) return '';
  if (loc.name) return `"${loc.name}"`;
  if (loc.text) return `文本"${loc.text}"`;
  if (loc.testId) return `[data-testid=${loc.testId}]`;
  if (loc.role) return `<${loc.role}>`;
  if (loc.css) return loc.css;
  if (loc.xpath) return loc.xpath;
  return '';
}

/** 把一条 step 转成用户友好的单行描述。 */
function describeStep(step: Step): string {
  const verb = TYPE_LABEL[step.type] ?? step.type;
  const target = step.target ? ` @${step.target}` : '';
  const loc = describeLocator(step.locator);
  const param =
    step.params?.value !== undefined ? ` → "${step.params.value}"`
    : step.params?.optionText !== undefined ? ` → "${step.params.optionText}"`
    : step.params?.durationMs !== undefined ? ` ${step.params.durationMs}ms`
    : '';
  return `${verb} ${loc}${param}${target}`.trim();
}

export class UiShell {
  private kernel: UiKernel;
  private mount: HTMLElement;
  private script: Script;
  private connected = false;
  private recording = false;
  private recorder = new Recorder();

  constructor(opts: UiShellOptions) {
    this.kernel = opts.kernel;
    this.mount = opts.mount;
    this.script = opts.script ?? {
      schema: SCRIPT_SCHEMA,
      app: { name: 'Unnamed', version: '0.0.0' },
      steps: [],
    };
  }

  // ---- 状态查询 ----

  isConnected(): boolean { return this.connected; }
  isRecording(): boolean { return this.recording; }
  getScript(): Script { return this.script; }

  // ---- 连接 ----

  async connect(opts?: ConnectOptions): Promise<void> {
    await this.kernel.connect(opts);
    this.connected = true;
    this.render();
  }

  async disconnect(): Promise<void> {
    await this.kernel.disconnect();
    this.connected = false;
    this.render();
  }

  // ---- 录制 ----

  startRecording(): void {
    this.recorder.reset();
    this.kernel.startRecording();
    this.recording = true;
    this.render();
  }

  async stopRecording(): Promise<void> {
    const events = await this.kernel.stopRecording();
    const wasRecording = this.recording;
    this.recording = false;
    // 仅当确实处于录制态才消费事件，避免脏数据（如 __recBuf 残留、
    // 或误调用 stop 而内核恰好返回缓存事件）被误插入脚本。
    if (wasRecording && events.length > 0) {
      for (const ev of events) this.recorder.record(ev);
      const steps = this.recorder.toSteps();
      for (const s of steps) this.script = ScriptEditor.insert(this.script, s);
    }
    this.render();
  }

  // ---- 编辑（不可变，委托 ScriptEditor）----

  insertStep(step: Step, index?: number): void {
    this.script = ScriptEditor.insert(this.script, step, index);
    this.render();
  }

  removeStep(stepId: string): void {
    this.script = ScriptEditor.remove(this.script, stepId);
    this.render();
  }

  updateStep(stepId: string, patch: Partial<Step>): void {
    this.script = ScriptEditor.update(this.script, stepId, patch);
    this.render();
  }

  moveStep(stepId: string, toIndex: number): void {
    this.script = ScriptEditor.move(this.script, stepId, toIndex);
    this.render();
  }

  // ---- 回放 ----

  async playback(): Promise<PlaybackResult> {
    const res = await this.kernel.playback(this.getScript());
    this.render();
    return res;
  }

  // ---- 可视化 ----

  async highlight(loc: Locator): Promise<VisualRect> {
    return this.kernel.locateVisual(loc);
  }

  async captureFrame(): Promise<Buffer> {
    return this.kernel.screenshot();
  }

  // ---- 导入 / 导出 ----

  exportScript(): string {
    return ScriptEditor.save(this.script);
  }

  importScript(json: string): void {
    this.script = ScriptEditor.load(json);
    this.render();
  }

  // ---- 渲染（全量重渲染，步骤规模小，简单优先）----

  render(): void {
    const root = this.mount;
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'ui-shell-header';
    header.textContent = `可视化蒙版 · ${this.script.app.name} · ${this.connected ? '已连接' : '未连接'}${this.recording ? ' · 录制中' : ''}`;
    root.appendChild(header);

    // 中间：被测软件视图（截图流占位 + 高亮层）
    const stage = document.createElement('div');
    stage.className = 'ui-shell-stage';
    stage.setAttribute('data-stage', 'true');
    const frame = document.createElement('div');
    frame.className = 'ui-shell-frame';
    frame.setAttribute('data-frame', 'true');
    frame.textContent = '[ 被测软件视图：截图流将在此渲染，坐标高亮叠加于其上 ]';
    stage.appendChild(frame);
    root.appendChild(stage);

    // 侧边：步骤列表（用户友好形式）
    const side = document.createElement('div');
    side.className = 'ui-shell-steps';
    side.setAttribute('data-steps', 'true');
    const title = document.createElement('div');
    title.className = 'ui-shell-steps-title';
    title.textContent = `步骤 (${this.script.steps.length})`;
    side.appendChild(title);

    this.script.steps.forEach((step, idx) => {
      const item = document.createElement('div');
      item.className = 'ui-shell-step-item';
      item.setAttribute('data-step-item', String(idx));
      item.setAttribute('data-step-id', step.id);
      const desc = document.createElement('span');
      desc.className = 'ui-shell-step-desc';
      desc.textContent = `${idx + 1}. ${describeStep(step)}`;
      item.appendChild(desc);
      side.appendChild(item);
    });

    root.appendChild(side);
  }
}
