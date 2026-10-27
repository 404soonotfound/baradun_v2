import { ChevronDown, MapPin, Navigation, Search, Waves } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { localizedPath, type Locale } from "@/lib/i18n";

// 홈 상단 줄 — 모바일만. 로고 · 지역 버튼 · 검색
// 지역 버튼은 위치와 관계없이 항상 누를 수 있음 → 지역 고르기 시트 (10/27 결정)
export function HomeTopBar({
  locale,
  label,
  nearby,
  onPickRegion,
}: {
  locale: Locale;
  // 버튼 글자: 고른 지역("강원 양양군") 또는 가까운 해변 지역. 없으면 null → "지역 고르기"
  label: string | null;
  // label이 내 위치에서 온 것이면 true(화살표 아이콘)
  nearby: boolean;
  onPickRegion: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex h-topbar items-center justify-between lg:hidden">
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          role="img"
          aria-label={t("meta.siteName")}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-brand-default text-brand-on"
        >
          <Waves aria-hidden="true" size={17} />
        </span>
        <button
          type="button"
          onClick={onPickRegion}
          aria-haspopup="dialog"
          aria-label={
            label ? t("home.top.changeRegion", { region: label }) : undefined
          }
          className="-ml-1 flex min-h-touch min-w-0 items-center gap-1.5 rounded-button px-1 text-title-s text-text-default"
        >
          {nearby ? (
            <Navigation aria-hidden="true" size={17} className="shrink-0" />
          ) : (
            <MapPin aria-hidden="true" size={17} className="shrink-0" />
          )}
          <span className="truncate">{label ?? t("home.top.pickRegion")}</span>
          <ChevronDown aria-hidden="true" size={16} className="shrink-0" />
        </button>
      </span>
      <Link
        href={localizedPath(locale, "/search/")}
        aria-label={t("home.top.search")}
        className="flex size-touch shrink-0 items-center justify-center rounded-full bg-bg-surface"
      >
        <Search aria-hidden="true" size={19} />
      </Link>
    </div>
  );
}
