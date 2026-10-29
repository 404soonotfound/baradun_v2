import type { LucideProps } from "lucide-react";

// 설정 아이콘 (Figma 아이콘/settings 8:11, 하단 탭 170:145·PC 내비 170:404, BRD-129)
// 가운데 원 + 바깥 짧은 선 8개. lucide Settings(톱니)·Sun(원 r4)과 모양이 달라 Figma 경로를 24 격자로 옮김
// lucide 아이콘과 같은 속성(size·strokeWidth)을 받아 탭 바·내비에서 섞어 씀. 이름은 부르는 쪽(aria-label·글자)이 줌
export function SettingsIcon({
  size = 24,
  strokeWidth = 2,
  ...props
}: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  );
}
