"use client";

import { cn } from "@/lib/cn";

// 세그먼트 (BRD-81 · 컴포넌트 명세 ViewToggle, Figma '목록·지도 전환 · 새' 170:2929)
// 연한 파랑 틀 + 고른 칸만 흰색. 상태별|가까운 순, 목록|지도, 즐겨찾기|최근 본
// 마지막 선택 기억은 쓰는 화면이 정함(어느 저장소에 둘지가 화면마다 달라서). 이 부품은 value·onChange만 받음

// <T extends string> = 값 종류를 쓰는 쪽이 정하는 '제네릭'. 예: "status" | "near"
export function ViewToggle<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string; // 묶음 이름(화면에는 안 보임, 예: "목록 보기 방식")
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void; // () => onChange(option.value) — 누를 때 그 칸 값을 밖으로 알림. 실제 바꾸기는 쓰는 쪽 상태(useState)가 처리.
  className?: string;
}) {
  return (
    // role="group" + aria-label = 버튼 묶음에 이름을 붙임. 각 버튼은 눌림 상태(aria-pressed)로 읽힘
    <div
      role="group"
      aria-label={label}
      className={cn("flex h-10 rounded-[10px] bg-bg-subtle p-[3px]", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-segment flex-1 rounded-[8px] px-2 text-body-s whitespace-nowrap text-text-default",
              selected && "bg-bg-surface font-bold shadow-card",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
