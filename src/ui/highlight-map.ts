// 预览舞台高亮坐标映射。
// locateVisual 给的是 CSS 视口像素；截图通常是设备像素（DPR），舞台 <img> 又是 object-fit:contain。
// 直接把 boundingBox 当 overlay 的 left/top 会完全对不齐。本模块只做纯函数换算。

export type CssBox = { x: number; y: number; width: number; height: number };

export type ViewportSize = {
  width: number;
  height: number;
};

export type ImgLayout = {
  naturalWidth: number;
  naturalHeight: number;
  clientWidth: number;
  clientHeight: number;
};

/**
 * 把 CSS 视口里的元素框映射到舞台 img 的 overlay 坐标（相对 img 左上角）。
 * object-fit:contain：等比缩放居中，上下或左右可能有 letterbox。
 */
export function mapHighlightRect(box: CssBox, viewport: ViewportSize, img: ImgLayout): CssBox {
  const vw = viewport.width;
  const vh = viewport.height;
  if (!vw || !vh || !img.naturalWidth || !img.naturalHeight || !img.clientWidth || !img.clientHeight) {
    return box;
  }
  const contain = Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
  const dispW = img.naturalWidth * contain;
  const dispH = img.naturalHeight * contain;
  const ox = (img.clientWidth - dispW) / 2;
  const oy = (img.clientHeight - dispH) / 2;
  const sx = (img.naturalWidth / vw) * contain;
  const sy = (img.naturalHeight / vh) * contain;
  return {
    x: ox + box.x * sx,
    y: oy + box.y * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

/** 从 VisualRect 可选字段取出视口；缺省时用 dpr 反推（截图像素 / dpr ≈ CSS 视口）。 */
export function viewportFromRect(
  rect: { viewportWidth?: number; viewportHeight?: number; devicePixelRatio?: number },
  img: ImgLayout,
): ViewportSize {
  const r = rect ?? {};
  if (r.viewportWidth && r.viewportHeight) {
    return { width: r.viewportWidth, height: r.viewportHeight };
  }
  const dpr = r.devicePixelRatio && r.devicePixelRatio > 0 ? r.devicePixelRatio : 1;
  return {
    width: img.naturalWidth / dpr,
    height: img.naturalHeight / dpr,
  };
}
