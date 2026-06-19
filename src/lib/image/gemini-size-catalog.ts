/**
 * Gemini/나노바나나 워터마크 규격 카탈로그
 * GargantuaX/gemini-watermark-remover geminiSizeCatalog.js 기반 (MIT)
 */

export type GeminiWatermarkConfig = {
  logoSize: number;
  marginRight: number;
  marginBottom: number;
  alphaVariant?: string;
};

const TIER_48: GeminiWatermarkConfig = {
  logoSize: 48,
  marginRight: 32,
  marginBottom: 32,
};

const TIER_96: GeminiWatermarkConfig = {
  logoSize: 96,
  marginRight: 64,
  marginBottom: 64,
};

const LARGE_MARGIN_48: GeminiWatermarkConfig = {
  logoSize: 48,
  marginRight: 96,
  marginBottom: 96,
};

const NEW_MARGIN_96: GeminiWatermarkConfig = {
  logoSize: 96,
  marginRight: 192,
  marginBottom: 192,
  alphaVariant: "96-20260520",
};

type OfficialEntry = {
  width: number;
  height: number;
  config: GeminiWatermarkConfig;
  legacy?: GeminiWatermarkConfig;
  /** 1k 공식 해상도에만 48px 대마진·36-v2 후보 추가 */
  include1kVariants?: boolean;
};

/** 자주 쓰이는 공식 출력 해상도 */
const OFFICIAL_ENTRIES: OfficialEntry[] = [
  { width: 1024, height: 1024, config: TIER_48, legacy: TIER_96, include1kVariants: true },
  { width: 1376, height: 768, config: TIER_48, legacy: TIER_96, include1kVariants: true },
  { width: 768, height: 1376, config: TIER_48, legacy: TIER_96, include1kVariants: true },
  { width: 1408, height: 768, config: { logoSize: 46, marginRight: 32, marginBottom: 32 } },
  { width: 1264, height: 848, config: TIER_48 },
  { width: 848, height: 1264, config: TIER_48 },
  { width: 1344, height: 768, config: TIER_96 },
  { width: 1248, height: 832, config: TIER_96 },
  { width: 832, height: 1248, config: TIER_96 },
  { width: 2048, height: 2048, config: TIER_96 },
  { width: 2752, height: 1536, config: TIER_96 },
  { width: 1536, height: 2752, config: TIER_96 },
  { width: 2816, height: 1536, config: NEW_MARGIN_96 },
  { width: 512, height: 512, config: TIER_48 },
  { width: 688, height: 384, config: TIER_48 },
  { width: 384, height: 688, config: TIER_48 },
];

const OFFICIAL_INDEX = new Map<string, OfficialEntry>(
  OFFICIAL_ENTRIES.map((e) => [`${e.width}x${e.height}`, e]),
);

function configKey(c: GeminiWatermarkConfig): string {
  return `${c.logoSize}:${c.marginRight}:${c.marginBottom}:${c.alphaVariant ?? ""}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function addConfig(
  list: GeminiWatermarkConfig[],
  seen: Set<string>,
  config: GeminiWatermarkConfig,
): void {
  const key = configKey(config);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(config);
}

function getDefaultConfig(width: number, height: number): GeminiWatermarkConfig {
  if (width > 1024 && height > 1024) return TIER_96;
  return TIER_48;
}

function createV2SmallConfig(width: number, height: number): GeminiWatermarkConfig | null {
  if (Math.max(width, height) > 2048) return null;

  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const sourceLongDim = shortSide >= 566 ? 2752 : shortSide >= 550 ? 2816 : 2848;
  const margin = Math.round(192 * (longSide / sourceLongDim));

  const config: GeminiWatermarkConfig = {
    logoSize: 36,
    marginRight: margin,
    marginBottom: margin,
    alphaVariant: "36-v2",
  };

  const x = width - config.marginRight - config.logoSize;
  const y = height - config.marginBottom - config.logoSize;
  return x >= 0 && y >= 0 ? config : null;
}

function createProjectedConfig(
  base: GeminiWatermarkConfig,
  scaleX: number,
  scaleY: number,
): GeminiWatermarkConfig | null {
  const scale = (scaleX + scaleY) / 2;
  return {
    logoSize: clamp(Math.round(base.logoSize * scale), 24, 192),
    marginRight: Math.max(8, Math.round(base.marginRight * scaleX)),
    marginBottom: Math.max(8, Math.round(base.marginBottom * scaleY)),
    ...(base.alphaVariant ? { alphaVariant: base.alphaVariant } : {}),
  };
}

function getProjectedConfigs(
  width: number,
  height: number,
): GeminiWatermarkConfig[] {
  const targetAspect = width / height;
  const results: { config: GeminiWatermarkConfig; score: number }[] = [];

  for (const entry of OFFICIAL_ENTRIES) {
    const scaleX = width / entry.width;
    const scaleY = height / entry.height;
    if (scaleX <= 0 || scaleY <= 0) continue;

    const scale = (scaleX + scaleY) / 2;
    const entryAspect = entry.width / entry.height;
    const aspectDelta = Math.abs(targetAspect - entryAspect) / entryAspect;
    const scaleMismatch = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);

    if (aspectDelta > 0.025) continue;
    if (scaleMismatch > 0.15) continue;

    const projected = createProjectedConfig(entry.config, scaleX, scaleY);
    if (!projected) continue;

    const x = width - projected.marginRight - projected.logoSize;
    const y = height - projected.marginBottom - projected.logoSize;
    if (x < 0 || y < 0) continue;

    results.push({
      config: projected,
      score: aspectDelta * 100 + scaleMismatch * 20 + Math.abs(Math.log2(scale)),
    });

    if (entry.legacy) {
      const legacyProjected = createProjectedConfig(entry.legacy, scaleX, scaleY);
      if (legacyProjected) {
        const lx = width - legacyProjected.marginRight - legacyProjected.logoSize;
        const ly = height - legacyProjected.marginBottom - legacyProjected.logoSize;
        if (lx >= 0 && ly >= 0) {
          results.push({
            config: legacyProjected,
            score: aspectDelta * 100 + scaleMismatch * 20 + Math.abs(Math.log2(scale)) + 0.5,
          });
        }
      }
    }
  }

  return results
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((r) => r.config);
}

/**
 * 이미지 크기에 맞는 워터마크 후보 규격 목록 (우선순위 순)
 */
export function resolveGeminiWatermarkSearchConfigs(
  width: number,
  height: number,
): GeminiWatermarkConfig[] {
  const configs: GeminiWatermarkConfig[] = [];
  const seen = new Set<string>();

  const official = OFFICIAL_INDEX.get(`${width}x${height}`);
  if (official) {
    addConfig(configs, seen, official.config);
    if (official.legacy) addConfig(configs, seen, official.legacy);
    if (official.include1kVariants) {
      addConfig(configs, seen, LARGE_MARGIN_48);
      const v2 = createV2SmallConfig(width, height);
      if (v2) addConfig(configs, seen, v2);
    }
    return configs;
  }

  for (const projected of getProjectedConfigs(width, height)) {
    addConfig(configs, seen, projected);
  }

  addConfig(configs, seen, getDefaultConfig(width, height));
  addConfig(configs, seen, TIER_48);
  addConfig(configs, seen, TIER_96);
  addConfig(configs, seen, LARGE_MARGIN_48);

  if (Math.min(width, height) >= 1024) {
    addConfig(configs, seen, NEW_MARGIN_96);
  }

  const v2 = createV2SmallConfig(width, height);
  if (v2) addConfig(configs, seen, v2);

  return configs;
}

export function getOfficialPrimaryConfig(
  width: number,
  height: number,
): GeminiWatermarkConfig | null {
  return OFFICIAL_INDEX.get(`${width}x${height}`)?.config ?? null;
}

export function isExactOfficialGeminiSize(width: number, height: number): boolean {
  return OFFICIAL_INDEX.has(`${width}x${height}`);
}

export function getWatermarkPositionFromConfig(
  imageWidth: number,
  imageHeight: number,
  config: GeminiWatermarkConfig,
): { x: number; y: number } {
  return {
    x: imageWidth - config.marginRight - config.logoSize,
    y: imageHeight - config.marginBottom - config.logoSize,
  };
}

export function getRefineSearchForConfig(
  imageWidth: number,
  imageHeight: number,
  config: GeminiWatermarkConfig,
  slack?: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const { x, y } = getWatermarkPositionFromConfig(imageWidth, imageHeight, config);
  const pad = slack ?? Math.max(12, Math.round(config.logoSize * 0.3));

  return {
    x0: Math.max(0, x - pad),
    y0: Math.max(0, y - pad),
    x1: Math.min(imageWidth, x + config.logoSize + pad),
    y1: Math.min(imageHeight, y + config.logoSize + pad),
  };
}

/** 알파 맵 조회 키 (가장 가까운 보정 맵) */
export function resolveAlphaMapKey(config: GeminiWatermarkConfig): number | string {
  if (config.alphaVariant) return config.alphaVariant;
  if (config.logoSize <= 40) return "36-v2";
  if (config.logoSize <= 72) return 48;
  return 96;
}
