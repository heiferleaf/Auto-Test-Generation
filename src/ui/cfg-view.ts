// M3-R4 CFG 图形化视图（控制流图）。
//
// 职责边界（SRP）：本组件只做「图模型构建」与「DOM 渲染」，不依赖执行器/
// 内核/playwright（DIP）——只 import `Script`/`Step` 类型。其本身不决定联动，
// 仅通过 `onSelect(stepId)` 上报点击，由 `UiShell` 负责编排（兄弟视图唯一真相源）。
//
// 设计依据：docs/design/visual-mask-ui-spec.md §2.7；约定与执行器 runNode 保持一致：
//   `if` 组的 children[0] = then 分支、children[1] = else 分支
//   （src/executor/executor.ts: `const chosen = result.passed ? branches[0] : branches[1]`）。
//   若图把两枝画反，用户看到的流向就与真实执行相反，故图模型严格按此约定构建边。
//
// 边界安全（CODEBUDDY.md §4.1）：`children` 含 `null` 时不得抛错（跳过即可），
// 渲染路径崩了会白屏，故防御而非抛错——与桥边界递归校验同族。

import type { Script, Step, StepType, ControlKind } from '../types/step';
import { CONTROL_KINDS } from '../types/step';

/**
 * 控制流分发的穷尽性守卫（OCP）—— **编译期报错，运行时降级**。
 *
 * 三处按 `control.kind` 分发的地方（`buildCfgGraph` 建边、`renderNode` 建 DOM、
 * `nodeLabel` 取文案）统一用它收尾。参数类型为 `never`：新增 `ControlKind` 时，
 * 未补 case 的每一处都会**编译期报错**并被逐个指出（实测新增 'switch' 时三处均报）。
 *
 * **为何运行时不 throw 而是降级**：`never` 只是编译期约束，运行时脏数据照样能进来。
 * `src/script/io.ts` 的导入期校验只覆盖 `importScript`（本地文件）这一条路径；
 * 录制直接构造 Script、Agent 经 MCP 构造、R5 版本层还原旧数据，都能绕过它直达渲染层。
 * 若在此 throw，异常发生在 `render()` 的同步栈内 → **整页白屏**，把"静默错渲"换成了
 * "彻底不可用"，更糟。故渲染层降级为「未知控制结构」占位并 warn：
 * 问题可见（不静默按顺序组错渲）、页面可用（不白屏）、硬失败留给导入期。
 */
function warnUnknownControlKind(kind: never): void {
  console.warn(
    `[CfgView] 未知的 control.kind: ${String(kind)}，已降级为「未知控制结构」占位节点。` +
    `脚本数据非法，正常应在导入期（script/io.ts）或桥边界被拦截。`,
  );
}

// ───────────────────────── 图模型（与 DOM 解耦的纯数据）─────────────────────────

/**
 * 图节点：判别联合（discriminated union），用 `isLeaf` 作判别位。
 *
 * 为何不写成 `kind: StepType | ControlKind` 的单一形状：那样每次按控制结构分发
 * 都得 `as ControlKind` 强转，强转会**破坏 TS 的收窄**，使穷尽性检查
 * （`assertNeverControlKind`）失效 —— OCP 守卫就白设了。用判别联合后，
 * `if (node.isLeaf)` 之后 `node.kind` 自动收窄为 `ControlKind`，无需强转。
 */
export type CfgLeafNode = {
  id: string;
  /** 叶子节点类型 = 其 StepType（如 'click'）。 */
  kind: StepType;
  isLeaf: true;
  children: CfgNode[]; // 恒为空数组，保持形状统一便于递归遍历
};

export type CfgGroupNode = {
  id: string;
  /** 组节点类型 = control.kind。 */
  kind: ControlKind;
  isLeaf: false;
  /** 递归子节点（顺序即执行序）。 */
  children: CfgNode[];
  /** 循环次数（仅 while，供图上显示「×N」）。 */
  loopCount?: number;
};

export type CfgNode = CfgLeafNode | CfgGroupNode;

export type CfgEdgeKind = 'flow' | 'true' | 'false' | 'loop';

export type CfgEdge = {
  from: string;
  to: string;
  kind: CfgEdgeKind;
};

export type CfgGraph = {
  /** 顶层节点数组（顺序即执行序）；嵌套通过 node.children 递归表达。 */
  nodes: CfgNode[];
  /** 扁平汇总：含各层级所有边（测试用 toContainEqual 断言）。 */
  edges: CfgEdge[];
};

/** 画边用的轴对齐盒（相对视口，与 getBoundingClientRect 同形）。 */
export type CfgBox = { left: number; top: number; width: number; height: number };
export type CfgLine = { x1: number; y1: number; x2: number; y2: number };

function rel(n: number, origin: number): number {
  return n - origin;
}

/**
 * 分支边：从条件头底边中心到同层分支头顶边中心。
 * 为什么不用整组外框：组节点 DOM 包着 True/False 子树，外框底边在子节点下面，
 * 从那里拉线会倒插入盒子，看起来像乱 V，和真实「先判条件再进一枝」相反。
 */
export function branchEdgeLine(head: CfgBox, branchHead: CfgBox, origin: CfgBox): CfgLine {
  return {
    x1: rel(head.left + head.width / 2, origin.left),
    y1: rel(head.top + head.height, origin.top),
    x2: rel(branchHead.left + branchHead.width / 2, origin.left),
    y2: rel(branchHead.top, origin.top),
  };
}

/**
 * 回环：从循环体末步右侧水平出盒，再竖直回到循环头。
 * 直线穿组会叠在 body 上，看不出「执行完再回到头」；绕行才是回环。
 */
export function loopEdgePath(last: CfgBox, head: CfgBox, group: CfgBox, origin: CfgBox): string {
  const pad = 14;
  const xOut = rel(group.left + group.width + pad, origin.left);
  const yLast = rel(last.top + last.height / 2, origin.top);
  const xLast = rel(last.left + last.width, origin.left);
  const yHead = rel(head.top + head.height / 2, origin.top);
  const xHead = rel(head.left + head.width, origin.left);
  return `M ${xLast} ${yLast} L ${xOut} ${yLast} L ${xOut} ${yHead} L ${xHead} ${yHead}`;
}

/**
 * 旧几何特征：起点贴在组外框底边，终点落在组框内部。
 * 用来守住「不要再倒插入组」；正确的分支线从条件头出发，不会命中。
 */
export function isInwardVIntoGroup(group: CfgBox, line: CfgLine, origin: CfgBox): boolean {
  const bottom = rel(group.top + group.height, origin.top);
  const top = rel(group.top, origin.top);
  const left = rel(group.left, origin.left);
  const right = rel(group.left + group.width, origin.left);
  const startsAtGroupBottom = Math.abs(line.y1 - bottom) <= 1;
  const endInside = line.x2 >= left && line.x2 <= right && line.y2 > top && line.y2 < bottom;
  return startsAtGroupBottom && endInside;
}

function readBox(el: Element): CfgBox {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** 递归建节点，并累加边到 `edges`。 */
function buildNode(step: Step, edges: CfgEdge[]): CfgNode | null {
  // 坏数据兜底：null/undefined 直接跳过（§4.1）。
  if (step == null) return null;

  const ctrl = step.control;
  if (!ctrl || (ctrl.kind === 'sequence' && !(step.children?.length))) {
    // 叶子，或原子顺序组（一步一组、无 children）：按动作节点画，组名走 control.name。
    return { id: step.id, kind: step.type, children: [], isLeaf: true };
  }

  const children = (step.children ?? [])
    .map((c) => buildNode(c, edges))
    .filter((c): c is CfgNode => c !== null); // 过滤 null 子

  const node: CfgNode = {
    id: step.id,
    kind: ctrl.kind,
    children,
    isLeaf: false,
    ...(ctrl.kind === 'while' ? { loopCount: ctrl.loopCount } : {}),
  };

  // 边：同层相邻兄弟链式 flow。选择组的 True/False 是并列分支，不是先后顺序。
  if (ctrl.kind !== 'if') {
    for (let i = 0; i < children.length - 1; i++) {
      edges.push({ from: children[i].id, to: children[i + 1].id, kind: 'flow' });
    }
  }

  switch (ctrl.kind) {
    case 'if': {
      if (children[0]) edges.push({ from: step.id, to: children[0].id, kind: 'true' });
      if (children[1]) edges.push({ from: step.id, to: children[1].id, kind: 'false' });
      break;
    }
    case 'while': {
      // 回环：末子回到循环头。不从组头再拉一条边进第一个子节点（会叠在组角上变成大三角）。
      if (children.length > 0) {
        const last = children[children.length - 1];
        edges.push({ from: last.id, to: step.id, kind: 'loop' });
      }
      break;
    }
    case 'sequence':
      break;
    default:
      // 运行时脏数据：降级（不建控制流边），节点本身仍保留在图中以便暴露问题。
      warnUnknownControlKind(ctrl.kind);
  }

  return node;
}

/** 从 Script 构建控制流图模型（纯函数，与 DOM 解耦）。 */
export function buildCfgGraph(script: Script): CfgGraph {
  const edges: CfgEdge[] = [];
  const nodes: CfgNode[] = (script.steps ?? [])
    .map((s) => buildNode(s, edges))
    .filter((n): n is CfgNode => n !== null);
  // 顶层兄弟间链式 flow 边（与组内兄弟边同构）。
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, kind: 'flow' });
  }
  return { nodes, edges };
}

// ───────────────────────── DOM 渲染组件 ─────────────────────────

// 从 types/step 引入（而非 './shell'）：CfgView 是与列表同级的视图组件，
// 不应反向依赖编排者 UiShell（架构文档：CfgView 仅依赖 Script/Step 类型）。
import type { StepRunStatus } from '../types/step';
import { describeStepBrief, TYPE_LABEL } from './step-label';

/** 流图画布点阵间距：铺满 pan 世界，不要密成整页钉板。 */
const CFG_DOT_GAP_PX = 20;

function cfgDotsReducedMotion(): boolean {
  try {
    if (typeof matchMedia !== 'function') return true;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

export type CfgViewOptions = {
  mount: HTMLElement;
  /** 点击节点时上报被点击的 stepId（由外部决定联动，本组件不依赖 UiShell）。 */
  onSelect?: (stepId: string, mods?: { additive?: boolean }) => void;
  /** 拖到另一节点上：同层调序，或丢进 sequence/while（spec §2.6）。 */
  onReorder?: (dragId: string, dropId: string) => void;
  /** 左键拖框松手后，上报框到的 stepId（spec §2.5 橡皮筋打包）。 */
  onMarquee?: (ids: string[]) => void;
  /** 点 CFG 空白：清框选/浮动打包，避免三个按钮钉在页面上。 */
  onBlank?: () => void;
  /** 悬停一步超过约 400ms：只切预览截图，不改选中。 */
  onHover?: (stepId: string) => void;
  /** 平移/缩放后通知外壳重放浮动钮（外壳按节点 GCR 锚，不跟树一起被 scale）。 */
  onViewChange?: () => void;
};

/**
 * CFG 视图渲染组件。
 *
 * 关键约束：
 *  - `update` 幂等：重复 update 同一脚本不产生重复节点（先清再画）。
 *  - `setStatus` 原地更新：只改已有 DOM 节点属性，不整树重建（避免运行时每步
 *    高频重渲染，CODEBUDDY.md §4.1 清单 7）。测试断言 setStatus 前后
 *    querySelector 返回**同一个 DOM 引用**。
 */
export class CfgView {
  private mount: HTMLElement;
  private onSelect?: (stepId: string, mods?: { additive?: boolean }) => void;
  private onReorder?: (dragId: string, dropId: string) => void;
  private onMarquee?: (ids: string[]) => void;
  private onBlank?: () => void;
  private onHover?: (stepId: string) => void;
  private onViewChange?: () => void;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverArmedId?: string;
  /** stepId → 对应 DOM 节点，供 setStatus 原地更新 O(1) 命中。 */
  private nodeEls = new Map<string, HTMLElement>();
  /** 当前选中态（同时只有一个；覆盖式设置）。 */
  private selectedId?: string;

  /** 已绑定委托的挂载元素（避免 rebindMount 后重复绑定造成一次点击多次上报）。 */
  private delegatedMounts = new WeakSet<HTMLElement>();
  private dragGhost?: HTMLElement;
  private dropLine?: HTMLElement;
  /** 指针拖刚结束时吞掉紧随的 click，避免拖完又改选中。 */
  private suppressClick = false;

  // ---- B4 规模可读性（spec §2.6.1）：视图态，不入 schema ----
  /** 折叠态：哪些组节点被折叠（仅视图层，D6；脚本数据不变）。 */
  private collapsed = new Set<string>();
  /** 缩放与平移：Ctrl+滚轮缩放、空白拖拽平移，避免大脚本看不下。 */
  private scale = 1;
  private panX = 0;
  private panY = 0;
  /** 点阵指针（画布坐标）；越界值表示不斥开。 */
  private dotMx = -9999;
  private dotMy = -9999;
  private dotRaf = 0;
  /** 最近一次渲染的脚本：折叠/缩放后整树重渲染需要。 */
  private lastScript: Script | undefined;
  /** stepId → Step 的 O(1) 索引：nodeLabel 取叶子文案不再每节点全树遍历（O(n²)→O(n)）。 */
  private stepIndex = new Map<string, Step>();

  constructor(opts: CfgViewOptions) {
    this.mount = opts.mount;
    this.onSelect = opts.onSelect;
    this.onReorder = opts.onReorder;
    this.onMarquee = opts.onMarquee;
    this.onBlank = opts.onBlank;
    this.onHover = opts.onHover;
    this.onViewChange = opts.onViewChange;
    this.bindDelegation(this.mount);
    this.bindZoomPan(this.mount);
    this.bindPointerDrag(this.mount);
    this.bindMarquee(this.mount);
    this.ensureDotField();
  }

  /**
   * 在挂载区挂**单一**点击委托：用 `closest` 就近命中被点节点。
   * 一处监听服务全部节点 —— 既覆盖"点节点内部文字"的真实落点，
   * 也避免逐节点绑定在大脚本下累积成百上千个监听器。
   */
  private bindDelegation(mount: HTMLElement): void {
    if (this.delegatedMounts.has(mount)) return; // 幂等：同一 mount 只绑一次
    this.delegatedMounts.add(mount);
    mount.addEventListener('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        e.stopPropagation();
        return;
      }
      // 折叠按钮优先：点折叠不触发选中（否则折叠的同时会选中该组，行为相互干扰）。
      const collapseHit = (e.target as HTMLElement | null)?.closest('[data-cfg-collapse]');
      if (collapseHit && mount.contains(collapseHit)) {
        const id = collapseHit.getAttribute('data-cfg-collapse');
        if (id) this.toggleCollapse(id);
        return;
      }
      const hit = (e.target as HTMLElement | null)?.closest('[data-cfg-node]');
      if (hit && mount.contains(hit)) {
        const id = hit.getAttribute('data-cfg-node');
        const ev = e as MouseEvent;
        if (id) this.emitSelect(id, { additive: !!(ev.ctrlKey || ev.metaKey) });
        return;
      }
      // 点空白清框选；打包钮和详情在画布内，点它们不要当成空白。
      if ((e.target as HTMLElement | null)?.closest('[data-pack-menu],[data-detail]')) return;
      this.onBlank?.();
    });
    this.bindHover(mount);
  }

  /** 悬停 >400ms 才切预览；离开节点不撤回（由下一次悬停或点击改）。 */
  private bindHover(mount: HTMLElement): void {
    mount.addEventListener('pointerover', (e) => {
      const hit = (e.target as HTMLElement | null)?.closest('[data-cfg-node]') as HTMLElement | null;
      if (!hit || !mount.contains(hit)) return;
      if ((e.target as HTMLElement | null)?.closest('[data-pack-menu],[data-detail]')) return;
      const id = hit.getAttribute('data-cfg-node');
      if (!id || id === this.hoverArmedId) return;
      this.hoverArmedId = id;
      if (this.hoverTimer !== undefined) clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = undefined;
        this.onHover?.(id);
      }, 400);
    });
  }

  /** 折叠/展开组节点（视图态；切换后整树重渲染，选中态由 update 内部保留）。 */
  private toggleCollapse(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    if (this.lastScript) this.update(this.lastScript);
  }

  /**
   * 缩放（Ctrl+滚轮）与平移（滚轮 / 中键 / Alt+左键）：spec §2.6.1。
   * 不用 overflow:auto，避免步骤流图中间出现原生滚动条。
   */
  private bindZoomPan(mount: HTMLElement): void {
    mount.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const next = this.scale - Math.sign(e.deltaY) * 0.1;
        this.scale = Math.min(2.5, Math.max(0.25, Math.round(next * 100) / 100));
      } else {
        this.panX -= e.deltaX;
        this.panY -= e.deltaY;
      }
      this.applyTransform();
    }, { passive: false });
    // 平移：中键或 Alt+左键。左键空白拖给橡皮筋，避免和框选抢手势。
    let dragging = false;
    let startX = 0, startY = 0, baseX = 0, baseY = 0;
    mount.addEventListener('mousedown', (e) => {
      const pan = e.button === 1 || (e.button === 0 && e.altKey);
      if (!pan) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY; baseX = this.panX; baseY = this.panY;
      e.preventDefault();
    });
    mount.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.panX = baseX + (e.clientX - startX);
      this.panY = baseY + (e.clientY - startY);
      this.applyTransform();
    });
    const end = () => { dragging = false; };
    mount.addEventListener('mouseup', end);
    mount.addEventListener('mouseleave', end);
  }

  /** 把 scale/pan 写到当前 cfg 树。跟随时带 260ms 过渡，手势平移立刻跟上。 */
  private applyTransform(opts?: { animate?: boolean }): void {
    const tree = this.mount.querySelector('.ui-shell-cfg-tree') as HTMLElement | null;
    if (tree) {
      tree.style.transition = opts?.animate ? 'transform 260ms ease' : 'none';
      tree.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
      tree.setAttribute('data-cfg-scale', String(this.scale));
      tree.setAttribute('data-cfg-pan-x', String(this.panX));
      tree.setAttribute('data-cfg-pan-y', String(this.panY));
      if (opts?.animate) tree.setAttribute('data-cfg-follow', 'center');
    }
    this.syncDotField();
    // 浮动钮画在画布上、不跟树一起 scale；平移后要按新的节点盒重放。
    this.onViewChange?.();
  }

  /**
   * 点阵铺在画布 inset:0 上（整个 pan 世界），不要绑在树上——树只有节点那么宽，会变成左侧一小块。
   * 顶栏不放点阵；页面壳只留雾块。
   */
  private ensureDotField(): void {
    let field = this.mount.querySelector(':scope > [data-cfg-dots]') as HTMLElement | null;
    if (!field) {
      field = document.createElement('div');
      field.className = 'ui-shell-cfg-dots';
      field.setAttribute('data-cfg-dots', 'true');
      field.setAttribute('data-cfg-field', 'true');
      field.setAttribute('data-dot-gap', String(CFG_DOT_GAP_PX));
      field.setAttribute('aria-hidden', 'true');
      field.style.pointerEvents = 'none';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('data-cfg-dots-canvas', 'true');
      field.appendChild(canvas);
      this.mount.insertBefore(field, this.mount.firstChild);
      this.bindDotRepulsion();
    }
    this.syncDotField();
  }

  /** CSS 点阵随 pan/zoom 走，和节点同一套世界坐标。 */
  private syncDotField(): void {
    const field = this.mount.querySelector(':scope > [data-cfg-dots]') as HTMLElement | null;
    if (!field) return;
    const gap = CFG_DOT_GAP_PX * this.scale;
    field.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
    field.style.backgroundSize = `${gap}px ${gap}px`;
    field.setAttribute('data-cfg-pan-x', String(this.panX));
    field.setAttribute('data-cfg-pan-y', String(this.panY));
  }

  private bindDotRepulsion(): void {
    const mount = this.mount as HTMLElement & { __cfgDots?: boolean };
    if (mount.__cfgDots) return;
    mount.__cfgDots = true;
    mount.addEventListener('mousemove', (e) => {
      const r = mount.getBoundingClientRect();
      this.dotMx = e.clientX - r.left;
      this.dotMy = e.clientY - r.top;
    });
    mount.addEventListener('mouseleave', () => {
      this.dotMx = -9999;
      this.dotMy = -9999;
    });
    if (cfgDotsReducedMotion()) return;
    const tick = () => {
      const field = this.mount.querySelector(':scope > [data-cfg-dots]') as HTMLElement | null;
      const canvas = field?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!field || !canvas || !this.mount.isConnected) {
        this.dotRaf = 0;
        return;
      }
      this.paintDotCanvas(field, canvas);
      if ((this.mount.clientWidth || 0) >= 8) this.dotRaf = requestAnimationFrame(tick);
      else this.dotRaf = 0;
    };
    this.dotRaf = requestAnimationFrame(tick);
  }

  /** 画布有尺寸才用 canvas 斥力；jsdom 宽高为 0 时只留 CSS 点阵。 */
  private paintDotCanvas(field: HTMLElement, canvas: HTMLCanvasElement): void {
    const w = Math.floor(this.mount.clientWidth || 0);
    const h = Math.floor(this.mount.clientHeight || 0);
    if (w < 8 || h < 8) {
      field.classList.remove('is-live');
      return;
    }
    field.classList.add('is-live');
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? Math.min(2, devicePixelRatio) : 1;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(212,212,216,.14)';
    const gap = CFG_DOT_GAP_PX * this.scale;
    const pad = 64;
    const n0 = Math.floor((-pad - this.panX) / gap);
    const n1 = Math.ceil((w + pad - this.panX) / gap);
    const m0 = Math.floor((-pad - this.panY) / gap);
    const m1 = Math.ceil((h + pad - this.panY) / gap);
    const mx = this.dotMx;
    const my = this.dotMy;
    for (let n = n0; n <= n1; n++) {
      for (let m = m0; m <= m1; m++) {
        let x = this.panX + n * gap;
        let y = this.panY + m * gap;
        const dx = x - mx;
        const dy = y - my;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 56) {
          const force = (1 - dist / 56) * 8;
          x += (dx / dist) * force;
          y += (dy / dist) * force;
        }
        ctx.beginPath();
        ctx.arc(x, y, 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * 重新绑定挂载区：render 全量 innerHTML='' 后，旧 mount 已脱离文档，
   * 需把 CfgView 指向新创建的 cfg 区，避免重复 new 导致事件重复绑定。
   * 重新绑定会清空已记录的节点引用，下次 update 重建。
   */
  rebindMount(mount: HTMLElement): void {
    if (this.dotRaf) {
      cancelAnimationFrame(this.dotRaf);
      this.dotRaf = 0;
    }
    this.mount = mount;
    this.nodeEls.clear();
    this.selectedId = undefined;
    this.bindDelegation(mount); // 新 mount 需要自己的委托（WeakSet 保证不重复绑定）
    this.bindZoomPan(mount);
    this.bindPointerDrag(mount);
    this.bindMarquee(mount);
    this.ensureDotField();
  }

  /** 渲染整棵图（幂等：先清空已有节点再重建）。 */
  update(script: Script): void {
    // 记住选中项：重建 DOM 会丢掉选中态，但"当前选中哪一步"是 UiShell 层的语义，
    // 不应因视图内部重建而被清掉（否则运行期间会出现"列表有选中、图上没有"的分叉）。
    // 重建后按需恢复；若该步已不在新脚本中（被删），自然不恢复。
    const keep = this.selectedId;
    this.nodeEls.clear();
    this.selectedId = undefined;
    this.lastScript = script;
    // O(1) 索引：一次展平建表，nodeLabel 取叶子文案不再每节点全树遍历（O(n²)→O(n)）。
    this.stepIndex = buildStepIndex(script);
    this.ensureDotField();
    // 同时清空态提示与旧树容器，否则空→非空时会残留"（无步骤，流程图为空）"。
    this.mount
      .querySelectorAll('[data-cfg-node], [data-cfg-empty], [data-cfg-minimap], [data-cfg-edges], .ui-shell-cfg-tree')
      .forEach((el) => el.remove());

    const graph = buildCfgGraph(script);

    if (graph.nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ui-shell-cfg-empty';
      empty.setAttribute('data-cfg-empty', 'true');
      empty.textContent = '（无步骤，流程图为空）';
      this.mount.appendChild(empty);
      return;
    }

    const root = document.createElement('div');
    root.className = 'ui-shell-cfg-tree';
    // 边 SVG 相对这棵树定位；不依赖 index.html 的 position:relative（改色时容易被拿掉）。
    root.style.position = 'relative';
    // 内边距写在树上：第一步不贴齐画布 (0,0)。jsdom 也能从 inline style / offset 读到。
    root.style.paddingTop = '32px';
    root.style.paddingRight = '48px';
    root.style.paddingBottom = '40px';
    root.style.paddingLeft = '40px';
    root.style.marginTop = '12px';
    root.style.marginLeft = '12px';
    root.style.boxSizing = 'border-box';
    root.setAttribute('data-cfg-inset', 'true');
    graph.nodes.forEach((n, i) => {
      if (i > 0) {
        const flow = document.createElement('div');
        flow.className = 'ui-shell-cfg-flow';
        flow.setAttribute('data-cfg-flow', 'true');
        flow.textContent = '↓';
        root.appendChild(flow);
      }
      root.appendChild(this.renderNode(n, true));
    });
    this.mount.appendChild(root);
    this.paintEdges(root, graph);
    // 不画 minimap：和组框叠在一起时看不出作用（spec D11）。
    // 重建后恢复缩放/平移（视图态跨 update 保留）。
    this.applyTransform();

    // 恢复重建前的选中项（该步仍存在时）。setSelected 内部按 nodeEls 命中，
    // 步骤已被删除则自然无操作。
    if (keep !== undefined) this.setSelected(keep);
  }

  /** 递归渲染单个节点（组节点嵌套包含其子节点）。 */
  private renderNode(node: CfgNode, topLevel = false, branch?: 'true' | 'false'): HTMLElement {
    const el = document.createElement('div');
    el.className = `ui-shell-cfg-node ui-shell-cfg-group is-${'pending'}`;
    el.setAttribute('data-cfg-node', node.id);
    el.setAttribute('data-cfg-status', 'pending');
    if (topLevel) {
      el.setAttribute('data-cfg-top', 'true');
    }
    el.setAttribute('data-cfg-draggable', 'true');
    const hideSeqChrome = !!branch && !node.isLeaf && node.kind === 'sequence'
      && isRedundantBranchSeqLabel(this.stepIndex.get(node.id)?.control?.name?.trim() || '顺序组');
    if (hideSeqChrome) el.setAttribute('data-cfg-seq-in-branch', 'true');
    if (!node.isLeaf) {
      const known = (CONTROL_KINDS as readonly string[]).includes(node.kind);
      el.setAttribute('data-cfg-kind', known ? node.kind : 'unknown');
      if (!known) el.classList.add('is-unknown');
      const isCollapsed = this.collapsed.has(node.id);
      el.setAttribute('data-cfg-collapsed', String(isCollapsed));
    } else {
      el.setAttribute('data-cfg-kind', this.stepIndex.get(node.id)?.type ?? 'click');
    }

    const head = document.createElement('div');
    head.className = 'ui-shell-cfg-group-head';
    head.setAttribute('data-cfg-anchor', 'head');
    if (!node.isLeaf && !hideSeqChrome) {
      const title = document.createElement('span');
      title.className = 'ui-shell-cfg-label';
      title.textContent = this.nodeLabel(node);
      head.appendChild(title);
      const tog = document.createElement('span');
      tog.className = 'ui-shell-cfg-collapse';
      tog.setAttribute('data-cfg-collapse', node.id);
      tog.textContent = this.collapsed.has(node.id) ? '▶' : '▼';
      head.appendChild(tog);
      el.appendChild(head);
    }

    if (node.isLeaf) {
      const inner = document.createElement('div');
      inner.className = 'ui-shell-cfg-leaf';
      inner.setAttribute('data-cfg-leaf', 'true');
      const step = this.stepIndex.get(node.id);
      const kind = document.createElement('span');
      kind.className = 'ui-shell-cfg-kind';
      kind.textContent = step ? (TYPE_LABEL[step.type] ?? step.type) : '';
      inner.appendChild(kind);
      const lab = document.createElement('span');
      lab.className = 'ui-shell-cfg-label';
      lab.setAttribute('data-locator-text', 'true');
      lab.textContent = ' ' + this.nodeActionText(node);
      inner.appendChild(lab);
      el.appendChild(inner);
    }

    if (node.isLeaf) {
      this.nodeEls.set(node.id, el);
      return el;
    }

    if (this.collapsed.has(node.id) && !hideSeqChrome) {
      this.nodeEls.set(node.id, el);
      return el;
    }

    const kind: ControlKind = node.kind;
    switch (kind) {
      case 'if': {
        const [thenChild, elseChild] = node.children;
        const branch = document.createElement('div');
        branch.className = 'ui-shell-cfg-if-grid' + (elseChild ? '' : ' is-single');
        if (thenChild) branch.appendChild(this.branchWrap('true', thenChild));
        if (elseChild) branch.appendChild(this.branchWrap('false', elseChild));
        el.appendChild(branch);
        break;
      }
      case 'while': {
        const loop = document.createElement('span');
        loop.className = 'ui-shell-cfg-loop-mark';
        loop.setAttribute('data-cfg-loop', 'true');
        loop.textContent = '↻';
        el.appendChild(loop);
        el.appendChild(this.childrenWrap('ui-shell-cfg-while-body', node.children));
        break;
      }
      case 'sequence':
        el.appendChild(this.childrenWrap('ui-shell-cfg-seq-body', node.children));
        break;
      default:
        warnUnknownControlKind(kind);
        el.appendChild(this.childrenWrap('ui-shell-cfg-seq-body', node.children));
    }

    this.nodeEls.set(node.id, el);
    return el;
  }

  /** if 分支包裹层（真/假两枝的唯一构造处，避免两处重复）。 */
  private branchWrap(branch: 'true' | 'false', child: CfgNode): HTMLElement {
    const b = document.createElement('div');
    b.className = `ui-shell-cfg-branch ui-shell-cfg-branch-${branch}`;
    b.setAttribute('data-cfg-branch', branch);
    const h = document.createElement('h4');
    h.setAttribute('data-cfg-anchor', 'branch-head');
    h.textContent = branch === 'true' ? 'True' : 'False';
    b.appendChild(h);
    b.appendChild(this.renderNode(child, false, branch));
    return b;
  }

  /** 子节点容器（sequence/while 复用）。 */
  private childrenWrap(className: string, children: CfgNode[]): HTMLElement {
    const body = document.createElement('div');
    body.className = className;
    children.forEach((c, i) => {
      if (i > 0) {
        const flow = document.createElement('div');
        flow.className = 'ui-shell-cfg-flow';
        flow.setAttribute('data-cfg-flow', 'true');
        flow.textContent = '↓';
        body.appendChild(flow);
      }
      body.appendChild(this.renderNode(c, false));
    });
    return body;
  }

  /** 节点展示文本（叶子用步骤描述，组标注结构类型与循环次数；折叠组附子节点计数）。 */
  private nodeLabel(node: CfgNode): string {
    if (node.isLeaf) {
      const step = this.stepIndex.get(node.id);
      if (!step) return node.id;
      const named = step.control?.name?.trim();
      return named || describeStepBrief(step);
    }
    // 同上：穷尽性 switch，新增控制流类型时编译期报错而非静默标成"顺序 sequence"。
    const kind: ControlKind = node.kind;
    let base: string;
    const named = this.stepIndex.get(node.id)?.control?.name?.trim();
    switch (kind) {
      case 'while': base = `${named || '循环'} ×${node.loopCount ?? 1}`; break;
      case 'if': base = named || '选择'; break;
      case 'sequence': base = named || '顺序组'; break;
      default:
        // 运行时脏数据：明确显示"未知"，绝不伪装成"顺序 sequence"（那会误导用户）。
        warnUnknownControlKind(kind);
        base = `未知控制结构（${String(kind)}）`;
    }
    // 折叠时附子节点计数，让用户不展开也能判断组规模。
    if (this.collapsed.has(node.id)) {
      base += `（${countLeaves(node)} 步）`;
    }
    return base;
  }

  private emitSelect(stepId: string, mods?: { additive?: boolean }): void {
    this.onSelect?.(stepId, mods);
  }

  private nodeActionText(node: CfgNode): string {
    const step = this.stepIndex.get(node.id);
    if (!step) return node.id;
    const brief = describeStepBrief(step);
    const verb = TYPE_LABEL[step.type] ?? '';
    return brief.replace(verb, '').trim() || brief;
  }

  private clearDragDecor(): void {
    this.mount.querySelectorAll('.is-drag, .is-drop-target').forEach((el) => {
      el.classList.remove('is-drag', 'is-drop-target');
    });
    this.dragGhost?.remove();
    this.dropLine?.remove();
    this.dragGhost = undefined;
    this.dropLine = undefined;
  }

  /**
   * 指针拖拽调序：任意 [data-cfg-node] 按住移动超过阈值后松手落在另一节点上即上报 onReorder。
   * 不用 HTML5 DnD：画布有 transform/scale 时 dragover 命中不稳定。
   */
  private bindPointerDrag(mount: HTMLElement): void {
    if (this.delegatedMounts.has(mount) && (mount as HTMLElement & { __cfgDrag?: boolean }).__cfgDrag) return;
    (mount as HTMLElement & { __cfgDrag?: boolean }).__cfgDrag = true;
    let startId: string | undefined;
    let startX = 0;
    let startY = 0;
    let moving = false;
    const onMove = (e: MouseEvent) => {
      if (!startId) return;
      if (!moving && (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5)) {
        moving = true;
        this.nodeEls.get(startId)?.classList.add('is-drag');
        const src = this.nodeEls.get(startId);
        const ghost = document.createElement('div');
        ghost.className = 'ui-shell-drag-ghost';
        ghost.setAttribute('data-drag-ghost', 'true');
        ghost.textContent = src?.textContent?.trim().slice(0, 40) || '移动步骤';
        document.body.appendChild(ghost);
        this.dragGhost = ghost;
        const line = document.createElement('div');
        line.className = 'ui-shell-drop-line';
        line.setAttribute('data-drop-line', 'true');
        line.hidden = true;
        document.body.appendChild(line);
        this.dropLine = line;
      }
      if (!moving) return;
      if (this.dragGhost) {
        this.dragGhost.style.left = `${e.clientX + 12}px`;
        this.dragGhost.style.top = `${e.clientY + 8}px`;
      }
      this.mount.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
      const over = (e.target as HTMLElement | null)?.closest('[data-cfg-node]') as HTMLElement | null;
      const overId = over?.getAttribute('data-cfg-node');
      if (over && overId && overId !== startId) {
        over.classList.add('is-drop-target');
        const r = over.getBoundingClientRect();
        if (this.dropLine) {
          this.dropLine.hidden = false;
          const before = e.clientY < r.top + r.height / 2;
          this.dropLine.style.left = `${r.left}px`;
          this.dropLine.style.width = `${r.width}px`;
          this.dropLine.style.top = `${before ? r.top : r.bottom}px`;
        }
      } else if (this.dropLine) {
        this.dropLine.hidden = true;
      }
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const from = startId;
      startId = undefined;
      const dropEl = (e.target as HTMLElement | null)?.closest('[data-cfg-node]') as HTMLElement | null;
      const dropId = dropEl?.getAttribute('data-cfg-node');
      this.clearDragDecor();
      if (!moving || !from) {
        moving = false;
        return;
      }
      moving = false;
      this.suppressClick = true;
      if (dropId && dropId !== from) this.onReorder?.(from, dropId);
    };
    mount.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      const hit = (e.target as HTMLElement | null)?.closest('[data-cfg-node]') as HTMLElement | null;
      if (!hit || !mount.contains(hit)) return;
      if ((e.target as HTMLElement | null)?.closest('[data-cfg-collapse]')) return;
      startId = hit.getAttribute('data-cfg-node') ?? undefined;
      startX = e.clientX;
      startY = e.clientY;
      moving = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /**
   * 左键在空白处拖框：命中节点后上报 onMarquee（spec §2.5）。
   */
  private bindMarquee(mount: HTMLElement): void {
    if ((mount as HTMLElement & { __cfgMarquee?: boolean }).__cfgMarquee) return;
    (mount as HTMLElement & { __cfgMarquee?: boolean }).__cfgMarquee = true;
    let active = false;
    let x0 = 0;
    let y0 = 0;
    let box: HTMLElement | undefined;
    const onMove = (e: MouseEvent) => {
      if (!active || !box) return;
      const x1 = e.clientX;
      const y1 = e.clientY;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(x1 - x0)}px`;
      box.style.height = `${Math.abs(y1 - y0)}px`;
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!active) return;
      active = false;
      const x1 = e.clientX;
      const y1 = e.clientY;
      box?.remove();
      box = undefined;
      if (Math.abs(x1 - x0) < 8 && Math.abs(y1 - y0) < 8) {
        // 空白单击：清掉框选浮动钮（不和拖框打包抢手势）。
        this.onBlank?.();
        return;
      }
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const right = Math.max(x0, x1);
      const bottom = Math.max(y0, y1);
      const ids: string[] = [];
      for (const [id, el] of this.nodeEls) {
        const r = el.getBoundingClientRect();
        const hit = r.left < right && r.right > left && r.top < bottom && r.bottom > top;
        if (hit) ids.push(id);
      }
      if (ids.length >= 2) {
        // 松手落在节点上才吞掉随后的 click，避免误选中；落在空白上不吞，方便点空白收起浮动钮。
        if ((e.target as HTMLElement | null)?.closest('[data-cfg-node]')) this.suppressClick = true;
        this.onMarquee?.(ids);
      }
    };
    mount.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      const onNode = (e.target as HTMLElement | null)?.closest('[data-cfg-node],[data-cfg-collapse],[data-cfg-minimap],[data-pack-menu],[data-detail]');
      if (onNode) return;
      active = true;
      x0 = e.clientX;
      y0 = e.clientY;
      box = document.createElement('div');
      box.className = 'ui-shell-marquee';
      box.setAttribute('data-marquee', 'true');
      box.style.cssText = `position:fixed;left:${x0}px;top:${y0}px;width:0;height:0;border:1px dashed var(--accent,#5a8fad);background:var(--accent-fill,rgba(90,143,173,.10));pointer-events:none;z-index:20;`;
      document.body.appendChild(box);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** 按图模型画 SVG 有向边（True/False/回环）。顺序边用层内 ↓，不再画 SVG flow。 */
  private paintEdges(root: HTMLElement, graph: CfgGraph): void {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('data-cfg-edges', 'true');
    svg.setAttribute('class', 'ui-shell-cfg-edges');
    const w = Math.max(root.scrollWidth || 0, root.clientWidth || 0, 1);
    const h = Math.max(root.scrollHeight || 0, root.clientHeight || 0, 1);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    // 像素钉在树原点。CSS `inset:0;width/height:100%` 会把 viewBox 压进画布视口，
    // 条件头→列头的线看起来像从组底朝上倒插（截图里的 V）。
    svg.style.position = 'absolute';
    svg.style.left = '0px';
    svg.style.top = '0px';
    svg.style.right = 'auto';
    svg.style.bottom = 'auto';
    svg.style.inset = 'auto';
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', 'cfg-arrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const tip = document.createElementNS(svgNS, 'path');
    tip.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
    tip.setAttribute('fill', 'currentColor');
    marker.appendChild(tip);
    defs.appendChild(marker);
    svg.appendChild(defs);
    const origin = readBox(root);
    for (const e of graph.edges) {
      // 顺序边已由各层 ↓ 间隔表达；再画 SVG flow 会穿过嵌套组，看起来像乱箭。
      if (e.kind === 'flow') continue;
      const fromEl = this.nodeEls.get(e.from);
      const toEl = this.nodeEls.get(e.to);
      if (e.kind === 'loop') {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('data-cfg-edge', 'loop');
        path.setAttribute('data-from', e.from);
        path.setAttribute('data-to', e.to);
        if (fromEl && toEl) {
          const headEl = (toEl.querySelector(':scope > .ui-shell-cfg-group-head') as HTMLElement | null) ?? toEl;
          path.setAttribute('d', loopEdgePath(readBox(fromEl), readBox(headEl), readBox(toEl), origin));
        } else {
          path.setAttribute('d', 'M 0 0');
        }
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-dasharray', '4 3');
        path.setAttribute('marker-end', 'url(#cfg-arrow)');
        svg.appendChild(path);
        continue;
      }
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('data-cfg-edge', e.kind);
      line.setAttribute('data-from', e.from);
      line.setAttribute('data-to', e.to);
      // True/False 只从条件头锚点拉到列头锚点。
      // 禁止回退到组外框：组框底边在 True/False 下面，一回退就是截图里「从组下方朝上插」的 V。
      // sequence 包装作为分支子节点时，toEl 是整组，更不能拿它当终点。
      if (fromEl && toEl) {
        const headEl = fromEl.querySelector(':scope > [data-cfg-anchor="head"]') as HTMLElement | null;
        const branchWrap = toEl.closest('[data-cfg-branch]') as HTMLElement | null;
        const branchHead = branchWrap?.querySelector(':scope > [data-cfg-anchor="branch-head"]') as HTMLElement | null;
        if (headEl && branchHead) {
          const pts = branchEdgeLine(readBox(headEl), readBox(branchHead), origin);
          if (!isInwardVIntoGroup(readBox(fromEl), pts, origin)) {
            line.setAttribute('x1', String(pts.x1));
            line.setAttribute('y1', String(pts.y1));
            line.setAttribute('x2', String(pts.x2));
            line.setAttribute('y2', String(pts.y2));
          }
        }
      }
      if (!line.hasAttribute('x1')) {
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '0');
        line.setAttribute('x2', '0');
        line.setAttribute('y2', '0');
      }
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', 'url(#cfg-arrow)');
      svg.appendChild(line);
    }
    root.insertBefore(svg, root.firstChild);
  }

  /**
   * 原地更新某节点的运行状态（不整树重建）。
   * 测试断言：调用前后同一 DOM 引用不变。
   * 运行态自动滚入视口（spec §2.6.1）：running 时把当前节点 scrollIntoView，
   * 让大脚本运行时用户视线自动跟随；pass/fail 不抢焦点（避免每步都跳）。
   */
  setStatus(stepId: string, status: StepRunStatus): void {
    const el = this.nodeEls.get(stepId);
    if (!el) return; // 未知节点：防御性跳过（边界安全）
    el.setAttribute('data-cfg-status', status);
    // className 同步运行态 class（保留 is-fail 等以供测试 .className 断言）。
    el.classList.remove('is-pending', 'is-running', 'is-pass', 'is-fail');
    el.classList.add(`is-${status}`);
    if (status === 'running') this.panNodeIntoView(el);
  }

  /** 运行中把当前步平滑移到画布中心（200–300ms），不要 jump。 */
  private panNodeIntoView(el: HTMLElement): void {
    const cr = this.mount.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const dx = (cr.left + cr.width / 2) - (r.left + r.width / 2);
    const dy = (cr.top + cr.height / 2) - (r.top + r.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    this.panX += dx;
    this.panY += dy;
    this.applyTransform({ animate: true });
  }

  /** 设置选中态。primary 为详情焦点；extras 为多选打包用。 */
  setSelected(stepId?: string, extras?: Iterable<string>): void {
    this.mount.querySelectorAll('[data-cfg-selected="true"]').forEach((el) => {
      el.setAttribute('data-cfg-selected', 'false');
      el.classList.remove('is-selected');
    });
    this.selectedId = stepId;
    const ids = new Set<string>(extras ? [...extras] : []);
    if (stepId) ids.add(stepId);
    for (const id of ids) {
      const el = this.nodeEls.get(id);
      if (el) {
        el.setAttribute('data-cfg-selected', 'true');
        el.classList.add('is-selected');
      }
    }
  }
}

// ───────────────────────── 复用 shell 的展示工具（避免重复实现）─────────────────────────

/** 一次展平建 stepId → Step 索引（O(n)），供 nodeLabel O(1) 取叶子文案。 */
function buildStepIndex(script: Script): Map<string, Step> {
  const idx = new Map<string, Step>();
  const walk = (steps: Step[] | undefined): void => {
    if (!steps) return;
    for (const s of steps) {
      if (s == null) continue; // 坏数据兜底（§4.1）
      idx.set(s.id, s);
      if (s.children?.length) walk(s.children);
    }
  };
  walk(script.steps);
  return idx;
}

/** 枝内 sequence 包装若只是 True/False/顺序组，不要再印一层和列头重复的词。 */
function isRedundantBranchSeqLabel(label: string): boolean {
  const t = label.trim();
  if (!t || t === '顺序组') return true;
  return /^true$/i.test(t) || /^false$/i.test(t);
}

/** 折叠组附子节点计数：只数叶子（用户关心的"几步"），不计中间组。 */
function countLeaves(node: CfgNode): number {
  if (node.isLeaf) return 1;
  let n = 0;
  for (const c of node.children) n += countLeaves(c);
  return n;
}

// describeStepBrief 已收敛到 ./step-label（与步骤列表共用同一份文案真相源）。
