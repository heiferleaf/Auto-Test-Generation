// 开场粒子进场：大号品牌字由像素颗粒汇聚而成，再飘散、收拢到顶栏字标的真实位置。
//
// 四条硬约束（用户逐字提的验收标准，改动前先读）：
//   1. 大字必须是粒子（像素颗粒）组成的，不是一整块文字元素，也不是 transform 缩放平移；
//   2. 没有进度条；
//   3. 没有跳过按钮；
//   4. 归位是「先炸开再收拢」的飘散，不是生硬的线性过渡。
//
// 挂在 document.body 而不是壳根：UiShell.render() 首行 innerHTML='' 全量重建，
// 34 处调用点（连接变化、插入步骤、选中步骤）都会触发。挂壳内只能靠实例字段记"播没播过"
// 来防重播，挂 body 之外则整类 bug 不存在。
//
// 落点由实测的 .ui-shell-wordmark 矩形换算，量不到就整个不演——宁可不平移，也不飞到错地方。

import { WORDMARK_TEXT } from './wordmark';

// ---- 顶栏字标几何（与 wordmark.ts 一一对应，落点换算依赖这些值）----
const WORD_CSS_W = 248;
const WORD_CSS_H = 36;
const WORD_DPR = 2;
/** 超采样倍数：顶栏画布太小（496×72），直接取点不够铺满大字，放大 3 倍再采样。 */
export const INTRO_SUPERSAMPLE = 3;
export const INTRO_RASTER_W = WORD_CSS_W * WORD_DPR * INTRO_SUPERSAMPLE; // 1488
export const INTRO_RASTER_H = WORD_CSS_H * WORD_DPR * INTRO_SUPERSAMPLE; // 216
/** 点云坐标 → 相对字标左上角的 CSS 偏移，除数恒为 dpr × 超采样。 */
const LANDING_DIVISOR = WORD_DPR * INTRO_SUPERSAMPLE; // 6

// ---- 采样 ----
// 步长实测（Chromium，1488×216 超采样，「测试步骤中台」6 字）：step3 → 6157 颗，
// step4 → 3482 颗，step5 → 2225 颗。取 4：颗粒够多撑得起字形，而大字下间距
// 5.2 CSS px 明显大于颗粒边长 3.2 px —— 看得见一颗颗，不糊成实心块。
export const INTRO_SAMPLE_STEP = 4;
const INTRO_ALPHA_MIN = 90;
/** 少于这个数就说明文字没画出来（字体缺失、画布异常），按"不演"处理。 */
export const INTRO_MIN_POINTS = 200;

// ---- 时间轴（ms）----
export const INTRO_TIMELINE = {
  assembleEnd: 800, // 汇聚成大字
  holdEnd: 1150, // 大字停留，轻微呼吸
  convergeEnd: 2050, // 飘散 + 收拢到字标
  fadeMs: 200, // 画布淡出 / 字标淡入
} as const;
export const INTRO_TOTAL_MS = INTRO_TIMELINE.convergeEnd + INTRO_TIMELINE.fadeMs;

// ---- 运动 ----
export const INTRO_DAMPING = 0.86;
const INTRO_STIFFNESS_MIN = 0.04;
const INTRO_STIFFNESS_MAX = 0.1;
// 收拢末段把弹簧拧硬、阻尼加重。原因：大字到顶栏有 700px 之遥，常量刚度下最晚起飞的那颗
// （扫掠 +180ms，只剩 43 帧）到 2050ms 还差 20px 上下没到位 —— 真机 Chromium 实测粒子云
// 比顶栏字标虚胖 42px。按进度平方加强后残差 < 1px；而冲量造成的外扩弧线发生在进度早期
// （刚度还软），飘散的手感不受影响。
const INTRO_STIFFNESS_END = 0.2;
const INTRO_DAMPING_END = 0.45;
// 飘散径向冲量（px/帧）。实测 43 帧内残差几乎与冲量无关（末段硬弹簧会全部吸收），
// 所以取大值换观感：imp=9 只外扩 20~26px（几乎看不出炸开），imp=26 外扩 52~75px，
// 落点残差仍是 0.74px。大字宽 1040px，外扩 60px 约 6%，是"飘散"而非"抖动"。
const INTRO_IMPULSE = 26;
const INTRO_TANGENT = 3; // 切向抖动幅度，让炸开不是规整的放射线
const INTRO_BIG_RADIUS = 1.6; // 大字状态下颗粒的半边长（CSS px），留缝才看得见一颗颗
const INTRO_LAND_RADIUS = 0.675; // 落到顶栏时的半边长（= wordmark.ts 的 1.35 设备像素 @dpr2）
const INTRO_SWEEP_MS = 180; // 飘散按 x 坐标左→右扫掠错峰
const INTRO_DELAY_MAX = 350; // 起飞错峰，形成"流入汇聚"而非整体位移
const INTRO_FADE_IN_MS = 220; // 单颗粒子淡入
const INTRO_BREATH_PX = 1.2; // HOLD 期间的漂移幅度
const FRAME_MS = 1000 / 60;
const MAX_CATCHUP_MS = 100; // 切后台回来别一次性补上百帧

// ---- 大字尺寸上限 ----
const BIG_MAX_W_RATIO = 0.8;
const BIG_MAX_W_PX = 1040;
const BIG_MAX_H_RATIO = 0.45;
const BIG_MAX_H_PX = 300;

export type Pt = { x: number; y: number };
export type BBox = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
/** 栅格化 seam：注入后纯几何逻辑可在无 canvas 的环境（node/jsdom）下验证。 */
export type Rasterizer = (text: string, width: number, height: number) => Uint8ClampedArray | null;

export type Particle = Pt & {
  vx: number;
  vy: number;
  k: number; // 弹簧刚度，每颗不同 → 到达时间错开
  tx: number; // 当前目标
  ty: number;
  delay: number; // 起飞延迟
  disperseAt: number; // 开始飘散的时刻（左→右扫掠）
  phase: number; // 呼吸相位
  impulsed: boolean;
  i: number; // 在点云中的下标，用于查大字/落点
};

/** 取文字位图的点云。栅格化器可注入，返回 null 视为"栅格化失败"。 */
export function sampleTextPointCloud(text: string, rasterize: Rasterizer, step = INTRO_SAMPLE_STEP): Pt[] {
  const data = rasterize(text, INTRO_RASTER_W, INTRO_RASTER_H);
  if (!data) return [];
  const w = INTRO_RASTER_W;
  const h = INTRO_RASTER_H;
  const pts: Pt[] = [];
  for (let y = 1; y < h; y += step) {
    for (let x = 1; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > INTRO_ALPHA_MIN) pts.push({ x, y });
    }
  }
  return pts;
}

export function pointCloudBBox(points: Pt[]): BBox | null {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 把点云等比放大成大字，整体居中于视口。宽高比不变是关键——拉伸了就不是同一个字。 */
export function layoutBigWord(points: Pt[], viewport: { width: number; height: number }): Pt[] {
  const box = pointCloudBBox(points);
  if (!box) return points.map((p) => ({ x: p.x, y: p.y }));
  const maxW = Math.min(viewport.width * BIG_MAX_W_RATIO, BIG_MAX_W_PX);
  const maxH = Math.min(viewport.height * BIG_MAX_H_RATIO, BIG_MAX_H_PX);
  const scale = Math.min(maxW / (box.width || 1), maxH / (box.height || 1));
  const ox = (viewport.width - box.width * scale) / 2 - box.minX * scale;
  const oy = (viewport.height - box.height * scale) / 2 - box.minY * scale;
  return points.map((p) => ({ x: p.x * scale + ox, y: p.y * scale + oy }));
}

/** 落点：点云坐标按顶栏字标的真实几何反算成视口 CSS 坐标。 */
export function computeLanding(points: Pt[], rect: { left: number; top: number }): Pt[] {
  return points.map((p) => ({
    x: rect.left + p.x / LANDING_DIVISOR,
    y: rect.top + p.y / LANDING_DIVISOR,
  }));
}

export interface ParticleSeed {
  big: Pt[];
  landing: Pt[];
  viewport: { width: number; height: number };
  random?: () => number;
}

export function createParticles(seed: ParticleSeed): Particle[] {
  const rnd = seed.random ?? Math.random;
  const big = seed.big;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of big) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const spanX = maxX - minX || 1;
  const parts: Particle[] = [];
  for (let i = 0; i < big.length; i++) {
    parts.push({
      i,
      // 起飞点散落在整个视口：汇聚时才看得出"从四面流进来"
      x: rnd() * seed.viewport.width,
      y: rnd() * seed.viewport.height,
      vx: 0,
      vy: 0,
      k: INTRO_STIFFNESS_MIN + rnd() * (INTRO_STIFFNESS_MAX - INTRO_STIFFNESS_MIN),
      tx: big[i].x,
      ty: big[i].y,
      delay: rnd() * INTRO_DELAY_MAX,
      disperseAt: INTRO_TIMELINE.holdEnd + ((big[i].x - minX) / spanX) * INTRO_SWEEP_MS,
      phase: rnd() * Math.PI * 2,
      impulsed: false,
    });
  }
  // 按起飞时间排序后绘制：alpha 沿数组单调，fillStyle 切换次数从「每颗一次」降到「每档一次」
  return parts.sort((a, b) => a.delay - b.delay);
}

/** 带阻尼的弹簧步进。不是线性插值——过冲再回弹才是"飘"的手感。 */
export function stepParticle(p: Particle, stiffness = p.k, damping = INTRO_DAMPING): void {
  const ax = (p.tx - p.x) * stiffness;
  const ay = (p.ty - p.y) * stiffness;
  p.vx = (p.vx + ax) * damping;
  p.vy = (p.vy + ay) * damping;
  p.x += p.vx;
  p.y += p.vy;
}

/**
 * 收拢段的刚度/阻尼：随进度平方加强。q=0 时就是常量（冲量刚打出去，要软才有弧线），
 * q=1 时拧到最硬（拉得住，收得准）。q 由调用方按每颗粒子自己的飘散时刻算。
 */
export function convergeTuning(k: number, q: number): { stiffness: number; damping: number } {
  const e = Math.min(1, Math.max(0, q)) ** 2;
  return {
    stiffness: k + (INTRO_STIFFNESS_END - k) * e,
    damping: INTRO_DAMPING + (INTRO_DAMPING_END - INTRO_DAMPING) * e,
  };
}

/** 背离质心的径向冲量 + 随机切向抖动：配合弹簧就是"先炸开再收拢"的弧线。 */
export function applyDisperseImpulse(p: Particle, centroid: Pt, random: () => number = Math.random): void {
  const dx = p.x - centroid.x;
  const dy = p.y - centroid.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  const radial = INTRO_IMPULSE * (0.6 + random() * 0.8);
  const tangent = (random() - 0.5) * INTRO_TANGENT;
  p.vx += nx * radial - ny * tangent;
  p.vy += ny * radial + nx * tangent;
}

function centroidOf(points: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

/** 默认栅格化器：与 wordmark.ts 的取样同源，只是分辨率放大 INTRO_SUPERSAMPLE 倍。 */
function defaultRasterize(text: string, w: number, h: number): Uint8ClampedArray | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const s = h / (WORD_CSS_H * WORD_DPR); // 起笔 x=10、基线 +1 都按同一倍数放大，保证形状与顶栏一致
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(h * 0.62)}px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10 * s, h / 2 + s);
  try {
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 画布被污染等：返回 null，调用方按"不演"处理
  }
}

function defaultReducedMotion(): boolean {
  try {
    if (typeof matchMedia !== 'function') return true;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true; // 判断不了就当"减少动效"，不演
  }
}

export interface IntroOptions {
  doc?: Document;
  rasterize?: Rasterizer;
  isReducedMotion?: () => boolean;
  random?: () => number;
  onDone?: () => void;
}

/** 播放开场动画。返回 false 表示走了某条降级路径（不建层、不抛错）。 */
export function playIntro(options: IntroOptions = {}): boolean {
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document);
  if (!doc || !doc.body) return false;
  const random = options.random ?? Math.random;
  const reducedMotion = options.isReducedMotion ?? defaultReducedMotion;
  if (reducedMotion()) return false;

  let mark: HTMLElement | null = doc.querySelector<HTMLElement>('.ui-shell-wordmark');
  if (!mark) return false;
  const measured = mark.getBoundingClientRect();
  // 量不到（jsdom 恒全 0、页面未布局）就不演：硬猜坐标只会让粒子飞到一个不存在的位置
  if (!measured || !measured.width || !measured.height) return false;

  // 先建离屏画布拿上下文，拿不到就到此为止，页面上不会留下任何痕迹
  const canvas = doc.createElement('canvas');
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return false;

  const points = sampleTextPointCloud(WORDMARK_TEXT, options.rasterize ?? defaultRasterize);
  if (points.length < INTRO_MIN_POINTS) return false;

  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const dpr = Math.min(3, Math.max(1, win.devicePixelRatio || 1));
  let vw = win.innerWidth || WORD_CSS_W * 4;
  let vh = win.innerHeight || WORD_CSS_H * 8;

  let big = layoutBigWord(points, { width: vw, height: vh });
  let landing = computeLanding(points, measured);
  let centroid = centroidOf(big);
  const particles = createParticles({ big, landing, viewport: { width: vw, height: vh }, random });

  const resizeCanvas = () => {
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
  };
  resizeCanvas();
  canvas.className = 'ui-shell-intro-canvas';
  canvas.setAttribute('data-intro-overlay', 'true');
  canvas.setAttribute('aria-hidden', 'true'); // 字标文字本身已在 DOM 里，重复播报是噪音
  doc.body.appendChild(canvas);
  doc.body.setAttribute('data-intro-active', '1');

  // 顶栏字标可能被 render() 重建（连接失败会压横幅，位置会变），脱文档时重量一次落点
  const remeasure = () => {
    const el = doc.querySelector<HTMLElement>('.ui-shell-wordmark');
    if (!el) return;
    mark = el;
    const r = el.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    landing = computeLanding(points, r);
  };

  const onResize = () => {
    vw = win.innerWidth || vw;
    vh = win.innerHeight || vh;
    resizeCanvas();
    big = layoutBigWord(points, { width: vw, height: vh });
    centroid = centroidOf(big);
    remeasure();
  };
  win.addEventListener('resize', onResize);

  let elapsed = 0;
  let handedOff = false;
  let finished = false;
  let raf = 0;
  let last = -1;
  let acc = 0;

  const tick = () => {
    elapsed += FRAME_MS;
    const t = INTRO_TIMELINE;
    // 顶栏字标可能被 render() 重建（连接失败压横幅、插入步骤都会触发），新元素位置会变。
    // 每帧查一次 isConnected（纯属性读取，不触发重排），脱文档就重新量一次落点。
    // 少了这一步，粒子会照着旧坐标收拢 —— 上一版就是这么飞的。
    if (mark && !mark.isConnected) remeasure();
    for (const p of particles) {
      if (elapsed < p.delay) continue;
      if (!p.impulsed && elapsed >= p.disperseAt) {
        p.impulsed = true;
        applyDisperseImpulse(p, centroid, random);
      }
      let tuning: { stiffness: number; damping: number } | null = null;
      if (p.impulsed) {
        p.tx = landing[p.i].x;
        p.ty = landing[p.i].y;
        tuning = convergeTuning(p.k, (elapsed - p.disperseAt) / Math.max(1, t.convergeEnd - p.disperseAt));
      } else if (elapsed >= t.assembleEnd) {
        // 停留期：目标不动，叠一点正弦漂移，免得整块字僵住
        const w = (elapsed - t.assembleEnd) / 90 + p.phase;
        p.tx = big[p.i].x + Math.cos(w) * INTRO_BREATH_PX;
        p.ty = big[p.i].y + Math.sin(w) * INTRO_BREATH_PX;
      } else {
        p.tx = big[p.i].x;
        p.ty = big[p.i].y;
      }
      if (tuning) stepParticle(p, tuning.stiffness, tuning.damping);
      else stepParticle(p);
    }
  };

  const draw = () => {
    const c = ctx as CanvasRenderingContext2D;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, vw, vh);
    const t = INTRO_TIMELINE;
    const fade = elapsed <= t.convergeEnd ? 1 : Math.max(0, 1 - (elapsed - t.convergeEnd) / t.fadeMs);
    if (fade <= 0) return;
    const raw = Math.min(1, Math.max(0, (elapsed - t.holdEnd) / Math.max(1, t.convergeEnd - t.holdEnd)));
    const shrink = raw * raw * (3 - 2 * raw); // smoothstep：末段收得柔和
    const r = INTRO_BIG_RADIUS + (INTRO_LAND_RADIUS - INTRO_BIG_RADIUS) * shrink;
    const d = r * 2;
    let bucket = -1;
    for (const p of particles) {
      const age = (elapsed - p.delay) / INTRO_FADE_IN_MS;
      if (age <= 0) continue;
      const a = Math.round((age >= 1 ? fade : fade * age) * 24);
      if (a <= 0) continue;
      if (a !== bucket) {
        c.fillStyle = `rgba(212,212,216,${a / 24})`;
        bucket = a;
      }
      // 方块而非 arc：更快，而且方块才像"像素颗粒"
      c.fillRect(p.x - r, p.y - r, d, d);
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (raf) win.cancelAnimationFrame(raf);
    win.removeEventListener('resize', onResize);
    canvas.remove();
    options.onDone?.();
  };

  const frame = (now: number) => {
    if (last < 0) last = now;
    acc += Math.min(Math.max(now - last, 0), MAX_CATCHUP_MS);
    last = now;
    // 固定步长推进：120Hz 屏不会把 2.25s 的动画压成 1.1s
    while (acc >= FRAME_MS) {
      acc -= FRAME_MS;
      tick();
      if (!handedOff && elapsed >= INTRO_TIMELINE.convergeEnd) {
        handedOff = true;
        // 交还字标：CSS 里 .ui-shell-wordmark 有 200ms opacity 过渡，与画布淡出同步
        doc.body.removeAttribute('data-intro-active');
      }
    }
    draw();
    if (elapsed >= INTRO_TOTAL_MS) {
      finish();
      return;
    }
    raf = win.requestAnimationFrame(frame);
  };
  raf = win.requestAnimationFrame(frame);
  return true;
}
