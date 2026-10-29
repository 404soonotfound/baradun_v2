import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { InquiryScreen } from "@/components/inquiry/inquiry-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";

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
  // useSearchParams(?beach=)는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈(브라우저에서 이어 그림)
  return (
    <Suspense
      fallback={
        <h1 className="text-title-l text-text-default">{t("inquiry")}</h1>
      }
    >
      <InquiryScreen locale="en" beaches={beaches} />
    </Suspense>
  );
}
