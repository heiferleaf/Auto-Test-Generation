// @vitest-environment jsdom
// snapshot 在收集可交互节点时顺带填 rect（getBoundingClientRect），不升 schema。

import { describe, it, expect, beforeEach } from 'vitest';
import { SNAPSHOT_COLLECT } from '../src/cdp/webview-session';

describe('snapshot 节点带 rect', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('收集脚本给每个节点填 x/y/width/height，旧字段仍在', () => {
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 4, y: 8, width: 40, height: 16, left: 4, top: 8, right: 44, bottom: 24, toJSON() { return {}; },
    }) as DOMRect;
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Go');
    btn.textContent = 'Go';
    document.body.appendChild(btn);
    const nodes = new Function(`return ${SNAPSHOT_COLLECT}`)() as Array<{
      name?: string; tag?: string; rect?: { x: number; y: number; width: number; height: number };
    }>;
    const hit = nodes.find((n) => n.name === 'Go' || n.tag === 'button');
    expect(hit).toBeTruthy();
    expect(hit!.rect).toEqual({ x: 4, y: 8, width: 40, height: 16 });
  });
});
