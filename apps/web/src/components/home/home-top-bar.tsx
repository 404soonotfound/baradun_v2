import { MapPin, Navigation, Search, Waves } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { localizedPath, type Locale } from "@/lib/i18n";

// 홈 상단 줄 (노션 2장 HOME 1, Figma S_M01_01 hbar) — 모바일만. PC는 공통 상단 내비(TopNav)
// 로고 30px · 지금 보는 곳 · 검색 버튼(흰 원 44px)
// 지역 고르기 창은 BRD-27에서 붙임. 그때까지 지역 글자는 누를 수 없음
export function HomeTopBar({
  locale,
  place,
}: {
  locale: Locale;
  place: string | null; // 위치가 있으면 가장 가까운 해변의 지역("강원 강릉시"). 없으면 null
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
        <span className="flex min-w-0 items-center gap-1.5 text-title-s text-text-default">
          {place ? (
            <Navigation aria-hidden="true" size={17} />
          ) : (
            <MapPin aria-hidden="true" size={17} />
          )}
          <span className="truncate">{place ?? t("home.top.pickRegion")}</span>
        </span>
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
