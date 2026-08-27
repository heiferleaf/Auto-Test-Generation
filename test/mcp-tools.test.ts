// MCP Tool 名契约：与 design.md §6 / architecture §3-C 对齐。
// 先于 src/mcp 实现存在；禁止为让实现通过而删断言。

import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, TOOL_NAMES } from '../src/mcp/tool-catalog';

/** design.md §6 执行器↔Tool 表（不含 P1 Agent 工具、不含未封装的 update_step）。 */
const DESIGN_ATOMS = [
  'app.connect',
  'app.list_targets',
  'page.snapshot',
  'actions.execute_steps',
  'script.import',
  'script.export',
  'script.open',
  'assert.run',
] as const;

const ARCH_SESSION = [
  'app.disconnect',
  'record.start',
  'record.stop',
  'record.get_steps',
  'launch-target',
  'workbench.start',
  'workbench.stop',
  'target.stop',
] as const;

const PROBE_ATOMS = [
  'page.click',
  'page.fill',
  'page.wait',
  'page.waitUntil',
  'page.screenshot',
] as const;

describe('MCP Tool 清单', () => {
  it('注册表无重复名', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect(TOOL_DEFS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it('含 design.md §6 原子名', () => {
    for (const name of DESIGN_ATOMS) {
      expect(TOOL_NAMES, `缺少 ${name}`).toContain(name);
    }
  });

  it('含会话/录制/探针 Tool', () => {
    for (const name of [...ARCH_SESSION, ...PROBE_ATOMS]) {
      expect(TOOL_NAMES, `缺少 ${name}`).toContain(name);
    }
  });

  it('不注册本期明确不做的 Tool', () => {
    expect(TOOL_NAMES).not.toContain('agent.suggest_steps');
    expect(TOOL_NAMES).not.toContain('agent.repair_steps');
  });

  it('每个 Tool 都有 JSON Schema 对象（跨 JSON 边界可校验）', () => {
    for (const t of TOOL_DEFS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(8);
    }
  });
});
