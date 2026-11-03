import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { InquiryScreen } from "@/components/inquiry/inquiry-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";
import { SettingsLayout } from "@/components/settings/settings-nav";

// 데이터 문의 /settings/inquiry/ (BRD-37). 해변 id·이름·지원 활동(?beach=slug 자동 입력용)만 빌드 때 넘김
const PATH = "/settings/inquiry/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("inquiry"), alternates: alternatesFor("en", PATH) };
}

export default async function Page() {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  const beaches = listBeachSummaries("en").map(
    ({ id, slug, name, activities }) => ({
      id,
      slug,
      name,
      activities,
    }),
  );
  // PC는 설정과 같은 좌우 배치(왼쪽 설정 목록). 목록은 Suspense 밖이라 정적 HTML에도 그림
  // useSearchParams(?beach=)는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈(브라우저에서 이어 그림)
  return (
    <SettingsLayout locale="en">
      <Suspense
        fallback={
          <h1 className="mx-auto flex h-14 max-w-[640px] items-center justify-center text-body font-bold text-text-default lg:mb-4 lg:h-auto lg:justify-start lg:text-title-xl">
            {t("inquiry")}
          </h1>
        }
      >
        <InquiryScreen locale="en" beaches={beaches} />
      </Suspense>
    </SettingsLayout>
  );
}
