import type { Region } from "@/lib/image/region";

export type DisplayLayout = {
  scale: number;
  displayW: number;
  displayH: number;
  offsetX: number;
  offsetY: number;
  /** 뷰포트 기준 이미지 콘텐츠 영역 좌상단 */
  originX: number;
  originY: number;
};

export function getObjectContainLayout(
  contentW: number,
  contentH: number,
  naturalW: number,
  naturalH: number,
): Pick<DisplayLayout, "scale" | "displayW" | "displayH" | "offsetX" | "offsetY"> {
  if (contentW <= 0 || contentH <= 0 || naturalW <= 0 || naturalH <= 0) {
    return { scale: 1, displayW: 0, displayH: 0, offsetX: 0, offsetY: 0 };
  }

  const scale = Math.min(contentW / naturalW, contentH / naturalH);
  const displayW = naturalW * scale;
  const displayH = naturalH * scale;

  return {
    scale,
    displayW,
    displayH,
    offsetX: (contentW - displayW) / 2,
    offsetY: (contentH - displayH) / 2,
  };
}

export function measureElementDisplayLayout(
  element: HTMLElement,
  naturalW: number,
  naturalH: number,
): DisplayLayout {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const padL = Number.parseFloat(style.paddingLeft) || 0;
  const padR = Number.parseFloat(style.paddingRight) || 0;
  const padT = Number.parseFloat(style.paddingTop) || 0;
  const padB = Number.parseFloat(style.paddingBottom) || 0;

  const contentW = rect.width - padL - padR;
  const contentH = rect.height - padT - padB;
  const inner = getObjectContainLayout(contentW, contentH, naturalW, naturalH);

  return {
    ...inner,
    originX: rect.left + padL,
    originY: rect.top + padT,
  };
}

export function measureLocalDisplayLayout(
  element: HTMLElement,
  naturalW: number,
  naturalH: number,
): DisplayLayout & { padL: number; padT: number } {
  const style = getComputedStyle(element);
  const padL = Number.parseFloat(style.paddingLeft) || 0;
  const padR = Number.parseFloat(style.paddingRight) || 0;
  const padT = Number.parseFloat(style.paddingTop) || 0;
  const padB = Number.parseFloat(style.paddingBottom) || 0;

  const contentW = element.clientWidth - padL - padR;
  const contentH = element.clientHeight - padT - padB;
  const inner = getObjectContainLayout(contentW, contentH, naturalW, naturalH);

  const rect = element.getBoundingClientRect();

  return {
    ...inner,
    originX: rect.left + padL,
    originY: rect.top + padT,
    padL,
    padT,
  };
}

export function clientToNatural(
  clientX: number,
  clientY: number,
  layout: DisplayLayout,
  naturalW: number,
  naturalH: number,
): { x: number; y: number } | null {
  const localX = clientX - layout.originX;
  const localY = clientY - layout.originY;
  const naturalX = (localX - layout.offsetX) / layout.scale;
  const naturalY = (localY - layout.offsetY) / layout.scale;

  if (naturalX < 0 || naturalY < 0 || naturalX > naturalW || naturalY > naturalH) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(naturalX, naturalW)),
    y: Math.max(0, Math.min(naturalY, naturalH)),
  };
}

export function regionToLocalStyle(
  region: Region,
  layout: Pick<DisplayLayout, "scale" | "offsetX" | "offsetY">,
  padL = 0,
  padT = 0,
): { left: number; top: number; width: number; height: number } {
  return {
    left: padL + layout.offsetX + region.x * layout.scale,
    top: padT + layout.offsetY + region.y * layout.scale,
    width: region.width * layout.scale,
    height: region.height * layout.scale,
  };
}
