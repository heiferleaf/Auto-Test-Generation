// 预览高亮：CSS 视口框 → object-fit:contain 截图 overlay（保留纯函数；产品路径改为拍摄时画进 PNG）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mapHighlightRect, viewportFromRect } from '../src/ui/highlight-map';
import { highlightPaintSource, HIGHLIGHT_CLEAR } from '../src/recorder/inject';

describe('mapHighlightRect', () => {
  it('DPR=2 的截图 + contain letterbox：框落在图上而不是 CSS 原坐标', () => {
    // 视口 800×400；截图 1600×800；舞台 img 显示区 400×300（上下留白）。
    const mapped = mapHighlightRect(
      { x: 100, y: 50, width: 40, height: 20 },
      { width: 800, height: 400 },
      { naturalWidth: 1600, naturalHeight: 800, clientWidth: 400, clientHeight: 300 },
    );
    // contain = min(400/1600, 300/800) = 0.25 → 显示 400×200，oy=50
    // sx = (1600/800)*0.25 = 0.5
    expect(mapped.x).toBeCloseTo(50);
    expect(mapped.y).toBeCloseTo(75);
    expect(mapped.width).toBeCloseTo(20);
    expect(mapped.height).toBeCloseTo(10);
  });

  it('缺视口/图片尺寸时原样返回，不把 NaN 画上舞台', () => {
    const box = { x: 10, y: 20, width: 30, height: 40 };
    expect(mapHighlightRect(box, { width: 0, height: 0 }, {
      naturalWidth: 0, naturalHeight: 0, clientWidth: 100, clientHeight: 100,
    })).toEqual(box);
  });
});

describe('viewportFromRect', () => {
  it('优先用 locateVisual 带回的 viewportWidth/Height', () => {
    const vp = viewportFromRect(
      { viewportWidth: 800, viewportHeight: 400, devicePixelRatio: 2 },
      { naturalWidth: 1600, naturalHeight: 800, clientWidth: 400, clientHeight: 200 },
    );
    expect(vp).toEqual({ width: 800, height: 400 });
  });

  it('没有 viewport 时用 natural / dpr 反推', () => {
    const vp = viewportFromRect(
      { devicePixelRatio: 2 },
      { naturalWidth: 1600, naturalHeight: 800, clientWidth: 400, clientHeight: 200 },
    );
    expect(vp).toEqual({ width: 800, height: 400 });
  });
});

describe('拍摄时把高亮画进靶机 DOM', () => {
  it('highlightPaintSource 在命中元素上插入 #__atgHl', () => {
    document.body.innerHTML = '';
    const row = document.createElement('div');
    row.setAttribute('aria-label', 'settings.json');
    row.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 80, height: 18, right: 90, bottom: 38, toJSON() {} }) as DOMRect;
    document.body.appendChild(row);
    new Function(`return ${highlightPaintSource({ name: 'settings.json' })}`)();
    const hl = document.getElementById('__atgHl');
    expect(hl).toBeTruthy();
    expect(hl?.getAttribute('data-atg-highlight')).toBe('true');
    new Function(`return ${HIGHLIGHT_CLEAR}`)();
    expect(document.getElementById('__atgHl')).toBeNull();
  });
});
