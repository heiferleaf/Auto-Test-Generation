/**
 * 顶栏品牌字进场动画：开场把「测试步骤中台」放大居中，配一条装饰进度条，
 * 走完后缩小平移回顶栏字标的位置与状态。
 *
 * 两条设计底线：
 * 1. **不撒谎**：进度条不反映真实加载进度（页面没有可等待的资源），
 *    它是固定时长的装饰动画。所以不给它百分比语义，也不接任何资源钩子。
 * 2. **不重播**：UiShell.render() 首行 innerHTML='' 全量重建，且有 34 处调用点
 *    （连接变化、插入步骤、选中步骤都会触发）。因此"播没播过"必须存在
 *    UiShell 实例字段上，不能靠 DOM 节点是否存在来判断。
 */

import { WORDMARK_TEXT } from './wordmark';

/** 进度阶段：进度条从 0 走到 100。 */
export const INTRO_PROGRESS_MS = 900;
/** 收敛阶段：文字缩小平移回顶栏。与 CSS 里的 transform 过渡时长保持一致。 */
export const INTRO_SETTLE_MS = 460;
/**
 * 进度推进步长。进度由 JS 推进（不是 CSS animation），
 * 因为 render() 会重建进场层：只有把进度存在实例上按已耗时推算，
 * 中途重建才不会把进度条弹回 0。CSS 只负责 transform 过渡。
 */
export const INTRO_TICK_MS = 60;

export type IntroPhase = 'opening' | 'settling';

export function prefersReducedMotion(): boolean {
  try {
    if (typeof matchMedia !== 'function') return true;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // 取不到偏好时按"减少动效"处理，宁可不动也不要晕。
    return true;
  }
}

/**
 * 算收敛落点：顶栏字标相对壳根左上角的实际坐标。
 *
 * 不能写死常量。顶栏之上可能压着横幅（演示模式提示 / 录制中 / 运行失败提醒），
 * 横幅有就有、没有就没有，高度还不固定（文案换行会变高）。曾按
 * "壳根 padding + 顶栏 padding" 算出固定 27px，实测字标却在 83px，
 * 动画末尾会朝上一个不存在的位置收敛，落点和字标对不上。
 * 所以改成收尾前量一次真实位置，写进 CSS 变量交给过渡去用。
 *
 * 量不到（jsdom / 未布局）时返回 null：调用方退回"原地淡出"，
 * 宁可不平移也不能平移到错地方。
 */
export function measureWordmarkLanding(
  layerRoot: HTMLElement,
  wordmark: HTMLElement | null,
): { x: number; y: number } | null {
  if (!wordmark) return null;
  const rootBox = layerRoot.getBoundingClientRect();
  const wmBox = wordmark.getBoundingClientRect();
  // 未布局时两边都是全 0（jsdom 恒如此），不能拿 0 当有效坐标。
  if (!wmBox.width || !wmBox.height) return null;
  return {
    x: Math.round(wmBox.left - rootBox.left),
    y: Math.round(wmBox.top - rootBox.top),
  };
}

/**
 * 建进场层。调用方负责在收敛结束后把它摘掉。
 * phase 决定 CSS 的 transform 目标态；进度条宽度由 CSS animation 推进，
 * 这里只把关键节点打进 data 属性，方便测试断言语义而非像素。
 */
export function renderIntroLayer(phase: IntroPhase, progress: number): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'ui-shell-intro';
  layer.setAttribute('data-intro', 'true');
  layer.setAttribute('data-intro-state', phase);
  layer.setAttribute('role', 'status');
  layer.setAttribute('aria-label', `${WORDMARK_TEXT} 正在进入`);

  const title = document.createElement('div');
  title.className = 'ui-shell-intro-title';
  title.setAttribute('data-intro-title', 'true');
  title.textContent = WORDMARK_TEXT;
  layer.appendChild(title);

  const track = document.createElement('div');
  track.className = 'ui-shell-intro-track';
  const fill = document.createElement('div');
  fill.className = 'ui-shell-intro-fill';
  fill.setAttribute('data-intro-progress', 'true');
  track.appendChild(fill);
  layer.appendChild(track);

  const skip = document.createElement('button');
  skip.className = 'ui-shell-intro-skip';
  skip.setAttribute('data-intro-skip', 'true');
  skip.setAttribute('type', 'button');
  skip.textContent = '跳过';
  layer.appendChild(skip);

  applyIntroProgress(layer, progress);
  return layer;
}

/**
 * 把进度写进进场层：data 属性与视觉宽度同一个来源，不允许分家
 * （分家的后果是"属性说 80%、眼睛看到 10%"这类撒谎式进度）。
 */
export function applyIntroProgress(layer: HTMLElement, progress: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const fill = layer.querySelector('[data-intro-progress]') as HTMLElement | null;
  if (!fill) return;
  fill.setAttribute('data-intro-progress', String(pct));
  fill.style.width = `${pct}%`;
}
