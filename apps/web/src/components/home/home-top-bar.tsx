import { Search, Waves } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { RegionButton } from "@/components/home/region-button";
import { localizedPath, type Locale } from "@/lib/i18n";

// 홈 상단 줄 — 모바일만. 로고 · 지역 버튼 · 검색 (PC는 공통 상단 내비, 지역 버튼은 홈 제목 위)
// 지역 버튼은 위치와 관계없이 항상 누를 수 있음 → 지역 고르기 시트 (10/27 결정)
export function HomeTopBar({
  locale,
  label,
  nearby,
  onPickRegion,
}: {
  locale: Locale;
  label: string | null;
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
        <RegionButton
          label={label}
          nearby={nearby}
          onClick={onPickRegion}
          className="-ml-1"
        />
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
