// 统一步骤模型：录制 / Agent 轨迹 / 导入导出 / MCP Tool / 执行器 共用此结构。
// 运行时常量（STEP_TYPES / CONTROL_KINDS）为类型唯一真相源，类型由其反推。

// 运行时常量为唯一真相源，类型由其反推（`typeof ARR[number]`）。
// 理由：TS 联合类型在运行时不存在，跨进程边界校验（bridge-server）必须有运行时值可查。
// 若各自维护"联合类型 + 校验用字面量数组"，新增类型时极易只改一处而漂移（OCP 风险）。
export const STEP_TYPES = [
  'click', 'fill', 'select', 'wait',
  'assert', 'hover', 'eval', 'snapshot',
  'waitUntil', 'repeat',
] as const;
export type StepType = typeof STEP_TYPES[number];

export const CONTROL_KINDS = ['sequence', 'if', 'while'] as const;
export type ControlKind = typeof CONTROL_KINDS[number];

/**
 * 步骤运行态（M3-R3）：**瞬时 UI 状态，刻意不作为 `Step` 的字段**。
 * 理由（SRP）：`Step` 是持久化数据（导出写盘、进 R5 版本层 diff），
 * 把 pass/fail 混进去会污染脚本文件与版本差异。故由 UI 侧旁挂 Map 保存。
 *
 * 放在本文件而非 `ui/shell.ts`：`ui/cfg-view.ts` 等**同级视图组件**也需要此类型，
 * 若从 shell 引入会形成"子组件反向依赖编排者"的耦合（违反架构文档中
 * "CfgView 仅依赖 Script/Step 类型"的约定）。故与 StepType/ControlKind 同处真相源。
 */
export type StepRunStatus = 'pending' | 'running' | 'pass' | 'fail';

/** 运行进度事件载荷（服务端经 'step-progress' 推送）。 */
export type StepProgressEvent = {
  stepId: string;
  status: StepRunStatus;
  /**
   * 该步的**高亮截图**（base64 PNG，无 data: 前缀），由桥端在**执行该步之前**拍好随事件下发。
   * 可选：旧内核不实现逐步截图时没有此字段，UI 侧不得因此报错，更不得伪造图片充数。
   */
  shot?: string;
};

export type Locator = {
  role?: string;       // 语义角色，如 'button'
  name?: string;       // accessibility name
  text?: string;       // 可见文本（模糊/精确）
  textExact?: boolean;
  testId?: string;     // data-testid
  css?: string;
  xpath?: string;
};

// 与 STEP_TYPES / CONTROL_KINDS 同风格：运行时常量为唯一真相源，类型由其反推。
// 理由：断言 kind 会跨 WS/JSON 边界（bridge-server 校验、MCP 入参），
// 只有类型则运行时查不到全集，新增 kind 时极易只改一处而漂移。
export const ASSERTION_KINDS = [
  'exists', 'visible', 'textContains',
  'titleIs', 'urlMatches', 'expr',
  'elementVisibleInViewport', 'screenshotMatches',
  // 截图 + 提示词断言（模型视觉判定）：提示词复用 value 字段，零 schema 变更。
  'visionPrompt',
] as const;

export type AssertionKind = typeof ASSERTION_KINDS[number];

export type Assertion = {
  kind: AssertionKind;
  // exists/visible 必填；textContains 可选（缺省=整页文本；先搜快照控件，未命中回落到整页）
  locator?: Locator;
  /** textContains/titleIs/urlMatches/expr 用；visionPrompt 用它承载提示词。 */
  value?: string;
  /** 检测前等待毫秒数（供 Agent 推理/异步渲染留时间，如"等待 N 秒后检测元素值"）。 */
  waitMs?: number;
};

export type StepSource = 'manual' | 'agent' | 'repaired' | 'recorded';

export type Step = {
  id: string;
  type: StepType;
  target?: string;     // window/webview 标识；缺省=主目标
  locator?: Locator;
  params?: {
    value?: string;            // fill 文本 / select option
    optionText?: string;       // select
    durationMs?: number;       // wait
    timeoutMs?: number;        // waitUntil 等待条件成立的超时
    key?: string;              // wait 文本/键
    code?: string;             // eval JS
    assertion?: Assertion;     // assert / waitUntil 用
  };
  expect?: Assertion;          // 步骤级可选期望
  source: StepSource;
  // ── M3-R0 CFG 扩展（加法式，向后兼容 v1 扁平脚本）──
  /** 递归子步骤：控制流节点（sequence/if/while）携带，叶子步骤可省略。 */
  children?: Step[];
  /** 控制结构：顺序/选择/循环。叶子步骤省略此字段。 */
  control?: {
    kind: ControlKind;
    /** 组名（spec §2.5/D5）：UI 把每个节点当组操作，组名供人识别与 CFG 节点展示，非内部实现 id。 */
    name?: string;
    /** if 分支的判断条件（复用 Assertion）。 */
    condition?: Assertion;
    /** while 循环的重复次数。 */
    loopCount?: number;
  };
  meta?: {
    window?: string;
    timestamp?: string;
    note?: string;
  };
};

export type Script = {
  schema: 'electron-auto-test/step/v1' | 'electron-auto-test/step/v2';
  app: { name: string; version?: string };
  steps: Step[];
  createdAt?: string;
  note?: string;
  /**
   * 可选配图：stepId → png data URL（或裸 base64）。
   * 仍是同一份 v1 JSON，不是第二种格式；导入后舞台能看图，不必先连靶机。
   */
  shots?: Record<string, string>;
};

export const SCRIPT_SCHEMA = 'electron-auto-test/step/v1';
export const SCRIPT_SCHEMA_V2 = 'electron-auto-test/step/v2';
export const SCRIPT_SCHEMAS = [SCRIPT_SCHEMA, SCRIPT_SCHEMA_V2] as const;
