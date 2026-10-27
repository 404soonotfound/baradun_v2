import { ChevronDown, MapPin, Navigation } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";

// 지역 고르기 시트를 여는 버튼. 모바일 상단 줄과 PC 홈 제목 위에서 같이 씀 (10/27 결정)
export function RegionButton({
  label,
  nearby,
  onClick,
  className,
}: {
  // 고른 지역("강원 양양군") 또는 가까운 해변 지역. 없으면 null → "지역 고르기"
  label: string | null;
  // label이 내 위치에서 온 것이면 true(화살표 아이콘)
  nearby: boolean;
  onClick: () => void;
  className?: string;
}) {
  const t = useTranslations("home.top");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={label ? t("changeRegion", { region: label }) : undefined}
      className={cn(
        "flex min-h-touch min-w-0 items-center gap-1.5 rounded-button px-1 text-title-s text-text-default",
        className,
      )}
    >
      {nearby ? (
        <Navigation aria-hidden="true" size={17} className="shrink-0" />
      ) : (
        <MapPin aria-hidden="true" size={17} className="shrink-0" />
      )}
      <span className="truncate">{label ?? t("pickRegion")}</span>
      <ChevronDown aria-hidden="true" size={16} className="shrink-0" />
    </button>
  );
}
