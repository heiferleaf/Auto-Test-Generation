// @vitest-environment jsdom
// 开场粒子进场（src/ui/intro.ts）验收：
// 大号品牌字必须由像素颗粒（粒子）组成，飘散后收拢到顶栏字标的真实落点。
// 没有进度条、没有跳过按钮（用户已被否决过一次，这两条不许再回来）。
//
// 项目没装 canvas 包，jsdom 下 getContext('2d') 恒为 null —— 所以不走真渲染，
// 靠「栅格化器注入」这个 seam 验证纯几何。最关键的一条是落点映射：
// 粒子最终落点必须与顶栏字标要画的点逐点重合，否则交接会飞到错地方。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  INTRO_RASTER_W,
  INTRO_RASTER_H,
  INTRO_SAMPLE_STEP,
  INTRO_DAMPING,
  INTRO_MIN_POINTS,
  INTRO_SWEEP_MS,
  INTRO_TIMELINE,
  INTRO_TOTAL_MS,
  sampleTextPointCloud,
  pointCloudBBox,
  layoutBigWord,
  computeLanding,
  createParticles,
  stepParticle,
  convergeTuning,
  applyDisperseImpulse,
  playIntro,
  type Pt,
  type Particle,
  type Rasterizer,
} from '../src/ui/intro';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTRO_SRC = readFileSync(join(HERE, '../src/ui/intro.ts'), 'utf8');
const HTML_SRC = readFileSync(join(HERE, '../src/ui/index.html'), 'utf8');
const APP_SRC = readFileSync(join(HERE, '../src/ui/app.ts'), 'utf8');

const TEXT = '测试步骤中台';

/** 合成 bitmap：把 [x0,x1) × [y0,y1) 涂成不透明，形状可控、不依赖真实字体。 */
function inkRect(x0: number, y0: number, x1: number, y1: number): Rasterizer {
  return (_text, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data[(y * w + x) * 4 + 3] = 255;
    }
    return data;
  };
}

/** 墨迹范围刻意仿真实文字：起笔 x=30（顶栏 10 设备像素 × 超采样 3），落在 248×36 的字标盒内。 */
const INK = inkRect(30, 41, 834, 175);
const VIEWPORT = { width: 1440, height: 900 };

function stubWordmark(left: number, top: number, width = 248, height = 36): HTMLElement {
  const host = document.createElement('div');
  host.className = 'ui-shell-wordmark';
  const label = document.createElement('span');
  label.className = 'ui-shell-wordmark-label';
  label.textContent = TEXT;
  host.appendChild(label);
  host.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(host);
  return host;
}

/** 包一层只为拿到 spy 的精确类型（不同 vitest 版本 MockInstance 泛型不一致）。 */
function spyGetContext() {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
}
type CtxSpy = ReturnType<typeof spyGetContext>;

/** 假 2d 上下文：记录每帧 fillRect 的包围盒，测试据此判断粒子到底落在哪。 */
function fakeCtx() {
  const calls = {
    fillRect: 0,
    clearRect: 0,
    // 每帧 clearRect 归零，故 bbox 恒为"最后一帧"的粒子范围
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
  };
  return {
    calls,
    fillStyle: '',
    setTransform: () => {},
    clearRect: () => {
      calls.clearRect += 1;
      calls.minX = Infinity; calls.maxX = -Infinity; calls.minY = Infinity; calls.maxY = -Infinity;
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.fillRect += 1;
      if (x < calls.minX) calls.minX = x;
      if (x + w > calls.maxX) calls.maxX = x + w;
      if (y < calls.minY) calls.minY = y;
      if (y + h > calls.maxY) calls.maxY = y + h;
    },
  } as unknown as CanvasRenderingContext2D & { calls: typeof calls };
}

describe('点云采样', () => {
  it('按步长与 alpha 阈值取点，bbox 贴合墨迹区域', () => {
    const pts = sampleTextPointCloud(TEXT, INK);
    expect(pts.length).toBeGreaterThan(1000);
    const box = pointCloudBBox(pts)!;
    // 采样从 x=1 起、步长 3，故首个取到的点落在 [30, 33) 内
    expect(box.minX).toBeGreaterThanOrEqual(30);
    expect(box.minX).toBeLessThan(30 + INTRO_SAMPLE_STEP);
    expect(box.maxX).toBeLessThan(834);
    expect(box.maxX).toBeGreaterThan(834 - INTRO_SAMPLE_STEP - 1);
    expect(box.minY).toBeGreaterThanOrEqual(41);
    expect(box.maxY).toBeLessThan(175);
  });

  it('栅格化器返回 null（getImageData 失败等）→ 空点云，不抛错', () => {
    expect(sampleTextPointCloud(TEXT, () => null)).toEqual([]);
    expect(pointCloudBBox([])).toBeNull();
  });

  it('全透明位图 → 空点云，不抛错', () => {
    const blank: Rasterizer = (_t, w, h) => new Uint8ClampedArray(w * h * 4);
    expect(sampleTextPointCloud(TEXT, blank)).toEqual([]);
  });

  it('点云坐标落在超采样画布范围内', () => {
    const pts = sampleTextPointCloud(TEXT, INK);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(INTRO_RASTER_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(INTRO_RASTER_H);
    }
  });
});

describe('大字布局', () => {
  const pts = sampleTextPointCloud(TEXT, INK);

  it('等比放大（宽高比不变）且整体居中于视口', () => {
    const big = layoutBigWord(pts, VIEWPORT);
    const src = pointCloudBBox(pts)!;
    const box = pointCloudBBox(big)!;
    expect(big).toHaveLength(pts.length);
    // 等比：只缩放不拉伸
    expect(box.width / box.height).toBeCloseTo(src.width / src.height, 6);
    // 居中：bbox 中心 == 视口中心
    expect((box.minX + box.maxX) / 2).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(VIEWPORT.height / 2, 6);
  });

  it('比顶栏字标明显更大，且不溢出视口', () => {
    const box = pointCloudBBox(layoutBigWord(pts, VIEWPORT))!;
    expect(box.width).toBeGreaterThan(248 * 2);
    expect(box.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(box.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('小视口下等比缩小而不是裁掉', () => {
    const small = { width: 520, height: 400 };
    const box = pointCloudBBox(layoutBigWord(pts, small))!;
    expect(box.width).toBeLessThanOrEqual(small.width);
    expect(box.height).toBeLessThanOrEqual(small.height);
    const src = pointCloudBBox(pts)!;
    expect(box.width / box.height).toBeCloseTo(src.width / src.height, 6);
  });
});

describe('落点映射（关键回归防线）', () => {
  it('落点 = 实测字标左上 + 点云坐标 / (dpr × 超采样)', () => {
    const pts = sampleTextPointCloud(TEXT, INK);
    const rect = { left: 83.5, top: 27.25 };
    const landing = computeLanding(pts, rect);
    expect(landing).toHaveLength(pts.length);
    // 顶栏 canvas 是 248×36 CSS / dpr2，点云在 dpr2 × 超采样 3 的坐标系下，故除数恒为 6
    for (let i = 0; i < pts.length; i += 97) {
      expect(landing[i].x).toBe(rect.left + pts[i].x / 6);
      expect(landing[i].y).toBe(rect.top + pts[i].y / 6);
    }
  });

  it('落点整体落在顶栏字标的 248×36 盒内（交接才不会偏）', () => {
    const pts = sampleTextPointCloud(TEXT, INK);
    const rect = { left: 16, top: 83 };
    const box = pointCloudBBox(computeLanding(pts, rect))!;
    expect(box.minX).toBeGreaterThanOrEqual(rect.left);
    expect(box.maxX).toBeLessThanOrEqual(rect.left + 248);
    expect(box.minY).toBeGreaterThanOrEqual(rect.top);
    expect(box.maxY).toBeLessThanOrEqual(rect.top + 36);
  });

  it('换一个字标位置，落点整体平移相同位移（不重算形状）', () => {
    const pts = sampleTextPointCloud(TEXT, INK);
    const a = computeLanding(pts, { left: 16, top: 27 });
    const b = computeLanding(pts, { left: 16, top: 120 });
    for (let i = 0; i < pts.length; i += 131) {
      expect(b[i].x - a[i].x).toBeCloseTo(0, 9);
      expect(b[i].y - a[i].y).toBeCloseTo(93, 9);
    }
  });
});

describe('粒子运动（飘散靠弹簧，不是线性插值）', () => {
  const pts = sampleTextPointCloud(TEXT, INK);
  const big = layoutBigWord(pts, VIEWPORT);
  const landing = computeLanding(pts, { left: 16, top: 27 });
  const particles = createParticles({ big, landing, random: () => 0.5 });

  it('每颗粒子的弹簧刚度落在 0.04~0.10，淡入错峰限制在浮现段内', () => {
    for (const p of particles) {
      expect(p.k).toBeGreaterThanOrEqual(0.04);
      expect(p.k).toBeLessThanOrEqual(0.1);
      // delay 只决定谁先亮，不再是"起飞错峰"：上限就是浮现段本身。
      // 取大了会变成"字一颗颗慢慢长出来"—— 那是另一种慢慢聚拢，用户明确不要。
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThanOrEqual(INTRO_TIMELINE.emergeEnd);
    }
  });

  it('粒子出生就站在大字坐标上，不是从全屏各处飞过来（用户第二轮反馈的回归防线）', () => {
    // 上一版：x = rnd()*视口宽、y = rnd()*视口高，靠飞行汇聚成字 —— 用户嫌那段拖沓。
    // 现在出生点就是大字坐标，只允许 ±1px 抖动免得像贴纸。这条断言锁死这一点。
    let worst = 0;
    // 换个真随机的序列，别让固定 0.5 把"全屏撒点"这种写法也蒙混过去
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const p of createParticles({ big, landing, random: rnd })) {
      const b = big[p.i];
      worst = Math.max(worst, Math.abs(p.x - b.x), Math.abs(p.y - b.y));
    }
    expect(worst).toBeLessThanOrEqual(1);
    // 反证：全屏撒点的偏移量是视口量级，绝不可能落在 1px 内
    expect(Math.min(VIEWPORT.width, VIEWPORT.height)).toBeGreaterThan(100);
  });

  it('大字一开局就居中：出生点云的中心就是视口中心（不需要飞过来才居中）', () => {
    for (const rndValue of [0, 0.5, 1]) {
      const ps = createParticles({ big, landing, random: () => rndValue });
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of ps) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      // ±1px 出生抖动，中心允许差 2px 内（全屏撒点的话中心仍会是视口中心，
      // 所以这条只守住"居中"，"出生就贴大字"由上面那条 worst<=1 守住）
      expect(Math.abs((minX + maxX) / 2 - VIEWPORT.width / 2)).toBeLessThan(2);
      expect(Math.abs((minY + maxY) / 2 - VIEWPORT.height / 2)).toBeLessThan(2);
    }
  });

  it('目标不变时逐步逼近，收敛且不发散', () => {
    const p = { ...particles[0] };
    p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.k = 0.07; p.tx = 100; p.ty = 0;
    const start = Math.abs(p.tx - p.x);
    stepParticle(p);
    expect(Math.abs(p.tx - p.x)).toBeLessThan(start);
    let worst = 0;
    for (let n = 0; n < 240; n++) {
      stepParticle(p);
      worst = Math.max(worst, Math.abs(p.tx - p.x));
    }
    expect(worst).toBeLessThanOrEqual(start); // 阻尼够大，不会越荡越远
    expect(Math.abs(p.tx - p.x)).toBeLessThan(0.5); // 最终贴上目标
  });

  it('阻尼系数是常量 0.86（改了观感就变了）', () => {
    expect(INTRO_DAMPING).toBe(0.86);
  });

  it('飘散后能在剩余帧数内真正落到点上（交接才不会"没到位就消失"）', () => {
    // 最苛刻的一颗：扫掠让它晚 INTRO_SWEEP_MS 才起飞，只剩 (2050-1420)/16.67 ≈ 37 帧。
    // 帧数由时间轴直接算出来，别写死 —— 上一轮停留段拉长后这里从 43 帧掉到 37 帧，
    // 旧的 0.2/0.45 参数残余差 2.52px 已经压不住 2px 验收线，是这条断言的由来。
    const frames = Math.floor((INTRO_TIMELINE.convergeEnd - (INTRO_TIMELINE.holdEnd + INTRO_SWEEP_MS)) / (1000 / 60));
    expect(frames).toBe(37);
    for (const k of [0.04, 0.07, 0.1]) {
      const p: Particle = { ...particles[0] };
      p.x = 700; p.y = 0; p.vx = 0; p.vy = 0; p.k = k; p.tx = 0; p.ty = 0;
      applyDisperseImpulse(p, { x: 0, y: 0 } as Pt, () => 0.5);
      for (let i = 0; i < frames; i++) {
        const tune = convergeTuning(p.k, (i + 1) / frames);
        stepParticle(p, tune.stiffness, tune.damping);
      }
      expect(Math.abs(p.x)).toBeLessThan(1.5);
    }
  });

  it('末段拧硬只影响收尾，冲量造成的弧线仍然看得见', () => {
    // 同一颗粒子，带冲量与不带冲量的位移差 = 炸开的幅度
    const trace = (impulse: boolean) => {
      const p: Particle = { ...particles[0] };
      p.x = 700; p.y = 0; p.vx = 0; p.vy = 0; p.k = 0.06; p.tx = 0; p.ty = 0;
      if (impulse) applyDisperseImpulse(p, { x: 0, y: 0 } as Pt, () => 0.5);
      const out: number[] = [];
      const frames = Math.floor((INTRO_TIMELINE.convergeEnd - (INTRO_TIMELINE.holdEnd + INTRO_SWEEP_MS)) / (1000 / 60));
      for (let i = 0; i < frames; i++) {
        const tune = convergeTuning(p.k, (i + 1) / frames);
        stepParticle(p, tune.stiffness, tune.damping);
        out.push(p.x);
      }
      return out;
    };
    const withImp = trace(true);
    const without = trace(false);
    let arc = 0;
    for (let i = 0; i < withImp.length; i++) arc = Math.max(arc, withImp[i] - without[i]);
    // 冲量取 9 时只外扩 20~26px，肉眼几乎看不出炸开；取 26 后 52~75px，落点残差不变
    expect(arc).toBeGreaterThan(40);
  });

  it('convergeTuning 在 q=0 时回到常量，q=1 时最硬，且单调', () => {
    const a = convergeTuning(0.06, 0);
    expect(a.stiffness).toBe(0.06);
    expect(a.damping).toBe(INTRO_DAMPING);
    const b = convergeTuning(0.06, 0.5);
    const c = convergeTuning(0.06, 1);
    expect(b.stiffness).toBeGreaterThan(a.stiffness);
    expect(c.stiffness).toBeGreaterThan(b.stiffness);
    expect(c.damping).toBeLessThan(a.damping); // 阻尼加重 = 速度保留系数变小
    // 越界不炸
    expect(convergeTuning(0.06, -3).stiffness).toBeCloseTo(0.06, 9);
    expect(convergeTuning(0.06, 9).stiffness).toBeCloseTo(c.stiffness, 9);
  });

  it('施加向外冲量后第一步位移朝背离质心方向', () => {
    const p: Particle = { ...particles[1] };
    p.x = 10; p.y = 0; p.vx = 0; p.vy = 0; p.tx = 10; p.ty = 0; // 目标=当前，排除弹簧干扰
    applyDisperseImpulse(p, { x: 0, y: 0 } as Pt, () => 0.5); // 随机关掉切向抖动
    stepParticle(p);
    expect(p.x).toBeGreaterThan(10);
    expect(p.y).toBe(0);
  });

  it('径向冲量压过切向抖动，粒子不会被甩向侧面', () => {
    const p: Particle = { ...particles[2] };
    p.x = 0; p.y = 10; p.vx = 0; p.vy = 0; p.tx = 0; p.ty = 10;
    applyDisperseImpulse(p, { x: 0, y: 0 } as Pt, () => 0); // 切向抖动取满
    stepParticle(p);
    expect(p.y).toBeGreaterThan(10); // 径向（向上）为主
    expect(Math.abs(p.x)).toBeLessThan(p.y - 10);
  });
});

describe('时长常量', () => {
  it('阶段顺序成立且总时长克制（不拖沓）', () => {
    const t = INTRO_TIMELINE;
    expect(t.emergeEnd).toBeGreaterThan(0);
    expect(t.holdEnd).toBeGreaterThan(t.emergeEnd);
    expect(t.convergeEnd).toBeGreaterThan(t.holdEnd);
    expect(t.fadeMs).toBeGreaterThan(0);
    expect(INTRO_TOTAL_MS).toBe(t.convergeEnd + t.fadeMs);
    expect(INTRO_TOTAL_MS).toBeLessThanOrEqual(3000);
    // 用户第二轮要求：总时长 2250ms 一点不许变，只重排内部各段
    expect(INTRO_TOTAL_MS).toBe(2250);
  });

  it('节奏是「浮现短、中央停留长、飘散收尾」（用户第二轮指定的结构）', () => {
    const t = INTRO_TIMELINE;
    const emerge = t.emergeEnd;
    const hold = t.holdEnd - t.emergeEnd;
    const converge = t.convergeEnd - t.holdEnd;
    // 浮现只占个零头：大字一开局就在中央，不是慢慢聚拢过来
    expect(emerge).toBeLessThanOrEqual(200);
    // 中央停留是全场最长的一段
    expect(hold).toBeGreaterThan(emerge);
    expect(hold).toBeGreaterThan(converge - INTRO_SWEEP_MS);
    expect(hold).toBeGreaterThan(1000);
    // 上一次被否决的分配：汇聚 800 / 停留 350 / 收拢 900
    expect(emerge).toBeLessThan(800);
    expect(hold).toBeGreaterThan(350);
  });

  it('粒子数下限已导出（太少就不演）', () => {
    expect(INTRO_MIN_POINTS).toBeGreaterThan(100);
  });
});

// 除 reducedMotion 那一条外，其余都必须注入 isReducedMotion: () => false。
// 否则 jsdom 缺 matchMedia，实现会先在"判断不了就不演"处短路，
// 每条断言其实都在验证同一件事 —— 变异检验里就是这么露的馅。
describe('降级路径（宁可不演，也不演砸）', () => {
  let getCtx: CtxSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    getCtx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const noLayer = () => {
    expect(document.querySelector('[data-intro-overlay]')).toBeNull();
    expect(document.body.hasAttribute('data-intro-active')).toBe(false);
  };

  it('prefers-reduced-motion: reduce → 不建层', () => {
    stubWordmark(16, 83);
    getCtx.mockReturnValue(fakeCtx());
    expect(playIntro({ isReducedMotion: () => true })).toBe(false);
    noLayer();
  });

  it('canvas 2d 上下文拿不到 → 不建层', () => {
    stubWordmark(16, 83);
    getCtx.mockReturnValue(null);
    expect(playIntro({ isReducedMotion: () => false })).toBe(false);
    noLayer();
  });

  it('getContext 抛错 → 不建层', () => {
    stubWordmark(16, 83);
    getCtx.mockImplementation(() => { throw new Error('tainted'); });
    expect(() => playIntro({ isReducedMotion: () => false })).not.toThrow();
    expect(playIntro({ isReducedMotion: () => false })).toBe(false);
    noLayer();
  });

  it('采样点数不足 → 不建层', () => {
    stubWordmark(16, 83);
    getCtx.mockReturnValue(fakeCtx());
    const tiny = inkRect(0, 0, 4, 4); // 只有个位数取点
    expect(sampleTextPointCloud(TEXT, tiny).length).toBeLessThan(INTRO_MIN_POINTS);
    expect(playIntro({ rasterize: tiny, isReducedMotion: () => false })).toBe(false);
    noLayer();
  });

  it('量不到字标矩形（jsdom 恒全 0 / 未布局）→ 不建层', () => {
    stubWordmark(0, 0, 0, 0);
    getCtx.mockReturnValue(fakeCtx());
    // 有画布、有点云，唯独落点测不出来：宁可不平移，也不飞到错地方
    expect(playIntro({ rasterize: INK, isReducedMotion: () => false })).toBe(false);
    noLayer();
  });

  it('找不到字标元素 → 不建层', () => {
    getCtx.mockReturnValue(fakeCtx());
    expect(playIntro({ rasterize: INK, isReducedMotion: () => false })).toBe(false);
    noLayer();
  });
});

// 注意：jsdom 没有 matchMedia，实现里"判断不了就当减少动效、不演"，
// 所以这一组必须注入 isReducedMotion: () => false 才能走到播放分支。
describe('完整播放（含交接）', () => {
  let frames: FrameRequestCallback[] = [];
  let clock = 0;
  let getCtx: CtxSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    frames = [];
    clock = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    getCtx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 按固定帧长推进：与实现里的固定步长循环一致，不依赖真实时钟。 */
  function pump(count: number) {
    for (let i = 0; i < count; i++) {
      const batch = frames;
      frames = [];
      if (!batch.length) return;
      clock += 1000 / 60;
      for (const cb of batch) cb(clock);
    }
  }

  it('挂全屏画布到 body、遮住字标，结束后摘除并交还字标', () => {
    const host = stubWordmark(16, 83);
    let done = 0;
    expect(playIntro({ rasterize: INK, random: () => 0.5, isReducedMotion: () => false, onDone: () => { done += 1; } })).toBe(true);

    const canvas = document.querySelector('[data-intro-overlay]') as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.parentElement).toBe(document.body); // 壳根之外：render() 重建也冲不掉
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.getAttribute('role')).toBeNull(); // 不重复播报，字标文字已在 DOM 里
    expect(document.body.hasAttribute('data-intro-active')).toBe(true);

    // 期间顶栏字标被 CSS 让位（opacity 而非 display，坐标才量得到）
    expect(HTML_SRC).toContain('body[data-intro-active] .ui-shell-wordmark { opacity: 0 }');

    // 先跑够 ASSEMBLE + HOLD，粒子应已画在大字上
    pump(60);
    expect(getCtx.mock.results.length).toBeGreaterThan(0);
    const ctx = getCtx.mock.results[0].value as unknown as { calls: { fillRect: number } };
    expect(ctx.calls.fillRect).toBeGreaterThan(INTRO_MIN_POINTS);

    // 跑完全程：交还字标、移除画布
    pump(140);
    expect(document.body.hasAttribute('data-intro-active')).toBe(false);
    expect(document.querySelector('[data-intro-overlay]')).toBeNull();
    expect(done).toBe(1);
    expect(host.isConnected).toBe(true); // 字标元素本身不受影响
  });

  it('开局头几帧大字就已经画在视口中央（不是从全屏各处往里聚）', () => {
    stubWordmark(16, 83);
    expect(playIntro({ rasterize: INK, random: () => 0.5, isReducedMotion: () => false })).toBe(true);
    // 12 帧 ≈ 183ms，刚过浮现段（180ms）。此时粒子若还是全屏撒点，包围盒会是整个视口。
    pump(12);
    const calls = (getCtx.mock.results[0].value as unknown as { calls: { minX: number; maxX: number; minY: number; maxY: number } }).calls;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const expected = pointCloudBBox(layoutBigWord(sampleTextPointCloud(TEXT, INK), { width: vw, height: vh }))!;
    // 颗粒有半径 + 停留期正弦漂移，放宽到 ±4px
    expect((calls.minX + calls.maxX) / 2).toBeCloseTo(vw / 2, -1);
    expect((calls.minY + calls.maxY) / 2).toBeCloseTo(vh / 2, -1);
    expect(calls.maxX - calls.minX).toBeGreaterThan(expected.width - 8);
    expect(calls.maxX - calls.minX).toBeLessThan(expected.width + 8);
    // 反证：全屏撒点的宽度是视口宽（jsdom 1024），远大于大字宽
    expect(calls.maxX - calls.minX).toBeLessThan(vw * 0.9);
  });

  it('动画期间 resize：重算落点继续演，不 abort', () => {
    stubWordmark(16, 83);
    expect(playIntro({ rasterize: INK, random: () => 0.5, isReducedMotion: () => false })).toBe(true);
    pump(30);
    window.dispatchEvent(new Event('resize'));
    pump(140);
    expect(document.querySelector('[data-intro-overlay]')).toBeNull();
    expect(document.body.hasAttribute('data-intro-active')).toBe(false);
  });

  it('字标元素被 shell 重建（横幅挤位）→ 重新量一次落点，不飞到旧坐标', () => {
    const host = stubWordmark(16, 83);
    expect(playIntro({ rasterize: INK, random: () => 0.5, isReducedMotion: () => false })).toBe(true);
    pump(20);
    // 模拟 render() 全量重建：旧元素脱离文档，同 class 的新元素被横幅压低 38px
    host.remove();
    stubWordmark(16, 121);
    pump(104); // 连前面 20 帧共 124 帧 ≈ 2050ms：刚收敛，还没到 2250ms 摘除（再走就淡空了）
    const calls = (getCtx.mock.results[0].value as unknown as { calls: { minY: number; maxY: number } }).calls;
    // 点云墨迹在字标内的纵向偏移是 43/6≈7.2 ~ 173/6≈28.8，落到新字标（top=121）应 ≈128~150；
    // 若照旧坐标收敛则是 90~112 —— 这条断言锁死"跟着新位置走"
    expect(calls.minY).toBeGreaterThan(123);
    expect(calls.minY).toBeLessThan(132);
    expect(calls.maxY).toBeGreaterThan(146);
    expect(calls.maxY).toBeLessThan(156);
    pump(40);
    expect(document.querySelector('[data-intro-overlay]')).toBeNull();
    expect(document.body.hasAttribute('data-intro-active')).toBe(false);
  });

  it('字标一直在（没被重建）时，收拢落点就是开演时量的那个矩形', () => {
    stubWordmark(16, 83);
    expect(playIntro({ rasterize: INK, random: () => 0.5, isReducedMotion: () => false })).toBe(true);
    pump(124);
    const calls = (getCtx.mock.results[0].value as unknown as { calls: { minY: number; maxY: number } }).calls;
    // 83 + 7.2 - 0.675 ≈ 89.5，83 + 28.8 + 0.675 ≈ 112.5
    expect(calls.minY).toBeGreaterThan(85);
    expect(calls.minY).toBeLessThan(93);
    expect(calls.maxY).toBeGreaterThan(107);
    expect(calls.maxY).toBeLessThan(117);
  });
});

describe('用户否决过的东西不许回来', () => {
  it('进场层没有进度条、没有跳过按钮', () => {
    // 只扫英文标识符：中文注释里会提到"没有进度条/跳过按钮"是刻意写下的约束说明
    expect(INTRO_SRC).not.toMatch(/progress/i);
    expect(INTRO_SRC).not.toMatch(/skip/i);
    expect(HTML_SRC).not.toMatch(/ui-shell-intro-(progress|skip)/);
  });

  it('大字是画出来的粒子，不是整块文字元素', () => {
    expect(INTRO_SRC).toContain('fillRect'); // 方块颗粒
    expect(INTRO_SRC).toContain('sampleTextPointCloud');
    expect(INTRO_SRC).not.toContain('intro-title'); // 上一版那块 textContent 大字
  });

  it('app.ts 在 shell.render() 之后才挂载（字标得先存在才量得到坐标）', () => {
    // 用 lastIndexOf 而不是 indexOf：文件顶部还有一句 import { playIntro }
    expect(APP_SRC).toContain('playIntro');
    expect(APP_SRC.indexOf('shell.render()')).toBeLessThan(APP_SRC.lastIndexOf('playIntro('));
  });
});
