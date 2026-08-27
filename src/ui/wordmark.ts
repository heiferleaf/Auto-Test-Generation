/** 顶栏点阵字标：「测试步骤中台」。jsdom / 减少动效时只留文字，不跑动画。 */

export const WORDMARK_TEXT = '测试步骤中台';

type Dot = { x: number; y: number; ox: number; oy: number };

function reducedMotion(): boolean {
  try {
    if (typeof matchMedia !== 'function') return true;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

export function mountWordmark(host: HTMLElement): void {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-wordmark-canvas', 'true');
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const cssH = 36;
  const cssW = 248;
  const dpr = 2;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dots = sampleGlyphDots(ctx, canvas.width, canvas.height);
  if (dots.length < 12) return;
  host.setAttribute('data-wordmark-live', 'true');

  if (reducedMotion()) {
    paintDots(ctx, canvas, dots);
    return;
  }

  let mx = -999;
  let my = -999;
  let raf = 0;
  const tick = () => {
    for (const d of dots) {
      const dx = d.ox - mx;
      const dy = d.oy - my;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 36) {
        const force = (1 - dist / 36) * 12;
        d.x = d.ox + (dx / dist) * force;
        d.y = d.oy + (dy / dist) * force;
      } else {
        d.x += (d.ox - d.x) * 0.2;
        d.y += (d.oy - d.y) * 0.2;
      }
    }
    paintDots(ctx, canvas, dots);
    raf = requestAnimationFrame(tick);
  };
  host.addEventListener('pointermove', (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    mx = (e.clientX - r.left) * (canvas.width / r.width);
    my = (e.clientY - r.top) * (canvas.height / r.height);
  });
  host.addEventListener('pointerleave', () => {
    mx = -999;
    my = -999;
  });
  raf = requestAnimationFrame(tick);
  host.addEventListener('remove', () => cancelAnimationFrame(raf), { once: true });
}

function sampleGlyphDots(ctx: CanvasRenderingContext2D, w: number, h: number): Dot[] {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(h * 0.62)}px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(WORDMARK_TEXT, 10, h / 2 + 1);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return [];
  }
  const dots: Dot[] = [];
  const step = 3;
  for (let y = 1; y < h; y += step) {
    for (let x = 1; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > 90) dots.push({ x, y, ox: x, oy: y });
    }
  }
  ctx.clearRect(0, 0, w, h);
  return dots;
}

function paintDots(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dots: Dot[]): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(212,212,216,.92)';
  for (const d of dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, 1.35, 0, Math.PI * 2);
    ctx.fill();
  }
}
