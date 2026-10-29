import { Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { RegionButton } from "@/components/home/region-button";
import { LogoMark } from "@/components/logo-mark";
import { localizedPath, type Locale } from "@/lib/i18n";

// 홈 상단 줄 — 모바일만. 로고 · 지역 버튼 · 검색 (PC는 공통 상단 내비, 지역 버튼은 홈 제목 위)
// Figma hbar 171:387: 높이 56, 오른쪽 여백 12(화면 여백 18보다 6 좁음 → -mr-1.5)
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
        <LogoMark label={t("meta.siteName")} />
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
        className="-mr-1.5 flex size-touch shrink-0 items-center justify-center rounded-full bg-bg-surface"
      >
        <Search aria-hidden="true" size={19} />
      </Link>
    </div>
  );
}
