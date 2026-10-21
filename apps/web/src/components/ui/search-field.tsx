import { Search } from "lucide-react";
import { useId, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

// 검색창 (BRD-81 · 컴포넌트 명세 SearchField, Figma S_M02_01 탐색 위 검색창 · L08 검색 화면 186:502)
// 높이 46, 돋보기 17px, 포커스면 파란 2px 테두리. <label>은 필수(화면에는 숨김)
export function SearchField({
  label,
  className,
  ...props
}: {
  // 접근 가능한 이름(예: "해변·지역 검색"). 안내 문구(placeholder)와 같아도 따로 꼭 줌
  label: string;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  // label과 input을 잇는 id. 화면에 검색창이 둘 있어도 겹치지 않음
  const id = useId();

  return (
    <div
      className={cn(
        // focus-within = 안쪽 input에 포커스가 있을 때. 테두리 1px + 같은 색 그림자 1px = 2px처럼 보임(높이는 그대로)
        "flex h-search items-center gap-2.5 rounded-input border border-border-strong bg-bg-surface px-[15px] focus-within:border-brand-default focus-within:shadow-[0_0_0_1px_var(--color-brand-default)]",
        className,
      )}
    >
      <Search
        aria-hidden="true"
        size={17}
        className="shrink-0 text-text-muted"
      />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        // 바깥 상자가 포커스 테두리를 그리므로 input 자체 바깥선은 끔
        className="min-w-0 flex-1 bg-transparent text-[15px] text-text-default outline-none placeholder:text-text-muted"
        {...props}
      />
    </div>
  );
}
