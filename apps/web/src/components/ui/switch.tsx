"use client";

import { cn } from "@/lib/cn";

// 켜고 끄는 스위치 (설정 화면, BRD-36). role="switch" + aria-checked로 화면 읽기가 '켜짐/꺼짐'을 읽음
// 이름은 labelledBy(보이는 제목), 설명은 describedBy로 연결. 누르는 자리는 44px 이상
// 색만으로 구분하지 않게 손잡이 위치(왼쪽·오른쪽)도 함께 바뀜. 색은 토큰만
// 크기는 Figma 스위치 170:319: 46×28, 손잡이 22(여백 3), BRD-129
export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className="flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-7 w-[46px] items-center rounded-full p-[3px] transition-colors duration-200 ease-standard",
          checked ? "bg-brand-default" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "size-[22px] rounded-full bg-bg-surface shadow-card transition-transform duration-200 ease-standard",
            checked && "translate-x-[18px]",
          )}
        />
      </span>
    </button>
  );
}
