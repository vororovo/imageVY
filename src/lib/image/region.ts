export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function clampRegion(
  region: Region,
  naturalW: number,
  naturalH: number,
): Region {
  const x1 = Math.max(0, Math.min(region.x, naturalW));
  const y1 = Math.max(0, Math.min(region.y, naturalH));
  const x2 = Math.max(0, Math.min(region.x + region.width, naturalW));
  const y2 = Math.max(0, Math.min(region.y + region.height, naturalH));
  return {
    x: Math.round(Math.min(x1, x2)),
    y: Math.round(Math.min(y1, y2)),
    width: Math.round(Math.max(1, Math.abs(x2 - x1))),
    height: Math.round(Math.max(1, Math.abs(y2 - y1))),
  };
}

/** 탐지된 워터마크 주변에 UI용 여유 패딩을 더합니다. */
export function padRegionAroundMatch(
  match: Region,
  imageWidth: number,
  imageHeight: number,
  padding?: number,
): Region {
  const base = Math.min(match.width, match.height);
  const pad = padding ?? Math.max(16, Math.round(base * 0.3));
  return clampRegion(
    {
      x: match.x - pad,
      y: match.y - pad,
      width: match.width + pad * 2,
      height: match.height + pad * 2,
    },
    imageWidth,
    imageHeight,
  );
}

export function regionFromMatch(
  x: number,
  y: number,
  size: number,
  imageWidth: number,
  imageHeight: number,
): Region {
  return clampRegion({ x, y, width: size, height: size }, imageWidth, imageHeight);
}
