import { Search } from "lucide-react";
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "@/lib/cn";

// 검색창 (BRD-81 · 컴포넌트 명세 SearchField, Figma S_M02_01 탐색 위 검색창 · L08 검색 화면 186:502)
// 높이 46, 돋보기 17px, 포커스면 파란 2px 테두리. <label>은 필수(화면에는 숨김)
export function SearchField({
  label,
  className,
  id: idProp,
  trailing,
  ...props
}: {
  // 접근 가능한 이름(예: "해변·지역 검색"). 안내 문구(placeholder)와 같아도 따로 꼭 줌
  label: string;
  className?: string;
  // 입력칸 오른쪽 끝(검색 화면의 검색어 지우기 버튼 등)
  trailing?: ReactNode;
  // 입력칸 자체(React 19: 함수 부품도 ref를 prop으로 받음). 지우기 뒤 포커스를 되돌릴 때 씀
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  // label과 input을 잇는 id. 화면에 검색창이 둘 있어도 겹치지 않음. 쓰는 쪽이 id를 주면 그 값으로 label도 이음
  const generatedId = useId();
  const id = idProp ?? generatedId;

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
        // 바깥 상자가 포커스 테두리를 그리므로 input 자체 바깥선은 숨김. outline-hidden은 고대비 모드에서는 바깥선을 살려 둠(그림자가 안 그려져서)
        // self-stretch: 입력칸이 틀 높이만큼 차서 틀 어디를 눌러도 입력됨(누르는 영역 44px, BRD-39)
        // trailing(지우기 버튼)이 있으면 브라우저 기본 지우기(✕)를 숨김(✕가 둘 보이지 않게)
        className={cn(
          "min-w-0 flex-1 self-stretch bg-transparent text-[15px] text-text-default outline-hidden placeholder:text-text-muted",
          trailing !== undefined &&
            "[&::-webkit-search-cancel-button]:appearance-none",
        )}
        {...props}
      />
      {trailing}
    </div>
  );
}
