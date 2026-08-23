// 统一步骤模型（M1 design.md §4）
// 录制 / Agent 轨迹 / 导入导出 / MCP Tool / 执行器 共用此结构。

export type StepType =
  | 'click' | 'fill' | 'select' | 'wait'
  | 'assert' | 'hover' | 'eval' | 'snapshot';

export type Locator = {
  role?: string;       // 语义角色，如 'button'
  name?: string;       // accessibility name
  text?: string;       // 可见文本（模糊/精确）
  textExact?: boolean;
  testId?: string;     // data-testid
  css?: string;
  xpath?: string;
};

export type AssertionKind =
  | 'exists' | 'visible' | 'textContains'
  | 'titleIs' | 'urlMatches' | 'expr'
  | 'elementVisibleInViewport' | 'screenshotMatches';

export type Assertion = {
  kind: AssertionKind;
  locator?: Locator;   // exists/visible/textContains 用
  value?: string;      // textContains/titleIs/urlMatches/expr 用
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
    key?: string;              // wait 文本/键
    code?: string;             // eval JS
    assertion?: Assertion;     // assert 用
  };
  expect?: Assertion;          // 步骤级可选期望
  source: StepSource;
  // ── M3-R0 CFG 扩展（加法式，向后兼容 v1 扁平脚本）──
  /** 递归子步骤：控制流节点（sequence/if/while）携带，叶子步骤可省略。 */
  children?: Step[];
  /** 控制结构：顺序/选择/循环。叶子步骤省略此字段。 */
  control?: {
    kind: 'sequence' | 'if' | 'while';
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
};

export const SCRIPT_SCHEMA = 'electron-auto-test/step/v1';
export const SCRIPT_SCHEMA_V2 = 'electron-auto-test/step/v2';
export const SCRIPT_SCHEMAS = [SCRIPT_SCHEMA, SCRIPT_SCHEMA_V2] as const;
