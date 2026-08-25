// @vitest-environment jsdom
// M3-R5 shell × version-panel 集成测试（测试先行：验证 UiShell 把版本操作回调接回
// version-store 纯函数，并把新 store 喂回面板重绘；同时验证面板确实挂载到 render 产物）。
//
// 不改动任何既有测试（测试代码权威性）。

import { describe, it, expect, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { makeMockKernel } from './mock-kernel';
import type { Script, Step } from '../src/types/step';

function seqStep(id: string, children: Step[] = []): Step {
  return {
    id,
    type: 'click',
    target: { kind: 'selector', selector: `#${id}` },
    source: 'manual',
    control: { kind: 'sequence' },
    children,
  } as unknown as Step;
}

function scriptOf(steps: Step[]): Script {
  return { schema: 'electron-auto-test/step/v2', app: { name: 'demo' }, steps };
}

describe('UiShell × VersionPanel 集成', () => {
  it('render 后版本面板挂载，且默认含 main 分支 chip', () => {
    const k = makeMockKernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: scriptOf([seqStep('g1', [])]) });
    shell.render();
    const verWrap = mount.querySelector('[data-version]');
    expect(verWrap).not.toBeNull();
    const chips = verWrap!.querySelectorAll('[data-branch]');
    expect(chips.length).toBe(1);
    expect(chips[0].getAttribute('data-branch')).toBe('main');
  });

  it('versionBranch 后在面板出现新分支 chip（经 shell 编排写回 store）', () => {
    const k = makeMockKernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: scriptOf([seqStep('g1', [])]) });
    shell.render();
    shell.versionBranch('feature');
    shell.render(); // 重绘以刷新面板
    const chips = mount.querySelectorAll('[data-version] [data-branch]');
    const names = Array.from(chips).map((c) => c.getAttribute('data-branch'));
    expect(names).toContain('feature');
  });

  it('点击分支 chip 经 shell 切回 store（onSwitch → vSwitchTo → 面板刷新）', () => {
    const k = makeMockKernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: scriptOf([seqStep('g1', [])]) });
    shell.render();
    shell.versionBranch('feature');
    shell.render();
    // 点 feature chip 内部文字 → 触发切换
    const featureChip = Array.from(mount.querySelectorAll('[data-version] [data-branch]')).find(
      (c) => c.getAttribute('data-branch') === 'feature',
    )!;
    const label = featureChip.querySelector('[data-branch-label]') as HTMLElement;
    label.click();
    shell.render(); // 重绘刷新当前分支高亮
    const current = Array.from(mount.querySelectorAll('[data-version] [data-branch]')).find((c) =>
      c.classList.contains('is-current'),
    );
    expect(current?.getAttribute('data-branch')).toBe('feature');
  });

  it('versionCommit 后历史条数 +1（不可变：原脚本未被改写）', () => {
    const k = makeMockKernel();
    const mount = document.createElement('div');
    const shell = new UiShell({ kernel: k as any, mount, script: scriptOf([seqStep('g1', [])]) });
    shell.render();
    const before = mount.querySelectorAll('[data-version] [data-commit]').length;
    shell.versionCommit('snapshot v1');
    shell.render();
    const after = mount.querySelectorAll('[data-version] [data-commit]').length;
    expect(after).toBe(before + 1);
  });
});
