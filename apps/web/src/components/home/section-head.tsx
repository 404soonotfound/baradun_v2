import Link from "next/link";

import { cn } from "@/lib/cn";

// 홈 묶음 제목 줄: 왼쪽 제목(h2) · 오른쪽 '전체 보기' 링크 또는 메타 글자 (Figma S_M01_01 '가까운 바다' 줄)
// id는 묶음(section)의 aria-labelledby와 이어서 화면 읽기에서 묶음 이름이 됨
export function SectionHead({
  id,
  title,
  href,
  linkText,
  meta,
  note,
  large = false,
  focusable = false,
}: {
  id: string;
  title: string;
  href?: string;
  linkText?: string;
  meta?: string | null;
  // 링크 앞 안내 글(PC 가까운 바다: 현장 우선 문구). 있으면 링크를 브랜드 색 굵게(Figma 181:849)
  note?: string | null;
  // PC에서 제목을 한 단계 크게(가까운 바다, Figma 181:848 20px)
  large?: boolean;
  // 프로그램으로 포커스를 옮길 제목(탭 순서에는 넣지 않음). 가까운 바다: 위치 '다시 시도' 성공 뒤(BRD-139)
  focusable?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2
        id={id}
        tabIndex={focusable ? -1 : undefined}
        className={cn(
          "text-title-m text-text-default",
          focusable && "outline-none",
          large && "lg:text-title-l",
        )}
      >
        {title}
      </h2>
      {note && (
        <span className="ml-auto text-caption text-text-muted">
          {note}
          <span aria-hidden="true"> · </span>
        </span>
      )}
      {href && linkText && (
        // 글자는 작아도 누르는 영역은 44px: 위아래 음수 여백으로 줄 높이는 그대로, 짧은 글자(See all)는 폭도 44px(오른쪽 맞춤)
        <Link
          href={href}
          // relative: 아래로 넓힌 영역이 뒤따르는 카드에 덮이지 않게 위에 그림
          className={cn(
            "relative -my-3 inline-flex min-h-touch min-w-touch items-center justify-end text-caption",
            note ? "-ml-3 font-bold text-brand-default" : "text-text-muted",
          )}
        >
          {linkText}
        </Link>
      )}
      {meta && <span className="text-caption text-text-muted">{meta}</span>}
    </div>
  );
}
