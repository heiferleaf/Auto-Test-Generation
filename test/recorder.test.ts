// M3 测试先行：Recorder 录制采集器单测。
// 验证交互事件 → Step[] 的字段正确性、语义化 locator 优先、Script 结构一致。

import { describe, it, expect } from 'vitest';
import { Recorder, emitRecordingEvent, mergeRecordingEvent, shouldKeepRecordingEvent, type InteractionEvent } from '../src/recorder/recorder';
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

describe('emitRecordingEvent：stop 与增量 drain 竞态', () => {
  it('listener 为 null/undefined 时不抛', () => {
    expect(() => emitRecordingEvent(null, clickEv)).not.toThrow();
    expect(() => emitRecordingEvent(undefined, clickEv)).not.toThrow();
  });

  it('是函数才调用', () => {
    const seen: InteractionEvent[] = [];
    emitRecordingEvent((e) => { seen.push(e); }, clickEv);
    expect(seen).toEqual([clickEv]);
  });
});

describe('录制噪声过滤：空 fill / presentation', () => {
  it('空 fill 丢弃；连续 fill 只留最新非空值', () => {
    const loc = { role: 'textbox', css: 'textarea' };
    expect(shouldKeepRecordingEvent({ type: 'fill', locator: loc, params: { value: '' } })).toBe(false);
    const merged = mergeRecordingEvent(
      [{ type: 'fill', locator: loc, params: { value: '你' } }],
      { type: 'fill', locator: loc, params: { value: '你好' } },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].params?.value).toBe('你好');
    const dropped = mergeRecordingEvent(merged, { type: 'fill', locator: loc, params: { value: '' } });
    expect(dropped).toBe(merged);
    expect(dropped[0].params?.value).toBe('你好');
  });

  it('role=presentation 的点击不进列表', () => {
    const prev: InteractionEvent[] = [{ type: 'click', locator: { role: 'button', name: 'Send' } }];
    const out = mergeRecordingEvent(prev, {
      type: 'click',
      locator: { role: 'presentation', css: 'div > span', name: '0B167F1451ED33C8' },
    });
    expect(out).toBe(prev);
    expect(out.some((e) => e.locator?.role === 'presentation')).toBe(false);
  });
});
