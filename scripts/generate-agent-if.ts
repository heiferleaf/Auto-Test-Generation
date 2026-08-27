// 生成 scripts/fixtures/agent-generated-if.json。
// 条件固定为：资源管理器 treeitem「settings.json」是否存在（不是菜单「文件」、也不是窗口标题）。
// True：点击该 treeitem（VS Code 会打开文件）；False：等待 200ms。
// 口没开时仍写出带 1×1 png 的稿；口开着则补真截图并 playback。
// 用法：npx tsx scripts/generate-agent-if.ts
// 端口：CDP_PORT 或 9246。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import { SCRIPT_SCHEMA, type Script, type Step } from '../src/types/step';
import { shotToDataUrl } from '../src/script/io';
import type { Locator } from '../src/types/step';

const PORT = Number(process.env.CDP_PORT ?? 9246);
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent-generated-if.json');
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FILE_LOC: Locator = { role: 'treeitem', name: 'settings.json' };

async function portLive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`);
    if (!r.ok) return false;
    const list = (await r.json()) as Array<{ webSocketDebuggerUrl?: string }>;
    return Array.isArray(list) && list.some((t) => !!t.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function buildScript(): Script {
  return {
    schema: SCRIPT_SCHEMA,
    app: { name: 'Electron (agent if/while sample)', version: 'agent-analysis' },
    note: 'if：资源管理器是否有 treeitem settings.json。True=点击打开该文件；False=等 200ms。不是菜单「文件」，也不是窗口标题。',
    createdAt: new Date().toISOString(),
    steps: [
      {
        id: 'agent-if-wait', type: 'wait', source: 'agent',
        params: { durationMs: 200 },
        control: { kind: 'sequence', name: '等待界面稳定' },
      },
      {
        id: 'agent-if', type: 'assert', source: 'agent',
        control: {
          kind: 'if',
          name: '资源管理器是否有 settings.json',
          condition: { kind: 'exists', locator: FILE_LOC },
        },
        children: [
          {
            id: 'agent-if-true', type: 'click', source: 'agent',
            control: { kind: 'sequence', name: 'True' },
            children: [{
              id: 'agent-if-true-click', type: 'click', source: 'agent',
              locator: FILE_LOC,
              control: { kind: 'sequence', name: 'True：点击 settings.json' },
            }],
          },
          {
            id: 'agent-if-false', type: 'wait', source: 'agent',
            control: { kind: 'sequence', name: 'False' },
            children: [{
              id: 'agent-if-false-wait', type: 'wait', source: 'agent',
              params: { durationMs: 200 },
              control: { kind: 'sequence', name: 'False：等待 200ms' },
            }],
          },
        ],
      },
      {
        id: 'agent-while', type: 'wait', source: 'agent',
        control: { kind: 'while', name: '循环两次', loopCount: 2 },
        children: [{
          id: 'agent-while-wait', type: 'wait', source: 'agent',
          params: { durationMs: 80 },
          control: { kind: 'sequence', name: '循环体：等待 80ms' },
        }],
      },
    ],
  };
}

function leafIds(script: Script): string[] {
  const out: string[] = [];
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s.children?.length) walk(s.children);
      else out.push(s.id);
    }
  };
  walk(script.steps);
  return out;
}

function locOf(script: Script, id: string): Locator | undefined {
  const walk = (steps: Step[]): Step | undefined => {
    for (const s of steps) {
      if (s.id === id) return s;
      if (s.children) {
        const hit = walk(s.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(script.steps)?.locator;
}

function withTinyShots(script: Script): Script {
  const shots: Record<string, string> = {};
  for (const id of leafIds(script)) shots[id] = TINY;
  return { ...script, shots };
}

async function main(): Promise<void> {
  const script = buildScript();
  if (!(await portLive(PORT))) {
    writeFileSync(OUT, JSON.stringify(withTinyShots(script), null, 2), 'utf8');
    console.log(`[generate-agent-if] ${PORT} 没有活 CDP，已写无真图夹具`);
    return;
  }
  const adapter = new PlaywrightCdpAdapter();
  await adapter.connect({ port: PORT });
  try {
    const shots: Record<string, string> = {};
    for (const id of leafIds(script)) {
      try {
        const loc = locOf(script, id) ?? FILE_LOC;
        const buf = await adapter.screenshot({ highlight: loc });
        shots[id] = shotToDataUrl(buf.toString('base64'));
      } catch {
        shots[id] = TINY;
      }
    }
    writeFileSync(OUT, JSON.stringify({ ...script, shots }, null, 2), 'utf8');
    const play = await adapter.playback(script);
    console.log(`[generate-agent-if] wrote ${OUT} shots=${Object.keys(shots).length} playback.ok=${play.ok}`);
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

void main();
