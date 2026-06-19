import Link from "next/link";
import { ArrowRight, FileText, ImageIcon, Shield } from "lucide-react";

const tools = [
  {
    href: "/image",
    title: "이미지 편집기",
    description: "크기 조절, 포맷 변환, 워터마크 제거 등 이미지를 브라우저에서 바로 편집합니다.",
    icon: ImageIcon,
    accent: "from-violet-500/20 to-indigo-500/10",
    iconColor: "text-violet-400",
    borderHover: "hover:border-violet-500/40",
  },
  {
    href: "/pdf",
    title: "PDF 편집기",
    description: "페이지 병합, 분할, 회전 등 PDF 작업을 서버 없이 클라이언트에서 처리합니다.",
    icon: FileText,
    accent: "from-emerald-500/20 to-teal-500/10",
    iconColor: "text-emerald-400",
    borderHover: "hover:border-emerald-500/40",
  },
] as const;

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <section className="mb-12 text-center sm:mb-16">
        <p className="mb-3 text-sm font-medium tracking-widest text-indigo-400 uppercase">
          Client-side Media Editor
        </p>
        <h1 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
          브라우저에서 바로 편집하세요
        </h1>
        <p className="mx-auto max-w-xl text-[var(--color-muted)]">
          파일은 서버로 전송되지 않습니다. 모든 미디어 처리는 사용자의 기기에서만
          이루어집니다.
        </p>
      </section>

      <div className="mb-12 grid gap-6 sm:grid-cols-2">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className={`group relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-8 transition-all duration-200 ${tool.borderHover} hover:bg-[var(--color-surface-elevated)]`}
          >
            <div
              className={`absolute inset-0 bg-gradient-to-br ${tool.accent} opacity-0 transition-opacity group-hover:opacity-100`}
            />
            <div className="relative">
              <div
                className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 ${tool.iconColor}`}
              >
                <tool.icon className="h-6 w-6" />
              </div>
              <h2 className="mb-2 text-xl font-semibold">{tool.title}</h2>
              <p className="mb-6 text-sm leading-relaxed text-[var(--color-muted)]">
                {tool.description}
              </p>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-400 transition-colors group-hover:text-indigo-300">
                시작하기
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </Link>
        ))}
      </div>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-6 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <h3 className="font-medium">프라이버시 우선 설계</h3>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                업로드 API나 클라우드 저장소를 사용하지 않습니다. 탭을 닫으면 메모리에
                있던 파일도 함께 사라집니다.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
