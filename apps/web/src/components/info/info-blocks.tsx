import { ExternalLink as ExternalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

// 안내 화면(안전·데이터 안내·약관·데이터 출처, BRD-36)이 같이 쓰는 묶음 카드와 바깥 링크
// 정적 내용이라 서버에서 그림(기기 저장·상태를 읽지 않음)

export function InfoSection({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn("flex flex-col gap-2", className)}
    >
      <h2 id={id} className="text-title-m text-text-default">
        {title}
      </h2>
      <div className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card">
        {children}
      </div>
    </section>
  );
}

// 새 창으로 여는 바깥 링크. 화면 읽기에 '새 창에서 열림'을 알림
export function ExternalLink({
  href,
  children,
  newWindow,
}: {
  href: string;
  children: ReactNode;
  newWindow: string; // 문구 키에서 받은 '새 창에서 열림'
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-touch items-center gap-1 text-body-s font-bold text-brand-default underline-offset-2 hover:underline"
    >
      {children}
      <ExternalIcon aria-hidden="true" size={14} className="shrink-0" />
      <span className="sr-only">({newWindow})</span>
    </a>
  );
}
