// M3 测试先行：ScriptEditor 编辑操作单测 + 触发编排（Recorder 产物 → runCli 回放）。
// 编辑操作均为不可变更新，复用 src/script/io.ts 的导入/导出校验。

import { describe, it, expect } from 'vitest';
import { ScriptEditor } from '../src/editor/editor';
import { Recorder, type InteractionEvent } from '../src/recorder/recorder';
import type { Script, Step } from '../src/types/step';
import type { CdpAdapter } from '../src/cdp/adapter';
import { runCli } from '../src/cli';

const base: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'CodeBuddy', version: '1.0.0' },
  steps: [
    { id: 's1', type: 'fill', locator: { name: 'Username' }, params: { value: 'admin' }, source: 'manual' },
    { id: 's2', type: 'click', locator: { role: 'button', name: 'Login' }, source: 'manual' },
  ],
};

describe('ScriptEditor 编辑操作', () => {
  it('insert 在指定位置插入且不改原对象', () => {
    const s3: Step = { id: 's3', type: 'wait', params: { durationMs: 100 }, source: 'manual' };
    const next = ScriptEditor.insert(base, s3, 1);
    expect(base.steps).toHaveLength(2); // 原对象不变（不可变）
    expect(next.steps.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
  });

  it('remove 按 id 删除', () => {
    const next = ScriptEditor.remove(base, 's1');
    expect(next.steps.map((s) => s.id)).toEqual(['s2']);
  });

  it('update 合并补丁', () => {
    const next = ScriptEditor.update(base, 's1', { params: { value: 'root' } });
    expect(next.steps[0].params?.value).toBe('root');
    expect(base.steps[0].params?.value).toBe('admin'); // 原对象不变
  });

  it('move 重排步骤', () => {
    const next = ScriptEditor.move(base, 's2', 0);
    expect(next.steps.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('load 校验非法 JSON 抛 ScriptError', () => {
    expect(() => ScriptEditor.load('{ not json')).toThrow();
  });

  it('roundTrip 导出导入结构等价', () => {
    const back = ScriptEditor.roundTrip(base);
    expect(back).toEqual(base);
  });
});

describe('触发编排（M3 组件对外：Recorder 产物 → 对目标软件响应）', () => {
  function stubAdapter(): CdpAdapter {
    return {
      async connect() {}, async disconnect() {},
      listTargets: () => [{ id: 'w1', type: 'page', title: 'main', isMain: true }],
      selectTarget() {},
      async click() {}, async fill() {}, async select() {}, async hover() {}, async wait() {},
      async eval() { return null; }, async snapshot() { return []; }, async query() { return null; },
      async pageText() { return null; },
    } as CdpAdapter;
  }

  it('Recorder 录制的脚本可被 runCli 回放成功', async () => {
    const evs: InteractionEvent[] = [
      { type: 'fill', locator: { name: 'Username' }, params: { value: 'admin' } },
      { type: 'click', locator: { role: 'button', name: 'Login' } },
    ];
    const rec = new Recorder();
    evs.forEach((e) => rec.record(e));
    const script = rec.buildScript({ name: 'CodeBuddy' });

    const res = await runCli({ adapter: stubAdapter(), script });
    expect(res.ok).toBe(true);
  });

  it('录制脚本经 ScriptEditor 编辑后仍可回放', async () => {
    const rec = new Recorder();
    rec.record({ type: 'click', locator: { role: 'button', name: 'Send' } });
    let script = rec.buildScript({ name: 'CodeBuddy' });

    // 编辑：给该步补一个 fill 前置，验证编辑+触发闭环
    script = ScriptEditor.insert(
      script,
      { id: 'pre', type: 'fill', locator: { name: 'Input' }, params: { value: '你好' }, source: 'recorded' },
      0,
    );
    const res = await runCli({ adapter: stubAdapter(), script });
    expect(res.ok).toBe(true);
    expect(script.steps).toHaveLength(2);
  });
});
