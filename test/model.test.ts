// 测试先行：本文件先于 src/types/step.ts 与 src/script/io.ts 实现存在。
// 目标：验证统一步骤模型类型与脚本导入/导出往返一致（M1 验收 §8-2）。
// 当前 src 模块未实现，运行会失败，属正常"测试先行"状态。

import { describe, it, expect } from 'vitest';
import type { Script, Step } from '../src/types/step';
import { importScript, exportScript } from '../src/script/io';

describe('步骤模型 (Step / Locator / Assertion)', () => {
  it('一个合法 click 步骤应包含 id/type/locator/source', () => {
    const step: Step = {
      id: 's1',
      type: 'click',
      locator: { role: 'button', name: 'Submit' },
      source: 'manual',
    };
    expect(step.id).toBe('s1');
    expect(step.type).toBe('click');
    expect(step.locator?.name).toBe('Submit');
  });

  it('断言支持 textContains 并携带 value', () => {
    const step: Step = {
      id: 's2',
      type: 'assert',
      expect: { kind: 'textContains', value: 'Welcome' },
      source: 'manual',
    };
    expect(step.expect?.kind).toBe('textContains');
    expect(step.expect?.value).toBe('Welcome');
  });

  it('步骤可带 target 以指定 window/webview', () => {
    const step: Step = {
      id: 's3',
      type: 'fill',
      target: 'webview-settings',
      locator: { css: '#name' },
      params: { value: 'abc' },
      source: 'recorded',
    };
    expect(step.target).toBe('webview-settings');
  });
});

describe('脚本导入/导出往返 (Script IO)', () => {
  const sample: Script = {
    schema: 'electron-auto-test/step/v1',
    app: { name: 'demo-app', version: '1.0.0' },
    steps: [
      { id: 's1', type: 'fill', locator: { name: 'Username' }, params: { value: 'admin' }, source: 'manual' },
      { id: 's2', type: 'click', locator: { role: 'button', name: 'Login' }, source: 'manual' },
    ],
  };

  it('导出后再导入应结构一致', () => {
    const json = exportScript(sample);
    const back = importScript(json);
    expect(back).toEqual(sample);
  });

  it('导入非法 schema 应抛出明确错误', () => {
    expect(() => importScript(JSON.stringify({ schema: 'wrong', steps: [] }))).toThrow(/schema/i);
  });

  it('导入缺 steps 应抛出明确错误', () => {
    expect(() => importScript(JSON.stringify({ schema: 'electron-auto-test/step/v1' }))).toThrow(/steps/i);
  });
});
