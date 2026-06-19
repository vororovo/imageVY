import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type EditorShellProps = {
  title: string;
  description: string;
  children: React.ReactNode;
};

export function EditorShell({ title, description, children }: EditorShellProps) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        대시보드로 돌아가기
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 text-[var(--color-muted)]">{description}</p>
      </div>

      {children}
    </div>
  );
}
