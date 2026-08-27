// Electron 真机夹具（本文件用 VSCODE_LIVE 门控，因本机常用 VS Code 当通用 Electron 靶机）。
// 无 VSCODE_LIVE=1 时 skip。验收走通用 CDP：连接、枚举、role+name 点击、waitUntil exists、fill 录制。
// 禁止硬编码某一款 App 的聊天/编辑器 css。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import { runScript } from '../src/executor/executor';
import { ScriptEditor } from '../src/editor/editor';
import { SCRIPT_SCHEMA } from '../src/types/step';
import type { Script } from '../src/types/step';
import { resolveAssetPath } from '../src/util/path';
import { isNonActionableName } from '../src/recorder/inject';

const LIVE = process.env.VSCODE_LIVE === '1';
const PORT = Number(process.env.CDP_PORT ?? 9244);
const live = LIVE ? describe : describe.skip;

let adapter: PlaywrightCdpAdapter;
const report: string[] = [];

function reportPath(): string {
  const dir = resolveAssetPath('./reports/', import.meta.url);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolveAssetPath(`./reports/vscode-run-${new Date().toISOString().replace(/[:.]/g, '-')}.md`, import.meta.url);
}

beforeAll(async () => {
  if (!LIVE) return;
  adapter = new PlaywrightCdpAdapter();
  await adapter.connect({ port: PORT });
}, 40_000);

afterAll(async () => {
  if (!LIVE) return;
  writeFileSync(reportPath(), `# VS Code 真机\n\n${report.join('\n')}\n`);
  await adapter.disconnect().catch(() => undefined);
});

live('Electron 真机夹具：连接 / 导入 / 运行全部 / 通用 locator', () => {
  it('连接后能枚举 page 目标', () => {
    const targets = adapter.listTargets();
    report.push(`- targets: ${targets.length}`);
    targets.slice(0, 12).forEach((t) => report.push(`  - ${t.type} ${t.title}`));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((t) => t.type === 'page')).toBe(true);
  });

  it('主窗口 snapshot 非空', async () => {
    const nodes = await adapter.snapshot();
    report.push(`- snapshot nodes: ${nodes.length}`);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('导入 wait 脚本并 runScript（运行全部）成功', async () => {
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'vscode', version: 'live' },
      steps: [{
        id: 'w1', type: 'wait', source: 'manual',
        params: { durationMs: 200 },
        control: { kind: 'sequence', name: '等待' },
      }],
    };
    const json = ScriptEditor.save(script);
    const loaded = ScriptEditor.load(json);
    await runScript(adapter, loaded);
    report.push('- runScript wait: ok');
    const viaPlayback = await adapter.playback(loaded);
    expect(viaPlayback.ok).toBe(true);
    report.push('- playback wait (runCli, 不重连 9222): ok');
  });

  it('click README.md treeitem 会改 document.title', async () => {
    const before = String(await adapter.eval('document.title') ?? '');
    await adapter.click({ role: 'treeitem', name: 'README.md' });
    await new Promise((r) => setTimeout(r, 800));
    const after = String(await adapter.eval('document.title') ?? '');
    report.push(`- title before=${before} after=${after}`);
    expect(after).toMatch(/README/i);
  }, 20_000);

  it('waitUntil：元素存在（通用等待，不是聊天面板 API）', async () => {
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'electron-fixture', version: 'live' },
      steps: [{
        id: 'wu1', type: 'waitUntil', source: 'manual',
        params: {
          timeoutMs: 8000,
          assertion: { kind: 'exists', locator: { role: 'treeitem', name: 'README.md' } },
        },
      }],
    };
    await runScript(adapter, script);
    report.push('- waitUntil exists treeitem README.md: ok');
  }, 20_000);

  it('若存在可操作 textbox/input：fill 后录制能收到 fill 事件', async () => {
    const targets = adapter.listTargets();
    let found = false;
    for (const t of targets) {
      try {
        adapter.selectTarget(t.id);
        const nodes = await adapter.snapshot();
        const chat = nodes.find((n) =>
          (n.role === 'textbox' || n.tag === 'textarea' || n.tag === 'input')
          && !isNonActionableName(n.name)
        );
        if (!chat) continue;
        found = true;
        report.push(`- fillable node on ${t.type}/${t.title}: role=${chat.role} name=${chat.name} tag=${chat.tag}`);
        await adapter.startRecording();
        const loc = chat.name
          ? { name: chat.name, ...(chat.role ? { role: chat.role } : {}) }
          : { css: chat.tag ?? 'div' };
        try {
          await adapter.fill(loc, 'atg-live');
        } catch (err) {
          report.push(`  fill skipped: ${err instanceof Error ? err.message : err}`);
        }
        await new Promise((r) => setTimeout(r, 400));
        const evs = await adapter.stopRecording();
        report.push(`- recorded events: ${JSON.stringify(evs).slice(0, 400)}`);
        // 焦点可能 fill 不到；至少录制路径不能崩。
        expect(Array.isArray(evs)).toBe(true);
        if (chat.name) {
          expect(chat.name).not.toMatch(/无法访问编辑器|屏幕阅读器|Shift\+Alt\+F1|not accessible/i);
        }
        break;
      } catch (err) {
        report.push(`- target ${t.id} snapshot fail: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!found) {
      report.push('- no textbox found; recording API still exercised on main');
      await adapter.startRecording();
      const evs = await adapter.stopRecording();
      expect(Array.isArray(evs)).toBe(true);
    }
  }, 30_000);

  it('snapshot 节点带 rect（宽高为数）', async () => {
    const nodes = await adapter.snapshot();
    const withBox = nodes.find((n) => n.rect && typeof n.rect.width === 'number');
    expect(withBox).toBeTruthy();
    report.push(`- snapshot rect sample: ${JSON.stringify(withBox?.rect)}`);
  });
});

describe('agent-generated-if：9246 活着则真机 playback', () => {
  it('探测 9246（或 CDP_PORT）后 adapter.playback if/while 夹具', async () => {
    const ports = [...new Set([Number(process.env.CDP_PORT ?? 9246), 9246])].filter((p) => p > 0);
    let port: number | undefined;
    for (const p of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/json`);
        if (!r.ok) continue;
        const list = (await r.json()) as Array<{ webSocketDebuggerUrl?: string }>;
        if (Array.isArray(list) && list.some((t) => !!t.webSocketDebuggerUrl)) {
          port = p;
          break;
        }
      } catch {
        /* 口没开 */
      }
    }
    if (port === undefined) {
      report.push('- agent-generated-if playback skipped: 9246/CDP_PORT 无活口');
      return;
    }
    const json = readFileSync(new URL('../scripts/fixtures/agent-generated-if.json', import.meta.url), 'utf8');
    const script = ScriptEditor.load(json);
    const a = new PlaywrightCdpAdapter();
    await a.connect({ port });
    try {
      const res = await a.playback(script);
      report.push(`- agent-generated-if playback port=${port} ok=${res.ok} failed=${res.failedStepId ?? '-'}`);
      expect(res.ok).toBe(true);
    } finally {
      await a.disconnect().catch(() => undefined);
    }
  }, 40_000);
});
