import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/i18n";

// - 모바일: 위 여백 20px(홈 화면 추가 모드는 노치만큼 더), 아래는 하단 탭 높이만큼 비워 가려지지 않게
// - PC(lg 이상): 상단 내비 + 가운데 정렬(최대 1280)
// - 키보드 사용자를 위해 "본문으로 건너뛰기" 링크를 맨 앞에 배치
export async function AppShell({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "nav" });

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-button focus:bg-bg-surface focus:px-4 focus:py-3 focus:shadow-raised"
      >
        {t("skipToContent")}
      </a>
      <main
        id="main"
        className="mx-auto w-full max-w-[1280px] px-gutter pt-5 pb-[calc(var(--spacing-tabbar)+max(14px,env(safe-area-inset-bottom))+24px)] lg:px-10 lg:pt-8 lg:pb-16"
      >
        {children}
      </main>
    </>
  );
}
