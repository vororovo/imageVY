/** 앱 버전 (표시 형식: XX.XX.XX) */
export const APP_VERSION = "00.51.04";

export type VersionParts = {
  major: number;
  minor: number;
  patch: number;
};

export function parseVersion(version: string): VersionParts {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  return { major, minor, patch };
}

export function formatVersion({ major, minor, patch }: VersionParts): string {
  return [major, minor, patch].map((n) => String(n).padStart(2, "0")).join(".");
}

/** 개선점·버그·보완 → 패치 +0.00.01 (예: 00.50.01 → 00.50.02) */
export function bumpPatchVersion(version: string): string {
  const parts = parseVersion(version);
  return formatVersion({ ...parts, patch: parts.patch + 1 });
}

/** 기능추가 → 마이너 +0.01.00, 패치 유지 (예: 00.50.04 → 00.51.04) */
export function bumpMinorVersion(version: string): string {
  const parts = parseVersion(version);
  return formatVersion({ major: parts.major, minor: parts.minor + 1, patch: parts.patch });
}

export function formatAppVersionLabel(version: string = APP_VERSION): string {
  return `v${version}`;
}
