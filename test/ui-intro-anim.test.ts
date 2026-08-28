// @vitest-environment jsdom
// 顶栏品牌字进场动画（需求：docs/requirements/requirements.md「顶栏品牌字进场动画」）。
//
// 动画按「意图」声明：把开场放大态与顶栏最终态视为同一个元素的两个状态，
// 过渡交给 CSS transform/opacity，不依赖 getBoundingClientRect 算位移
// （jsdom 里它恒返回全 0，任何基于实测坐标的断言都是假绿灯）。
// 因此这里断言的是**状态机与语义**，不是像素。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UiShell } from '../src/ui/shell';
import { INTRO_PROGRESS_MS, INTRO_SETTLE_MS } from '../src/ui/intro';
import type { Script } from '../src/types/step';

/**
 * 工作台样式全在 index.html 的内联 <style> 里（不进 JS bundle），
 * 所以 jsdom 里查不到对应 <style> 标签，必须直接读源文件才能验证 CSS 层行为。
 */
function readIndexHtmlStyles(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/ui/index.html'),
    'utf8',
  );
}

/**
 * 必须先剥掉注释再匹配：注释里也会写 pointer-events 这几个字，
 * 不剥的话断言命中的是注释而不是真正的声明，等于没验证（假绿灯）。
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某条规则的声明体（到第一个 } 为止）。 */
function cssRule(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

// 断言不写死毫秒：全部由实现常量推导，改时序不会把测试变成假绿灯/假红灯。
const TOTAL_MS = INTRO_PROGRESS_MS + INTRO_SETTLE_MS;

type AnyKernel = any;

function makeMockKernel(): AnyKernel {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTargets: vi.fn((): any[] => [{ id: 'main', type: 'page', title: '主窗口' }]),
    selectTarget: vi.fn(),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    eval: vi.fn(async () => undefined),
    snapshot: vi.fn(async (): Promise<any[]> => []),
    query: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    locateVisual: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4, visible: true, inViewport: true })),
    startRecording: vi.fn(),
    stopRecording: vi.fn(async () => []),
    playback: vi.fn(async () => ({ ok: true })),
    on: vi.fn(),
    off: vi.fn(),
  } as AnyKernel;
}

const seed: Script = {
  schema: 'electron-auto-test/step/v1',
  app: { name: 'T', version: '1.0.0' },
  steps: [],
};

/** 装一个可插拔的 matchMedia，控制 prefers-reduced-motion。 */
function stubMatchMedia(reduce: boolean) {
  const impl = (q: string) => ({
    matches: /prefers-reduced-motion/.test(q) ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  });
  (window as any).matchMedia = impl;
  (globalThis as any).matchMedia = impl;
}

function boot(opts: { reduce?: boolean } = {}) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const shell = new UiShell({ kernel: makeMockKernel(), mount, script: seed });
  shell.render();
  return { shell, mount };
}

/** 推进 rAF + 定时器，把 CSS 过渡当作「时间到了」处理。 */
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

const intro = (m: HTMLElement) => m.querySelector('[data-intro]') as HTMLElement | null;
const wordmark = (m: HTMLElement) => m.querySelector('[data-wordmark]') as HTMLElement | null;

describe('顶栏品牌字进场动画', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- 1. 首帧：放大态居中 + 进度条 ----

  it('首次 render 后处于放大态：顶栏字标被标记为 intro 源头，页面出现进场层', () => {
    const { mount } = boot();
    expect(intro(mount)).toBeTruthy();
    expect(intro(mount)!.getAttribute('data-intro-state')).toBe('opening');
    expect(wordmark(mount)).toBeTruthy();
  });

  it('进场层里有与顶栏同一个产品名的文字，且标记为放大态', () => {
    const { mount } = boot();
    const title = intro(mount)!.querySelector('[data-intro-title]') as HTMLElement;
    expect(title).toBeTruthy();
    // 同一个产品名，不另起一套文案（需求：「还是这几个字」）。
    expect(title.textContent).toBe('测试步骤中台');
  });

  it('进场层里有进度条（长方形），且从 0 开始', () => {
    const { mount } = boot();
    const bar = intro(mount)!.querySelector('[data-intro-progress]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('data-intro-progress')).toBe('0');
    // 宽度与属性同源：属性说 0，视觉宽度就得是 0，不许两处对不上。
    expect(bar.style.width).toBe('0%');
  });

  it('进度条不与真实进度挂钩：是固定时长的装饰动画，不是假进度', async () => {
    // 不撒谎原则：没有任何资源可等（jsdom 无 canvas、无真机连接），
    // 进度条仍按固定时长走完。它表达的是「开场动画进行中」，不是「加载百分比」。
    const { mount } = boot();
    const prog = () => {
      const b = intro(mount)!.querySelector('[data-intro-progress]') as HTMLElement;
      return { attr: Number(b.getAttribute('data-intro-progress')), width: b.style.width };
    };
    await tick(300);
    const a = prog();
    await tick(300);
    const b = prog();
    expect(a.attr).toBeGreaterThan(0);
    expect(b.attr).toBeGreaterThan(a.attr);
    // 属性与视觉宽度始终一致，避免"属性说 80%、眼睛看到 10%"的假进度。
    expect(a.width).toBe(`${a.attr}%`);
    expect(b.width).toBe(`${b.attr}%`);
  });

  // ---- 2. 过渡与结束 ----

  it('进度走完后进入收敛态，最终从 DOM 移除进场层（不残留遮罩）', async () => {
    const { mount } = boot();
    await tick(INTRO_PROGRESS_MS);
    expect(intro(mount)!.getAttribute('data-intro-state')).toBe('settling');
    await tick(INTRO_SETTLE_MS);
    expect(intro(mount)).toBeNull();
  });

  it('动画结束后顶栏字标仍在（进场层不能把字标吃掉）', async () => {
    const { mount } = boot();
    await tick(TOTAL_MS + 60);
    expect(wordmark(mount)).toBeTruthy();
    expect(wordmark(mount)!.textContent).toContain('测试步骤中台');
  });

  it('总时长控制在 2.5s 内', async () => {
    const { mount } = boot();
    expect(TOTAL_MS).toBeLessThan(2500);
    await tick(TOTAL_MS + 60);
    expect(intro(mount)).toBeNull();
  });

  // ---- 2b. 收敛落点必须是「量出来的」，不是写死的常量 ----

  it('收敛落点取自顶栏字标的实测坐标（横幅顶着顶栏时也不会收敛到错位置）', async () => {
    const { mount } = boot();
    // 给字标造一个"非默认"位置：顶栏被横幅顶下去时它就在别处。
    // 关键在断言"落点来自这个盒子"，而不是某个写死的 27px/31px。
    const wm = wordmark(mount)!;
    const rootBox = { left: 100, top: 200 };
    const wmBox = { left: 145, top: 283 };
    wm.getBoundingClientRect = () => ({ ...wmBox, width: 248, height: 36, right: 0, bottom: 0, x: wmBox.left, y: wmBox.top }) as DOMRect;
    mount.getBoundingClientRect = () => ({ ...rootBox, width: 800, height: 600, right: 0, bottom: 0, x: rootBox.left, y: rootBox.top }) as DOMRect;

    await tick(INTRO_PROGRESS_MS);
    const layer = intro(mount)!;
    expect(layer.getAttribute('data-intro-landing')).toBe('measured');
    expect(layer.style.getPropertyValue('--intro-land-x')).toBe(`${wmBox.left - rootBox.left}px`);
    expect(layer.style.getPropertyValue('--intro-land-y')).toBe(`${wmBox.top - rootBox.top}px`);
    await tick(INTRO_SETTLE_MS);
  });

  it('量不到落点时只淡出不平移（不朝凭空算出来的坐标飞）', async () => {
    const { mount } = boot();
    // jsdom 的 getBoundingClientRect 恒返回全 0 = 未布局，属"量不到"。
    await tick(INTRO_PROGRESS_MS);
    const layer = intro(mount)!;
    expect(layer.getAttribute('data-intro-landing')).toBe('none');
    // 没有落点变量：CSS 回退到"停在原位淡出"，不写死平移。
    expect(layer.style.getPropertyValue('--intro-land-x')).toBe('');
    await tick(INTRO_SETTLE_MS);
  });

  it('CSS 落点用变量而非硬编码像素（写死就会在有横幅时收敛到错位置）', () => {
    const css = stripComments(readIndexHtmlStyles());
    const rule = cssRule(css, '.ui-shell-intro[data-intro-state="settling"] .ui-shell-intro-title');
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/left:\s*var\(--intro-land-x/);
    expect(rule).toMatch(/top:\s*var\(--intro-land-y/);
    // 量不到时的兜底：标了 landing=none 就不平移。
    expect(cssRule(css, '.ui-shell-intro[data-intro-landing="none"][data-intro-state="settling"] .ui-shell-intro-title'))
      .toMatch(/left:\s*50%/);
  });

  // ---- 3. render 重播防护（关键：render 有 34 处调用点，且首行 innerHTML=''）----

  it('后续 render 不重播：动画期间插入步骤触发 render，进场层不回到 opening', async () => {
    const { shell, mount } = boot();
    await tick(300);
    const stateBefore = intro(mount)!.getAttribute('data-intro-state');
    shell.insertStep({ id: 's1', type: 'wait', source: 'manual', params: { ms: 100 } } as any);
    const stateAfter = intro(mount)!.getAttribute('data-intro-state');
    // 重建后不能倒退回开场放大态。
    expect(['opening', 'settling']).toContain(stateAfter!);
    if (stateBefore === 'settling') expect(stateAfter).toBe('settling');
  });

  it('动画播完后再 render 不会又冒出进场层', async () => {
    const { shell, mount } = boot();
    await tick(TOTAL_MS + 60);
    expect(intro(mount)).toBeNull();
    shell.insertStep({ id: 's2', type: 'wait', source: 'manual', params: { ms: 100 } } as any);
    expect(intro(mount)).toBeNull();
  });

  it('同一实例多次 render：进度不回退（中途重建进场层也不从头再播）', async () => {
    const { shell, mount } = boot();
    const prog = () => Number(intro(mount)!.querySelector('[data-intro-progress]')!.getAttribute('data-intro-progress'));
    await tick(300);
    const before = prog();
    expect(before).toBeGreaterThan(0);
    // 连续两次全量 render：进场层被 innerHTML='' 冲掉后重建，
    // 进度必须接着走，否则用户会看到进度条"弹回去重来"。
    shell.render();
    const mid = prog();
    shell.render();
    expect(prog()).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThanOrEqual(before);
  });

  it('进场层被重建后仍只有一个（不叠加多层遮罩）', async () => {
    const { shell, mount } = boot();
    shell.render();
    shell.render();
    expect(mount.querySelectorAll('[data-intro]').length).toBe(1);
  });

  // ---- 4. 降级路径 ----

  it('prefers-reduced-motion 时直接最终态：不出现进场层', () => {
    stubMatchMedia(true);
    const { mount } = boot();
    expect(intro(mount)).toBeNull();
    // 顶栏字标照常可用（降级不能把主功能降没了）。
    expect(wordmark(mount)).toBeTruthy();
  });

  it('reduced-motion 下 render 多次也不会补播动画', () => {
    stubMatchMedia(true);
    const { shell, mount } = boot();
    shell.render();
    shell.render();
    expect(intro(mount)).toBeNull();
  });

  // ---- 5. 可跳过 ----

  it('用户点「跳过」按钮可跳过动画，直接进入最终态', async () => {
    const { mount } = boot();
    // 点按钮而不是点遮罩：进场层 pointer-events:none，
    // 用户唯一点得到的就是「跳过」（另一条通道是 Esc）。
    const skip = intro(mount)!.querySelector('[data-intro-skip]') as HTMLElement;
    skip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(INTRO_SETTLE_MS + 60);
    expect(intro(mount)).toBeNull();
    expect(wordmark(mount)).toBeTruthy();
  });

  it('按 Esc 也能跳过，不等进度条走完', async () => {
    const { mount } = boot();
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(500);
    expect(intro(mount)).toBeNull();
  });

  it('跳过按钮对用户可见（不只是键盘通道）', () => {
    const { mount } = boot();
    const skip = intro(mount)!.querySelector('[data-intro-skip]') as HTMLElement;
    expect(skip).toBeTruthy();
    expect(skip.textContent!.trim().length).toBeGreaterThan(0);
  });

  // ---- 6. 不阻碍交互 ----

  it('动画期间顶栏按钮仍可点（进场层不拦截除自身外的点击）', async () => {
    const { mount } = boot();
    const btn = mount.querySelector('[data-action="insert"]') as HTMLElement;
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mount.querySelector('[data-insert-type="wait"]')).toBeTruthy();
  });

  it('进场层真的不吃点击：CSS 层上 pointer-events:none（不能只靠 dispatchEvent 验证）', () => {
    // 反假绿灯：jsdom 的 dispatchEvent 不走命中测试（hit-testing），
    // 全屏遮罩即使把按钮盖死，上面那条用例也照样通过。
    // 所以这里直接查样式表，确认进场层在 CSS 层面就不参与命中。
    const { mount } = boot();
    const css = stripComments(readIndexHtmlStyles());
    const rule = cssRule(css, '.ui-shell-intro');
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/pointer-events:\s*none/);
    // 「跳过」按钮必须单独放开，否则用户点不到跳过。
    expect(cssRule(css, '.ui-shell-intro-skip')).toMatch(/pointer-events:\s*auto/);
    expect(mount.querySelector('[data-intro-skip]')).toBeTruthy();
  });

  it('进场层带 aria 语义，读屏不会以为页面是空的', () => {
    const { mount } = boot();
    const layer = intro(mount)!;
    expect(layer.getAttribute('role')).toBe('status');
    expect(layer.getAttribute('aria-label')).toBeTruthy();
  });
});
