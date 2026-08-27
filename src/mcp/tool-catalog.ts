// MCP Tool 注册表：名称与 design.md §6 / architecture §3-C 对齐。
// 描述写行为（模型怎么调），不写需求编号。

export type JsonSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

const obj = (properties: Record<string, unknown> = {}, required?: string[]): JsonSchema => ({
  type: 'object',
  properties,
  additionalProperties: true,
  ...(required && required.length ? { required } : {}),
});

const locatorProp = {
  type: 'object',
  description: '语义化 locator（role/name/text/testId/css/xpath）',
  additionalProperties: true,
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'launch-target',
    description:
      '用现有 scripts/launch-*.cmd 拉起被测 Electron（vscode/codebuddy/workbuddy），返回实际调试端口。不要假设 9222。',
    inputSchema: obj({
      name: { type: 'string', description: 'targets.json 中的 name：vscode / codebuddy / workbuddy' },
      port: { type: 'number', description: '覆盖启动脚本端口；省略则用该靶机目录默认值' },
    }),
  },
  {
    name: 'target.stop',
    description: '停止本会话 launch-target 拉起的被测进程（按调试端口杀监听进程）。',
    inputSchema: obj({
      port: { type: 'number', description: '省略则用本会话上次 launch-target 返回的端口' },
    }),
  },
  {
    name: 'workbench.start',
    description:
      '启动测试步骤中台（等价 npm run ui），返回实际 URL（端口占用时可能不是 5173）。',
    inputSchema: obj({
      port: { type: 'number', description: 'UI_PORT 覆盖' },
    }),
  },
  {
    name: 'workbench.stop',
    description: '停止本会话拉起的工作台进程。未由本会话启动的实例不会被杀掉。',
    inputSchema: obj(),
  },
  {
    name: 'app.connect',
    description: 'CDP connectOverCDP。port 用 launch-target 的返回值；省略则走内核探测，不要口播 9222。',
    inputSchema: obj({
      port: { type: 'number' },
      appPath: { type: 'string' },
    }),
  },
  {
    name: 'app.disconnect',
    description: '断开 CDP 连接。',
    inputSchema: obj(),
  },
  {
    name: 'app.list_targets',
    description:
      '列出外层 page 与嵌套 webview。写脚本前先调本工具，把返回的 id 写入步骤的 target 字段；观察用 page.snapshot({ targetId })。',
    inputSchema: obj(),
  },
  {
    name: 'page.snapshot',
    description:
      '可交互节点快照。可选 targetId（默认当前目标）。JSON 里的 null 视为缺省，不会当成 id。',
    inputSchema: obj({
      targetId: { type: ['string', 'null'], description: 'list_targets 的 id；省略/null=当前页' },
    }),
  },
  {
    name: 'page.click',
    description:
      '可选单步探针：在指定 target 上点一次，确认 locator。整条测试请写成 Script JSON 后走 actions.execute_steps。',
    inputSchema: obj({
      locator: locatorProp,
      targetId: { type: ['string', 'null'] },
    }),
  },
  {
    name: 'page.fill',
    description:
      '可选单步探针：在指定 target 上填一次。整条测试请写成 Script JSON 后走 actions.execute_steps。',
    inputSchema: obj({
      locator: locatorProp,
      value: { type: 'string' },
      targetId: { type: ['string', 'null'] },
    }),
  },
  {
    name: 'page.wait',
    description: '等待时长或页面出现某段文本。',
    inputSchema: obj({
      durationMs: { type: 'number' },
      text: { type: 'string' },
      targetId: { type: ['string', 'null'] },
    }),
  },
  {
    name: 'page.waitUntil',
    description:
      '轮询直到断言成立。支持 kind=textContains（搜 snapshot 文本，含嵌套节点）。可带 targetId。',
    inputSchema: obj({
      kind: { type: 'string', description: '如 textContains / exists / visible' },
      value: { type: 'string' },
      locator: locatorProp,
      assertion: { type: 'object', additionalProperties: true },
      timeoutMs: { type: 'number' },
      targetId: { type: ['string', 'null'] },
    }),
  },
  {
    name: 'page.screenshot',
    description: '截图；可选 target / highlight locator。返回 png base64，不改 Script schema。',
    inputSchema: obj({
      targetId: { type: ['string', 'null'] },
      highlight: locatorProp,
      fullPage: { type: 'boolean' },
      savePath: { type: 'string' },
    }),
  },
  {
    name: 'actions.execute_steps',
    description: '执行整份 Script（内核 runCli）。步骤已有 target 字段会被执行器遵守。',
    inputSchema: obj({
      script: { description: 'Script 对象或 JSON 字符串' },
      fromStepId: { type: ['string', 'null'] },
    }),
  },
  {
    name: 'script.import',
    description: '校验并解析 Script JSON（文件路径或字符串）。不推进工作台；推进用 script.open。',
    inputSchema: obj({
      json: { type: 'string' },
      path: { type: 'string' },
    }),
  },
  {
    name: 'script.export',
    description: '把 Script 对象序列化为 JSON 字符串。',
    inputSchema: obj({
      script: { description: 'Script 对象' },
    }),
  },
  {
    name: 'script.open',
    description:
      '把 Script JSON 推进当前工作台会话（桥 loadScript + WS 广播 load-script）。不是文件导入，也不替代 UI 导入按钮。',
    inputSchema: obj({
      script: { description: 'Script 对象或 JSON 字符串' },
    }),
  },
  {
    name: 'assert.run',
    description: '执行单条断言（含 textContains）。',
    inputSchema: obj({
      kind: { type: 'string' },
      value: { type: 'string' },
      locator: locatorProp,
      waitMs: { type: 'number' },
    }),
  },
  {
    name: 'record.start',
    description: '开始内核录制（注入全部已枚举 target）。Agent 不必录制，但原子已暴露。',
    inputSchema: obj(),
  },
  {
    name: 'record.stop',
    description: '停止录制并返回 InteractionEvent[]。',
    inputSchema: obj(),
  },
  {
    name: 'record.get_steps',
    description: '把最近一次录制事件转成 Step[]（不写盘、不改 schema）。',
    inputSchema: obj(),
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);
