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
import type { Script, Step, StepType, Assertion, AssertionKind } from '../types/step';
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
  let param = '';
  if (step.type === 'assert' && step.params?.assertion) {
    const a = step.params.assertion;
    const kind = assertionKindLabel(a.kind);
    const val = a.value !== undefined ? ` "${a.value}"` : '';
    const wait = a.waitMs ? ` (等${a.waitMs}ms)` : '';
    param = ` ${kind}${val}${wait}`;
  } else {
    param =
      step.params?.value !== undefined ? ` → "${step.params.value}"`
      : step.params?.optionText !== undefined ? ` → "${step.params.optionText}"`
      : step.params?.durationMs !== undefined ? ` ${step.params.durationMs}ms`
      : '';
  }
  return `${verb} ${loc}${param}${target}`.trim();
}

/** 断言序号计数器（生成稳定唯一 id）。 */
let assertSeq = 0;

/** 断言 kind 全集（单一真相源）：新增断言类型只改这里，标签与选择菜单同步。OCP：扩展而非修改核心逻辑。 */
export const ASSERTION_KINDS: { kind: AssertionKind; label: string; needsValue: boolean }[] = [
  { kind: 'exists', label: '出现新元素', needsValue: false },
  { kind: 'visible', label: '元素可见', needsValue: false },
  { kind: 'textContains', label: '值包含内容', needsValue: true },
  { kind: 'titleIs', label: '值等于特定值', needsValue: true },
  { kind: 'urlMatches', label: 'URL 匹配', needsValue: true },
  { kind: 'elementVisibleInViewport', label: '元素在视口内可见', needsValue: false },
  { kind: 'screenshotMatches', label: '截图匹配', needsValue: false },
  { kind: 'expr', label: '表达式成立', needsValue: true },
];

/** 断言 kind → 用户友好标签（M3 补全：把内核断言语义翻译为产品语言）。 */
export function assertionKindLabel(kind: AssertionKind): string {
  return ASSERTION_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export class UiShell {
  private kernel: UiKernel;
  private mount: HTMLElement;
  private script: Script;
  private connected = false;
  private recording = false;
  private recorder = new Recorder();
  /** 当前选中的目标（窗口/webview）；缺省=主目标。 */
  private currentTargetId?: string;
  /** 截图流定时器句柄（Node 用 Timeout，浏览器用 number；用 any 兼容二者）。 */
  private frameTimer: any = undefined;

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

  // ---- 目标（窗口 / webview）选择 ----

  /** 枚举可用目标（代理内核）。 */
  listTargets() {
    return this.kernel.listTargets();
  }

  /** 选中目标（委托内核 selectTarget，并记录当前目标）。 */
  selectTarget(id: string): void {
    this.kernel.selectTarget(id);
    this.currentTargetId = id;
    this.render();
  }

  getCurrentTarget(): string | undefined {
    return this.currentTargetId;
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

  /** 编辑钩子：由宿主（app.ts）注入弹窗；默认无操作。点击步骤 ✎ 时触发。 */
  onEditStep?: (step: Step) => void;

  editStep(stepId: string): void {
    const step = this.script.steps.find((s) => s.id === stepId);
    if (step && this.onEditStep) this.onEditStep(step);
  }

  /**
   * 断言友好封装（M3 补全核心）：在某步骤后插入一条断言步骤。
   * kind 映射到用户友好语义（见 assertionKindLabel）；waitMs 为"检测前等待"，
   * 供 Agent 推理或异步渲染留时间（如"等待 N 秒后检测元素值"）。
   */
  insertAssertion(
    kind: AssertionKind,
    locator: Locator,
    value?: string,
    waitMs = 0,
  ): void {
    const assertion: Assertion = { kind, locator: { ...locator } };
    if (value !== undefined) assertion.value = value;
    if (waitMs > 0) assertion.waitMs = waitMs;
    const step: Step = {
      id: `assert-${Date.now().toString(36)}-${++assertSeq}`,
      type: 'assert',
      source: 'manual',
      params: { assertion },
    };
    if (this.currentTargetId) step.target = this.currentTargetId;
    this.insertStep(step);
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

  /**
   * 启动截图流：定时拉取被测软件截图并渲染到舞台区（解决"看不到软件页面"）。
   * 演示内核截图为空，仅真机（WsKernel/PlaywrightCdpAdapter）有实际画面。
   * 渲染为 dataURL <img> 叠加在舞台区，高亮框叠加其上。
   */
  startFrameStream(intervalMs = 1000): void {
    this.stopFrameStream();
    const tick = async () => {
      try {
        const buf = await this.captureFrame();
        const b64 = buf.toString('base64');
        const stage = this.mount.querySelector('[data-stage]') as HTMLElement | null;
        if (stage) {
          let img = stage.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
          if (!img) {
            img = document.createElement('img');
            img.className = 'ui-shell-frame-img';
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
            stage.prepend(img);
          }
          img.src = `data:image/png;base64,${b64}`;
        }
      } catch (err) {
        // 截图失败（如未连接/目标失效）静默跳过，下一周期重试；仅在控制台留痕便于排查。
        console.warn('[UiShell] 截图流单帧失败，重试中:', err instanceof Error ? err.message : err);
      }
    };
    // 立即先取一帧，再周期性
    tick();
    this.frameTimer = setInterval(tick, intervalMs);
  }

  stopFrameStream(): void {
    if (this.frameTimer !== undefined) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }
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
    header.innerHTML = '';

    const titleText = document.createElement('span');
    titleText.textContent = `可视化蒙版 · ${this.script.app.name} · ${this.connected ? '已连接' : '未连接'}${this.recording ? ' · 录制中' : ''}`;
    header.appendChild(titleText);

    // 录制指示灯
    const dot = document.createElement('span');
    dot.className = 'rec-dot' + (this.recording ? ' on' : '');
    header.appendChild(dot);

    // 目标选择下拉（窗口/webview）
    const targets = this.listTargets();
    if (this.connected && targets.length > 0) {
      const sel = document.createElement('select');
      sel.className = 'ui-shell-target-select';
      sel.setAttribute('data-action', 'select-target');
      targets.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.title ?? t.id} (${t.type})`;
        if (t.id === this.currentTargetId) opt.selected = true;
        sel.appendChild(opt);
      });
      header.appendChild(sel);
    }
    root.appendChild(header);

    // 顶部操作栏
    const actions = document.createElement('div');
    actions.className = 'ui-shell-actions';
    actions.setAttribute('data-actions', 'true');
    const addBtn = (label: string, action: string, cls = '') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.setAttribute('data-action', action);
      actions.appendChild(b);
    };
    addBtn('插入步骤', 'insert', 'primary');
    addBtn('加断言', 'add-assert');
    addBtn('开始录制', 'toggle-record');
    addBtn('回放', 'playback');
    addBtn('高亮示例', 'highlight');
    addBtn('导出', 'export');
    addBtn('清空', 'clear', 'danger');
    root.appendChild(actions);

    // 中间：被测软件视图（截图流 <img> + 高亮层）
    const stage = document.createElement('div');
    stage.className = 'ui-shell-stage';
    stage.setAttribute('data-stage', 'true');
    const frameHint = document.createElement('div');
    frameHint.className = 'ui-shell-frame';
    frameHint.setAttribute('data-frame', 'true');
    frameHint.textContent = '[ 被测软件视图：连接后自动拉取截图流 ]';
    stage.appendChild(frameHint);
    root.appendChild(stage);

    // 侧边：步骤列表（用户友好形式，每条带操作按钮）
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

      const ops = document.createElement('span');
      ops.className = 'ui-shell-step-ops';
      const mkOp = (label: string, action: string, handler: () => void) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('data-action', action);
        b.setAttribute('data-step-id', step.id);
        b.addEventListener('click', handler);
        ops.appendChild(b);
      };
      // 每条步骤自带操作按钮，shell 自包含处理（不依赖外部委托），便于单元验证
      mkOp('↑', 'up', () => this.moveStep(step.id, Math.max(0, idx - 1)));
      mkOp('↓', 'down', () => this.moveStep(step.id, idx + 1));
      mkOp('✎', 'edit', () => this.editStep(step.id));
      mkOp('✕', 'remove', () => this.removeStep(step.id));
      item.appendChild(ops);

      side.appendChild(item);
    });

    root.appendChild(side);
  }
}
