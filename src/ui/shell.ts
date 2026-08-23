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
import { Recorder, type InteractionEvent } from '../recorder/recorder';
import { ScriptEditor } from '../editor/editor';
import { SCRIPT_SCHEMA } from '../types/step';

/** 回放结果（与 cli.CliResult 同构，但由内核产生，UI 壳不依赖 cli 模块）。 */
export type PlaybackResult = { ok: boolean; failedStepId?: string };

/**
 * 步骤运行态（R3）：仅 UI 瞬时状态，**不写入 Step 模型**。
 * 理由（SRP）：`Step` 是持久化数据（导出写盘、进 R5 版本层 diff），
 * 若把 pass/fail 混入会污染脚本文件与版本差异。故旁挂于 UiShell。
 */
export type StepRunStatus = 'pending' | 'running' | 'pass' | 'fail';

/** 运行进度事件载荷（服务端经 'step-progress' 推送）。 */
export type StepProgressEvent = { stepId: string; status: StepRunStatus };

/**
 * UI 壳所需的完整内核能力（抽象接口并集）。
 *
 * 重要约束（CODEBUDDY.md §4.1）：本接口会被 `WsKernel` 跨 WebSocket 实现，
 * 因此**所有方法参数必须 JSON-可序列化**。逐步进度不能以回调函数入参传递
 * （`JSON.stringify(fn)` → undefined，真机上必然丢失），只能走 `on/off` 推送通道。
 */
export type UiKernel = CdpAdapter & VisualCapable & Recordable & {
  /** 按脚本回放（内核职责：真机驱动 adapter / 演示返回假结果）。签名保持单参。 */
  playback(script: Script): Promise<PlaybackResult>;
  /** 订阅服务端主动推送事件（'recording' 录制增量 / 'step-progress' 运行进度）；可选。 */
  on?(event: string, cb: (data: unknown) => void): void;
  /** 退订；与 on 配对，供单次运行结束后清理。可选（旧内核可不实现）。 */
  off?(event: string, cb: (data: unknown) => void): void;
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
  /** 步骤列表容器缓存（增量 append 用，避免录制高频全量重渲染）。 */
  private stepsEl?: HTMLElement;

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

  /** 实时录制事件指纹缓存（去重用，避免 stopRecording 拉回与实时推送重复插入）。
   * 用事件内容指纹而非 step.id：实时 emit 与 stop 拉回的同源事件 id 不同但内容一致。 */
  private recordedKeys = new Set<string>();
  private eventKey(ev: InteractionEvent): string {
    return JSON.stringify({ t: ev.type, l: ev.locator, p: ev.params, tg: ev.target });
  }

  startRecording(): void {
    this.recorder.reset();
    this.recordedKeys.clear();
    this.kernel.startRecording();
    this.recording = true;
    // 订阅服务端实时推送：每捕获一个交互即增量生成步骤（边操作边长步骤）。
    this.kernel.on?.('recording', (ev) => this.onRecordingEvent(ev as InteractionEvent));
    this.render();
  }

  /** 实时事件回调：转 Step 并增量插入脚本与 DOM（不重渲染全列表）。 */
  private onRecordingEvent(ev: InteractionEvent): void {
    const key = this.eventKey(ev);
    if (this.recordedKeys.has(key)) return; // 去重
    this.recordedKeys.add(key);
    const step = this.recorder.toSingleStep(ev);
    this.script = ScriptEditor.insert(this.script, step);
    this.appendStepEl(step);
  }

  async stopRecording(): Promise<void> {
    const events = await this.kernel.stopRecording();
    const wasRecording = this.recording;
    this.recording = false;
    // 仅当确实处于录制态才消费事件，避免脏数据（如 __recBuf 残留、
    // 或误调用 stop 而内核恰好返回缓存事件）被误插入脚本。
    if (wasRecording && events.length > 0) {
      for (const ev of events) {
        const key = this.eventKey(ev);
        if (this.recordedKeys.has(key)) continue; // 实时已插入的跳过
        this.recordedKeys.add(key);
        const step = this.recorder.toSingleStep(ev);
        this.script = ScriptEditor.insert(this.script, step);
      }
    }
    this.render(); // 停止后全量刷新，保证一致
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

  // ---- 运行全部（R3）----

  /** 步骤运行态旁挂表（stepId → status）；不入 Step 模型，见 StepRunStatus 注释。 */
  private stepStatus = new Map<string, StepRunStatus>();
  /** 上一次运行的失败步 id（用于失败提醒渲染）。 */
  private lastFailedStepId?: string;

  /** 运行态变化钩子：宿主/测试可观察逐步流转（含 running 中间态）。 */
  onStepStatusChange?: (stepId: string, status: StepRunStatus) => void;

  /** 查询某步运行态；未跑过默认 pending。 */
  getStepStatus(stepId: string): StepRunStatus {
    return this.stepStatus.get(stepId) ?? 'pending';
  }

  /** 扁平化脚本步骤（含 CFG children），供状态查找与汇总回填按序遍历。 */
  private flattenSteps(steps: Step[] = this.script.steps): Step[] {
    const out: Step[] = [];
    for (const s of steps) {
      out.push(s);
      if (s.children?.length) out.push(...this.flattenSteps(s.children));
    }
    return out;
  }

  /** 单次运行内的 id→Step 索引（O(1) 查找），避免每步重建扁平数组（O(n²)→O(n)）。 */
  private runIndex?: Map<string, Step>;

  /**
   * 高亮"代际号"：每次 runAll 开始 ++、结束再 ++。
   * 迟到的异步 locateVisual 回调若携带的代际 ≠ 当前代际，则丢弃其渲染。
   * 目的（可运行性审查结论）：同时消除两类缺陷 ——
   *  (1) 多步快速执行时 locateVisual 乱序 resolve 导致高亮停在旧步；
   *  (2) 运行结束 finally 清屏后，迟到渲染又画上"幽灵框"且永不清除。
   * 仅用"当前步 id 守卫"治不了 (2)（结束时当前步仍是末步，守卫会放行）。
   */
  private highlightGen = 0;

  /**
   * 运行当前所有步骤（原「回放」，spec §2.3.4 改名「运行全部」）。
   * 流式：每步 running/pass/fail 即时回显，并让高亮自动跟随当前步（P1）。
   * 兼容：内核若忽略 onStepResult（旧实现），据汇总结果回填状态。
   */
  async runAll(): Promise<PlaybackResult> {
    this.resetRunStatus();
    // 本次运行的步骤索引快照：单次构建，后续每步 O(1) 命中（避免 O(n²) 重复扁平化）。
    this.runIndex = new Map(this.flattenSteps().map((s) => [s.id, s]));
    const gen = ++this.highlightGen;
    let sawProgress = false;

    /** 进度监听器：经内核推送通道接收，而非以回调入参传给 playback（RPC 不可序列化函数）。 */
    const onProgress = (data: unknown) => {
      // 跨 WS 边界兜底：不依赖解构默认值，显式 ?? {}（§4.1 清单 1）。
      const d = (data ?? {}) as Partial<StepProgressEvent>;
      const stepId = d.stepId;
      const status = d.status;
      if (!stepId || !status) return;
      sawProgress = true;
      if (status === 'running') {
        // 顺序要求：先画占位框、再广播状态钩子，否则观察者在钩子里看到的高亮会滞后一步。
        // 同步画占位框的理由（可运行性审查裁定）：真机 locateVisual 往返可达上百 ms，
        // 若等它回来才画，用户会看到高亮明显滞后于执行；坐标随后精修。
        this.renderHighlight(stepId, this.lastRect, gen);
      }
      this.setStepStatus(stepId, status);
      if (status === 'running') {
        // 精修不 await（推送回调为同步契约），失败静默不打断运行。
        void this.followHighlight(stepId, gen);
      }
    };

    this.kernel.on?.('step-progress', onProgress);

    let res: PlaybackResult;
    try {
      res = await this.kernel.playback(this.getScript());
    } finally {
      // 退订必须与订阅配对，否则多次 runAll 的回调会叠加。
      this.kernel.off?.('step-progress', onProgress);
      // 先作废本代际，再清屏：此后任何迟到渲染都会被代际守卫丢弃。
      this.highlightGen++;
      this.clearHighlight();
      this.runIndex = undefined;
    }

    // 内核不支持进度推送（DemoKernel / 纯批处理）时，据汇总结果回填。
    if (!sawProgress) this.backfillStatus(res);
    this.lastFailedStepId = res.ok ? undefined : res.failedStepId;
    this.render();
    return res;
  }

  /** 兼容旧「回放」入口（既有调用方零改动）。 */
  async playback(): Promise<PlaybackResult> {
    return this.runAll();
  }

  private resetRunStatus(): void {
    this.stepStatus.clear();
    this.lastFailedStepId = undefined;
  }

  private setStepStatus(stepId: string, status: StepRunStatus): void {
    this.stepStatus.set(stepId, status);
    this.onStepStatusChange?.(stepId, status);
  }

  /** 无流式回调时，按汇总结果回填：失败步前视为 pass，失败步 fail，其后 pending。 */
  private backfillStatus(res: PlaybackResult): void {
    const flat = this.flattenSteps();
    if (res.ok) {
      for (const s of flat) this.stepStatus.set(s.id, 'pass');
      return;
    }
    for (const s of flat) {
      if (s.id === res.failedStepId) {
        this.stepStatus.set(s.id, 'fail');
        break;
      }
      this.stepStatus.set(s.id, 'pass');
    }
  }

  // ---- 高亮跟随（P1）----

  /** 上一次成功定位的坐标：新步骤占位框先沿用它，避免 CDP 往返期间无反馈。 */
  private lastRect?: VisualRect;

  /** 按 id 取步骤：运行期走索引 O(1)，非运行期回退遍历。 */
  private findStep(stepId: string): Step | undefined {
    if (this.runIndex) return this.runIndex.get(stepId);
    return this.flattenSteps().find((s) => s.id === stepId);
  }

  /** 定位当前步元素并精修高亮框坐标；无 locator 或定位失败则静默跳过。 */
  private async followHighlight(stepId: string, gen: number): Promise<void> {
    const loc = this.findStep(stepId)?.locator;
    if (!loc) return;
    try {
      const rect = await this.kernel.locateVisual(loc);
      this.lastRect = rect;
      this.renderHighlight(stepId, rect, gen);
    } catch (err) {
      // 高亮是辅助能力：元素消失/未连接等失败不得中断运行全部。
      console.warn('[UiShell] 高亮跟随失败（不影响运行）:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * 渲染唯一高亮框（先清旧再画新，保证舞台上恒有 0 或 1 个）。
   * @param gen 发起时的代际号；不传=手动高亮（不受运行代际约束）。
   *            传入且与当前代际不符 → 本次渲染已作废，直接丢弃。
   */
  private renderHighlight(stepId: string, rect: VisualRect | undefined, gen?: number): void {
    if (gen !== undefined && gen !== this.highlightGen) return; // 迟到/乱序渲染作废
    this.clearHighlight();
    const stage = this.mount.querySelector('[data-stage]') as HTMLElement | null;
    if (!stage) return;
    const r = rect ?? { x: 0, y: 0, width: 0, height: 0, visible: false, inViewport: false };
    const box = document.createElement('div');
    box.className = 'ui-shell-highlight' + (rect ? '' : ' is-pending');
    box.setAttribute('data-highlight', 'true');
    box.setAttribute('data-highlight-step', stepId);
    box.style.cssText =
      `position:absolute;left:${r.x}px;top:${r.y}px;` +
      `width:${r.width}px;height:${r.height}px;` +
      'border:2px solid #ff5252;pointer-events:none;box-sizing:border-box;';
    stage.appendChild(box);
  }

  private clearHighlight(): void {
    this.mount.querySelectorAll('[data-highlight]').forEach((el) => el.remove());
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
    addBtn('运行全部', 'run-all');
    addBtn('高亮示例', 'highlight');
    addBtn('导出', 'export');
    addBtn('清空', 'clear', 'danger');
    root.appendChild(actions);

    // 运行失败提醒（spec §2.3.4：中途失败需暂停提醒，指明失败步骤）
    if (this.lastFailedStepId) {
      const failed = this.flattenSteps().find((s) => s.id === this.lastFailedStepId);
      const notice = document.createElement('div');
      notice.className = 'ui-shell-run-notice';
      notice.setAttribute('data-run-notice', 'true');
      notice.textContent = failed
        ? `运行中断：第 ${this.flattenSteps().indexOf(failed) + 1} 步「${describeStep(failed)}」失败，请检查后重跑。`
        : `运行中断：步骤 ${this.lastFailedStepId} 失败。`;
      root.appendChild(notice);
    }

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
      side.appendChild(this.buildStepItem(step, idx));
    });

    this.stepsEl = side;
    root.appendChild(side);
  }

  /** 构造单条步骤 DOM 项（render 与增量 append 复用）。 */
  private buildStepItem(step: Step, idx: number): HTMLElement {
    const item = document.createElement('div');
    const status = this.getStepStatus(step.id);
    item.className = `ui-shell-step-item is-${status}`;
    item.setAttribute('data-step-item', String(idx));
    item.setAttribute('data-step-id', step.id);
    item.setAttribute('data-step-status', status);
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
    return item;
  }

  /** 增量追加一个步骤 DOM（录制实时生成用，避免全列表重渲染）。 */
  private appendStepEl(step: Step): void {
    if (!this.stepsEl) {
      this.render();
      return;
    }
    this.stepsEl.appendChild(this.buildStepItem(step, this.script.steps.length - 1));
    const title = this.stepsEl.querySelector('.ui-shell-steps-title');
    if (title) title.textContent = `步骤 (${this.script.steps.length})`;
  }
}
