import type { ReactNode } from "react";

// 빈 화면 (BRD-81 · 컴포넌트 명세 EmptyState, Figma S_M05_03 178:287)
// 원형 아이콘 + 한 문장 + 도움말 + 행동 버튼 하나. 검색 결과 없음·즐겨찾기 없음 등에 씀
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-12 text-center">
      <span
        aria-hidden="true"
        className="flex size-[60px] items-center justify-center rounded-full bg-bg-subtle text-text-muted"
      >
        {icon}
      </span>
      <p className="text-title-s text-text-default">{title}</p>
      {description && (
        <p className="text-caption text-text-muted">{description}</p>
      )}
      {action && <div className="pt-1.5">{action}</div>}
    </div>
  );
}
