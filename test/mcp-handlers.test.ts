// MCP handler 契约：null 入参、script.open→loadScript、launch-target 端口、waitUntil textContains。
// 内核用 mock，不拉真机、不启 stdio MCP 进程。

import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, type McpDeps } from '../src/mcp/dispatch';
import { parseCdpPortFromLaunchOutput, parseWorkbenchUrl } from '../src/mcp/parse-output';
import { loadTargetCatalog, resolveTargetSpec } from '../src/mcp/launch-target';
import type { CdpAdapter, TargetInfo } from '../src/cdp/adapter';
import type { Locator, Script, Step } from '../src/types/step';
import { SCRIPT_SCHEMA } from '../src/types/step';
import type { InteractionEvent } from '../src/recorder/recorder';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sampleScript(steps: Step[] = []): Script {
  return {
    schema: SCRIPT_SCHEMA,
    app: { name: 'mcp-test' },
    steps,
  };
}

type StubAdapter = CdpAdapter & {
  calls: string[];
  refreshTargets: () => Promise<TargetInfo[]>;
  screenshot: (opts?: unknown) => Promise<Buffer>;
  startRecording: () => void;
  stopRecording: () => Promise<InteractionEvent[]>;
  pageText: (selector?: string) => Promise<string | null>;
};

function callsOf(deps: McpDeps): string[] {
  return (deps.adapter as unknown as { calls: string[] }).calls;
}

function stubAdapter(over: Partial<StubAdapter> = {}): StubAdapter {
  const calls: string[] = [];
  const targets: TargetInfo[] = [
    { id: 'page-main', type: 'page', title: 'outer', isMain: true },
    { id: 'wv-chat', type: 'webview', title: 'nested-chat' },
  ];
  return {
    calls,
    async connect(opts) { calls.push(`connect:${opts?.port ?? 'none'}`); },
    async disconnect() { calls.push('disconnect'); },
    listTargets: () => targets,
    selectTarget(id: string) { calls.push(`select:${id}`); },
    async click(_l: Locator) { calls.push('click'); },
    async fill(_l: Locator, v: string) { calls.push(`fill:${v}`); },
    async select() { calls.push('select'); },
    async hover() { calls.push('hover'); },
    async wait() { calls.push('wait'); },
    async eval() { return null; },
    async snapshot() {
      calls.push('snapshot');
      return [{ role: 'button', name: 'Send', text: 'Send' }];
    },
    async query() { return { hit: true }; },
    async pageText() { calls.push('pageText'); return null; },
    async refreshTargets() { calls.push('refresh'); return targets; },
    async screenshot() { return Buffer.from('png'); },
    startRecording() { calls.push('rec-start'); },
    async stopRecording() { return [{ type: 'click', locator: { name: 'Send' } }]; },
    ...over,
  };
}

function makeDeps(over: Partial<McpDeps> = {}): McpDeps & { loadScript: ReturnType<typeof vi.fn> } {
  const adapter: StubAdapter = stubAdapter();
  const loadScript = vi.fn((raw: unknown) => {
    const v = raw ?? {};
    return typeof v === 'string' ? JSON.parse(v) : v;
  });
  const base: McpDeps & { loadScript: ReturnType<typeof vi.fn> } = {
    adapter,
    loadScript,
    launchTarget: async (opts) => {
      const spec = resolveTargetSpec(opts.name, loadTargetCatalog(ROOT));
      const port = opts.port ?? spec.port;
      return { name: spec.name, port, jsonUrl: `http://localhost:${port}/json` };
    },
    stopTarget: async (opts) => ({ stopped: true, port: opts?.port }),
    startWorkbench: async () => ({ url: 'http://localhost:5173/' }),
    stopWorkbench: async () => ({ stopped: true }),
  };
  return { ...base, ...over } as McpDeps & { loadScript: ReturnType<typeof vi.fn> };
}

describe('JSON 边界：null 入参', () => {
  it('app.list_targets 对 null args 当空对象，刷新后返回 page+webview', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('app.list_targets', null, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = r.data as TargetInfo[];
    expect(targets.some((t) => t.type === 'page')).toBe(true);
    expect(targets.some((t) => t.type === 'webview')).toBe(true);
    expect(callsOf(deps)).toContain('refresh');
  });

  it('page.snapshot 对 null args 不崩，不切换 target', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('page.snapshot', null, deps);
    expect(r.ok).toBe(true);
    const selects = callsOf(deps).filter((c) => c.startsWith('select:'));
    expect(selects).toEqual([]);
    expect(callsOf(deps)).toContain('snapshot');
  });

  it('page.snapshot 的 targetId=null 视为缺省（当前页）', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('page.snapshot', { targetId: null }, deps);
    expect(r.ok).toBe(true);
    const selects = callsOf(deps).filter((c) => c.startsWith('select:'));
    expect(selects).toEqual([]);
  });

  it('actions.execute_steps 对 null / script:null 拒绝而非空跑', async () => {
    const deps = makeDeps();
    const a = await dispatchTool('actions.execute_steps', null, deps);
    expect(a.ok).toBe(false);
    const b = await dispatchTool('actions.execute_steps', { script: null }, deps);
    expect(b.ok).toBe(false);
  });

  it('script.open 对 null / script:null 拒绝，且不调用 loadScript', async () => {
    const deps = makeDeps();
    const a = await dispatchTool('script.open', null, deps);
    expect(a.ok).toBe(false);
    const b = await dispatchTool('script.open', { script: null }, deps);
    expect(b.ok).toBe(false);
    expect(deps.loadScript).not.toHaveBeenCalled();
  });
});

describe('嵌套页面：list_targets + snapshot(target) + click(target)', () => {
  it('page.snapshot({targetId}) 先切到该 webview 再快照', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('page.snapshot', { targetId: 'wv-chat' }, deps);
    expect(r.ok).toBe(true);
    expect(callsOf(deps)).toContain('select:wv-chat');
    expect(callsOf(deps)).toContain('snapshot');
  });

  it('page.click 把 target 写进一步脚本，由执行器 selectTarget', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('page.click', {
      locator: { role: 'button', name: 'Send' },
      targetId: 'wv-chat',
    }, deps);
    expect(r.ok).toBe(true);
    expect(callsOf(deps)).toContain('select:wv-chat');
    expect(callsOf(deps)).toContain('click');
  });
});

describe('script.open 走工作台 loadScript', () => {
  it('调用桥 loadScript，而不是只做文件 import', async () => {
    const script = sampleScript([{
      id: 's1', type: 'click', source: 'agent', locator: { name: 'Go' },
    }]);
    const deps = makeDeps();
    const r = await dispatchTool('script.open', { script }, deps);
    expect(r.ok).toBe(true);
    expect(deps.loadScript).toHaveBeenCalledTimes(1);
    const passed = deps.loadScript.mock.calls[0][0];
    expect(passed).toMatchObject({ steps: [{ id: 's1' }] });
  });
});

describe('launch-target 端口', () => {
  it('从输出解析实际端口，而不是写死 9222', () => {
    expect(parseCdpPortFromLaunchOutput('[ok] CDP is live: http://localhost:9246/json')).toBe(9246);
    expect(parseCdpPortFromLaunchOutput('Open http://localhost:9233/json to verify')).toBe(9233);
    expect(parseCdpPortFromLaunchOutput('no port here')).toBeUndefined();
  });

  it('vscode 目录项默认不是 9222', () => {
    const vscode = resolveTargetSpec('vscode', loadTargetCatalog(ROOT));
    expect(vscode.port).not.toBe(9222);
    expect(vscode.port).toBe(9244);
  });

  it('handler 返回 launcher 给出的端口（可覆盖，绝不唯一 9222）', async () => {
    const deps = makeDeps({
      launchTarget: async () => ({
        name: 'vscode',
        port: 9244,
        jsonUrl: 'http://localhost:9244/json',
      }),
    });
    const r = await dispatchTool('launch-target', { name: 'vscode' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { port: number };
    expect(data.port).toBe(9244);
    expect(data.port).not.toBe(9222);
  });

  it('显式 port 覆盖目录默认值', async () => {
    const seen: number[] = [];
    const deps = makeDeps({
      launchTarget: async (opts) => {
        seen.push(opts.port ?? -1);
        return { name: 'vscode', port: opts.port ?? 0, jsonUrl: `http://localhost:${opts.port}/json` };
      },
    });
    const r = await dispatchTool('launch-target', { name: 'vscode', port: 9250 }, deps);
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe(9250);
  });
});

describe('waitUntil textContains', () => {
  it('page.waitUntil 能表达 textContains（一步脚本）', async () => {
    const deps = makeDeps();
    const adapter = deps.adapter as CdpAdapter & { snapshot: () => Promise<{ text: string }[]> };
    adapter.snapshot = async () => [{ text: 'hello from nested page' }];
    const r = await dispatchTool('page.waitUntil', {
      kind: 'textContains',
      value: 'hello',
      targetId: 'wv-chat',
      timeoutMs: 1000,
    }, deps);
    expect(r.ok).toBe(true);
  });

  it('actions.execute_steps 接受带 waitUntil textContains 的脚本', async () => {
    const deps = makeDeps();
    (deps.adapter as CdpAdapter).snapshot = async () => [{ text: 'ready' }];
    const script = sampleScript([{
      id: 'w1',
      type: 'waitUntil',
      source: 'agent',
      target: 'wv-chat',
      params: {
        timeoutMs: 500,
        assertion: { kind: 'textContains', value: 'ready' },
      },
    }]);
    const r = await dispatchTool('actions.execute_steps', { script }, deps);
    expect(r.ok).toBe(true);
  });
});

describe('工作台 URL 解析', () => {
  it('从 serve 打印行取出实际 URL，不假设只有 5173', () => {
    const line = '可视化蒙版面板已启动: http://localhost:5174  (Ctrl+C 退出)';
    expect(parseWorkbenchUrl(line)).toBe('http://localhost:5174');
  });
});

describe('kill 端口解析', () => {
  it('精确匹配 :port，不会把 19222 当成 9222', async () => {
    const { pidsListeningOnPort } = await import('../src/mcp/session');
    const out = [
      'TCP    127.0.0.1:19222    0.0.0.0:0    LISTENING    111',
      'TCP    127.0.0.1:9222     0.0.0.0:0    LISTENING    222',
    ].join('\n');
    expect(pidsListeningOnPort(out, 9222)).toEqual([222]);
    expect(pidsListeningOnPort(out, 19222)).toEqual([111]);
  });
});

describe('其它原子薄封装', () => {
  it('assert.run 走内核断言', async () => {
    const deps = makeDeps();
    const r = await dispatchTool('assert.run', {
      kind: 'textContains',
      value: 'Send',
    }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { passed: boolean }).passed).toBe(true);
  });

  it('未知 tool 名拒绝', async () => {
    const r = await dispatchTool('agent.suggest_steps', {}, makeDeps());
    expect(r.ok).toBe(false);
  });
});
