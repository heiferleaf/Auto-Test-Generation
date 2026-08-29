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
import { Recorder, type InteractionEvent, sameFillLocator, shouldKeepRecordingEvent } from '../recorder/recorder';
import { ScriptEditor, isAtomicGroup } from '../editor/editor';
import { parseShotsMap, shotToBase64, shotToDataUrl } from '../script/io';
import { SCRIPT_SCHEMA } from '../types/step';
import { CfgView, SHOT_HINT_NONE } from './cfg-view';
import { TYPE_LABEL, describeLocator, describeStepBrief } from './step-label';
import { mapHighlightRect, viewportFromRect } from './highlight-map';
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
import { WORDMARK_TEXT, mountWordmark } from './wordmark';

/** 回放结果（与 cli.CliResult 同构，但由内核产生，UI 壳不依赖 cli 模块）。 */
export type PlaybackResult = { ok: boolean; failedStepId?: string };

/**
 * 逐步高亮截图计划：stepId → 该步截图参数。随 playback 一起交给内核，
 * 由内核（桥端）在**执行该步之前**拍这一张 —— 拍完才放行执行（executor 会 await running 上报）。
 *
 * 为什么不能等浏览器收到 running 事件后再补拍：那样截图请求会和该步的点击/输入赛跑，
 * 真机上往往拍到执行**之后**的画面，而这一步要操作的元素那时可能已经变了或没了，
 * 高亮框必然画不上（且全程静默不报错）。这正是"Agent 脚本没有高亮、录制的有"的根因。
 *
 * 必须 JSON 可序列化：UiKernel 会被 WsKernel 跨 WebSocket 实现。
 */
export type StepShotPlan = Record<string, { highlight?: Locator; target?: string }>;

/** 预演单步结论。**只有两种**：找到了 / 当前状态下不存在。后者不是失败。 */
export type DryRunOutcome = 'found' | 'notYetPresent';

export type DryRunStepResult = {
  stepId: string;
  outcome: DryRunOutcome;
  /** 人读（也给 Agent 读）的结论说明，`notYetPresent` 时必须说清"为什么没有"。 */
  message: string;
  rect?: VisualRect;
};

export type DryRunReport = {
  /** false = 预演根本没跑（未连接 / 内核不支持定位），此时看 notice。 */
  ran: boolean;
  notice?: string;
  results: DryRunStepResult[];
  foundCount: number;
  notYetCount: number;
};

/** 手动可插入的步骤类型（spec §2.4 仅 3 类；click/fill 等仅由录制产生，循环走组操作）。 */
type ManualStepType = 'wait' | 'waitUntil' | 'assert';

/** 详情/打包簇出现与消失的时长，与 index.html 的 180ms 动画对齐。 */
const UI_MOTION_MS = 180;

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
  /** 按脚本回放（内核职责：真机驱动 adapter / 演示返回假结果）。
   *  fromStepId 可选「从此处运行」起点（spec §2.7），不传为从头跑（向后兼容）。
   *  shotPlan 可选逐步截图计划（见 StepShotPlan）：执行到某步、**执行该步之前**拍一张。 */
  playback(script: Script, fromStepId?: string, shotPlan?: StepShotPlan): Promise<PlaybackResult>;
  /** 订阅服务端主动推送事件（'recording' / 'step-progress' / 'pick' / 'load-script'）；可选。 */
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

/**
 * 断言 kind 的行为描述（单一真相源）：新增断言类型只改这里，
 * 标签、选择菜单、详情区显隐全部跟随。OCP：扩展而非在调用处堆 if-else。
 *
 * - needsValue：要不要填「期望值」；`multiline` 时用 textarea（提示词是一段话）。
 * - promptOnly：值字段的标签与占位（visionPrompt 填的是提示词，不是"期望值"）。
 * - showsPick：要不要显示「在软件中点选」；判整张截图的不点选。
 */
export type AssertionKindSpec = {
  kind: AssertionKind;
  label: string;
  needsValue: boolean;
  /** 值字段用多行输入（长文本/提示词）。 */
  multiline?: boolean;
  /** 值字段的标签，缺省为「期望值」。 */
  valueLabel?: string;
  /** 值字段的占位提示。 */
  valuePlaceholder?: string;
  /** 显示「在软件中点选」；缺省 true（多数断言有目标元素）。 */
  showsPick?: boolean;
  /** 类型下方的说明文案。 */
  help?: string;
};

export const ASSERTION_KINDS: AssertionKindSpec[] = [
  { kind: 'exists', label: '出现新元素', needsValue: false, help: 'exists：在 DOM 里即可，被隐藏也算存在' },
  { kind: 'visible', label: '元素可见', needsValue: false, help: 'visible：在屏幕上可见、未被隐藏' },
  {
    kind: 'textContains', label: '值包含内容', needsValue: true,
    help: '有点选则只搜该节点文本；无点选则搜整页（如点击后弹出）',
  },
  { kind: 'titleIs', label: '值等于特定值', needsValue: true, showsPick: false },
  { kind: 'urlMatches', label: 'URL 匹配', needsValue: true, showsPick: false },
  { kind: 'elementVisibleInViewport', label: '元素在视口内可见', needsValue: false },
  { kind: 'screenshotMatches', label: '截图匹配', needsValue: false, showsPick: false },
  { kind: 'expr', label: '表达式成立', needsValue: true, showsPick: false },
  {
    kind: 'visionPrompt',
    label: '视觉判定（截图 + 提示词）',
    needsValue: true,
    // 提示词通常是一句话甚至多句，单行 input 装不下且没法换行分段。
    multiline: true,
    valueLabel: '提示词',
    valuePlaceholder: '例：截图里是否出现了红色的错误提示？',
    // 判定对象是整张截图，不是某个元素，点选没有意义。
    showsPick: false,
    help: 'visionPrompt：截图后交给视觉模型按提示词判定；未配置 apikey 会判失败（不会静默跳过）',
  },
];

/** 取某 kind 的行为描述；未知 kind 退回「需要值、可点选」的保守默认。 */
function assertionSpec(kind: AssertionKind): AssertionKindSpec {
  return ASSERTION_KINDS.find((k) => k.kind === kind)
    ?? { kind, label: kind, needsValue: false };
}

/**
 * 详情区「类型」下拉里出现的 kind（人可编辑的子集）。
 * titleIs/urlMatches/expr/screenshotMatches 留给 Agent/MCP：
 * 它们要么要写代码、要么要准备基线图，塞进人工菜单只会让人选错。
 */
const UI_EDITABLE_KINDS: AssertionKind[] = [
  'visible', 'exists', 'textContains', 'visionPrompt',
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

/** spec §2.5：每条新步骤自身即一个顺序组，组名默认为封装文案。 */
function asAtomicGroup(step: Step): Step {
  if (step.control) return step;
  return {
    ...step,
    control: { kind: 'sequence', name: describeStepBrief(step) },
  };
}

/** 跨 WS 的截图可能是 Node Buffer，也可能是 { __base64 }。 */
function pngBase64(buf: unknown): string {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  if (typeof buf === 'object' && buf !== null && '__base64' in buf) {
    const b64 = (buf as { __base64?: unknown }).__base64;
    return typeof b64 === 'string' ? b64 : '';
  }
  if (typeof Buffer !== 'undefined' && typeof (Buffer as { isBuffer?: (x: unknown) => boolean }).isBuffer === 'function' && Buffer.isBuffer(buf)) {
    return buf.toString('base64');
  }
  return '';
}

/**
 * 详情区暴露给用户的断言类型子集（spec §2.3：断言元素可见/存在文本）。
 * 完整 AssertionKind 含 titleIs/urlMatches/expr/screenshotMatches 等，留给 Agent/MCP 用；
 * UI 只给人可编辑的常用几类，避免把不适用的人工选项塞给用户。
 *
 * visionPrompt 在此列：它是给人用的（填一句提示词即可），不像 expr 那样要写代码。
 * 由 ASSERTION_KINDS 过滤而来，新增类型只要标了 ui:true 就自动进菜单。
 */
const ASSERTION_UI_KINDS: { value: AssertionKind; label: string }[] = ASSERTION_KINDS
  .filter((k) => UI_EDITABLE_KINDS.includes(k.kind))
  .map((k) => ({ value: k.kind, label: `${k.label}(${k.kind})` }));

/** 该断言类型需要用户填写值（textContains 的文本 / visionPrompt 的提示词）。 */
function assertionNeedsValue(kind: AssertionKind): boolean {
  return assertionSpec(kind).needsValue;
}

/** 是否显示「在软件中点选」：判整张截图/整页文本的不点选。 */
function assertionShowsPick(kind: AssertionKind): boolean {
  return assertionSpec(kind).showsPick !== false;
}

/** 值字段是否用多行输入（提示词是一段话，单行装不下）。 */
function assertionValueMultiline(kind: AssertionKind): boolean {
  return assertionSpec(kind).multiline === true;
}

function assertionKindHelp(kind: AssertionKind): string {
  return assertionSpec(kind).help ?? '';
}

/** locator 是否带了任一可查询字段（空对象 `{}` 经 JSON 往返后仍算「未选取」）。 */
function locatorIsPresent(loc?: Locator): loc is Locator {
  if (!loc) return false;
  return !!(loc.role || loc.name || loc.text || loc.testId || loc.css || loc.xpath);
}

/**
 * 点选状态给人看的文案。
 * textContains/expr 等无 locator 时执行器搜整页文本，不是漏了必填点选；
 * 「尚未选取」只留给 exists/visible 这类必须有目标节点的断言。
 */
function assertionPickHint(assertion?: Assertion): string {
  if (locatorIsPresent(assertion?.locator)) return describeLocator(assertion!.locator) || '尚未选取';
  if (assertion?.kind === 'textContains') return '整页文本，无需点选';
  if (assertion && assertionNeedsValue(assertion.kind) && !assertionShowsPick(assertion.kind)) {
    return '整页文本，无需点选';
  }
  return '尚未选取';
}

function defaultGroupName(kind: 'sequence' | 'if' | 'while'): string {
  if (kind === 'if') return '选择组';
  if (kind === 'while') return '循环组';
  return '顺序组';
}

/** 补拍/录制高亮用的 locator：步骤自身 → 断言 → 选择组条件。 */
function shotLocatorOf(step: Step): Locator | undefined {
  const loc = step.locator ?? step.params?.assertion?.locator ?? step.control?.condition?.locator;
  return locatorIsPresent(loc) ? loc : undefined;
}

export type FloatBox = { left: number; top: number; right: number; bottom: number };

/** 轴对齐盒是否相交（含边重叠）。用来保证详情/浮动钮不盖住步骤节点。 */
export function boxesIntersect(a: FloatBox, b: FloatBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 把浮动钮/详情锚在选区包围盒外侧。
 * 为什么不钉画布 (12,12)：那是 CFG 原点，选中节点在别处时按钮会看起来「停在栏左上」。
 * 详情优先右侧，不够则左侧，再不行上下外侧，避免盖住节点本身。
 */
export function floatingChromePosition(
  node: FloatBox,
  canvas: { width: number; height: number },
  overlay: { width: number; height: number },
  kind: 'toolbar' | 'detail',
  pad = 8,
): { left: number; top: number } {
  const nw = Math.max(1, overlay.width);
  const nh = Math.max(1, overlay.height);
  const maxL = Math.max(pad, canvas.width - nw - pad);
  const maxT = Math.max(pad, canvas.height - nh - pad);
  const rightX = node.right + pad;
  const leftX = node.left - nw - pad;
  const fitsRight = rightX + nw <= canvas.width - pad + 0.5;
  const fitsLeft = leftX >= pad - 0.5;

  let x: number;
  let y: number;
  if (kind === 'toolbar') {
    if (fitsRight) {
      x = rightX;
      y = node.top;
    } else {
      // 顶右：贴在包围盒上方、右对齐，仍算「步骤旁边」。
      x = Math.min(maxL, Math.max(pad, node.right - nw));
      y = node.top - nh - pad;
      if (y < pad) y = node.bottom + pad;
    }
  } else if (fitsRight) {
    x = rightX;
    y = node.top;
  } else if (fitsLeft) {
    x = leftX;
    y = node.top;
  } else {
    const roomR = canvas.width - node.right;
    const roomL = node.left;
    x = roomR >= roomL ? Math.min(rightX, maxL) : Math.max(pad, leftX);
    y = node.top;
  }

  x = Math.min(maxL, Math.max(pad, x));
  y = Math.min(maxT, Math.max(pad, y));

  const placed = { left: x, top: y, right: x + nw, bottom: y + nh };
  if (boxesIntersect(placed, node)) {
    y = node.top - nh - pad;
    if (y < pad) y = node.bottom + pad;
    y = Math.min(maxT, Math.max(pad, y));
    const retry = { left: x, top: y, right: x + nw, bottom: y + nh };
    if (boxesIntersect(retry, node)) {
      x = Math.min(maxL, Math.max(pad, node.right + pad));
      y = Math.min(maxT, Math.max(pad, node.top));
    }
  }

  return { left: Math.min(maxL, Math.max(pad, x)), top: Math.min(maxT, Math.max(pad, y)) };
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
  /** 画布尺寸变化时重算浮动钮/详情位置（只在真实有宽高时启用，避免 jsdom 空盒冲掉测试坐标）。 */
  private chromeObserver?: ResizeObserver;
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
  /** 橡皮筋松手后待打包的 id；有值时渲染 [data-pack-menu]。 */
  private packMenuIds?: string[];
  /** 正在播放离开动画，到期后再全量 render，避免打包钮/详情瞬切。 */
  private motionTimer: ReturnType<typeof setTimeout> | undefined;
  /** 详情叠加层是否打开。点节点默认只查看截图；点「编辑」才打开。 */
  private detailOpen = false;
  /** 点选/框选后流图主栏；点空白后截图主栏。录制中始终流图主栏。 */
  private cfgPrimary = false;
  /** 舞台当前预览的 stepId（悬停可切，离开不撤回）。 */
  private previewStepId?: string;
  /** 预览来自悬停：render 时不要用选中组把图清成空白。 */
  private previewFromHover = false;
  /** 刚保存成功：给详情一条可见确认，避免点了保存像没反应。 */
  private saveNotice = false;
  /** 插入菜单展开态：点击「插入步骤」切换，决定是否渲染 4 类子菜单。 */
  private insertMenuOpen = false;
  /** Git 版本面板是否挂载（可选插件，默认隐藏）。 */
  private enableVersionPanel: boolean;
  /** 顶部提示横幅文本（演示模式说明 / 未连接真机录制警告）。render 会据此重建，故不会被后续 render 冲掉。 */
  private bannerText?: string;
  /** 横幅样式变体：true=琥珀色（显式演示），false=红色（降级/错误）。 */
  private bannerDemo = false;
  /** 每步一张靶机截图（不进 Step JSON）。key = step.id。 */
  private stepShots = new Map<string, { png: string; rect?: VisualRect }>();

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

  /**
   * 桥/MCP 把一份 Script JSON 推进当前工作台。坏数据只出横幅，不让 render 白屏。
   * 入参经 JSON 可能是 null，不能依赖默认参数。
   */
  private onLoadScript = (data: unknown): void => {
    try {
      this.loadScript(data);
    } catch (err) {
      this.setBanner(`无法载入脚本：${err instanceof Error ? err.message : String(err)}`);
    }
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
      // 点叠加详情内部（输入框等）不要关层。
      if (el.closest('[data-detail]')) return;
      // 点舞台：关掉详情，保留当前步以便继续看截图。
      if (el.closest('[data-stage]')) {
        if (this.detailOpen) this.closeInspector();
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
    this.mount.setAttribute('tabindex', '-1');
    this.mount.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.onEscape();
    });
    // 工作台指针只改 CSS 变量，雾块/光斑用 transition 缓过去；装饰层 pointer-events:none，点击仍打到 CFG。
    this.mount.addEventListener('pointermove', (e: PointerEvent) => {
      const rect = this.mount.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (!w || !h) return;
      const x = ((e.clientX - rect.left) / w) * 100;
      const y = ((e.clientY - rect.top) / h) * 100;
      this.mount.style.setProperty('--fluid-x', `${x.toFixed(2)}%`);
      this.mount.style.setProperty('--fluid-y', `${y.toFixed(2)}%`);
    });
    // 常驻：对话/MCP 经桥推入脚本时立刻画 CFG。导入按钮仍是另一条用户路径。
    this.kernel.on?.('load-script', this.onLoadScript);
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
        this.applyGroupKind('if');
        break;
      case 'wrap-while':
        this.applyGroupKind('while');
        break;
      case 'wrap-sequence': {
        const ids = this.packOverlayIds();
        if (ids.length >= 2) {
          this.selectedIds = new Set(ids);
          this.packMenuIds = undefined;
          this.wrapSelection('sequence');
        }
        break;
      }
      case 'edit': {
        const id = el.getAttribute('data-step-id') ?? this.selectedStepId ?? '';
        if (id) this.openInspector(id);
        break;
      }
      case 'select-target': {
        const sel = el as HTMLSelectElement;
        if (sel.value) this.selectTarget(sel.value);
        break;
      }
      case 'unpack': {
        const id = el.getAttribute('data-step-id') ?? this.selectedStepId ?? [...this.selectedIds][0] ?? '';
        const step = id ? this.findStep(id) : undefined;
        if (id && step && !isAtomicGroup(step)) {
          this.script = ScriptEditor.unpack(this.script, id);
          this.render();
        }
        break;
      }
      case 'add-else': {
        const id = el.getAttribute('data-step-id') ?? this.selectedStepId ?? '';
        if (id) { this.script = ScriptEditor.addElseBranch(this.script, id); this.render(); }
        break;
      }
      case 'remove-else': {
        const id = el.getAttribute('data-step-id') ?? this.selectedStepId ?? '';
        if (id) { this.script = ScriptEditor.removeElseBranch(this.script, id); this.render(); }
        break;
      }
      case 'pack-choice': {
        const kind = (el.getAttribute('data-pack-choice') ?? el.getAttribute('data-pack-kind')) as 'sequence' | 'if' | 'while' | null;
        if (kind && this.packMenuIds?.length) {
          this.selectedIds = new Set(this.packMenuIds);
          this.packMenuIds = undefined;
          this.wrapSelection(kind);
        }
        break;
      }
      case 'import': {
        const input = this.mount.querySelector('[data-import-file]') as HTMLInputElement | null;
        input?.click();
        break;
      }
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
      case 'remove': {
        const id = el.getAttribute('data-step-id') ?? this.selectedStepId ?? '';
        if (id) this.removeStep(id);
        break;
      }
      case 'cancel-edit':
      case 'close-inspector':
        this.closeInspector();
        break;
      case 'toggle-record':
        // 不在此处同步 render：startRecording 先置 recording=true 再 await，
        // 否则按钮仍写「开始录制」，用户会以为没点上（甚至再点一次变成停止）。
        if (this.isRecording()) void this.stopRecording();
        else void this.startRecording();
        break;
      case 'run-all':
        if (!this.connected) {
          this.runNoticeText = '未连接靶机，无法运行';
          this.lastFailedStepId = undefined;
          this.render();
          break;
        }
        void this.runAll().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.runNoticeText = `运行失败：${msg}`;
          this.lastFailedStepId = undefined;
          this.render();
        });
        break;
      case 'export':
        this.downloadScript();
        break;
      case 'clear':
        if (this.script.steps.length === 0) break;
        if (typeof window !== 'undefined' && !window.confirm('确定清空全部步骤？此操作不能撤销。')) break;
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
    // 该步的高亮截图由内核在执行该步之前拍好随事件下发（跨 WS 边界：null 当没有，不靠默认值）。
    const shot = (d as { shot?: unknown }).shot;
    const fresh = typeof shot === 'string' && shot.length > 0;
    if (fresh) this.storedStepShot(stepId, shot as string);
    if (fresh || status === 'running') this.showStoredShot(stepId);
    this.setStepStatus(stepId, status);
  };

  /**
   * 记下某一步的高亮截图。旧内核不逐步截图时收不到 shot，此处不会被调用 ——
   * 那一步就保持「未运行，暂无截图」，不给假图充数。
   */
  private storedStepShot(stepId: string, png: string): void {
    this.stepShots.set(stepId, { png });
    this.cfgView?.setShot(stepId, true);
  }

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
    this.runNoticeText = undefined;
    this.render();
    // 刻意不补拍：截图只跟执行走（执行到某步、执行该步之前拍），
    // 连接时靶机还在初始状态，那时拍第 N 步只能拍到一张没有该元素的误导性图。
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
    // fill 指纹不含 value：同一框连续输入要就地更新，不能因 n→nihao 被当成新步。
    if (ev.type === 'fill') return JSON.stringify({ t: ev.type, l: ev.locator, tg: ev.target });
    return JSON.stringify({ t: ev.type, l: ev.locator, p: ev.params, tg: ev.target });
  }

  /** 录制增量回调：稳定引用，便于 start/stop 配对 on/off，避免多次开始叠加监听。 */
  private onRecordingPush = (data: unknown): void => {
    this.onRecordingEvent(data as InteractionEvent);
  };

  async startRecording(): Promise<void> {
    // 先进入录制态并立刻渲染（spec §2.2：顶部 ● 录制中、按钮改「停止录制」），
    // 再 await 内核。否则 WS 往返期间界面毫无变化，用户不知道有没有开始。
    this.recorder.reset();
    this.recordedKeys.clear();
    this.kernel.off?.('recording', this.onRecordingPush);
    this.kernel.on?.('recording', this.onRecordingPush);
    this.recording = true;
    this.bannerText = '';
    this.render();
    try {
      await this.kernel.startRecording();
    } catch (e) {
      this.recording = false;
      this.kernel.off?.('recording', this.onRecordingPush);
      const msg = e instanceof Error ? e.message : String(e);
      this.setBanner(`录制失败：尚未连接靶机（${msg}）。请先启动软件调试端口，刷新页面后再试。`);
    }
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
    // 点选子模式优先：这次点击是给表单填 locator，不得写成普通录制步（spec §2.3）。
    if (this.pickMode) return;
    if (!shouldKeepRecordingEvent(ev.locator ? { ...ev, locator: ev.locator } : ev)) return;
    if (ev.type === 'fill') {
      const last = this.lastRecordedLeaf();
      if (last?.type === 'fill' && sameFillLocator(last.locator, ev.locator)) {
        this.script = ScriptEditor.updateNested(this.script, last.id, {
          params: { ...last.params, value: ev.params?.value },
          control: { kind: 'sequence', name: describeStepBrief({ ...last, params: { ...last.params, value: ev.params?.value } }) },
        });
        this.cfgView?.update(this.script);
        this.syncAllCfgShots();
        void this.captureStepShot(last.id, shotLocatorOf(last), ev.target);
        this.selectStep(last.id);
        return;
      }
      const step = asAtomicGroup(this.recorder.toSingleStep(ev));
      this.script = ScriptEditor.insert(this.script, step);
      this.appendStepEl(step);
      void this.captureStepShot(step.id, shotLocatorOf(step), ev.target);
      this.selectStep(step.id);
      return;
    }
    const key = this.eventKey(ev);
    if (this.recordedKeys.has(key)) return;
    this.recordedKeys.add(key);
    const step = asAtomicGroup(this.recorder.toSingleStep(ev));
    this.script = ScriptEditor.insert(this.script, step);
    this.appendStepEl(step);
    void this.captureStepShot(step.id, shotLocatorOf(step), ev.target);
    this.selectStep(step.id);
  }

  /** 脚本末条可合并的叶子（原子组就是它自己）。 */
  private lastRecordedLeaf(): Step | undefined {
    const last = this.script.steps[this.script.steps.length - 1];
    if (!last) return undefined;
    if (last.control?.kind === 'sequence' && last.children?.length) {
      return last.children[last.children.length - 1];
    }
    return last;
  }

  async stopRecording(): Promise<void> {
    this.kernel.off?.('recording', this.onRecordingPush);
    const events = await this.kernel.stopRecording();
    const wasRecording = this.recording;
    this.recording = false;
    // 仅当确实处于录制态才消费事件，避免脏数据（如 __recBuf 残留、
    // 或误调用 stop 而内核恰好返回缓存事件）被误插入脚本。
    if (wasRecording && events.length > 0) {
      for (const ev of events) {
        if (ev.type === 'fill') {
          this.onRecordingEvent(ev);
          continue;
        }
        const key = this.eventKey(ev);
        if (this.recordedKeys.has(key)) continue;
        this.recordedKeys.add(key);
        const step = asAtomicGroup(this.recorder.toSingleStep(ev));
        this.script = ScriptEditor.insert(this.script, step);
        void this.captureStepShot(step.id, shotLocatorOf(step), ev.target);
      }
    }
    this.render(); // 停止后全量刷新，保证一致
  }

  // ---- 编辑（不可变，委托 ScriptEditor）----

  insertStep(step: Step, index?: number): void {
    const wrapped = asAtomicGroup(step);
    this.script = ScriptEditor.insert(this.script, wrapped, index);
    this.detailOpen = true;
    this.cfgPrimary = true;
    this.render();
    void this.captureStepShot(wrapped.id, shotLocatorOf(wrapped), wrapped.target);
    this.selectStep(wrapped.id);
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

  /** 编辑某步：打开叠加详情（点节点默认只查看截图，要改字段才走这里）。 */
  editStep(stepId: string): void {
    this.openInspector(stepId);
  }

  /**
   * 渲染步骤详情/编辑区（spec §2.6）：类型/定位/参数可改，保存=不可变更新。
   * 挂在 mount 内的独立片段 [data-edit-area]，不占用步骤列表 DOM。
   */
  private renderEditArea(step: Step): void {
    const pane = this.mount.querySelector('[data-detail]') as HTMLElement | null;
    if (!pane) return;
    pane.innerHTML = '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ui-shell-inspector-close';
    close.setAttribute('data-inspector-close', 'true');
    close.setAttribute('data-action', 'close-inspector');
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    pane.appendChild(close);
    const paneTitle = document.createElement('div');
    paneTitle.className = 'ui-shell-pane-title';
    paneTitle.textContent = '详情 / 编辑';
    pane.appendChild(paneTitle);

    const scroll = document.createElement('div');
    scroll.className = 'ui-shell-detail-scroll';
    scroll.setAttribute('data-inspector-scroll', 'true');
    scroll.style.overflow = 'auto';
    scroll.style.maxHeight = 'min(64vh, 460px)';

    const area = document.createElement('div');
    area.className = 'ui-shell-edit-area';
    area.setAttribute('data-edit-area', 'true');

    const title = document.createElement('div');
    title.className = 'ui-shell-edit-title';
    title.textContent = `编辑步骤：${describeStep(step)}`;
    area.appendChild(title);

    const pickField = pickFieldFor(step);

    // 组节点详情：组名、循环次数、Else。拆包只在选区浮动钮上，不进详情。
    if (step.control) {
      area.appendChild(this.editField(step, 'control.name', '组名', step.control.name ?? ''));
      if (step.control.kind === 'while') {
        area.appendChild(this.editField(step, 'control.loopCount', '循环次数', String(step.control.loopCount ?? 1)));
      }
      if (step.control.kind === 'if') {
        const hasElse = !!(step.children && step.children[1]);
        const eb = document.createElement('button');
        eb.textContent = hasElse ? '移除 Else 分支' : '增加 Else 分支';
        eb.setAttribute('data-action', hasElse ? 'remove-else' : 'add-else');
        eb.setAttribute('data-step-id', step.id);
        area.appendChild(eb);
      }
    }

    // 定位：先给人看封装（role + [name] + 截断 css），完整 css 放可展开字段里改。
    if (step.locator) {
      if (!pickField) {
        const encap = document.createElement('div');
        encap.className = 'ui-shell-encap';
        encap.setAttribute('data-encap', 'true');
        encap.setAttribute('data-locator-human', 'true');
        encap.textContent = describeLocator(step.locator) || '（无定位）';
        area.appendChild(encap);
      }
      area.appendChild(this.editField(step, 'locator.name', '定位名称(name)', step.locator.name ?? ''));
      if (step.locator.role) {
        area.appendChild(this.editField(step, 'locator.role', '定位角色(role)', step.locator.role));
      }
      const path = document.createElement('details');
      path.className = 'ui-shell-locator-path';
      path.setAttribute('data-locator-path', 'true');
      const sum = document.createElement('summary');
      sum.textContent = '完整 css 路径';
      path.appendChild(sum);
      path.appendChild(this.editField(step, 'locator.css', 'css', step.locator.css ?? ''));
      area.appendChild(path);
    }
    // 参数：fill/select 的 value、wait 的 durationMs、waitUntil/assert 的 timeoutMs。
    const val = step.params?.value ?? step.params?.optionText;
    if (val !== undefined) {
      area.appendChild(this.editField(step, 'params.value', '输入值(value)', val));
    }
    if (step.params?.durationMs !== undefined) {
      area.appendChild(this.editField(step, 'params.durationMs', '等待毫秒(durationMs)', String(step.params.durationMs)));
    }
    // 断言表单顺序：类型 → 点选（若需要）→ 期望值（若需要）→ 最长等待 → 确定；关闭用右上角 X。
    const assertion = step.params?.assertion;
    if (assertion) {
      const kindRow = this.wrapAssertSlot('kind', this.editSelect(
        step, 'assertion.kind', '类型', ASSERTION_UI_KINDS, assertion.kind,
        (v) => this.onKindChange(step.id, 'assertion', v),
      ));
      const help = assertionKindHelp(assertion.kind);
      if (help) {
        const hint = document.createElement('div');
        hint.className = 'ui-shell-assert-hint';
        hint.setAttribute('data-assert-hint', 'true');
        hint.textContent = help;
        kindRow.appendChild(hint);
      }
      area.appendChild(kindRow);
      if (pickField === 'assertion-locator' && assertionShowsPick(assertion.kind)) {
        area.appendChild(this.wrapAssertSlot('pick', this.renderPickBlock(step, pickField, assertion, '在软件中点选')));
      }
      if (assertionNeedsValue(assertion.kind)) {
        const spec = assertionSpec(assertion.kind);
        area.appendChild(this.wrapAssertSlot('value', this.editField(
          step, 'assertion.value', spec.valueLabel ?? '期望值', assertion.value ?? '',
          { multiline: assertionValueMultiline(assertion.kind), placeholder: spec.valuePlaceholder },
        )));
        if (assertion.kind === 'visionPrompt') {
          area.appendChild(this.renderVisionKeyHint());
        }
      }
      if (step.type === 'waitUntil') {
        area.appendChild(this.wrapAssertSlot(
          'timeout',
          this.editField(step, 'params.timeoutMs', '最长等待(ms)', String(step.params?.timeoutMs ?? 5000)),
        ));
      }
    }
    const condition = step.control?.condition;
    if (step.control?.kind === 'if') {
      const cond = condition ?? ({ kind: 'visible' } as Assertion);
      const kindRow = this.wrapAssertSlot('kind', this.editSelect(
        step, 'condition.kind', '类型', ASSERTION_UI_KINDS, cond.kind,
        (v) => this.onKindChange(step.id, 'condition', v),
      ));
      const help = assertionKindHelp(cond.kind);
      if (help) {
        const hint = document.createElement('div');
        hint.setAttribute('data-assert-hint', 'true');
        hint.textContent = help;
        kindRow.appendChild(hint);
      }
      area.appendChild(kindRow);
      if (assertionShowsPick(cond.kind)) {
        area.appendChild(this.wrapAssertSlot('pick', this.renderPickBlock(step, 'condition-locator', cond, '点选执行条件')));
      }
      if (assertionNeedsValue(cond.kind)) {
        const spec = assertionSpec(cond.kind);
        area.appendChild(this.wrapAssertSlot('value', this.editField(
          step, 'condition.value', spec.valueLabel ?? '期望值', cond.value ?? '',
          { multiline: assertionValueMultiline(cond.kind), placeholder: spec.valuePlaceholder },
        )));
        if (cond.kind === 'visionPrompt') {
          area.appendChild(this.renderVisionKeyHint());
        }
      }
    }

    // 确定/删除放进同一行等宽：截图里确定是左对齐小条、删除独占整行，那才是要改的布局。
    const actions = document.createElement('div');
    actions.className = 'ui-shell-edit-actions';
    actions.setAttribute('data-edit-actions', 'true');
    const save = document.createElement('button');
    save.textContent = this.saveNotice ? '已保存' : '确定';
    save.className = 'primary';
    save.setAttribute('data-action', 'save-edit');
    save.setAttribute('data-step-id', step.id);
    actions.appendChild(save);
    const del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'danger';
    del.setAttribute('data-action', 'remove');
    del.setAttribute('data-step-id', step.id);
    actions.appendChild(del);
    area.appendChild(this.wrapAssertSlot('actions', actions));

    if (this.saveNotice) {
      const notice = document.createElement('div');
      notice.className = 'ui-shell-save-notice';
      notice.setAttribute('data-save-notice', 'true');
      notice.textContent = '已保存';
      area.appendChild(notice);
    }

    scroll.appendChild(area);
    pane.appendChild(scroll);
  }

  /** 统一处理「保存编辑」：从编辑区表单读取并不可变更新对应步骤。 */
  private saveEdit(stepId: string): void {
    const step = this.findStep(stepId);
    const area = this.mount.querySelector('[data-edit-area]');
    if (!step || !area) return;
    const patch: Partial<Step> = {};
    // 用 HTMLInputElement | HTMLTextAreaElement：提示词是多行 textarea，
    // 与单行 input 都靠 .value 读取，走同一套回写逻辑。
    area.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-edit-field]').forEach((inp) => {
      const path = inp.getAttribute('data-edit-field')!;
      const v = inp.value;
      // 多个 locator/params/control 字段须累加到同一 patch 对象，不能各自覆盖（否则后者丢失前者）。
      if (path === 'locator.name') patch.locator = { ...(patch.locator ?? step.locator), name: v };
      else if (path === 'locator.role') patch.locator = { ...(patch.locator ?? step.locator), role: v };
      else if (path === 'locator.css') patch.locator = { ...(patch.locator ?? step.locator), css: v };
      else if (path === 'params.value') patch.params = { ...(patch.params ?? step.params), value: v };
      else if (path === 'params.durationMs') patch.params = { ...(patch.params ?? step.params), durationMs: Number(v) || 0 };
      else if (path === 'params.timeoutMs') patch.params = { ...(patch.params ?? step.params), timeoutMs: Number(v) || 0 };
      else if (path === 'assertion.kind') {
        // 保留同次保存已写入的 params 字段与 assertion 子字段（value 等），不互相覆盖。
        const baseParams = patch.params ?? step.params ?? {};
        const baseAssert = (patch.params?.assertion ?? step.params?.assertion) ?? ({ kind: 'visible' } as Assertion);
        patch.params = { ...baseParams, assertion: { ...baseAssert, kind: v as AssertionKind } };
      } else if (path === 'assertion.value') {
        const baseParams = patch.params ?? step.params ?? {};
        const baseAssert = (patch.params?.assertion ?? step.params?.assertion) ?? ({ kind: 'visible' } as Assertion);
        patch.params = { ...baseParams, assertion: { ...baseAssert, value: v } };
      } else if (path === 'condition.kind') {
        const baseCtrl = patch.control ?? step.control!;
        const baseCond = (patch.control?.condition ?? step.control?.condition) ?? ({ kind: 'visible' } as Assertion);
        patch.control = { ...baseCtrl, condition: { ...baseCond, kind: v as AssertionKind } };
      } else if (path === 'condition.value') {
        const baseCtrl = patch.control ?? step.control!;
        const baseCond = (patch.control?.condition ?? step.control?.condition) ?? ({ kind: 'visible' } as Assertion);
        patch.control = { ...baseCtrl, condition: { ...baseCond, value: v } };
      } else if (path === 'control.name') patch.control = { ...(patch.control ?? step.control!), name: v };
      else if (path === 'control.loopCount') patch.control = { ...(patch.control ?? step.control!), loopCount: Number(v) || 1 };
    });
    this.script = ScriptEditor.updateNested(this.script, stepId, patch);
    this.saveNotice = true;
    this.detailOpen = true;
    this.render();
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        this.saveNotice = false;
        const btn = this.mount.querySelector('[data-action="save-edit"]');
        if (btn) btn.textContent = '确定';
      }, 1600);
    }
  }

  /**
   * 视觉判定的 apikey 配置引导。
   *
   * 为什么要有它：visionPrompt 没配 apikey 时执行器会判失败（不静默跳过），
   * 用户如果不知道去哪配，只会看到一个"断言失败"，无从下手。
   * 这里**只给配置途径，不收集也不展示密钥**：密钥存宿主进程的环境变量/用户级配置，
   * 绝不进 Script JSON（脚本是要导出分享的产物）。
   */
  private renderVisionKeyHint(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ui-shell-assert-hint ui-shell-vision-key-hint';
    box.setAttribute('data-vision-key-hint', 'true');
    box.textContent =
      '需要视觉模型密钥：宿主进程设置环境变量 VISION_API_KEY（可配 VISION_API_BASE / VISION_MODEL），' +
      '或写入 ~/.electron-auto-test/vision.json。密钥不会存进脚本。';
    return box;
  }

  private wrapAssertSlot(name: string, child: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-assert-slot', name);
    wrap.appendChild(child);
    return wrap;
  }

  /** 点选块：exists/visible 必填；textContains 可选。命名组不显示「尚未选取」。 */
  private renderPickBlock(
    step: Step,
    field: 'assertion-locator' | 'condition-locator',
    assertion: Assertion | undefined,
    label: string,
  ): HTMLElement {
    const box = document.createElement('div');
    const pick = document.createElement('button');
    pick.className = 'ui-shell-pick-btn';
    pick.textContent = label;
    pick.setAttribute('data-action', 'pick');
    pick.setAttribute('data-pick-step-id', step.id);
    pick.setAttribute('data-pick-field', field);
    if (!this.connected || !this.kernel.startPick) {
      pick.disabled = true;
      pick.title = '请先连接靶机';
    }
    box.appendChild(pick);
    const namedGroup = !!(step.control?.name);
    if (locatorIsPresent(assertion?.locator)) {
      const encap = document.createElement('div');
      encap.className = 'ui-shell-encap';
      encap.setAttribute('data-encap', 'true');
      encap.setAttribute('data-locator-human', 'true');
      encap.textContent = describeLocator(assertion!.locator) || '';
      box.appendChild(encap);
    } else {
      const hint = assertionPickHint(assertion);
      if (!(namedGroup && hint === '尚未选取')) {
        const encap = document.createElement('div');
        encap.className = 'ui-shell-encap';
        encap.setAttribute('data-encap', 'true');
        encap.setAttribute('data-locator-human', 'true');
        encap.textContent = hint;
        box.appendChild(encap);
      }
    }
    return box;
  }

  /** 生成一个可编辑输入行（label + input），input 带 data-edit-field 供保存时读取。 */
  /**
   * 生成文本输入行。
   * @param multiline 用 textarea（提示词这类长文本）；保存侧靠 data-edit-field 读取，
   *   与单行 input 完全同构，不需要额外的保存分支。
   */
  private editField(
    step: Step,
    path: string,
    label: string,
    value: string,
    opts: { multiline?: boolean; placeholder?: string } = {},
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'ui-shell-edit-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = opts.multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    if (!opts.multiline) (input as HTMLInputElement).type = 'text';
    input.value = value;
    if (opts.placeholder) input.setAttribute('placeholder', opts.placeholder);
    input.setAttribute('data-edit-field', path);
    row.appendChild(span);
    row.appendChild(input);
    return row;
  }

  /** 生成一个下拉选择行（label + select），select 带 data-edit-field 供保存时读取。
   * 选「断言/条件类型」时即时 onChange：把新 kind 写回步骤并重渲染编辑区，
   * 让 textContains 的「期望值」输入框立刻出现（否则要保存后才出现，交互不直观）。 */
  private editSelect(step: Step, path: string, label: string, options: { value: string; label: string }[], current: string, onChange?: (v: string) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'ui-shell-edit-field';
    const span = document.createElement('span');
    span.textContent = label;
    const sel = document.createElement('select');
    sel.setAttribute('data-edit-field', path);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      sel.appendChild(opt);
    }
    if (onChange) sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(span);
    row.appendChild(sel);
    return row;
  }

  /** 断言/条件类型变更：即时写回步骤并重渲染编辑区（让期望值字段按需出现/隐藏）。 */
  private onKindChange(stepId: string, which: 'assertion' | 'condition', kind: string): void {
    const step = this.findStep(stepId);
    if (!step) return;
    let patch: Partial<Step>;
    if (which === 'assertion') {
      const assertion = step.params?.assertion ?? ({ kind: 'visible' } as Assertion);
      patch = { params: { ...step.params, assertion: { ...assertion, kind: kind as AssertionKind } } };
    } else {
      const condition = step.control?.condition ?? ({ kind: 'visible' } as Assertion);
      patch = { control: { ...step.control!, condition: { ...condition, kind: kind as AssertionKind } } };
    }
    this.script = ScriptEditor.updateNested(this.script, stepId, patch);
    // 重渲染编辑区：用更新后的步骤，使期望值字段随 kind 显隐。
    const updated = this.findStep(stepId);
    if (updated) this.renderEditArea(updated);
  }

  /** 手动步骤类型：spec §2.4 仅暴露 3 类（wait/waitUntil/assert）；循环走组操作（§2.5）。 */
  private insertManualStep(type: 'wait' | 'waitUntil' | 'assert'): void {
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
      default:
        // 受控联合外的值（如非法注入）直接拒绝，避免 insertStep(undefined) 崩溃。
        console.warn('[UiShell] 未知手动步骤类型，已忽略:', type);
        return;
    }
    this.insertStep(step);
  }

  /** spec §2.5：对已有组设 kind；多选则先打包再设。 */
  private applyGroupKind(kind: 'if' | 'while'): void {
    const ids = this.selectedIdsForGroup();
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const s = this.findStep(ids[0]);
      if (!s) return;
      if (!s.control) {
        this.script = ScriptEditor.updateNested(this.script, ids[0], {
          control: { kind: 'sequence', name: describeStepBrief(s) },
        });
      }
      this.script = ScriptEditor.setGroupKind(this.script, ids[0], kind);
      this.selectedIds.clear();
      this.packMenuIds = undefined;
      this.detailOpen = true;
      this.cfgPrimary = true;
      this.render();
      return;
    }
    this.wrapSelection(kind);
  }

  private selectedIdsForGroup(): string[] {
    if (this.selectedIds.size > 0) return [...this.selectedIds];
    if (this.selectedStepId) return [this.selectedStepId];
    return [];
  }

  /** 把当前多选的步骤整体包成控制流组（spec §2.5）。空选集不操作（边界安全）。 */
  private wrapSelection(kind: 'sequence' | 'if' | 'while', typedName?: string): void {
    const ids = this.selectedIdsForGroup();
    if (ids.length === 0) return;
    const name = (typedName ?? defaultGroupName(kind)).trim() || defaultGroupName(kind);
    const groupId = `grp-${kind}-${Date.now().toString(36)}-${ids.length}`;
    this.script = ScriptEditor.wrap(this.script, ids, kind, groupId);
    this.script = ScriptEditor.renameGroup(this.script, groupId, name);
    this.selectedStepId = groupId;
    this.selectedIds.clear();
    if (this.selectedStepId) this.selectedIds.add(this.selectedStepId);
    this.packMenuIds = undefined;
    this.detailOpen = kind !== 'sequence';
    this.cfgPrimary = true;
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

  /** 导出脚本为 JSON 文件下载。配图写进同一份 JSON 的 shots。 */
  private downloadScript(): void {
    const json = this.exportScript();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'script.json'; a.click();
    URL.revokeObjectURL(url);
  }

  /** 测试/导出用：stepId → png base64。 */
  getStepShots(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, s] of this.stepShots) out[id] = s.png;
    return out;
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
  /** 未连接点运行全部等：不依赖 failedStepId 的提醒文案。 */
  private runNoticeText?: string;

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
    this.showStoredShot(stepId);
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

  /**
   * 把"哪些步已有高亮截图"全量回填到 CFG 卡片（节点重建后调用）。
   * 与 syncAllCfgStatuses 同构：卡片提示与 stepShots 保持同一真相源，不由视图各算一套。
   */
  private syncAllCfgShots(): void {
    if (!this.cfgView) return;
    for (const s of this.flattenSteps()) {
      this.cfgView.setShot(s.id, this.stepShots.has(s.id));
    }
  }

  /** 把选中态同步到两个兄弟视图（列表项 + CFG 节点）。 */
  private syncSelectedDom(stepId: string): void {
    // 列表项：先清旧、再置新。
    this.mount.querySelectorAll('[data-step-selected="true"]').forEach((el) =>
      this.markStepItemSelected(el, false),
    );
    this.markStepItemSelected(this.findStepItemEl(stepId), true);
    this.cfgView?.setSelected(stepId, this.selectedIds);
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
   * @param fromStepId 可选「从此处运行」起点（spec §2.7）：前序跳过该步之前的步骤。
   */
  async runAll(fromStepId?: string): Promise<PlaybackResult> {
    this.resetRunStatus();
    // 本次运行的步骤索引快照：单次构建，后续每步 O(1) 命中（避免 O(n²) 重复扁平化）。
    this.runIndex = new Map(this.flattenSteps().map((s) => [s.id, s]));
    ++this.highlightGen;
    this.sawProgress = false;

    // 进度监听器：每次运行订阅一次、结束时退订一次，避免多次 runAll 回调叠加。
    // 只需这一处订阅 —— CFG 节点状态由 setStepStatus 单点分发，不另开订阅。
    this.kernel.on?.('step-progress', this.onProgress);

    // 未连接就没有靶机可拍，不传计划（保持 playback 两参调用，也不让内核做无谓的截图尝试）。
    const shotPlan = this.connected ? this.buildShotPlan() : undefined;
    let res: PlaybackResult = { ok: false };
    try {
      res = (shotPlan === undefined
        ? await this.kernel.playback(this.getScript(), fromStepId)
        : await this.kernel.playback(this.getScript(), fromStepId, shotPlan)) ?? { ok: false };
    } catch (err) {
      // playback 抛错（桥校验失败、WS 断开、if 条件崩）以前会让 res 未赋值，
      // 后面读 res.ok 再抛一次，void runAll() 吞掉 → 用户点「运行全部」零反馈。
      const msg = err instanceof Error ? err.message : String(err);
      this.runNoticeText = `运行失败：${msg}`;
      res = { ok: false };
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
    if (res.ok) {
      this.lastFailedStepId = undefined;
      this.runNoticeText = undefined;
    } else {
      this.lastFailedStepId = res.failedStepId;
      if (!this.runNoticeText && !res.failedStepId) {
        this.runNoticeText = '运行失败，未定位到具体步骤。请查看 CFG 运行态。';
      }
    }
    this.render();
    // 失败高亮（spec §2.7）：把失败步滚入视口，让用户一眼定位到崩点。
    if (!res.ok && res.failedStepId) this.scrollStepIntoView(res.failedStepId);
    return res;
  }

  /** 把某步的 CFG 节点与列表项滚入视口（失败高亮用；运行跟随由 CFG setStatus 处理）。 */
  private scrollStepIntoView(stepId: string): void {
    const cfgNode = this.mount.querySelector(`[data-cfg-node="${stepId}"]`) as HTMLElement | null;
    if (cfgNode && typeof cfgNode.scrollIntoView === 'function') {
      cfgNode.scrollIntoView({ block: 'nearest' });
    }
    const listItem = this.mount.querySelector(`[data-step-item][data-step-id="${stepId}"]`) as HTMLElement | null;
    if (listItem && typeof listItem.scrollIntoView === 'function') {
      listItem.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 兼容旧「回放」入口（既有调用方零改动）。 */
  async playback(): Promise<PlaybackResult> {
    return this.runAll();
  }

  /**
   * 非破坏性预演：只验证每一步的 locator 在当前界面状态下能不能定位到，**不执行任何操作**。
   *
   * 用途：Agent 刚生成完脚本时先过一遍，快速知道"哪些元素现在就找得到"。
   * 适用范围（刻意如此，不是缺陷）：只对当前界面状态下就存在的元素有效。第 1 步通常有效；
   * 第 3 步那种"前两步跑完才出现"的元素，预演必然找不到 —— 那是预期行为，报成
   * `notYetPresent` 并说明原因，**绝不能报成错误**，否则会把 Agent 带偏。
   *
   * 副作用约定：全程只调 `kernel.locateVisual`（只读取 bounding box）。
   * 不点击、不填值、不切窗口、不调 playback、不截图，被测软件状态前后完全一致。
   *
   * 已知限制（刻意不绕过）：`locateVisual` 作用于当前选中的窗口，故跨窗口步骤
   * （step.target 指向别的窗口）会被判成 `notYetPresent`。为它调 selectTarget
   * 就等于产生副作用，与"非破坏性"相悖 —— 宁可结论保守，也不动靶机。
   */
  async dryRun(): Promise<DryRunReport> {
    const empty: DryRunReport = { ran: false, results: [], foundCount: 0, notYetCount: 0 };
    if (!this.connected) return { ...empty, notice: '未连接靶机，无法预演（先连上靶机再试）' };
    if (typeof this.kernel.locateVisual !== 'function') {
      return { ...empty, notice: '当前内核不支持视觉定位，无法预演' };
    }

    const results: DryRunStepResult[] = [];
    for (const step of this.flattenSteps()) {
      if (step.children?.length) continue;
      const loc = shotLocatorOf(step);
      // 整页断言（textContains）与纯等待没有"要操作的元素"，谈不上定位，跳过。
      if (!loc) continue;
      results.push(await this.probeStep(step, loc));
    }
    return {
      ran: true,
      results,
      foundCount: results.filter((r) => r.outcome === 'found').length,
      notYetCount: results.filter((r) => r.outcome === 'notYetPresent').length,
    };
  }

  /** 预演单步：只定位、不操作。定位失败（含内核抛错）一律算"当前状态下不存在"，不算失败。 */
  private async probeStep(step: Step, loc: Locator): Promise<DryRunStepResult> {
    const what = describeLocator(loc) || step.id;
    try {
      // 跨 WS 边界兜底：不依赖解构默认值，显式 ?? {}（§4.1 清单 1）。
      const rect = (await this.kernel.locateVisual(loc)) ?? {};
      if (rect.visible && rect.width > 0 && rect.height > 0) {
        return { stepId: step.id, outcome: 'found', message: `已确认存在：${what}`, rect };
      }
    } catch (err) {
      // 定位服务不可用等原因：如实带进文案，但不中断预演、也不把它报成脚本的错。
      const why = err instanceof Error ? err.message : String(err);
      return {
        stepId: step.id,
        outcome: 'notYetPresent',
        message: `当前状态下无法确认「${what}」（${why}）；若该元素需前序步骤执行后才出现，属预期行为`,
      };
    }
    return {
      stepId: step.id,
      outcome: 'notYetPresent',
      message: `该元素需前序步骤执行后才出现，无法在预演阶段验证：${what}`,
    };
  }

  private resetRunStatus(): void {
    this.stepStatus.clear();
    this.lastFailedStepId = undefined;
    // 重置图上所有节点状态为 pending（避免上一轮 pass/fail 残留，§4 测试「重跑」）。
    this.cfgView?.update(this.script);
    // update 会整树重建，卡片上的"未运行，暂无截图"标记随之丢失，必须按 stepShots 回填，
    // 否则跑第二轮时上一轮已拍到的步骤会被误标成没图。
    this.syncAllCfgShots();
  }

  /**
   * 逐步截图计划：每个叶子步骤一张，高亮它要操作的那个元素。
   * 组节点跳过（它不是"要操作的元素"）；无 locator 的步骤（纯等待 / 整页断言）也要拍整页，
   * 这样舞台的逐步流才不会断档。
   */
  private buildShotPlan(): StepShotPlan {
    const plan: StepShotPlan = {};
    for (const step of this.flattenSteps()) {
      if (step.children?.length) continue;
      const entry: { highlight?: Locator; target?: string } = {};
      const loc = shotLocatorOf(step);
      if (loc) entry.highlight = loc;
      if (step.target) entry.target = step.target;
      plan[step.id] = entry;
    }
    return plan;
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
    // 失败但没带 stepId：不能把所有步标成 pass（那会看起来像跑成功了）。
    if (!res.failedStepId) return;
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
  private async followHighlight(stepId: string, gen?: number): Promise<void> {
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
    const img = stage.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    let boxRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    if (img && img.naturalWidth && img.clientWidth) {
      const layout = {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        clientWidth: img.clientWidth,
        clientHeight: img.clientHeight,
      };
      const vp = viewportFromRect(r, layout);
      boxRect = mapHighlightRect(boxRect, vp, layout);
    }
    const box = document.createElement('div');
    box.className = 'ui-shell-highlight' + (rect ? '' : ' is-pending');
    box.setAttribute('data-highlight', 'true');
    box.setAttribute('data-highlight-step', stepId);
    const step = this.findStep(stepId);
    box.style.cssText =
      `position:absolute;left:${boxRect.x}px;top:${boxRect.y}px;` +
      `width:${boxRect.width}px;height:${boxRect.height}px;` +
      'pointer-events:none;box-sizing:border-box;z-index:3;';
    stage.appendChild(box);
    if (step) {
      const tag = document.createElement('div');
      tag.className = 'ui-shell-highlight-tag';
      tag.setAttribute('data-highlight-tag', 'true');
      tag.textContent = describeStepBrief(step);
      tag.style.cssText =
        `position:absolute;left:${boxRect.x}px;top:${Math.max(0, boxRect.y - 22)}px;` +
        'pointer-events:none;z-index:4;';
      stage.appendChild(tag);
    }
  }

  private clearHighlight(): void {
    this.mount.querySelectorAll('[data-highlight],[data-highlight-tag]').forEach((el) => el.remove());
  }

  // ---- 可视化 ----

  async highlight(loc: Locator): Promise<VisualRect> {
    return this.kernel.locateVisual(loc);
  }

  async captureFrame(): Promise<Buffer> {
    return this.kernel.screenshot();
  }

  /** 抓当前靶机画面，绑到该 step.id。有 locator 时先在靶机上画框再拍；target 用步骤上的窗口，不看下拉。 */
  private async captureStepShot(stepId: string, loc?: Locator, target?: string): Promise<void> {
    if (!this.connected) return;
    try {
      const opts: { highlight?: Locator; target?: string } = {};
      if (loc) opts.highlight = loc;
      if (target) opts.target = target;
      const buf = Object.keys(opts).length > 0
        ? await this.kernel.screenshot(opts)
        : await this.kernel.screenshot();
      const png = pngBase64(buf);
      if (!png || png.length < 8) return;
      this.storedStepShot(stepId, png);
      if (this.selectedStepId === stepId) this.showStoredShot(stepId);
    } catch (err) {
      console.warn('[UiShell] 步骤截图失败:', err instanceof Error ? err.message : err);
    }
  }

  /** 舞台只显示该步缓存图，不刷实时流。悬停也会走这里，离开不撤回。 */
  private showStoredShot(stepId: string): void {
    const stage = this.mount.querySelector('[data-stage]') as HTMLElement | null;
    if (!stage) return;
    stage.setAttribute('data-preview-step', stepId);
    stage.removeAttribute('data-preview-empty');
    const shot = this.stepShots.get(stepId);
    const hint = stage.querySelector('[data-frame]') as HTMLElement | null;
    let img = stage.querySelector('img.ui-shell-frame-img') as HTMLImageElement | null;
    if (!shot) {
      if (img) img.remove();
      this.clearHighlight();
      if (hint) hint.textContent = SHOT_HINT_NONE;
      return;
    }
    if (!img) {
      img = document.createElement('img');
      img.className = 'ui-shell-frame-img';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      stage.prepend(img);
    }
    img.src = `data:image/png;base64,${shot.png}`;
    if (hint) hint.textContent = '';
    this.clearHighlight();
  }

  private showBlankPreview(): void {
    const stage = this.mount.querySelector('[data-stage]') as HTMLElement | null;
    if (!stage) return;
    stage.setAttribute('data-preview-empty', 'true');
    stage.removeAttribute('data-preview-step');
    stage.querySelector('img.ui-shell-frame-img')?.remove();
    this.clearHighlight();
    const hint = stage.querySelector('[data-frame]') as HTMLElement | null;
    if (hint) hint.textContent = '';
  }

  private applyPreview(): void {
    if (this.previewFromHover && this.previewStepId) {
      this.showStoredShot(this.previewStepId);
      return;
    }
    if ((this.packMenuIds?.length ?? 0) >= 2 || this.selectedIds.size >= 2) {
      this.showBlankPreview();
      return;
    }
    const id = this.previewStepId ?? this.selectedStepId;
    if (!id) {
      this.showBlankPreview();
      return;
    }
    const step = this.findStep(id);
    if (step && this.isNonAtomic(step)) {
      this.showBlankPreview();
      return;
    }
    this.showStoredShot(id);
  }

  /**
   * 非产品路径：规格要求舞台只显示步骤截图。保留此方法仅供旧单测与显式调试调用。
   * 连接 / boot 不得自动开流。
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
    const shots = this.shotsPayload();
    const { shots: _ignored, ...rest } = this.script;
    const payload = Object.keys(shots).length > 0 ? { ...rest, shots } : rest;
    return ScriptEditor.save(payload);
  }

  /**
   * 导入同一份工作台 JSON。可选 sidecar 是 `*.shots.json`（{ shots } 或扁平 map）。
   * 配图写入 getStepShots，未连接也能在舞台看到。
   */
  importScript(json: string, sidecarJson?: string): void {
    this.script = ScriptEditor.load(json);
    this.stepShots.clear();
    this.hydrateShots(parseShotsMap(this.script));
    if (sidecarJson) {
      try {
        this.hydrateShots(parseShotsMap(JSON.parse(sidecarJson)));
      } catch {
        /* 侧车坏了不影响步骤导入 */
      }
    }
    this.detailOpen = false;
    this.packMenuIds = undefined;
    this.render();
    // 导入不补拍：截图在执行时逐步拍。内嵌/侧车带来的图已在上面 hydrateShots 灌入，
    // 这里把"哪些步有图"同步到卡片，免得卡片把带了图的步骤误标成「未运行，暂无截图」。
    this.syncAllCfgShots();
  }

  /**
   * 把一份 Script 推进当前 UI 会话（CFG + shots）。
   * 工作台「导入」按钮仍走文件选择 → importScript；本方法是对话/桥/将来 MCP `script.open` 的入口。
   * 跨 JSON 边界：null 当空对象，不靠函数默认参数。
   */
  loadScript(raw: unknown): void {
    const v = raw ?? {};
    const json = typeof v === 'string' ? v : JSON.stringify(v);
    this.importScript(json);
  }

  private hydrateShots(map: Record<string, string>): void {
    for (const [id, v] of Object.entries(map ?? {})) {
      const png = shotToBase64(v);
      if (png) this.stepShots.set(id, { png });
    }
  }

  private shotsPayload(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, s] of this.stepShots) {
      const url = shotToDataUrl(s.png);
      if (url) out[id] = url;
    }
    return out;
  }

  /** 录制/点选/点步/框选 → 流图主栏；闲置与悬停 → 截图主栏。 */
  private layoutMode(): 'flow' | 'shot' {
    if (this.recording || this.pickMode) return 'flow';
    if (this.cfgPrimary) return 'flow';
    return 'shot';
  }

  /** 顶栏旁注已连接靶机的窗口名，不是产品名。未连接则省略。 */
  private connectedTargetTitle(): string | undefined {
    if (!this.connected) return undefined;
    let targets: { id?: string; title?: string }[] = [];
    try { targets = (this.listTargets() ?? []) as { id?: string; title?: string }[]; } catch { targets = []; }
    const cur = targets.find((t) => t.id === this.currentTargetId) ?? targets[0];
    const title = cur?.title?.trim();
    return title || undefined;
  }

  private openInspector(stepId: string): void {
    if (!this.findStep(stepId)) return;
    this.selectedStepId = stepId;
    if (this.selectedIds.size <= 1) this.selectedIds = new Set([stepId]);
    this.detailOpen = true;
    this.cfgPrimary = true;
    this.saveNotice = false;
    this.render();
  }

  private closeInspector(): void {
    if (!this.detailOpen && !this.saveNotice) return;
    this.detailOpen = false;
    this.saveNotice = false;
    const pane = this.mount.querySelector('[data-detail]') as HTMLElement | null;
    this.mount.setAttribute('data-layout', this.layoutMode());
    if (pane && pane.getAttribute('data-detail-open') === 'true') {
      pane.classList.remove('is-open');
      pane.classList.add('is-leaving');
      pane.setAttribute('data-detail-open', 'false');
      this.afterMotion(() => this.render());
      return;
    }
    this.render();
  }

  /** 点 CFG 空白：回到截图主栏，关浮动钮和详情，保留最后点中步的高亮。 */
  private clearCfgBlank(): void {
    const menu = this.mount.querySelector('[data-pack-menu]') as HTMLElement | null;
    const pane = this.mount.querySelector('[data-detail]') as HTMLElement | null;
    this.packMenuIds = undefined;
    this.cfgPrimary = false;
    this.detailOpen = false;
    this.saveNotice = false;
    if (this.selectedStepId) this.selectedIds = new Set([this.selectedStepId]);
    else this.selectedIds.clear();
    this.mount.setAttribute('data-layout', this.layoutMode());
    let waiting = false;
    if (menu && !menu.hasAttribute('data-leaving')) {
      menu.classList.add('is-leaving');
      menu.setAttribute('data-leaving', 'true');
      waiting = true;
    }
    if (pane && pane.getAttribute('data-detail-open') === 'true') {
      pane.classList.remove('is-open');
      pane.classList.add('is-leaving');
      pane.setAttribute('data-detail-open', 'false');
      waiting = true;
    }
    if (waiting) {
      this.afterMotion(() => this.render());
      return;
    }
    this.render();
  }

  private afterMotion(fn: () => void): void {
    if (this.motionTimer !== undefined) {
      clearTimeout(this.motionTimer);
      this.motionTimer = undefined;
    }
    this.motionTimer = setTimeout(() => {
      this.motionTimer = undefined;
      fn();
    }, UI_MOTION_MS);
  }

  private onEscape(): void {
    if (this.pickMode) { this.exitPickMode(); return; }
    if (this.packMenuIds || this.selectedIds.size > 1) {
      this.clearCfgBlank();
      return;
    }
    if (this.detailOpen) this.closeInspector();
  }

  private selectForView(stepId: string): void {
    if (!this.findStep(stepId)) return;
    this.selectedStepId = stepId;
    this.selectedIds = new Set([stepId]);
    this.detailOpen = false;
    this.saveNotice = false;
    this.packMenuIds = undefined;
    this.cfgPrimary = true;
    this.previewFromHover = false;
    this.previewStepId = this.previewTargetOf(stepId);
    this.render();
  }

  /** 非原子组/框选没有逐步截图，舞台留空，避免残留上一步的图。 */
  private previewTargetOf(stepId: string): string | undefined {
    const step = this.findStep(stepId);
    if (!step) return undefined;
    if (this.isNonAtomic(step)) return undefined;
    return stepId;
  }

  private isNonAtomic(step: Step): boolean {
    if (step.children?.length) return true;
    return !!step.control && !isAtomicGroup(step);
  }

  private packActionIds(): string[] {
    if (this.packMenuIds && this.packMenuIds.length >= 2) return this.packMenuIds;
    if (this.selectedIds.size >= 2) return [...this.selectedIds];
    return [];
  }

  /** 框选（≥2）或 shot 布局下点单步：都要在包围盒旁出打包簇。 */
  private packOverlayIds(): string[] {
    const multi = this.packActionIds();
    if (multi.length > 0) return multi;
    if (this.selectedStepId) return [this.selectedStepId];
    return [];
  }

  /** 点选/框选后在选区边缘出浮动钮；闲置截图主栏时不出。 */
  private shouldShowPackOverlay(): boolean {
    if (!this.cfgPrimary) return false;
    return this.packOverlayIds().length > 0;
  }

  private packButtonSet(): 'atomic' | 'marquee' | 'group' {
    if ((this.packMenuIds?.length ?? 0) >= 2 || this.selectedIds.size >= 2) return 'marquee';
    const s = this.selectedStepId ? this.findStep(this.selectedStepId) : undefined;
    if (s && this.isNonAtomic(s)) return 'group';
    return 'atomic';
  }

  /** 浮动打包簇贴在选区包围盒右侧；右侧不够则放到选区上方。 */
  private placePackMenu(menu: HTMLElement, canvas: HTMLElement): void {
    const ids = this.packOverlayIds();
    this.placeOverlayNearIds(menu, canvas, ids, 'toolbar');
  }

  private placeDetailOverlay(pane: HTMLElement, canvas: HTMLElement): void {
    const id = this.selectedStepId;
    this.placeOverlayNearIds(pane, canvas, id ? [id] : [], 'detail');
  }

  /** pan/zoom/resize 后按当前节点盒重放浮动层，不整页 render。 */
  private repositionFloatingChrome(): void {
    const canvas = this.mount.querySelector('.ui-shell-cfg-canvas') as HTMLElement | null;
    if (!canvas) return;
    const menu = canvas.querySelector('[data-pack-menu]') as HTMLElement | null;
    if (menu) this.placePackMenu(menu, canvas);
    const pane = canvas.querySelector('[data-detail]') as HTMLElement | null;
    if (pane && pane.getAttribute('data-detail-open') === 'true') {
      this.placeDetailOverlay(pane, canvas);
    }
  }

  private watchFloatingChrome(canvas: HTMLElement): void {
    this.chromeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined' || canvas.clientWidth < 1) return;
    this.chromeObserver = new ResizeObserver(() => this.repositionFloatingChrome());
    this.chromeObserver.observe(canvas);
  }

  /** 节点盒相对画布；GCR 为空时走 offset，避免退回 CFG 原点。 */
  private nodeBoxInCanvas(node: HTMLElement, canvas: HTMLElement, canvasRect: DOMRect): FloatBox {
    const r = node.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) {
      return { left: r.left - canvasRect.left, top: r.top - canvasRect.top, right: r.right - canvasRect.left, bottom: r.bottom - canvasRect.top };
    }
    let x = 0;
    let y = 0;
    let cur: HTMLElement | null = node;
    while (cur && cur !== canvas) {
      x += cur.offsetLeft;
      y += cur.offsetTop;
      const next = cur.offsetParent as HTMLElement | null;
      if (!next || next === cur) break;
      cur = next;
    }
    const w = node.offsetWidth || 120;
    const h = node.offsetHeight || 36;
    return { left: x, top: y, right: x + w, bottom: y + h };
  }

  private placeOverlayNearIds(el: HTMLElement, canvas: HTMLElement, ids: string[], kind: 'toolbar' | 'detail'): void {
    const cr = canvas.getBoundingClientRect();
    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    let hit = false;
    for (const node of canvas.querySelectorAll('[data-cfg-node]')) {
      const id = node.getAttribute('data-cfg-node');
      if (!id || !ids.includes(id)) continue;
      const box = this.nodeBoxInCanvas(node as HTMLElement, canvas, cr);
      minL = Math.min(minL, box.left);
      minT = Math.min(minT, box.top);
      maxR = Math.max(maxR, box.right);
      maxB = Math.max(maxB, box.bottom);
      hit = true;
    }
    el.style.position = 'absolute';
    el.style.zIndex = kind === 'detail' ? '18' : '16';
    el.style.removeProperty('right');
    el.style.removeProperty('bottom');
    const canvasW = Math.max(cr.width, canvas.clientWidth, 1);
    const canvasH = Math.max(cr.height, canvas.clientHeight, 1);
    if (!hit) {
      // 没有命中节点才贴内边距；有选区时禁止假装停在 CFG 原点。
      el.style.left = '8px';
      el.style.top = '8px';
      el.setAttribute('data-float-origin', 'fallback');
      return;
    }
    const nodeBox: FloatBox = { left: minL, top: minT, right: maxR, bottom: maxB };
    const ow = Math.max(el.offsetWidth || 0, kind === 'detail' ? 280 : 168);
    const oh = Math.max(el.offsetHeight || 0, kind === 'detail' ? 180 : 32);
    const pos = floatingChromePosition(nodeBox, { width: canvasW, height: canvasH }, { width: ow, height: oh }, kind);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    el.setAttribute('data-float-origin', 'bbox');
  }

  /**
   * 页面壳：跟指针的雾块。点阵只在 CFG 画布，不要铺到顶栏或整页。
   */
  private renderFluidField(): HTMLElement {
    const field = document.createElement('div');
    field.className = 'ui-shell-app-field';
    field.setAttribute('data-app-field', 'true');
    field.setAttribute('aria-hidden', 'true');
    field.setAttribute('data-pointer', 'none');
    field.style.pointerEvents = 'none';
    const fluid = document.createElement('div');
    fluid.className = 'ui-shell-fluid';
    fluid.setAttribute('data-fluid', 'true');
    const follow = document.createElement('div');
    follow.className = 'ui-shell-fluid-follow';
    for (let i = 1; i <= 3; i++) {
      const blob = document.createElement('span');
      blob.className = `ui-shell-fluid-blob ui-shell-fluid-blob--${i}`;
      blob.setAttribute('data-fluid-blob', String(i));
      follow.appendChild(blob);
    }
    fluid.appendChild(follow);
    const spot = document.createElement('span');
    spot.className = 'ui-shell-fluid-spot';
    spot.setAttribute('data-fluid-spot', 'true');
    fluid.appendChild(spot);
    field.appendChild(fluid);
    return field;
  }

  // ---- 渲染（全量重渲染，步骤规模小，简单优先）----

  render(): void {
    if (this.motionTimer !== undefined) {
      clearTimeout(this.motionTimer);
      this.motionTimer = undefined;
    }
    const root = this.mount;
    root.innerHTML = '';

    // 持久横幅（演示模式/录制警告）：render 每次重建 DOM，故 banner 必须从实例字段重新渲染，
    // 否则 insertStep 等后续 render 会把它冲掉（此前 banner 在 render 外 prepend 即被此问题吞掉）。
    root.classList.add('ui-shell-app');
    root.setAttribute('data-layout', this.layoutMode());
    root.setAttribute('data-workbench-inset', '12-14-14');
    root.style.padding = '12px 14px 14px';
    root.style.gap = '10px';
    root.style.overflow = 'hidden';
    root.style.maxWidth = '100%';
    root.appendChild(this.renderFluidField());
    if (this.bannerText) {
      const bar = document.createElement('div');
      bar.className = 'ui-shell-banner' + (this.bannerDemo ? ' banner--demo' : '');
      bar.setAttribute('data-banner', 'true');
      bar.textContent = this.bannerText;
      root.appendChild(bar);
    }

    // 录制中提示（spec §2.2）：按钮文案之外再给一条横幅，避免「点了开始录制却像没反应」。
    if (this.recording) {
      const bar = document.createElement('div');
      bar.className = 'ui-shell-banner banner--recording';
      bar.setAttribute('data-recording-banner', 'true');
      bar.textContent = '录制中：请到靶机里点击或输入，步骤会实时出现在工作台。再点「停止录制」结束。';
      root.appendChild(bar);
    }

    // 点选态提示（spec §2.3）：进入点选后顶部提示用户切到靶机点击，并提供取消。
    if (this.pickMode) {
      const bar = document.createElement('div');
      bar.className = 'ui-shell-banner banner--pick';
      bar.setAttribute('data-pick-mode', 'true');
      bar.textContent = '请到真实软件里点选目标元素。这次点击只写回当前表单，不会当成普通录制步骤。';
      const cancel = document.createElement('button');
      cancel.className = 'ui-shell-pick-cancel';
      cancel.textContent = '取消点选';
      cancel.setAttribute('data-action', 'cancel-pick');
      bar.appendChild(cancel);
      root.appendChild(bar);
    }

    const header = document.createElement('div');
    header.className = 'ui-shell-header';
    header.setAttribute('data-header', 'true');

    const brand = document.createElement('div');
    brand.className = 'ui-shell-header-brand';
    brand.setAttribute('data-header-brand', 'true');

    const wordmark = document.createElement('div');
    wordmark.className = 'ui-shell-wordmark';
    wordmark.setAttribute('data-wordmark', 'true');
    const titleText = document.createElement('span');
    titleText.className = 'ui-shell-wordmark-label';
    titleText.setAttribute('data-product-title', 'true');
    titleText.textContent = WORDMARK_TEXT;
    wordmark.appendChild(titleText);
    brand.appendChild(wordmark);
    mountWordmark(wordmark);

    const conn = document.createElement('span');
    conn.className = 'ui-shell-conn';
    conn.setAttribute('data-conn-status', 'true');
    conn.textContent = this.connected ? '已连接' : '未连接';
    const targetTitle = this.connectedTargetTitle();
    if (targetTitle) conn.title = targetTitle;
    brand.appendChild(conn);

    if (typeof document !== 'undefined') document.title = WORDMARK_TEXT;

    const dot = document.createElement('span');
    dot.className = 'rec-dot' + (this.recording ? ' on' : '');
    brand.appendChild(dot);

    // CDP 目标下拉：单窗口没用，多 webview 才需要。标签是「当前窗口」不是产品名。
    let targets: { id: string; type?: string; title?: string }[] = [];
    try { targets = (this.listTargets() ?? []) as { id: string; type?: string; title?: string }[]; } catch { targets = []; }
    if (this.connected && targets.length > 1 && !this.recording) {
      const lab = document.createElement('label');
      lab.className = 'ui-shell-target-label';
      lab.setAttribute('data-target-label', 'true');
      const labText = document.createElement('span');
      labText.textContent = '当前窗口';
      lab.appendChild(labText);
      const sel = document.createElement('select');
      sel.className = 'ui-shell-target-select';
      sel.setAttribute('data-action', 'select-target');
      sel.setAttribute('data-target-select', 'true');
      targets.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.title ?? t.id} (${t.type})`;
        if (t.id === this.currentTargetId) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => this.selectTarget(sel.value));
      lab.appendChild(sel);
      brand.appendChild(lab);
    }
    header.appendChild(brand);

    // 操作栏进顶栏第二行，不再钉在窗口底。data-action 名不变。
    const actions = document.createElement('div');
    actions.className = 'ui-shell-actions';
    actions.setAttribute('data-actions', 'true');
    const addBtn = (label: string, action: string, cls = '', disabled = false) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.setAttribute('data-action', action);
      b.disabled = disabled;
      actions.appendChild(b);
      return b;
    };
    {
      const rec = document.createElement('button');
      rec.textContent = this.recording ? '停止录制' : '开始录制';
      rec.setAttribute('data-action', 'toggle-record');
      rec.setAttribute('data-recording', this.recording ? 'true' : 'false');
      rec.disabled = !this.connected && !this.recording;
      if (this.recording) rec.className = 'danger';
      else rec.className = 'primary';
      actions.appendChild(rec);
    }
    const insertBtn = addBtn('插入步骤 ▾', 'insert');
    const insertWrap = document.createElement('div');
    insertWrap.className = 'ui-shell-insert-wrap';
    insertWrap.setAttribute('data-insert-wrap', 'true');
    insertBtn.replaceWith(insertWrap);
    insertWrap.appendChild(insertBtn);
    addBtn('运行全部', 'run-all');
    addBtn('导入', 'import');
    addBtn('导出', 'export');
    addBtn('清空', 'clear', 'danger');
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.multiple = true;
    file.setAttribute('data-import-file', 'true');
    file.style.display = 'none';
    file.addEventListener('change', () => {
      const files = Array.from(file.files ?? []);
      if (files.length === 0) return;
      const scriptFile = files.find((f) => !/\.shots\.json$/i.test(f.name)) ?? files[0];
      const shotsFile = files.find((f) => /\.shots\.json$/i.test(f.name));
      void scriptFile.text().then(async (txt) => {
        try {
          const sidecar = shotsFile ? await shotsFile.text() : undefined;
          this.importScript(txt, sidecar);
        } catch (err) {
          this.setBanner(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        }
      });
    });
    actions.appendChild(file);
    header.appendChild(actions);
    root.appendChild(header);

    // 运行失败 / 未连接提醒（spec §2.3.4：失败要有 notice，不能静默禁用按钮）
    const noticeText = (() => {
      if (this.lastFailedStepId) {
        const failed = this.flattenSteps().find((s) => s.id === this.lastFailedStepId);
        return failed
          ? `运行中断：第 ${this.flattenSteps().indexOf(failed) + 1} 步「${describeStep(failed)}」失败，请检查后重跑。`
          : `运行中断：步骤 ${this.lastFailedStepId} 失败。`;
      }
      return this.runNoticeText;
    })();
    if (noticeText) {
      const notice = document.createElement('div');
      notice.className = 'ui-shell-run-notice';
      notice.setAttribute('data-run-notice', 'true');
      notice.textContent = noticeText;
      root.appendChild(notice);
    }

    // 主体：步骤流图 | 预览舞台。详情是叠加层，不占常驻右栏。
    const body = document.createElement('div');
    body.className = 'ui-shell-body';
    root.appendChild(body);

    const cfg = document.createElement('div');
    cfg.className = 'ui-shell-cfg';
    cfg.setAttribute('data-cfg', 'true');
    cfg.style.position = 'relative';
    cfg.style.overflow = 'hidden';
    const cfgTitle = document.createElement('div');
    cfgTitle.className = 'ui-shell-pane-title';
    cfgTitle.innerHTML = '<span>步骤流图</span><span>拖拽调序 · 框选打包 · 单选编辑</span>';
    cfg.appendChild(cfgTitle);
    const cfgTree = document.createElement('div');
    cfgTree.className = 'ui-shell-cfg-canvas';
    cfgTree.style.overflow = 'hidden';
    cfg.appendChild(cfgTree);
    if (!this.cfgView) {
      this.cfgView = new CfgView({
        mount: cfgTree,
        onSelect: (stepId, mods) => {
          if (mods?.additive) {
            this.packMenuIds = undefined;
            if (this.selectedIds.has(stepId)) this.selectedIds.delete(stepId);
            else this.selectedIds.add(stepId);
            this.selectedStepId = stepId;
            this.detailOpen = false;
            this.cfgPrimary = true;
            this.previewFromHover = false;
            this.previewStepId = this.selectedIds.size >= 2 ? undefined : this.previewTargetOf(stepId);
            this.render();
            return;
          }
          this.selectForView(stepId);
        },
        onReorder: (dragId, dropId) => {
          this.script = ScriptEditor.relocate(this.script, dragId, dropId);
          this.render();
        },
        onMarquee: (ids) => {
          this.selectedIds = new Set(ids);
          this.selectedStepId = ids[0];
          this.packMenuIds = ids;
          this.detailOpen = false;
          this.cfgPrimary = true;
          this.previewFromHover = false;
          this.previewStepId = undefined;
          this.render();
        },
        onBlank: () => this.clearCfgBlank(),
        onHover: (stepId) => {
          this.previewFromHover = true;
          this.previewStepId = stepId;
          this.showStoredShot(stepId);
        },
        onViewChange: () => this.repositionFloatingChrome(),
      });
    } else {
      this.cfgView.rebindMount(cfgTree);
    }
    this.cfgMount = cfgTree;
    this.cfgView.update(this.script);
    this.syncAllCfgStatuses();
    // update 整树重建后卡片回到"无图"默认态，按 stepShots 回填一次（顺序必须在 update 之后）。
    this.syncAllCfgShots();
    if (this.selectedStepId) this.cfgView.setSelected(this.selectedStepId, this.selectedIds);
    if (this.shouldShowPackOverlay()) {
      const menu = document.createElement('div');
      menu.className = 'ui-shell-pack-menu';
      menu.setAttribute('data-pack-menu', 'true');
      menu.setAttribute('data-pack-float', 'true');
      menu.setAttribute('data-pack-compact', 'true');
      menu.setAttribute('data-pack-anchor', 'bbox');
      menu.setAttribute('data-ui-motion', '180');
      const packSet = this.packButtonSet();
      menu.setAttribute('data-pack-set', packSet);
      const mk = (kind: 'sequence' | 'if' | 'while', action: string, label: string, title: string) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.setAttribute('data-action', action);
        b.setAttribute('data-pack-choice', kind);
        menu.appendChild(b);
      };
      const mkEdit = () => {
        if (!this.selectedStepId) return;
        const edit = document.createElement('button');
        edit.textContent = '编辑';
        edit.setAttribute('data-action', 'edit');
        edit.setAttribute('data-step-id', this.selectedStepId);
        menu.appendChild(edit);
      };
      if (packSet === 'marquee') {
        mk('sequence', 'wrap-sequence', '打包', '框选打包为顺序组');
        mk('if', 'wrap-if', '分支', '设为分支组');
        mk('while', 'wrap-while', '循环', '设为循环组');
      } else if (packSet === 'group') {
        mkEdit();
        mk('if', 'wrap-if', '分支', '设为分支组');
        mk('while', 'wrap-while', '循环', '设为循环组');
        const unpack = document.createElement('button');
        unpack.textContent = '拆包';
        unpack.setAttribute('data-action', 'unpack');
        unpack.setAttribute('data-step-id', this.selectedStepId ?? '');
        menu.appendChild(unpack);
      } else {
        mkEdit();
        mk('if', 'wrap-if', '分支', '设为分支组');
        mk('while', 'wrap-while', '循环', '设为循环组');
      }
      cfgTree.appendChild(menu);
    }
    body.appendChild(cfg);

    const stageWrap = document.createElement('div');
    stageWrap.className = 'ui-shell-stage-wrap';
    const stage = document.createElement('div');
    stage.className = 'ui-shell-stage';
    stage.setAttribute('data-stage', 'true');
    const frameHint = document.createElement('div');
    frameHint.className = 'ui-shell-frame';
    frameHint.setAttribute('data-frame', 'true');
    frameHint.textContent = this.connected
      ? '该步截图（不是实时软件画面）'
      : (this.stepShots.size > 0
        ? '该步截图来自导入文件，无需连接靶机'
        : '[ 连接后：选中或录制一步才会出现该步截图 ]');
    stage.appendChild(frameHint);
    stageWrap.appendChild(stage);
    body.appendChild(stageWrap);

    const detail = document.createElement('div');
    detail.className = 'ui-shell-detail' + (this.detailOpen ? ' is-open' : '');
    detail.setAttribute('data-detail', 'true');
    detail.setAttribute('data-detail-open', this.detailOpen ? 'true' : 'false');
    detail.setAttribute('data-detail-anchor', 'node');
    detail.setAttribute('data-ui-motion', '180');
    detail.style.overflow = 'hidden';
    detail.style.maxHeight = 'min(72vh, 520px)';
    const detailTitle = document.createElement('div');
    detailTitle.className = 'ui-shell-pane-title';
    detailTitle.textContent = '详情 / 编辑';
    detail.appendChild(detailTitle);
    cfgTree.appendChild(detail);
    if (this.detailOpen && this.selectedStepId) {
      const sel = this.findStep(this.selectedStepId);
      if (sel) this.renderEditArea(sel);
    }
    // 先挂进文档再量包围盒：脱离文档时 GCR 全是 0，浮动钮会假停在 CFG 原点。
    this.repositionFloatingChrome();
    this.watchFloatingChrome(cfgTree);
    this.applyPreview();

    this.stepsEl = undefined;

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

    if (this.insertMenuOpen) {
      const menu = document.createElement('div');
      menu.className = 'ui-shell-insert-menu';
      menu.setAttribute('data-insert-menu', 'true');
      const kinds: { type: string; label: string }[] = [
        { type: 'wait', label: '等待时间' },
        { type: 'waitUntil', label: '等待元素出现' },
        { type: 'assert', label: '断言' },
      ];
      kinds.forEach((k) => {
        const b = document.createElement('button');
        b.className = 'ui-shell-insert-item';
        b.textContent = k.label;
        b.setAttribute('data-action', 'insert-type');
        b.setAttribute('data-insert-type', k.type);
        menu.appendChild(b);
      });
      const off = document.createElement('div');
      off.className = 'ui-shell-insert-off';
      off.textContent = '循环不在这里 · 选中组后设 kind';
      menu.appendChild(off);
      insertWrap.appendChild(menu);
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

  /** 增量把新录制步画进 CFG（不再维护线性步骤列表）。 */
  private appendStepEl(_step: Step): void {
    if (!this.cfgView) {
      this.render();
      return;
    }
    this.cfgView.update(this.script);
    this.syncAllCfgStatuses();
    this.syncAllCfgShots();
  }
}
