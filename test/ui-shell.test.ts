// @vitest-environment jsdom
// UI 壳（可视化蒙版）单元测试 —— 测试先行（CODEBUDDY.md §5）。
// 用 mock kernel 验证 UiShell 的编排逻辑与状态管理，不依赖真机。
//
// 设计意图：UiShell 依赖 CdpAdapter & VisualCapable & Recordable 抽象（DIP），
// 因此单测可注入 MockKernel 完整驱动：连接 / 录制 / 编辑 / 回放 / 高亮 / 导入导出。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UiShell, assertionKindLabel } from '../src/ui/shell';
import { SCRIPT_SCHEMA, type Script, type Step, type Locator } from '../src/types/step';

// ---- Mock Kernel：同时实现三大抽象接口，并记录调用 ----

type AnyKernel = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  listTargets: ReturnType<typeof vi.fn>;
  selectTarget: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  locateVisual: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  playback: ReturnType<typeof vi.fn>;
  captureFrame: ReturnType<typeof vi.fn>;
  calls: string[];
};

function makeMockKernel(recordedEvents: any[] = []) {
  const calls: string[] = [];
  const log = (name: string) => () => { calls.push(name); };
  const kernel = {
    calls,
    connect: vi.fn(async () => { calls.push('connect'); }),
    disconnect: vi.fn(async () => { calls.push('disconnect'); }),
    listTargets: vi.fn((): any[] => {
      calls.push('listTargets');
      return [
        { id: 'main', type: 'page', title: '主窗口', url: 'app://main' },
        { id: 'wv1', type: 'webview', title: '设置面板', url: 'vscode-webview://x' },
      ];
    }),
    selectTarget: vi.fn((id: string) => { calls.push(`selectTarget:${id}`); }),
    click: vi.fn(async (_l: Locator) => { calls.push('click'); }),
    fill: vi.fn(async (_l: Locator, _v: string) => { calls.push('fill'); }),
    select: vi.fn(async (_l: Locator, _o: string) => { calls.push('select'); }),
    hover: vi.fn(async (_l: Locator) => { calls.push('hover'); }),
    wait: vi.fn(async (_o: any) => { calls.push('wait'); }),
    eval: vi.fn(async (_c: string) => { calls.push('eval'); return undefined; }),
    snapshot: vi.fn(async (): Promise<any[]> => { calls.push('snapshot'); return []; }),
    query: vi.fn(async () => { calls.push('query'); return undefined; }),
    screenshot: vi.fn(async (): Promise<Buffer> => {
      calls.push('screenshot');
      return Buffer.from('fake-png');
    }),
    locateVisual: vi.fn(async (_l: Locator) => {
      calls.push('locateVisual');
      return { x: 10, y: 20, width: 100, height: 40, visible: true, inViewport: true };
    }),
    startRecording: vi.fn(() => { calls.push('startRecording'); }),
    stopRecording: vi.fn(async () => {
      calls.push('stopRecording');
      return recordedEvents;
    }),
    playback: vi.fn(async () => {
      calls.push('playback');
      return { ok: true };
    }),
  } as unknown as AnyKernel;
  return kernel;
}

// 简单计数器生成唯一 id
let idc = 0;
const nid = (p: string) => `${p}-${++idc}`;

function makeStep(type: Step['type'], over: Partial<Step> = {}): Step {
  return {
    id: nid(type),
    type,
    source: 'manual',
    ...over,
  };
}

function emptyScript(): Script {
  return {
    schema: SCRIPT_SCHEMA,
    app: { name: 'TestApp', version: '1.0.0' },
    steps: [],
  };
}

// ---- 测试分组 ----

describe('UiShell 构造与状态', () => {
  it('构造后处于未连接、空脚本状态', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    expect(shell.isConnected()).toBe(false);
    expect(shell.getScript().steps).toEqual([]);
    expect(shell.isRecording()).toBe(false);
  });

  it('构造时接受初始脚本', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    s.steps = [makeStep('click')];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    expect(shell.getScript().steps.length).toBe(1);
  });
});

describe('连接流程', () => {
  it('connect 调用内核 connect 并标记已连接', async () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    await shell.connect({ port: 9222 });
    expect(k.connect).toHaveBeenCalledTimes(1);
    expect(k.calls).toContain('connect');
    expect(shell.isConnected()).toBe(true);
  });

  it('disconnect 调用内核 disconnect 并标记未连接', async () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    await shell.connect({});
    await shell.disconnect();
    expect(k.disconnect).toHaveBeenCalledTimes(1);
    expect(shell.isConnected()).toBe(false);
  });
});

describe('录制流程', () => {
  it('startRecording 调用内核 startRecording 并标记录制中', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    shell.startRecording();
    expect(k.startRecording).toHaveBeenCalledTimes(1);
    expect(shell.isRecording()).toBe(true);
  });

  it('stopRecording 收集事件并转为步骤插入脚本', async () => {
    const evs = [
      { type: 'click', locator: { role: 'button', name: '登录' } },
      { type: 'fill', locator: { testId: 'usr' }, params: { value: 'tom' } },
    ];
    const k = makeMockKernel(evs);
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    shell.startRecording();
    await shell.stopRecording();
    expect(k.stopRecording).toHaveBeenCalledTimes(1);
    expect(shell.isRecording()).toBe(false);
    const steps = shell.getScript().steps;
    expect(steps.length).toBe(2);
    expect(steps[0].type).toBe('click');
    expect(steps[1].type).toBe('fill');
    expect(steps[1].params?.value).toBe('tom');
  });

  it('stopRecording 未开始时不应插入步骤', async () => {
    const k = makeMockKernel([{ type: 'click' }]);
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    await shell.stopRecording();
    expect(k.stopRecording).toHaveBeenCalledTimes(1);
    // 内核返回事件，但 UI 壳未处于录制态应忽略（避免脏数据）
    expect(shell.getScript().steps.length).toBe(0);
  });
});

describe('步骤列表渲染', () => {
  it('渲染时侧边列表包含每条 step 的友好描述', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    s.steps = [
      makeStep('click', { locator: { role: 'button', name: '提交' } }),
      makeStep('fill', { locator: { testId: 'name' }, params: { value: '张三' } }),
    ];
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: s });
    shell.render();
    const items = mount.querySelectorAll('[data-step-item]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('点击');
    expect(items[1].textContent).toContain('填写');
    expect(items[1].textContent).toContain('张三');
  });
});

describe('编辑操作', () => {
  it('insertStep 在脚本末尾新增步骤', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    const before = shell.getScript().steps.length;
    shell.insertStep(makeStep('click', { locator: { role: 'link', name: '首页' } }));
    expect(shell.getScript().steps.length).toBe(before + 1);
  });

  it('removeStep 按 id 删除', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    const st = makeStep('click');
    s.steps = [st];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    shell.removeStep(st.id);
    expect(shell.getScript().steps.find((x) => x.id === st.id)).toBeUndefined();
  });

  it('updateStep 合并补丁', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    const st = makeStep('fill', { params: { value: 'a' } });
    s.steps = [st];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    shell.updateStep(st.id, { params: { value: 'b' } });
    expect(shell.getScript().steps[0].params?.value).toBe('b');
  });

  it('moveStep 重排位置', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    const a = makeStep('click');
    const b = makeStep('fill');
    s.steps = [a, b];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    shell.moveStep(a.id, 1);
    expect(shell.getScript().steps[1].id).toBe(a.id);
  });

  it('编辑返回新脚本，原脚本不被就地修改（不可变语义）', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    const st = makeStep('click');
    s.steps = [st];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    shell.removeStep(st.id);
    expect(s.steps.length).toBe(1); // 原对象不变
  });
});

describe('回放流程', () => {
  it('playback 委托内核 playback 并返回成功', async () => {
    const k = makeMockKernel();
    const s = emptyScript();
    s.steps = [
      makeStep('click', { locator: { role: 'button', name: 'go' } }),
      makeStep('fill', { locator: { testId: 'q' }, params: { value: 'x' } }),
    ];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    const res = await shell.playback();
    // UI 壳不依赖执行器细节，只把脚本交给内核 playback 编排
    expect(k.playback).toHaveBeenCalledTimes(1);
    expect(k.playback).toHaveBeenCalledWith(s);
    expect(res.ok).toBe(true);
  });

  it('playback 失败时透传 failedStepId', async () => {
    const k = makeMockKernel();
    k.playback = vi.fn(async () => ({ ok: false, failedStepId: 'want-id' })) as any;
    const s = emptyScript();
    const st = makeStep('click');
    s.steps = [st];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    const res = await shell.playback();
    expect(res.ok).toBe(false);
    expect(res.failedStepId).toBe('want-id');
  });
});

describe('高亮', () => {
  it('highlight(locator) 调用内核 locateVisual 并返回视觉矩形', async () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    const loc = { role: 'button', name: '高亮我' };
    const rect = await shell.highlight(loc);
    expect(k.locateVisual).toHaveBeenCalledTimes(1);
    expect(rect).toMatchObject({ x: 10, y: 20, width: 100, height: 40, visible: true });
  });
});

describe('截图流', () => {
  it('captureFrame 调用内核 screenshot 返回 buffer', async () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    const buf = await shell.captureFrame();
    expect(k.screenshot).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });
});

describe('导入 / 导出', () => {
  it('export 输出可 round-trip 的 JSON', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    s.steps = [makeStep('click', { locator: { role: 'button', name: 'a' } })];
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div'), script: s });
    const json = shell.exportScript();
    const back = JSON.parse(json);
    expect(back.schema).toBe(SCRIPT_SCHEMA);
    expect(back.steps.length).toBe(1);
  });

  it('import 替换当前脚本并校验 schema', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    const s = emptyScript();
    s.steps = [makeStep('hover', { locator: { css: '.x' } })];
    const json = JSON.stringify(s);
    shell.importScript(json);
    expect(shell.getScript().steps.length).toBe(1);
    expect(shell.getScript().steps[0].type).toBe('hover');
  });

  it('import 非法 schema 抛错', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    expect(() => shell.importScript(JSON.stringify({ schema: 'wrong', steps: [] }))).toThrow();
  });
});

// ---- 新增 UI 组件（M3 补全）：目标选择 / 步骤编辑按钮 / 断言封装 / 截图流 ----

describe('目标选择', () => {
  it('listTargets 代理内核并返回目标列表', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    const ts = shell.listTargets();
    expect(k.listTargets).toHaveBeenCalledTimes(1);
    expect(ts.length).toBe(2);
  });

  it('selectTarget 委托内核并记录当前目标', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    shell.selectTarget('wv1');
    expect(k.selectTarget).toHaveBeenCalledWith('wv1');
    expect(shell.getCurrentTarget()).toBe('wv1');
  });
});

describe('步骤编辑组件（UI 渲染）', () => {
  it('render 时每条步骤含 删除/上移/下移 按钮', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    s.steps = [makeStep('click'), makeStep('fill')];
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: s });
    shell.render();
    const items = mount.querySelectorAll('[data-step-item]');
    expect(items.length).toBe(2);
    // 每条至少 3 个操作按钮
    const btns = items[0].querySelectorAll('button[data-action]');
    const acts = Array.from(btns).map((b) => b.getAttribute('data-action'));
    expect(acts).toContain('remove');
    expect(acts).toContain('up');
    expect(acts).toContain('down');
  });

  it('顶部含 插入 与 加断言 入口', () => {
    const k = makeMockKernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount });
    shell.render();
    const actions = Array.from(mount.querySelectorAll('[data-action]')).map((b) => b.getAttribute('data-action'));
    expect(actions).toContain('insert');
    expect(actions).toContain('add-assert');
  });

  it('点击删除按钮移除对应步骤（委托 removeStep）', () => {
    const k = makeMockKernel();
    const s = emptyScript();
    const st = makeStep('click');
    s.steps = [st, makeStep('fill')];
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: s });
    shell.render();
    // 模拟点击第一条的删除
    const del = mount.querySelector('[data-step-item] button[data-action="remove"]') as HTMLButtonElement;
    del.click();
    expect(shell.getScript().steps.find((x) => x.id === st.id)).toBeUndefined();
    expect(shell.getScript().steps.length).toBe(1);
  });
});

describe('断言友好封装', () => {
  it('insertAssertion 生成 assert 步骤，含 kind/locator/waitMs', () => {
    const k = makeMockKernel();
    const shell = new UiShell({ kernel: k as any, mount: document.createElement('div') });
    shell.insertAssertion('textContains', { role: 'status' }, '登录成功', 3000);
    const steps = shell.getScript().steps;
    expect(steps.length).toBe(1);
    const a = steps[0];
    expect(a.type).toBe('assert');
    expect(a.params?.assertion?.kind).toBe('textContains');
    expect(a.params?.assertion?.value).toBe('登录成功');
    expect(a.params?.assertion?.waitMs).toBe(3000);
    expect(a.params?.assertion?.locator).toMatchObject({ role: 'status' });
  });

  it('断言 kind 映射到用户友好标签', () => {
    expect(assertionKindLabel('exists')).toBe('出现新元素');
    expect(assertionKindLabel('textContains')).toBe('值包含内容');
    expect(assertionKindLabel('titleIs')).toBe('值等于特定值');
  });
});

describe('截图流', () => {
  it('startFrameStream 启动定时器并周期性调用 captureFrame（内核 screenshot）渲染到舞台区', async () => {
    vi.useFakeTimers();
    const k = makeMockKernel();
    let calls = 0;
    (k.screenshot as any) = vi.fn(async () => { calls++; return Buffer.from('png'); });
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount });
    shell.startFrameStream(100);
    // 推进两个周期（含首帧 1 + 周期 2 = ≥3 次，至少 2 次）
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBeGreaterThanOrEqual(2);
    shell.stopFrameStream();
    vi.useRealTimers();
  });
});
