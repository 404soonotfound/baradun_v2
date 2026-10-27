import Link from "next/link";

// 홈 묶음 제목 줄: 왼쪽 제목(h2) · 오른쪽 '전체 보기' 링크 또는 메타 글자 (Figma S_M01_01 '가까운 바다' 줄)
// id는 묶음(section)의 aria-labelledby와 이어서 화면 읽기에서 묶음 이름이 됨
export function SectionHead({
  id,
  title,
  href,
  linkText,
  meta,
}: {
  id: string;
  title: string;
  href?: string;
  linkText?: string;
  meta?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-title-m text-text-default">
        {title}
      </h2>
      {href && linkText && (
        // 글자는 작아도 누르는 영역은 44px: 위아래 음수 여백으로 줄 높이는 그대로
        <Link
          href={href}
          className="-my-3 inline-flex min-h-touch items-center text-caption text-text-muted"
        >
          {linkText}
        </Link>
      )}
      {meta && <span className="text-caption text-text-muted">{meta}</span>}
    </div>
  );
}
