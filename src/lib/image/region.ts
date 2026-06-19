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
