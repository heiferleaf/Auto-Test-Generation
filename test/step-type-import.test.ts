// 「假绿灯」缺陷回归：Agent 从 Playwright 训练数据里写出 press/dblclick 这类步骤类型时，
// 必须在**导入期**就失败 —— 一次报全、带位置、带合法值全量、带 Playwright→本平台的映射提示。
// 先于实现存在：实现落地前本文件应全红，禁止为让实现通过而删断言。

import { describe, it, expect } from 'vitest';
import { importScript } from '../src/script/io';
import { assertRunnableScript } from '../src/ui/bridge-server';
import { dispatchTool, type McpDeps } from '../src/mcp/dispatch';
import { TOOL_DEFS } from '../src/mcp/tool-catalog';
import { STEP_TYPES, SCRIPT_SCHEMA } from '../src/types/step';

/** 合法值清单一律从唯一真相源生成，本文件不写字面量，否则将来加类型会静默漂移。 */
const LEGAL_LIST = STEP_TYPES.join('/');

/** 造一步；type 故意放宽成 string，因为非法值正是本文件要喂进去的被测数据。 */
function step(type: string, id = `s-${type}`, children?: unknown[]): Record<string, unknown> {
  return {
    id,
    type,
    source: 'agent',
    ...(children ? { children } : {}),
  };
}

function scriptJson(steps: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: SCRIPT_SCHEMA, app: { name: 'probe' }, steps, ...extra });
}

/** 导入必然失败，返回错误消息；没失败就是假绿灯，直接判测试失败。 */
function importErr(steps: unknown[]): string {
  try {
    importScript(scriptJson(steps));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('预期 importScript 抛错，但它放行了');
}

function makeDeps(): McpDeps {
  const unreachable = async () => {
    throw new Error('本用例不该走到这里');
  };
  return {
    adapter: {} as unknown as McpDeps['adapter'],
    loadScript: unreachable,
    launchTarget: unreachable,
    stopTarget: unreachable,
    startWorkbench: unreachable,
    stopWorkbench: unreachable,
  };
}

describe('Script JSON 导入期步骤类型校验', () => {
  it('press 步骤：报出位置、实际值、合法值全量、以及 eval/fill 映射提示', () => {
    const msg = importErr([step('press')]);
    expect(msg).toContain('steps[0]');
    expect(msg).toContain('press');
    expect(msg).toContain(LEGAL_LIST);
    expect(msg).toContain('eval');
    expect(msg).toContain('fill');
  });

  it('多个非法步骤：一条消息里同时报出全部位置与实际值（不是遇到第一个就 throw）', () => {
    const msg = importErr([
      step('press', 'a'),
      step('dblclick', 'b'),
      step('tap', 'c'),
    ]);
    for (const bad of ['press', 'dblclick', 'tap']) {
      expect(msg, `漏报 ${bad}`).toContain(bad);
    }
    for (const p of ['steps[0]', 'steps[1]', 'steps[2]']) {
      expect(msg, `漏报位置 ${p}`).toContain(p);
    }
  });

  it('repeat 的子步骤非法：报出嵌套路径（children 是真实嵌套字段）', () => {
    const msg = importErr([step('repeat', 'outer', [step('press', 'inner')])]);
    expect(msg).toContain('steps[0].children[0]');
    expect(msg).toContain('press');
  });

  it('深层嵌套也能定位（children 的 children）', () => {
    const msg = importErr([
      step('repeat', 'outer', [step('repeat', 'mid', [step('type', 'leaf')])]),
    ]);
    expect(msg).toContain('steps[0].children[0].children[0]');
    expect(msg).toContain('type');
  });

  it('type 缺失也要报，且带位置', () => {
    const msg = importErr([{ id: 'x', source: 'agent' }]);
    expect(msg).toContain('steps[0]');
    expect(msg).toContain('缺失');
  });

  it('映射提示按不同 Playwright API 给不同建议（不是一句通用文案）', () => {
    expect(importErr([step('press')])).toContain('eval');
    expect(importErr([step('dblclick')])).toContain('click');
    expect(importErr([step('selectOption')])).toContain('select');
  });

  it('全部合法步骤类型：导入通过（清单由 STEP_TYPES 生成，不手写 10 条）', () => {
    const steps = STEP_TYPES.map((t, i) => step(t, `s-${i}`));
    const parsed = importScript(scriptJson(steps));
    expect(parsed.steps).toHaveLength(STEP_TYPES.length);
  });
});

describe('合法值清单不漂移（唯一真相源 = STEP_TYPES）', () => {
  it('导入期报错里的合法值清单等于 STEP_TYPES.join("/")', () => {
    const msg = importErr([step('press')]);
    const m = msg.match(/合法值:\s*([^\s。]+)/);
    expect(m, `没匹配到合法值清单: ${msg}`).not.toBeNull();
    expect(m![1]).toBe(LEGAL_LIST);
  });

  it('接受 Script JSON 的 MCP 工具描述里都写了这份清单，并声明是封闭集合', () => {
    const scriptTools = [
      'script.import',
      'script.export',
      'script.open',
      'actions.execute_steps',
    ];
    for (const name of scriptTools) {
      const def = TOOL_DEFS.find((t) => t.name === name);
      expect(def, `缺少 ${name}`).toBeDefined();
      expect(def!.description, `${name} 没写合法值清单`).toContain(LEGAL_LIST);
      expect(def!.description, `${name} 没声明封闭集合`).toContain('封闭集合');
      expect(def!.description, `${name} 没提醒不是 Playwright`).toContain('Playwright');
    }
  });
});

describe('导入期与执行期共用同一套措辞', () => {
  it('bridge 的执行期校验与导入期命中同一条映射提示（不是各复制一份）', () => {
    const importMsg = importErr([step('press')]);

    let bridgeMsg = '';
    try {
      assertRunnableScript({ steps: [step('press')] });
      throw new Error('预期 assertRunnableScript 抛错，但它放行了');
    } catch (e) {
      bridgeMsg = e instanceof Error ? e.message : String(e);
    }

    const sharedHint = '本平台没有 press 步骤';
    expect(bridgeMsg).toContain('steps[0]');
    expect(bridgeMsg).toContain(LEGAL_LIST);
    expect(bridgeMsg).toContain(sharedHint);
    expect(importMsg).toContain(sharedHint);
  });
});

describe('端到端：MCP 层不再是假绿灯', () => {
  it('script.import 收到含 press 的脚本返回 ok:false，且错误可直接给 Agent 看', async () => {
    const res = await dispatchTool('script.import', { json: scriptJson([step('press')]) }, makeDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('press');
      expect(res.error).toContain('steps[0]');
      expect(res.error).toContain(LEGAL_LIST);
      expect(res.error).toContain('eval');
    }
  });

  it('actions.execute_steps 收��含 press 的脚本在入口就被拦，不再等到执行期才炸', async () => {
    const res = await dispatchTool(
      'actions.execute_steps',
      { script: scriptJson([step('press')]) },
      makeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('press');
      expect(res.error).toContain(LEGAL_LIST);
    }
  });

  it('合法脚本经 script.import 仍然通过（没有把正常路径一起拦死）', async () => {
    const steps = STEP_TYPES.map((t, i) => step(t, `s-${i}`));
    const res = await dispatchTool('script.import', { json: scriptJson(steps) }, makeDeps());
    expect(res.ok).toBe(true);
  });
});
