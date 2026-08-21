// 统一步骤模型（M1 设计文档 §4）
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
  | 'titleIs' | 'urlMatches' | 'expr';

export type Assertion = {
  kind: AssertionKind;
  locator?: Locator;   // exists/visible/textContains 用
  value?: string;      // textContains/titleIs/urlMatches/expr 用
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
  meta?: {
    window?: string;
    timestamp?: string;
    note?: string;
  };
};

export type Script = {
  schema: 'electron-auto-test/step/v1';
  app: { name: string; version?: string };
  steps: Step[];
  createdAt?: string;
  note?: string;
};

export const SCRIPT_SCHEMA = 'electron-auto-test/step/v1';
