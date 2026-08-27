// MCP Tool 分发：全部 1:1 调内核，不重写 CDP。
// 每个 case 入口 `args = args ?? {}`；targetId 的 null 当缺省。

import { readFileSync } from 'node:fs';
import type { CdpAdapter, ScreenshotOptions, TargetInfo } from '../cdp/adapter';
import type { Assertion, Locator, Script, Step, StepType } from '../types/step';
import { SCRIPT_SCHEMA } from '../types/step';
import { runCli } from '../cli';
import { runAssertion } from '../executor/assert';
import { importScript, exportScript } from '../script/io';
import { parseLoadScriptArg } from '../ui/bridge-server';
import { Recorder, type InteractionEvent } from '../recorder/recorder';
import { asArgs, asOptionalNumber, asOptionalString, omitted } from './json-args';
import { TOOL_NAMES } from './tool-catalog';

export type McpAdapter = CdpAdapter & {
  refreshTargets?: () => Promise<TargetInfo[]>;
  screenshot?: (opts?: ScreenshotOptions) => Promise<Buffer>;
  startRecording?: (onEvent?: (e: InteractionEvent) => void) => void;
  stopRecording?: () => Promise<InteractionEvent[]>;
};

export type LaunchTargetFn = (opts: { name?: string; port?: number }) => Promise<{
  name: string;
  port: number;
  jsonUrl: string;
  label?: string;
}>;

export type McpDeps = {
  adapter: McpAdapter;
  loadScript: (raw: unknown) => Promise<Script> | Script;
  launchTarget: LaunchTargetFn;
  stopTarget: (opts?: { port?: number }) => Promise<{ stopped: boolean; port?: number }>;
  startWorkbench: (opts?: { port?: number; cdpPort?: number }) => Promise<{ url: string; reused?: boolean }>;
  stopWorkbench: () => Promise<{ stopped: boolean; url?: string; reused?: boolean }>;
  /** 最近一次录制事件，供 record.get_steps；可选。 */
  recorded?: InteractionEvent[];
};

export type ToolOk = { ok: true; data: unknown };
export type ToolErr = { ok: false; error: string };
export type ToolResult = ToolOk | ToolErr;

function fail(error: string): ToolErr {
  return { ok: false, error };
}

function ok(data: unknown): ToolOk {
  return { ok: true, data };
}

function targetIdOf(args: Record<string, unknown>): string | undefined {
  return asOptionalString(args.targetId) ?? asOptionalString(args.target);
}

function locatorOf(raw: unknown): Locator | undefined {
  if (omitted(raw) || typeof raw !== 'object') return undefined;
  return raw as Locator;
}

function probeScript(step: Step): Script {
  return { schema: SCRIPT_SCHEMA, app: { name: 'mcp-probe' }, steps: [step] };
}

function withTarget(step: Step, targetId: string | undefined): Step {
  if (!targetId) return step;
  return { ...step, target: targetId };
}

async function runProbe(deps: McpDeps, step: Step): Promise<ToolResult> {
  const res = await runCli({ adapter: deps.adapter, script: probeScript(step) });
  if (!res.ok) return fail(`步骤失败${res.failedStepId ? `（${res.failedStepId}）` : ''}`);
  return ok({ ok: true, stepId: step.id });
}

function readScriptArg(args: Record<string, unknown>): Script {
  const wrapped = args.script;
  if (!omitted(wrapped)) {
    return typeof wrapped === 'string' ? importScript(wrapped) : parseLoadScriptArg(wrapped);
  }
  if (typeof args.schema === 'string' || Array.isArray(args.steps)) {
    return parseLoadScriptArg(args);
  }
  throw new Error('需要 script 对象或 JSON 字符串');
}

function asAssertion(args: Record<string, unknown>): Assertion {
  if (!omitted(args.assertion) && typeof args.assertion === 'object') {
    return args.assertion as Assertion;
  }
  const kind = asOptionalString(args.kind);
  if (!kind) throw new Error('需要 assertion 或 kind');
  const a: Assertion = { kind: kind as Assertion['kind'] };
  const loc = locatorOf(args.locator);
  if (loc) a.locator = loc;
  const value = asOptionalString(args.value);
  if (value !== undefined) a.value = value;
  const waitMs = asOptionalNumber(args.waitMs);
  if (waitMs !== undefined) a.waitMs = waitMs;
  return a;
}

let seq = 0;
function probeId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export async function dispatchTool(name: string, rawArgs: unknown, deps: McpDeps): Promise<ToolResult> {
  const args = asArgs(rawArgs);
  try {
    switch (name) {
      case 'launch-target': {
        const data = await deps.launchTarget({
          name: asOptionalString(args.name),
          port: asOptionalNumber(args.port),
        });
        return ok(data);
      }
      case 'target.stop': {
        return ok(await deps.stopTarget({ port: asOptionalNumber(args.port) }));
      }
      case 'workbench.start': {
        return ok(await deps.startWorkbench({
          port: asOptionalNumber(args.port),
          cdpPort: asOptionalNumber(args.cdpPort),
        }));
      }
      case 'workbench.stop': {
        return ok(await deps.stopWorkbench());
      }
      case 'app.connect': {
        await deps.adapter.connect({
          port: asOptionalNumber(args.port),
          appPath: asOptionalString(args.appPath),
        });
        const port = asOptionalNumber(args.port);
        return ok({ connected: true, ...(port !== undefined ? { port } : {}) });
      }
      case 'app.disconnect': {
        await deps.adapter.disconnect();
        return ok({ disconnected: true });
      }
      case 'app.list_targets': {
        if (typeof deps.adapter.refreshTargets === 'function') {
          const list = await deps.adapter.refreshTargets();
          return ok(list);
        }
        return ok(deps.adapter.listTargets());
      }
      case 'page.snapshot': {
        const tid = targetIdOf(args);
        if (typeof deps.adapter.refreshTargets === 'function') {
          await deps.adapter.refreshTargets();
        }
        if (tid) deps.adapter.selectTarget(tid);
        return ok(await deps.adapter.snapshot());
      }
      case 'page.click': {
        const locator = locatorOf(args.locator);
        if (!locator) return fail('page.click 需要 locator');
        const step: Step = withTarget({
          id: probeId('click'),
          type: 'click' as StepType,
          source: 'agent',
          locator,
        }, targetIdOf(args));
        return runProbe(deps, step);
      }
      case 'page.fill': {
        const locator = locatorOf(args.locator);
        if (!locator) return fail('page.fill 需要 locator');
        const step: Step = withTarget({
          id: probeId('fill'),
          type: 'fill',
          source: 'agent',
          locator,
          params: { value: omitted(args.value) ? '' : String(args.value) },
        }, targetIdOf(args));
        return runProbe(deps, step);
      }
      case 'page.wait': {
        const durationMs = asOptionalNumber(args.durationMs);
        const text = asOptionalString(args.text);
        if (durationMs === undefined && text === undefined) {
          return fail('page.wait 需要 durationMs 或 text');
        }
        const step: Step = withTarget({
          id: probeId('wait'),
          type: 'wait',
          source: 'agent',
          params: { durationMs, key: text },
        }, targetIdOf(args));
        return runProbe(deps, step);
      }
      case 'page.waitUntil': {
        const assertion = asAssertion(args);
        const step: Step = withTarget({
          id: probeId('waitUntil'),
          type: 'waitUntil',
          source: 'agent',
          params: {
            assertion,
            timeoutMs: asOptionalNumber(args.timeoutMs) ?? 10_000,
          },
        }, targetIdOf(args));
        return runProbe(deps, step);
      }
      case 'page.screenshot': {
        const shot = deps.adapter.screenshot;
        if (typeof shot !== 'function') return fail('当前适配器不支持截图');
        const opts: ScreenshotOptions = {};
        const tid = targetIdOf(args);
        if (tid) opts.target = tid;
        const hl = locatorOf(args.highlight);
        if (hl) opts.highlight = hl;
        if (args.fullPage === true) opts.fullPage = true;
        const savePath = asOptionalString(args.savePath);
        if (savePath) opts.savePath = savePath;
        const buf = await shot.call(deps.adapter, opts);
        return ok({
          pngBase64: buf.toString('base64'),
          byteLength: buf.length,
          ...(savePath ? { savePath } : {}),
        });
      }
      case 'actions.execute_steps': {
        const script = readScriptArg(args);
        const fromStepId = asOptionalString(args.fromStepId);
        const res = await runCli({ adapter: deps.adapter, script, fromStepId });
        return ok(res);
      }
      case 'script.import': {
        const json = asOptionalString(args.json);
        const path = asOptionalString(args.path);
        if (!json && !path) return fail('script.import 需要 json 或 path');
        const text = json ?? readFileSync(path!, 'utf8');
        return ok(importScript(text));
      }
      case 'script.export': {
        const script = readScriptArg(args);
        return ok({ json: exportScript(script) });
      }
      case 'script.open': {
        const hasWrapped = !omitted(args.script);
        const looksLikeScript = typeof args.schema === 'string' || Array.isArray(args.steps);
        if (!hasWrapped && !looksLikeScript) {
          return fail('script.open 需要 script 对象或 JSON 字符串');
        }
        const raw = hasWrapped ? args.script : args;
        const opened = await deps.loadScript(raw);
        return ok({ opened: true, steps: opened.steps?.length ?? 0 });
      }
      case 'assert.run': {
        const assertion = asAssertion(args);
        const result = await runAssertion(deps.adapter, assertion);
        return ok(result);
      }
      case 'record.start': {
        if (typeof deps.adapter.startRecording !== 'function') {
          return fail('当前适配器不支持录制');
        }
        deps.adapter.startRecording();
        return ok({ recording: true });
      }
      case 'record.stop': {
        if (typeof deps.adapter.stopRecording !== 'function') {
          return fail('当前适配器不支持录制');
        }
        const events = await deps.adapter.stopRecording();
        if (deps.recorded) {
          deps.recorded.length = 0;
          deps.recorded.push(...events);
        }
        return ok({ events });
      }
      case 'record.get_steps': {
        const rec = new Recorder();
        for (const ev of deps.recorded ?? []) rec.record(ev);
        return ok({ steps: rec.toSteps() });
      }
      default:
        if (!TOOL_NAMES.includes(name)) {
          return fail(`未知 MCP Tool: ${name}`);
        }
        return fail(`Tool ${name} 未实现`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
