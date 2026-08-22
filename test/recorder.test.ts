// M3 测试先行：Recorder 录制采集器单测。
// 验证交互事件 → Step[] 的字段正确性、语义化 locator 优先、Script 结构一致。

import { describe, it, expect } from 'vitest';
import { Recorder, type InteractionEvent } from '../src/recorder/recorder';
import { SCRIPT_SCHEMA, type Step } from '../src/types/step';

const clickEv: InteractionEvent = {
  type: 'click',
  target: 'webview-1',
  locator: { role: 'button', name: '发送' },
};
const fillEv: InteractionEvent = {
  type: 'fill',
  locator: { css: '#input' },
  params: { value: '你好' },
};

describe('Recorder 录制采集器', () => {
  it('单事件 → 单 Step，字段与模型一致', () => {
    const r = new Recorder();
    r.record(clickEv);
    const steps = r.toSteps();
    expect(steps).toHaveLength(1);
    const s: Step = steps[0];
    expect(s.type).toBe('click');
    expect(s.target).toBe('webview-1');
    expect(s.source).toBe('recorded');
    expect(s.locator).toEqual({ role: 'button', name: '发送' });
  });

  it('累积多事件保持顺序', () => {
    const r = new Recorder();
    r.record(clickEv);
    r.record(fillEv);
    const steps = r.toSteps();
    expect(steps.map((s) => s.type)).toEqual(['click', 'fill']);
    expect(steps[1].params?.value).toBe('你好');
  });

  it('size 与 reset 正确', () => {
    const r = new Recorder();
    r.record(clickEv);
    r.record(fillEv);
    expect(r.size).toBe(2);
    r.reset();
    expect(r.size).toBe(0);
    expect(r.toSteps()).toEqual([]);
  });

  it('buildScript 产出合规 Script（schema / app / steps）', () => {
    const r = new Recorder();
    r.record(clickEv);
    const script = r.buildScript({ name: 'CodeBuddy', version: '1.0.0' }, '录制冒烟');
    expect(script.schema).toBe(SCRIPT_SCHEMA);
    expect(script.app.name).toBe('CodeBuddy');
    expect(script.app.version).toBe('1.0.0');
    expect(script.steps).toHaveLength(1);
    expect(script.note).toBe('录制冒烟');
  });

  it('assert 类型事件携带 assertion 补丁', () => {
    const r = new Recorder();
    r.record({ type: 'assert', locator: { role: 'textbox' } });
    const s = r.toSteps()[0];
    expect(s.type).toBe('assert');
    expect(s.params?.assertion).toEqual({ kind: 'exists', locator: { role: 'textbox' } });
  });
});
