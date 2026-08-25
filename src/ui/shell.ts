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
import type {
  Script, Step, StepType, Assertion, AssertionKind,
  StepRunStatus, StepProgressEvent,
} from '../types/step';
import { Recorder, type InteractionEvent } from '../recorder/recorder';
import { ScriptEditor } from '../editor/editor';
import { SCRIPT_SCHEMA } from '../types/step';
import { CfgView } from './cfg-view';
import { TYPE_LABEL, describeLocator } from './step-label';
import {
  createStore,
  commit as vCommit,
  branch as vBranch,
  switchTo as vSwitchTo,
  cherryPick as vCherryPick,
  tag as vTag,
  getBranches,
  getCurrentScript,
  type VersionStore,
} from '../script/version-store';
import { VersionPanel } from './version-panel';

/** 回放结果（与 cli.CliResult 同构，但由内核产生，UI 壳不依赖 cli 模块）。 */
export type PlaybackResult = { ok: boolean; failedStepId?: string };

/** 手动可插入的步骤类型（spec §2.3.1 仅 4 类；click/fill 等仅由录制产生）。 */
type ManualStepType = 'wait' | 'waitUntil' | 'assert' | 'repeat';

// 运行态类型定义已迁至 `src/types/step.ts`（与 StepType/ControlKind 同处真相源），
// 因同级视图组件 cfg-view 也需要它，从 shell 引入会形成"子组件反向依赖编排者"。
// 此处 re-export 保持既有引用路径可用（向后兼容，不破坏既有 import）。
export type { StepRunStatus, StepProgressEvent } from '../types/step';

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
  /** 订阅服务端主动推送事件（'recording' 录制增量 / 'step-progress' 运行进度 / 'pick' 点选命中）；可选。 */
  on?(event: string, cb: (data: unknown) => void): void;
  /** 退订；与 on 配对，供单次运行结束后清理。可选（旧内核可不实现）。 */
  off?(event: string, cb: (data: unknown) => void): void;
  /** 进入点选态（spec §2.3）。可选：旧内核不实现时 UI 侧「在软件中点选」按钮禁用。 */
  startPick?(): Promise<void>;
  /** 取消点选态。可选，与 startPick 配对。 */
  cancelPick?(): Promise<void>;
};

export type UiShellOptions = {
  kernel: UiKernel;
  /** 挂载根节点（测试可注入 detached div，宿主可注入页面 #app）。 */
  mount: HTMLElement;
  /** 初始脚本（可选，如从文件载入）。 */
  script?: Script;
  /** 是否挂载 Git 版本面板（可选插件，默认隐藏；主体生成流程不依赖）。 */
  enableVersionPanel?: boolean;
};

// TYPE_LABEL / describeLocator 已收敛到 ./step-label（与 CFG 视图共用同一份文案真相源）。

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

/**
 * 判断某步是否需要「在软件中点选」按钮，并返回点选回写的目标字段（spec §2.3）。
 * - waitUntil / assert（带 params.assertion）→ 写回 assertion.locator
 * - 选择组（control.kind==='if'）→ 写回 control.condition.locator
 * 其余类型返回 undefined（不显示按钮）。
 */
function pickFieldFor(step: Step): 'assertion-locator' | 'condition-locator' | undefined {
  if (step.control?.kind === 'if') return 'condition-locator';
  if (step.type === 'waitUntil' || step.type === 'assert') return 'assertion-locator';
  return undefined;
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
  /** CFG 图形化视图（M3-R4）：SRP 独立组件，仅依赖 Script/Step 类型（DIP）。 */
  private cfgView?: CfgView;
  /** CFG 视图挂载区（render 时创建，update 复用）。 */
  private cfgMount?: HTMLElement;
  /**
   * Git 式版本库（M3-R5）：版本状态在 UI 侧/本地，UiKernel 不上提版本（DIP）。
   * UiShell 持有 store 并编排版本操作（调 version-store 纯函数），再把新 store
   * 喂给 VersionPanel 重绘。版本库以"当前编辑脚本"初始化首个提交。
   */
  private versionStore: VersionStore;
  /** 版本面板（SRP 组件，仅消费 store + 回调，不依赖内核）。 */
  private versionPanel?: VersionPanel;
  /** 版本面板挂载区（render 时创建，update 复用）。 */
  private versionMount?: HTMLElement;
  /**
   * 选中态唯一真相源：列表视图与 CFG 视图都订阅它（兄弟视图互不依赖）。
   * 避免两个兄弟视图互相同步产生的双向耦合与状态分叉。
   */
  private selectedStepId?: string;
  /** 多选态（建组用）：收集用户勾选/连选的步骤 id，调 wrap 时整体包成组。 */
  private selectedIds = new Set<string>();
  /** 插入菜单展开态：点击「插入步骤」切换，决定是否渲染 4 类子菜单。 */
  private insertMenuOpen = false;
  /** Git 版本面板是否挂载（可选插件，默认隐藏）。 */
  private enableVersionPanel: boolean;
  /** 顶部提示横幅文本（演示模式说明 / 未连接真机录制警告）。render 会据此重建，故不会被后续 render 冲掉。 */
  private bannerText?: string;
  /** 横幅样式变体：true=琥珀色（显式演示），false=红色（降级/错误）。 */
  private bannerDemo = false;

  // ---- 嵌入式点选录制（spec §2.3）----
  /** 当前是否处于点选态（waitUntil/assert/选择组条件共用一套）。 */
  private pickMode = false;
  /** 点选回写目标：哪个步骤的哪个 locator 字段。 */
  private pickTarget?: { stepId: string; field: 'assertion-locator' | 'condition-locator' };
  /** 'pick' 事件回调：把靶机点到的完整 locator 写回当前编辑步骤。 */
  private onPick = (data: unknown): void => {
    // 跨 WS 边界兜底：不依赖解构默认值，显式 ?? {}（§4.1）。
    const d = (data ?? {}) as { locator?: Locator };
    const loc = d.locator;
    if (!loc) return;
    this.applyPick(loc);
  };

  constructor(opts: UiShellOptions) {
    this.kernel = opts.kernel;
    this.mount = opts.mount;
    this.enableVersionPanel = opts.enableVersionPanel ?? false;
    this.script = opts.script ?? {
      schema: SCRIPT_SCHEMA,
      app: { name: 'Unnamed', version: '0.0.0' },
      steps: [],
    };
    // M3-R5：以当前脚本在 main 分支建首个提交（版本库入口，不可变）。
    this.versionStore = createStore(this.script, 'init');
    // 在 UiShell 内部挂**一处**事件委托：列表项点击 → 选中/多选（反向联动），
    // 不依赖 app.ts。用 closest 就近命中，兼容点击列表项内部文字。
    this.mount.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      // 操作栏/菜单/步骤按钮等带 data-action 的点击，统一交给下方动作委托处理。
      const actionEl = el.closest('[data-action]') as HTMLElement | null;
      if (actionEl) {
        this.handleAction(actionEl.getAttribute('data-action')!, actionEl);
        return;
      }
      // 否则按步骤项命中：多选累积 + 选中并打开编辑区（spec §2.6 选中即出详情）。
      const item = el.closest('[data-step-item]') as HTMLElement | null;
      if (!item) return;
      const id = item.getAttribute('data-step-id');
      if (!id) return;
      // 多选：每点一次 toggle 进/出 selectedIds（建组用）。
      if (this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
      // 选中该步并渲染真实编辑区（替代旧版 alert 弹窗）。
      this.editStep(id);
    });
  }

  /** 统一动作分发（操作栏 / 插入菜单 / 建组按钮的 data-action 均走此）。 */
  private handleAction(action: string, el: HTMLElement): void {
    switch (action) {
      case 'insert':
        this.insertMenuOpen = !this.insertMenuOpen;
        this.render();
        break;
      case 'insert-type': {
        const type = el.getAttribute('data-insert-type')!;
        this.insertManualStep(type as ManualStepType);
        this.insertMenuOpen = false;
        this.render();
        break;
      }
      case 'wrap-if':
        this.wrapSelection('if');
        break;
      case 'wrap-while':
        this.wrapSelection('while');
        break;
      case 'pick': {
        const stepId = el.getAttribute('data-pick-step-id') ?? '';
        const field = el.getAttribute('data-pick-field') as 'assertion-locator' | 'condition-locator';
        if (stepId && field) void this.startPickFor(stepId, field);
        break;
      }
      case 'cancel-pick':
        this.exitPickMode();
        break;
      case 'save-edit':
        this.saveEdit(el.getAttribute('data-step-id') ?? '');
        break;
      case 'toggle-record':
        if (this.isRecording()) void this.stopRecording();
        else void this.startRecording();
        this.render();
        break;
      case 'run-all':
        void this.runAll();
        break;
      case 'export':
        this.downloadScript();
        break;
      case 'clear':
        [...this.getScript().steps].forEach((st) => this.removeStep(st.id));
        break;
      default:
        break;
    }
  }

  /** 运行进度处理（每次 runAll 订阅，finally 退订，避免多次运行回调叠加）。 */
  private sawProgress = false;
  private onProgress = (data: unknown): void => {
    // 跨 WS 边界兜底：不依赖解构默认值，显式 ?? {}（§4.1 清单 1）。
    const d = (data ?? {}) as Partial<StepProgressEvent>;
    const stepId = d.stepId;
    const status = d.status;
    if (!stepId || !status) return;
    this.sawProgress = true;
    if (status === 'running') {
      // 顺序要求：先画占位框、再广播状态钩子，否则观察者在钩子里看到的高亮会滞后一步。
      this.renderHighlight(stepId, this.lastRect, this.highlightGen);
    }
    this.setStepStatus(stepId, status);
    if (status === 'running') {
      // 精修不 await（推送回调为同步契约），失败静默不打断运行。
      void this.followHighlight(stepId, this.highlightGen);
    }
  };

  // 注：CFG 节点状态**不另开** WS 订阅。状态经 `setStepStatus` 单点分发
  // （列表项 + CFG 视图共用同一个 stepStatus Map），故只需一处订阅、无顺序问题。
  // 曾有一版为迁就测试而让生产代码嗅探 mock 夹具属性（kernel.listeners）走不同分支，
  // 已移除 —— 那会造成"单测走 A 路径、真机走 B 路径"，正是 CODEBUDDY.md §4.1 的盲区成因。

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

  async startRecording(): Promise<void> {
    // 录制依赖真机内核实时回传交互事件（click/fill 等仅由录制产生，见 spec §2.3.1）。
    // kernel.startRecording 可能 reject（如 WsKernel 尚未连接靶机），必须捕获：
    // 否则未捕获异常会中断 UI 交互、且用户看不到任何失败原因。
    try {
      await this.kernel.startRecording();
    } catch (e) {
      // 降级：连接失败时不进入录制态，给出明确红条提示（而非静默失效）。
      const msg = e instanceof Error ? e.message : String(e);
      this.setBanner(`录制失败：尚未连接靶机（${msg}）。请先启动软件调试端口，刷新页面后再试。`);
      return;
    }
    this.recorder.reset();
    this.recordedKeys.clear();
    this.kernel.on?.('recording', (ev) => this.onRecordingEvent(ev as InteractionEvent));
    this.recording = true;
    this.render();
  }

  /** 设置顶部提示横幅（持久于实例，render 会据此重建，故不被后续 render 冲掉）。
   * @param demo 为 true 时用琥珀色变体（显式演示模式），否则默认红色（降级/错误）。 */
  setBanner(text: string, demo = false): void {
    this.bannerText = text;
    this.bannerDemo = demo;
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

  /** 编辑某步：渲染 §2.6 真实编辑区（表单），替代旧版 alert 弹窗。 */
  editStep(stepId: string): void {
    const step = this.findStep(stepId);
    if (!step) return;
    this.selectStep(stepId); // 同步选中态（列表项 + CFG 节点高亮）
    this.renderEditArea(step);
  }

  /**
   * 渲染步骤详情/编辑区（spec §2.6）：类型/定位/参数可改，保存=不可变更新。
   * 挂在 mount 内的独立片段 [data-edit-area]，不占用步骤列表 DOM。
   */
  private renderEditArea(step: Step): void {
    // 每次重建编辑区（简单优先，步骤规模小）。
    this.mount.querySelector('[data-edit-area]')?.remove();
    const area = document.createElement('div');
    area.className = 'ui-shell-edit-area';
    area.setAttribute('data-edit-area', 'true');

    const title = document.createElement('div');
    title.className = 'ui-shell-edit-title';
    title.textContent = `编辑步骤：${describeStep(step)}`;
    area.appendChild(title);

    // 「在软件中点选」按钮（spec §2.3）：waitUntil/assert 的 assertion.locator、
    // 选择组(if)的 condition.locator 三处共用一套点选子模式。未连接时禁用。
    const pickField = pickFieldFor(step);
    if (pickField) {
      const pick = document.createElement('button');
      pick.className = 'ui-shell-pick-btn';
      pick.textContent = '在软件中点选';
      pick.setAttribute('data-action', 'pick');
      pick.setAttribute('data-pick-step-id', step.id);
      pick.setAttribute('data-pick-field', pickField);
      // 未连接或内核无点选能力时禁用，并提示先连接。
      if (!this.connected || !this.kernel.startPick) {
        pick.disabled = true;
        pick.title = '请先连接靶机';
      }
      area.appendChild(pick);
    }

    // 定位 name 字段（最常见的可编辑项，点击/填充/断言都带 locator.name）。
    if (step.locator) {
      area.appendChild(this.editField(step, 'locator.name', '定位名称(name)', step.locator.name ?? ''));
      if (step.locator.role) {
        area.appendChild(this.editField(step, 'locator.role', '定位角色(role)', step.locator.role));
      }
    }
    // 参数：fill/select 的 value、wait 的 durationMs、waitUntil/assert 的 timeoutMs。
    const val = step.params?.value ?? step.params?.optionText;
    if (val !== undefined) {
      area.appendChild(this.editField(step, 'params.value', '输入值(value)', val));
    }
    if (step.params?.durationMs !== undefined) {
      area.appendChild(this.editField(step, 'params.durationMs', '等待毫秒(durationMs)', String(step.params.durationMs)));
    }

    // 保存 / 删除（保存走统一 data-action 委托，见 saveEdit；删除保留行内处理）
    const save = document.createElement('button');
    save.textContent = '保存';
    save.setAttribute('data-action', 'save-edit');
    save.setAttribute('data-step-id', step.id);
    area.appendChild(save);

    const del = document.createElement('button');
    del.textContent = '删除';
    del.setAttribute('data-action', 'remove');
    del.setAttribute('data-step-id', step.id);
    del.addEventListener('click', () => { this.removeStep(step.id); area.remove(); });
    area.appendChild(del);

    this.mount.appendChild(area);
  }

  /** 统一处理「保存编辑」：从编辑区表单读取并不可变更新对应步骤。 */
  private saveEdit(stepId: string): void {
    const step = this.findStep(stepId);
    const area = this.mount.querySelector('[data-edit-area]');
    if (!step || !area) return;
    const patch: Partial<Step> = {};
    area.querySelectorAll<HTMLInputElement>('[data-edit-field]').forEach((inp) => {
      const path = inp.getAttribute('data-edit-field')!;
      const v = inp.value;
      // 多个 locator/params 字段须累加到同一 patch 对象，不能各自覆盖（否则后者丢失前者）。
      if (path === 'locator.name') patch.locator = { ...(patch.locator ?? step.locator), name: v };
      else if (path === 'locator.role') patch.locator = { ...(patch.locator ?? step.locator), role: v };
      else if (path === 'params.value') patch.params = { ...(patch.params ?? step.params), value: v };
      else if (path === 'params.durationMs') patch.params = { ...(patch.params ?? step.params), durationMs: Number(v) || 0 };
    });
    this.script = ScriptEditor.updateNested(this.script, stepId, patch);
    area.remove();
    this.render();
  }

  /** 生成一个可编辑输入行（label + input），input 带 data-edit-field 供保存时读取。 */
  private editField(step: Step, path: string, label: string, value: string): HTMLElement {
    const row = document.createElement('label');
    row.className = 'ui-shell-edit-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.setAttribute('data-edit-field', path);
    row.appendChild(span);
    row.appendChild(input);
    return row;
  }

  /** 手动步骤类型：spec §2.3.1 仅暴露 4 类（录制才产生 click/fill 等）。 */
  private insertManualStep(type: 'wait' | 'waitUntil' | 'assert' | 'repeat'): void {
    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let step: Step;
    switch (type) {
      case 'wait':
        step = { id, type: 'wait', source: 'manual', params: { durationMs: 1000 } };
        break;
      case 'waitUntil':
        step = {
          id, type: 'waitUntil', source: 'manual',
          params: { assertion: { kind: 'visible', locator: { role: 'status' } }, timeoutMs: 5000 },
        };
        break;
      case 'assert':
        step = {
          id, type: 'assert', source: 'manual',
          params: { assertion: { kind: 'visible', locator: { role: 'status' } } },
        };
        break;
      case 'repeat':
        // repeat ≡ while 循环组：以 while 控制节点表达，循环体初为空，用户再往里加步或包组。
        step = { id, type: 'wait', source: 'manual', control: { kind: 'while', loopCount: 1 }, children: [] };
        break;
      default:
        // 受控联合外的值（如非法注入）直接拒绝，避免 insertStep(undefined) 崩溃。
        console.warn('[UiShell] 未知手动步骤类型，已忽略:', type);
        return;
    }
    this.insertStep(step);
  }

  /** 把当前多选的步骤整体包成控制流组（spec §2.3.0）。空选集不操作（边界安全）。 */
  private wrapSelection(kind: 'if' | 'while'): void {
    const ids = [...this.selectedIds];
    if (ids.length === 0) return;
    this.script = ScriptEditor.wrap(this.script, ids, kind);
    this.selectedIds.clear();
    this.render();
  }

  // ---- 嵌入式点选录制（spec §2.3）----
  /** 进入点选态：未连接时禁用并提示；订阅 'pick' 事件，调内核 startPick。 */
  private async startPickFor(
    stepId: string,
    field: 'assertion-locator' | 'condition-locator',
  ): Promise<void> {
    if (!this.connected) {
      this.setBanner('请先连接靶机，再点选元素。');
      return;
    }
    if (!this.kernel.startPick || !this.kernel.cancelPick) return; // 旧内核无点选能力：兜底静默
    this.pickMode = true;
    this.pickTarget = { stepId, field };
    this.kernel.on?.('pick', this.onPick);
    // 先渲染点选态提示（同步反馈：用户点击按钮后立刻看到「请在靶机中点击目标元素」），
    // 再 await 内核 startPick；若 startPick 失败再 exitPickMode 清掉提示。
    this.render();
    try {
      await this.kernel.startPick();
    } catch (e) {
      this.exitPickMode(false); // 失败：清理订阅但不再次调 cancelPick
      const msg = e instanceof Error ? e.message : String(e);
      this.setBanner(`点选启动失败：${msg}`);
      return;
    }
  }

  /** 点选命中：把完整 locator 不可变写回当前编辑步骤的目标字段，再退出点选态。 */
  private applyPick(loc: Locator): void {
    const t = this.pickTarget;
    if (!t) return;
    // 边界兜底：跨 WS 的 locator 可能带 null 字段，统一还原为 undefined（§4.1）。
    const clean: Locator = {};
    for (const [k, v] of Object.entries(loc)) {
      if (v !== null && v !== undefined) (clean as Record<string, unknown>)[k] = v;
    }
    const step = this.findStep(t.stepId);
    let patch: Partial<Step>;
    if (t.field === 'assertion-locator') {
      const assertion = step?.params?.assertion ?? { kind: 'visible' as const };
      patch = { params: { ...step?.params, assertion: { ...assertion, locator: clean } } };
    } else {
      const ctrl = step?.control ?? { kind: 'if' as const };
      const condition = ctrl.condition ?? { kind: 'visible' as const };
      patch = { control: { ...ctrl, condition: { ...condition, locator: clean } } };
    }
    this.script = ScriptEditor.updateNested(this.script, t.stepId, patch);
    this.exitPickMode();
  }

  /** 退出点选态：退订事件、调内核 cancelPick、清目标、重渲染。
   * @param cancelKernel 为 false 时不调 kernel.cancelPick（用于 startPick 本身失败时清理）。 */
  private exitPickMode(cancelKernel = true): void {
    const was = this.pickMode;
    this.pickMode = false;
    this.pickTarget = undefined;
    this.kernel.off?.('pick', this.onPick);
    if (cancelKernel && was) void this.kernel.cancelPick?.();
    this.render();
  }

  /** 导出脚本为 JSON 文件下载（替代旧 app.ts 的实现，UI 壳自包含）。 */
  private downloadScript(): void {
    const json = ScriptEditor.save(this.getScript());
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'script.json'; a.click();
    URL.revokeObjectURL(url);
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

  // ---- 选中态（M3-R4）：UiShell 是唯一真相源 ----

  /** 当前选中步骤 id（未选中=undefined）。 */
  getSelectedStepId(): string | undefined {
    return this.selectedStepId;
  }

  /** 选中某步：同时同步列表项与 CFG 节点的选中态。选不存在的 id 不产生任何选中态。 */
  selectStep(stepId: string): void {
    // 校验 id 是否真实存在于脚本（防脏数据）；不存在则清空选中。
    const exists = this.flattenSteps().some((s) => s.id === stepId);
    if (!exists) {
      this.clearSelection();
      return;
    }
    this.selectedStepId = stepId;
    this.syncSelectedDom(stepId);
  }

  /**
   * 按 stepId 查列表项 DOM。
   *
   * 刻意**不用** `querySelector(`[data-step-id="${id}"]`)` 拼接选择器：
   * stepId 由脚本自由命名，可能含 `"` `\` `]` 空格等 CSS 特殊字符，
   * 拼接后在真实 Chromium 会抛 SyntaxError 使整页 JS 中断（jsdom 下则静默选空，
   * 单测因只用安全 id 而看不见）。改为属性精确比对，从根上消除选择器注入。
   */
  private findStepItemEl(stepId: string): Element | undefined {
    for (const el of this.mount.querySelectorAll('[data-step-id]')) {
      if (el.getAttribute('data-step-id') === stepId) return el;
    }
    return undefined;
  }

  /**
   * 在单个列表项上标记/取消选中。
   *
   * 属性与 class **必须同时设置**：`data-step-selected` 供测试与程序查询，
   * `is-selected` class 是 CSS 挂点（用户能看见的那一半）。
   * 曾出现只打属性、index.html 无对应规则 → 点 CFG 节点时列表侧零视觉反馈，
   * 而只断言属性的测试完全看不出来。故收敛到这一处，避免两者再分叉。
   */
  private markStepItemSelected(el: Element | undefined, selected: boolean): void {
    if (!el) return;
    el.setAttribute('data-step-selected', selected ? 'true' : 'false');
    el.classList.toggle('is-selected', selected);
  }

  /** 清除选中态（列表项与 CFG 节点都还原）。 */
  private clearSelection(): void {
    if (this.selectedStepId) {
      this.markStepItemSelected(this.findStepItemEl(this.selectedStepId), false);
    }
    this.cfgView?.setSelected(undefined);
    this.selectedStepId = undefined;
  }

  /**
   * 把当前 stepStatus Map 全部回填到 CFG 节点（CFG update 重置为 pending 后调用，
   * 保证图节点与列表项状态始终一致——同一真相源，不各算一套）。
   */
  private syncAllCfgStatuses(): void {
    if (!this.cfgView) return;
    for (const s of this.flattenSteps()) {
      this.cfgView.setStatus(s.id, this.getStepStatus(s.id));
    }
  }

  /** 把选中态同步到两个兄弟视图（列表项 + CFG 节点）。 */
  private syncSelectedDom(stepId: string): void {
    // 列表项：先清旧、再置新。
    this.mount.querySelectorAll('[data-step-selected="true"]').forEach((el) =>
      this.markStepItemSelected(el, false),
    );
    this.markStepItemSelected(this.findStepItemEl(stepId), true);
    // CFG 节点：由 CfgView 自身管理唯一选中（setSelected 内部清旧置新）。
    this.cfgView?.setSelected(stepId);
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
    this.sawProgress = false;

    // 进度监听器：每次运行订阅一次、结束时退订一次，避免多次 runAll 回调叠加。
    // 只需这一处订阅 —— CFG 节点状态由 setStepStatus 单点分发，不另开订阅。
    this.kernel.on?.('step-progress', this.onProgress);

    let res: PlaybackResult;
    try {
      res = await this.kernel.playback(this.getScript());
    } finally {
      // 退订必须与订阅配对，否则多次 runAll 的回调会叠加。
      this.kernel.off?.('step-progress', this.onProgress);
      // 先作废本代际，再清屏：此后任何迟到渲染都会被代际守卫丢弃。
      this.highlightGen++;
      this.clearHighlight();
      this.runIndex = undefined;
    }

    // 内核不支持进度推送（DemoKernel / 纯批处理）时，据汇总结果回填。
    if (!this.sawProgress) this.backfillStatus(res);
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
    // 重置图上所有节点状态为 pending（避免上一轮 pass/fail 残留，§4 测试「重跑」）。
    this.cfgView?.update(this.script);
  }

  private setStepStatus(stepId: string, status: StepRunStatus): void {
    this.stepStatus.set(stepId, status);
    // 顺序要求：**先把状态落到视图，再广播钩子**。
    // 钩子是对外可观测点，订阅者会在回调里读 DOM；若先广播后更新，订阅者读到的是
    // 上一步的旧状态（滞后一步）。R3 的高亮占位框曾踩过同一个坑，此处同理。
    // CFG 与列表项共用同一 stepStatus Map，状态不各算一套。
    this.cfgView?.setStatus(stepId, status);
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

    // 持久横幅（演示模式/录制警告）：render 每次重建 DOM，故 banner 必须从实例字段重新渲染，
    // 否则 insertStep 等后续 render 会把它冲掉（此前 banner 在 render 外 prepend 即被此问题吞掉）。
    if (this.bannerText) {
      const bar = document.createElement('div');
      bar.className = 'ui-shell-banner' + (this.bannerDemo ? ' banner--demo' : '');
      bar.setAttribute('data-banner', 'true');
      bar.textContent = this.bannerText;
      root.appendChild(bar);
    }

    // 点选态提示（spec §2.3）：进入点选后顶部提示用户切到靶机点击，并提供取消。
    if (this.pickMode) {
      const bar = document.createElement('div');
      bar.className = 'ui-shell-banner banner--pick';
      bar.setAttribute('data-pick-mode', 'true');
      bar.textContent = '请在靶机中点击目标元素…';
      const cancel = document.createElement('button');
      cancel.className = 'ui-shell-pick-cancel';
      cancel.textContent = '取消点选';
      cancel.setAttribute('data-action', 'cancel-pick');
      bar.appendChild(cancel);
      root.appendChild(bar);
    }

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
    addBtn('开始录制', 'toggle-record');
    addBtn('包成选择组', 'wrap-if');
    addBtn('包成循环组', 'wrap-while');
    addBtn('运行全部', 'run-all');
    addBtn('导出', 'export');
    addBtn('清空', 'clear', 'danger');
    root.appendChild(actions);

    // 插入 4 类手动步骤的子菜单（spec §2.3.1：仅 wait/waitUntil/assert/repeat）。
    // 仅当用户点击「插入步骤」展开后才渲染；初始不展开，避免遮挡主区。
    if (this.insertMenuOpen) {
      const menu = document.createElement('div');
      menu.className = 'ui-shell-insert-menu';
      menu.setAttribute('data-insert-menu', 'true');
      const kinds: { type: string; label: string }[] = [
        { type: 'wait', label: '等待时间（wait）' },
        { type: 'waitUntil', label: '等待条件（waitUntil）' },
        { type: 'assert', label: '断言（assert，可作选择组条件）' },
        { type: 'repeat', label: '循环（repeat）' },
      ];
      kinds.forEach((k) => {
        const b = document.createElement('button');
        b.className = 'ui-shell-insert-item';
        b.textContent = k.label;
        b.setAttribute('data-action', 'insert-type');
        b.setAttribute('data-insert-type', k.type);
        menu.appendChild(b);
      });
      root.appendChild(menu);
    }

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

    // 多栏主体：被测软件视图 + 步骤列表 + CFG 视图（横向 4 栏，由 .ui-shell-body flex 承载）。
    const body = document.createElement('div');
    body.className = 'ui-shell-body';
    root.appendChild(body);

    // 中间：被测软件视图（截图流 <img> + 高亮层）
    const stage = document.createElement('div');
    stage.className = 'ui-shell-stage';
    stage.setAttribute('data-stage', 'true');
    const frameHint = document.createElement('div');
    frameHint.className = 'ui-shell-frame';
    frameHint.setAttribute('data-frame', 'true');
    frameHint.textContent = '[ 被测软件视图：连接后自动拉取截图流 ]';
    stage.appendChild(frameHint);
    body.appendChild(stage);

    // 侧边：步骤列表（用户友好形式，每条带操作按钮；支持多选建组）
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
    body.appendChild(side);

    // 右侧：CFG 图形化视图（M3-R4）。独立 SRP 组件，由 UiShell 编排联动。
    const cfg = document.createElement('div');
    cfg.className = 'ui-shell-cfg';
    cfg.setAttribute('data-cfg', 'true');
    // 复用同一挂载区：若已存在 CfgView 则复用其实例，避免重复 new 导致事件重复绑定。
    if (!this.cfgView) {
      this.cfgView = new CfgView({
        mount: cfg,
        onSelect: (stepId) => this.selectStep(stepId),
      });
    } else {
      // 重新挂到新创建的挂载区（render 会 innerHTML=''，旧 mount 已脱离文档）。
      this.cfgView.rebindMount(cfg);
    }
    this.cfgMount = cfg;
    // update 幂等：重复 render 不会产生重复节点。
    this.cfgView.update(this.script);
    // 重建后回填运行态（update 会重置为 pending，需用同一真相源 stepStatus 恢复）。
    this.syncAllCfgStatuses();
    // 重建后恢复当前选中态（若运行/编辑期间有选中）。
    if (this.selectedStepId) this.cfgView.setSelected(this.selectedStepId);
    body.appendChild(cfg);

    // Git 版本面板：按产品决策默认不挂载（解耦可选插件，保留 VersionPanel 类与
    // version-store 接口，由宿主配置决定是否启用）。主体「生成脚本」流程不依赖它。
    if (this.enableVersionPanel) {
      const ver = document.createElement('div');
      ver.className = 'ui-shell-version';
      ver.setAttribute('data-version', 'true');
      if (!this.versionPanel) {
        this.versionPanel = new VersionPanel({
          mount: ver,
          store: this.versionStore,
          onSwitch: (name) => this.applyVersionStore(vSwitchTo(this.versionStore, name)),
          onCherryPick: (hash) => this.applyVersionStore(vCherryPick(this.versionStore, hash)),
          canCherryPick: () => this.versionStore.currentBranch !== 'main' || getBranches(this.versionStore).length > 1,
        });
      } else {
        this.versionPanel.rebindMount(ver);
        this.versionPanel.update(this.versionStore);
      }
      body.appendChild(ver);
    }
  }

  /** 应用版本库新状态：写回 store 并刷新面板（不可变：新 store 替换旧引用）。 */
  private applyVersionStore(next: VersionStore): void {
    this.versionStore = next;
    this.versionPanel?.update(next);
  }

  /** 暴露版本库入口操作给外部（如录制落盘时提交、UI 按钮创建分支/标签）。 */
  versionCommit(message: string): void {
    this.applyVersionStore(vCommit(this.versionStore, message, this.script));
  }
  versionBranch(name: string): void {
    this.applyVersionStore(vBranch(this.versionStore, name));
  }
  versionTag(name: string): void {
    this.applyVersionStore(vTag(this.versionStore, name));
  }

  /** 构造单条步骤 DOM 项（render 与增量 append 复用）。 */
  private buildStepItem(step: Step, idx: number): HTMLElement {
    const item = document.createElement('div');
    const status = this.getStepStatus(step.id);
    item.className = `ui-shell-step-item is-${status}`;
    item.setAttribute('data-step-item', String(idx));
    item.setAttribute('data-step-id', step.id);
    item.setAttribute('data-step-status', status);
    // 选中态经统一入口设置（属性 + class 同步），避免 render 重建后丢样式。
    this.markStepItemSelected(item, step.id === this.selectedStepId);
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
