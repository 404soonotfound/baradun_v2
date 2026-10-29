import { cn } from "@/lib/cn";

// 로고 (노션 4장 5절 '파랑 둥근 사각 30px·모서리 9 + 흰 물결 선', Figma logo 170:376 · 아이콘/wave, BRD-129)
// 물결 선 하나는 lucide Waves(세 줄)와 달라 Figma 원본 경로를 옮김. 17 격자
// label이 있으면 그림 하나로 읽힘(모바일 홈 상단), 없으면 옆 글자(PC '바라던 바다')가 이름이라 숨김
export function LogoMark({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-brand-default text-brand-on",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        width={17}
        height={17}
        viewBox="0 0 17 17"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.55833}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.125 9.91667C3.54167 9.91667 3.54167 8.5 5.3125 8.5C7.08333 8.5 6.72917 9.91667 8.5 9.91667C10.2708 9.91667 9.91667 8.5 11.6875 8.5C13.4583 8.5 13.4583 9.91667 14.875 9.91667" />
      </svg>
    </span>
  );
}
