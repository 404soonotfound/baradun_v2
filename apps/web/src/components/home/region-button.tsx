import { ChevronDown, MapPin, Navigation } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";

// 지역 고르기 시트를 여는 버튼. 모바일 상단 줄과 PC 홈 제목 위에서 같이 씀 (10/27 결정)
// 모양(Figma, BRD-129): bar = 모바일 상단 줄(아이콘 17·글자 15 굵게), hero = PC 제목 위(아이콘 16·글자 14 굵게 보조색)
export function RegionButton({
  label,
  nearby,
  onClick,
  variant = "bar",
  className,
}: {
  // 고른 지역("강원 양양군") 또는 가까운 해변 지역. 없으면 null → "지역 고르기"
  label: string | null;
  // label이 내 위치에서 온 것이면 true(화살표 아이콘)
  nearby: boolean;
  onClick: () => void;
  variant?: "bar" | "hero";
  className?: string;
}) {
  const t = useTranslations("home.top");
  const icon = variant === "hero" ? 16 : 17;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={label ? t("changeRegion", { region: label }) : undefined}
      className={cn(
        "flex min-h-touch min-w-0 items-center gap-1.5 rounded-button px-1",
        variant === "hero"
          ? "text-body font-bold text-text-body"
          : "text-title-s text-text-default",
        className,
      )}
    >
      {nearby ? (
        <Navigation aria-hidden="true" size={icon} className="shrink-0" />
      ) : (
        <MapPin aria-hidden="true" size={icon} className="shrink-0" />
      )}
      <span className="truncate">{label ?? t("pickRegion")}</span>
      <ChevronDown aria-hidden="true" size={14} className="shrink-0" />
    </button>
  );
}
