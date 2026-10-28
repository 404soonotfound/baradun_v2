import { getTranslations } from "next-intl/server";
import { LOCALES, type Locale } from "@/lib/i18n";
import {
  LanguageNotice,
  type LanguageNoticeText,
} from "@/components/language-notice";
import { Onboarding } from "@/components/onboarding/onboarding";
import { TabBar } from "@/components/shell/tab-bar";
import { TopNav } from "@/components/shell/top-nav";
import { SystemScreen } from "@/components/system/system-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { regionGroups } from "@/lib/region-list";

// - 모바일: 위 여백 20px(홈 화면 추가 모드는 노치만큼 더), 아래는 하단 탭 높이만큼 비워 가려지지 않게
// - PC(lg 이상): 상단 내비 + 가운데 정렬(최대 1280)
// - 키보드 사용자를 위해 "본문으로 건너뛰기" 링크를 맨 앞에 배치
// - 첫 실행 안내(BRD-25)는 주소 없이 어느 화면이든 덮어서 여기 둠. 지역 묶음은 빌드 때 만들어 넘김
// - 점검·강제 업데이트(BRD-38)도 어느 화면이든 덮음. 첫 실행 안내 뒤에 두어 둘 다면 showModal이 나중에 불려 위에 보임
// - 첫 방문 언어 안내(BRD-48)는 본문 맨 위. 기기 언어로 써야 해서 다른 언어 문구를 빌드 때 꺼내 넘김
export async function AppShell({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "nav" });
  const noticeTexts: Partial<Record<Locale, LanguageNoticeText>> = {};
  for (const other of LOCALES) {
    if (other === locale) continue;
    const n = await getTranslations({
      locale: other,
      namespace: "languageNotice",
    });
    noticeTexts[other] = {
      label: n("label"),
      offer: n("offer"),
      switch: n("switch"),
      stay: n("stay"),
    };
  }

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-button focus:bg-bg-surface focus:px-4 focus:py-3 focus:shadow-raised"
      >
        {t("skipToContent")}
      </a>
      <TopNav />

      <main
        id="main"
        className="mx-auto w-full max-w-[1280px] px-gutter pt-5 pb-[calc(var(--spacing-tabbar)+max(14px,env(safe-area-inset-bottom))+24px)] standalone:pt-[calc(20px+env(safe-area-inset-top))] lg:px-10 lg:pt-8 lg:pb-16"
      >
        <LanguageNotice locale={locale} texts={noticeTexts} />
        {children}
      </main>
      <TabBar />
      <Onboarding
        locale={locale}
        groups={regionGroups(listBeachSummaries(locale))}
      />
      <SystemScreen />
    </>
  );
}
