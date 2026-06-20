import { APP_VERSION, formatAppVersionLabel } from "@/lib/version";

type AppVersionProps = {
  className?: string;
};

export function AppVersion({ className = "" }: AppVersionProps) {
  return (
    <p
      className={`text-center text-[11px] tabular-nums tracking-wide text-[var(--color-muted)]/45 ${className}`}
      aria-label={`앱 버전 ${APP_VERSION}`}
    >
      {formatAppVersionLabel()}
    </p>
  );
}
