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

/** 递归建节点，并累加边到 `edges`。 */
function buildNode(step: Step, edges: CfgEdge[]): CfgNode | null {
  // 坏数据兜底：null/undefined 直接跳过（§4.1）。
  if (step == null) return null;

  const ctrl = step.control;
  if (!ctrl) {
    // 叶子节点
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

  // 边：同层相邻兄弟链式 flow。
  for (let i = 0; i < children.length - 1; i++) {
    edges.push({ from: children[i].id, to: children[i + 1].id, kind: 'flow' });
  }

  switch (ctrl.kind) {
    case 'if': {
      // children[0]=then(→true)、children[1]=else(→false)；只有一个 child 不得臆造 false 边。
      if (children[0]) edges.push({ from: step.id, to: children[0].id, kind: 'true' });
      if (children[1]) edges.push({ from: step.id, to: children[1].id, kind: 'false' });
      break;
    }
    case 'while': {
      // 循环头到首子 flow；末子回到循环头 loop（回环）。
      if (children.length > 0) {
        edges.push({ from: step.id, to: children[0].id, kind: 'flow' });
        const last = children[children.length - 1];
        edges.push({ from: last.id, to: step.id, kind: 'loop' });
      }
      break;
    }
    case 'sequence':
      // 顺序组：子节点间链式 flow 已在上方统一生成；组头到首子也连 flow。
      if (children.length > 0) {
        edges.push({ from: step.id, to: children[0].id, kind: 'flow' });
      }
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
import { describeStepBrief } from './step-label';

export type CfgViewOptions = {
  mount: HTMLElement;
  /** 点击节点时上报被点击的 stepId（由外部决定联动，本组件不依赖 UiShell）。 */
  onSelect?: (stepId: string) => void;
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
  private onSelect?: (stepId: string) => void;
  /** stepId → 对应 DOM 节点，供 setStatus 原地更新 O(1) 命中。 */
  private nodeEls = new Map<string, HTMLElement>();
  /** 当前选中态（同时只有一个；覆盖式设置）。 */
  private selectedId?: string;

  /** 已绑定委托的挂载元素（避免 rebindMount 后重复绑定造成一次点击多次上报）。 */
  private delegatedMounts = new WeakSet<HTMLElement>();

  // ---- B4 规模可读性（spec §2.6.1）：视图态，不入 schema ----
  /** 折叠态：哪些组节点被折叠（仅视图层，D6；脚本数据不变）。 */
  private collapsed = new Set<string>();
  /** 缩放与平移：Ctrl+滚轮缩放、空白拖拽平移，避免大脚本看不下。 */
  private scale = 1;
  private panX = 0;
  private panY = 0;
  /** 最近一次渲染的脚本：折叠/缩放后整树重渲染需要。 */
  private lastScript: Script | undefined;
  /** stepId → Step 的 O(1) 索引：nodeLabel 取叶子文案不再每节点全树遍历（O(n²)→O(n)）。 */
  private stepIndex = new Map<string, Step>();

  constructor(opts: CfgViewOptions) {
    this.mount = opts.mount;
    this.onSelect = opts.onSelect;
    this.bindDelegation(this.mount);
    this.bindZoomPan(this.mount);
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
      // 折叠按钮优先：点折叠不触发选中（否则折叠的同时会选中该组，行为相互干扰）。
      const collapseHit = (e.target as HTMLElement | null)?.closest('[data-cfg-collapse]');
      if (collapseHit && mount.contains(collapseHit)) {
        const id = collapseHit.getAttribute('data-cfg-collapse');
        if (id) this.toggleCollapse(id);
        return;
      }
      const hit = (e.target as HTMLElement | null)?.closest('[data-cfg-node]');
      if (!hit || !mount.contains(hit)) return;
      const id = hit.getAttribute('data-cfg-node');
      if (id) this.emitSelect(id);
    });
  }

  /** 折叠/展开组节点（视图态；切换后整树重渲染，选中态由 update 内部保留）。 */
  private toggleCollapse(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    if (this.lastScript) this.update(this.lastScript);
  }

  /**
   * 缩放（Ctrl+滚轮）与平移（空白拖拽）：spec §2.6.1 规模可读性。
   * 无 Ctrl 的滚轮交给浏览器原生滚动，避免劫持正常翻页。
   */
  private bindZoomPan(mount: HTMLElement): void {
    mount.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // 无 Ctrl 不劫持：让页面正常滚动
      e.preventDefault();
      // deltaY 向上为负 → 放大；步长按 0.1，钳在 0.25–2.5 防止缩到看不见或过大溢出。
      const next = this.scale - Math.sign(e.deltaY) * 0.1;
      this.scale = Math.min(2.5, Math.max(0.25, Math.round(next * 100) / 100));
      this.applyTransform();
    }, { passive: false });
    // 空白拖拽平移：mousedown 落点不在任何节点上时启动。
    let dragging = false;
    let startX = 0, startY = 0, baseX = 0, baseY = 0;
    mount.addEventListener('mousedown', (e) => {
      const onNode = (e.target as HTMLElement | null)?.closest('[data-cfg-node],[data-cfg-collapse]');
      if (onNode) return; // 点在节点上：让节点交互（选中/折叠）生效，不启动平移
      dragging = true;
      startX = e.clientX; startY = e.clientY; baseX = this.panX; baseY = this.panY;
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

  /** 把 scale/pan 写到当前 cfg 树的 transform 与 data 属性（供测试与样式断言）。 */
  private applyTransform(): void {
    const tree = this.mount.querySelector('.ui-shell-cfg-tree') as HTMLElement | null;
    if (!tree) return;
    tree.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    tree.setAttribute('data-cfg-scale', String(this.scale));
    tree.setAttribute('data-cfg-pan-x', String(this.panX));
    tree.setAttribute('data-cfg-pan-y', String(this.panY));
  }

  /**
   * 重新绑定挂载区：render 全量 innerHTML='' 后，旧 mount 已脱离文档，
   * 需把 CfgView 指向新创建的 cfg 区，避免重复 new 导致事件重复绑定。
   * 重新绑定会清空已记录的节点引用，下次 update 重建。
   */
  rebindMount(mount: HTMLElement): void {
    this.mount = mount;
    this.nodeEls.clear();
    this.selectedId = undefined;
    this.bindDelegation(mount); // 新 mount 需要自己的委托（WeakSet 保证不重复绑定）
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
    // 同时清空态提示与旧树容器，否则空→非空时会残留"（无步骤，流程图为空）"。
    this.mount
      .querySelectorAll('[data-cfg-node], [data-cfg-empty], .ui-shell-cfg-tree')
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
    for (const n of graph.nodes) {
      root.appendChild(this.renderNode(n));
    }
    this.mount.appendChild(root);
    // 重建后恢复缩放/平移（视图态跨 update 保留）。
    this.applyTransform();

    // 恢复重建前的选中项（该步仍存在时）。setSelected 内部按 nodeEls 命中，
    // 步骤已被删除则自然无操作。
    if (keep !== undefined) this.setSelected(keep);
  }

  /** 递归渲染单个节点（组节点嵌套包含其子节点）。 */
  private renderNode(node: CfgNode): HTMLElement {
    const el = document.createElement('div');
    el.className = `ui-shell-cfg-node is-${'pending'}`;
    el.setAttribute('data-cfg-node', node.id);
    el.setAttribute('data-cfg-status', 'pending');
    if (!node.isLeaf) {
      // 未知 kind（运行时脏数据）标为 'unknown'，让问题在界面上可见而非伪装成合法结构。
      const known = (CONTROL_KINDS as readonly string[]).includes(node.kind);
      el.setAttribute('data-cfg-kind', known ? node.kind : 'unknown');
      if (!known) el.classList.add('is-unknown');
      // 折叠态属性（视图层）：供测试与样式断言。
      const isCollapsed = this.collapsed.has(node.id);
      el.setAttribute('data-cfg-collapsed', String(isCollapsed));
    }

    const label = document.createElement('span');
    label.className = 'ui-shell-cfg-label';
    label.textContent = this.nodeLabel(node);
    el.appendChild(label);

    // 组节点折叠按钮（spec §2.6.1）：点击切换折叠态；叶子无此按钮。
    if (!node.isLeaf) {
      const tog = document.createElement('span');
      tog.className = 'ui-shell-cfg-collapse';
      tog.setAttribute('data-cfg-collapse', node.id);
      tog.textContent = this.collapsed.has(node.id) ? '▶' : '▼';
      el.appendChild(tog);
    }

    // 点击不在此处逐节点绑定：改由 mount 级单一事件委托（见 bindDelegation），
    // 用 `closest('[data-cfg-node]')` 就近命中。原因：真实用户点的是节点**内部的文字**，
    // 此时 e.target 是 label 子元素、不等于节点本身，"仅当 target===currentTarget 才上报"
    // 会导致点文字无反应（而 `el.click()` 的合成事件恰好 target===el，把该缺陷掩盖了）。

    if (node.isLeaf) {
      this.nodeEls.set(node.id, el);
      return el;
    }

    // 折叠态：不渲染子节点（label 已含子节点计数），节省大脚本渲染量。
    if (this.collapsed.has(node.id)) {
      this.nodeEls.set(node.id, el);
      return el;
    }

    // 组节点：按控制结构包裹子节点。
    // 用 switch + 穷尽性检查（而非 if/else + 兜底 else）：新增 ControlKind 时
    // 编译期即报错指出此处漏改，避免被静默按顺序组渲染（图与真实执行不符）。
    // 对 kind 取局部变量再 switch：让收窄落在**值**上，
    // default 分支里 kind 才会是 never（若对 node 取 switch，收窄的是整个对象，
    // default 里 node 变 never，反而读不出 node.kind）。
    const kind: ControlKind = node.kind;
    switch (kind) {
      case 'if': {
        const [thenChild, elseChild] = node.children;
        if (thenChild) el.appendChild(this.branchWrap('true', thenChild));
        if (elseChild) el.appendChild(this.branchWrap('false', elseChild));
        break;
      }
      case 'while': {
        const loop = document.createElement('span');
        loop.className = 'ui-shell-cfg-loop-mark';
        loop.setAttribute('data-cfg-loop', 'true');
        loop.textContent = '↻'; // 回环视觉标记
        el.appendChild(loop);
        el.appendChild(this.childrenWrap('ui-shell-cfg-while-body', node.children));
        break;
      }
      case 'sequence':
        el.appendChild(this.childrenWrap('ui-shell-cfg-seq-body', node.children));
        break;
      default:
        // 运行时脏数据：仍把子节点画出来（不让它们凭空消失），但不声称任何控制语义。
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
    b.appendChild(this.renderNode(child));
    return b;
  }

  /** 子节点容器（sequence/while 复用）。 */
  private childrenWrap(className: string, children: CfgNode[]): HTMLElement {
    const body = document.createElement('div');
    body.className = className;
    for (const c of children) body.appendChild(this.renderNode(c));
    return body;
  }

  /** 节点展示文本（叶子用步骤描述，组标注结构类型与循环次数；折叠组附子节点计数）。 */
  private nodeLabel(node: CfgNode): string {
    if (node.isLeaf) {
      // O(1) 命中：从 update 时建好的 stepIndex 取，不再每节点全树遍历。
      const step = this.stepIndex.get(node.id);
      return step ? describeStepBrief(step) : node.id;
    }
    // 同上：穷尽性 switch，新增控制流类型时编译期报错而非静默标成"顺序 sequence"。
    const kind: ControlKind = node.kind;
    let base: string;
    switch (kind) {
      case 'while': base = `循环 while ×${node.loopCount ?? 1}`; break;
      case 'if': base = '选择 if'; break;
      case 'sequence': base = '顺序 sequence'; break;
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

  private emitSelect(stepId: string): void {
    this.onSelect?.(stepId);
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
    if (status === 'running' && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 设置选中态（同时只有一个）。 */
  setSelected(stepId?: string): void {
    // 清旧
    if (this.selectedId) {
      const prev = this.nodeEls.get(this.selectedId);
      if (prev) {
        prev.setAttribute('data-cfg-selected', 'false');
        prev.classList.remove('is-selected');
      }
    }
    this.selectedId = stepId;
    if (stepId) {
      const el = this.nodeEls.get(stepId);
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

/** 折叠组附子节点计数：只数叶子（用户关心的"几步"），不计中间组。 */
function countLeaves(node: CfgNode): number {
  if (node.isLeaf) return 1;
  let n = 0;
  for (const c of node.children) n += countLeaves(c);
  return n;
}

// describeStepBrief 已收敛到 ./step-label（与步骤列表共用同一份文案真相源）。
