// 测试先行：修正 M1 真机暴露的偏差——VS Code 系 Electron 的 webview
// 在 CDP /json 中以 type="iframe" 出现，而非 "webview"。
// 本测试断言：原始 CDP type 到本项目 TargetType 的分类能正确把 iframe 归为 webview。
//
// 设计基线：docs/设计文档.md §5；修正依据 test/reports 真机报告（webview:0 实为 iframe 漏识）。

import { describe, it, expect } from 'vitest';
import { classifyTargetType, type RawCdpTarget } from '../src/cdp/targets';

describe('CDP target 类型分类（iframe→webview 偏差修正）', () => {
  it('page 保持为 page', () => {
    const raw: RawCdpTarget = {
      id: 'p1',
      type: 'page',
      title: 'main',
      webSocketDebuggerUrl: 'ws://x',
    };
    expect(classifyTargetType(raw)).toBe('page');
  });

  it('iframe 归类为 webview（真机偏差修正点）', () => {
    const raw: RawCdpTarget = {
      id: 'i1',
      type: 'iframe',
      title: 'vscode-webview://...',
      webSocketDebuggerUrl: 'ws://x',
    };
    expect(classifyTargetType(raw)).toBe('webview');
  });

  it('其它已知类型（worker/other）透传不丢', () => {
    const raw: RawCdpTarget = {
      id: 'w1',
      type: 'worker',
      title: '',
      webSocketDebuggerUrl: 'ws://x',
    };
    expect(classifyTargetType(raw)).toBe('worker');
  });

  it('无 type 字段时回退为 page', () => {
    const raw: RawCdpTarget = { id: 'u1', title: '' };
    expect(classifyTargetType(raw)).toBe('page');
  });
});
