import { ChevronDown, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

// 칩 (BRD-81 · 컴포넌트 명세 Chip, Figma '칩 · 새' 170:2928)
//   default: 흰 바탕 + 회색 테두리 · on: 파랑 채움(선택됨) · sel: 연한 파랑 + 파랑 테두리(드롭다운에서 고른 값, ⌄ 표시)
// 높이 36(지역 선택 화면은 42 = size "lg")
// 누르는 영역은 44px(점검표 12): 보이는 크기는 그대로 두고 위아래로만 넓힘(36 → +4px씩, 42 → +1px씩, BRD-39).
// ::before는 테두리(1px) 안쪽 기준으로 놓여서 1px씩 더 뺌
// 옆으로 스크롤하는 줄에 둘 때는 줄에 위아래 4px 여백을 둬 넓힌 영역이 잘리지 않게 함(explore-filters.tsx)
const HIT_AREA = {
  md: "before:-inset-y-[5px]",
  lg: "before:-inset-y-[2px]",
} as const;
const VARIANTS = {
  default: "border-border-strong bg-bg-surface font-medium text-text-body",
  on: "border-brand-default bg-brand-default font-bold text-brand-on",
  sel: "border-brand-default bg-brand-weak font-bold text-brand-default",
} as const; // 읽기전용 상수

// "VARIANTS 표의 키 이름(default | on | sel) 중 하나 "라는 타입을 만들어  ChipVariant라고 부른다
export type ChipVariant = keyof typeof VARIANTS;

// Omit<A, "x"> = A에서 x 속성만 뺀 타입. 버튼 속성을 다 받되 children은 따로 정함
export interface ChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  variant?: ChipVariant;
  size?: "md" | "lg";
  icon?: ReactNode;
  children: ReactNode;
}

export function Chip({
  variant = "default",
  size = "md",
  icon,
  children,
  className,
  type = "button",
  ...props
}: ChipProps) {
  return (
    <button
      type={type}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-[5px] rounded-full border text-[13.5px] whitespace-nowrap before:absolute before:inset-x-0 before:content-['']",
        size === "lg" ? "h-[42px] px-4" : "h-chip px-[13px]",
        HIT_AREA[size],
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
      {variant === "sel" && <ChevronDown aria-hidden="true" size={13} />}
    </button>
  );
}

// 지울 수 있는 칩(예: 검색 필터 '수영 · 강원 ✕'). 글자와 ✕ 버튼을 나눠 버튼 안에 버튼이 생기지 않게 함
// tone: selected = 고른 필터(브랜드 색), plain = 목록 칩(홈 최근 본, Figma 171:463: 높이 34·흰 바탕·12.5 보통 굵기, BRD-129)
export function RemovableChip({
  children,
  removeLabel,
  onRemove,
  tone = "selected",
}: {
  children: ReactNode;
  // ✕의 접근 가능한 이름(예: "강원 빼기"). 화면에는 ✕만 보임
  removeLabel: string;
  onRemove: () => void;
  tone?: "selected" | "plain";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border pl-[13px]",
        tone === "plain"
          ? "h-[34px] border-border-default bg-bg-surface pr-[3px] text-label-s text-text-default"
          : "h-chip border-brand-default bg-brand-weak text-[12.5px] font-bold text-brand-default",
      )}
    >
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        // 보이는 원은 작아도 누르는 영역은 30px(명세 '✕ 30px 터치 영역'). 눌림 영역만 위아래·옆으로 7px씩 넓혀 44px를 맞춤
        className="relative ml-0.5 flex size-[30px] items-center justify-center rounded-full before:absolute before:-inset-[7px] before:content-['']"
      >
        <X aria-hidden="true" size={tone === "plain" ? 11 : 13} />
      </button>
    </span>
  );
}
