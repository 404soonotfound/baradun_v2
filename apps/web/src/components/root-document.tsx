import { NextIntlClientProvider } from "next-intl";
import type { Locale } from "@/lib/i18n";
import "@fontsource-variable/noto-sans-kr";
import { DISPLAY_INIT_SCRIPT } from "@/lib/display-init";
import { getMessages } from "next-intl/server";
import { ServiceWorkerSetup } from "@/components/service-worker";
import { LegacyStorageCleanup } from "@/components/legacy-storage-cleanup";
import { GoogleAnalytics } from "@/components/analytics/google-analytics";
import { GA_MEASUREMENT_ID, isProductionSite } from "@/lib/site-env";

// 두 루트 레이아웃((ko)·(en))과 전역 404가 같이 쓰는 html 뼈대 (BRD-22)
// suppressHydrationWarning: 테마 스크립트가 그리기 전에 data-theme을 붙여서 생기는 차이를 허용함.
export async function RootDocument({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const messages = await getMessages({ locale });
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        {/* body 맨 앞의 인라인 스크립트는 뒤 내용을 그리기 전에 실행됨(파서가 멈추고 실행).
            <head>를 직접 쓰지 않는 이유: 이 파일이 app/ 밖에 있어서 Next 린트(no-head-element)가
            페이지 라우터용 경고를 냄. 메타데이터는 metadata API가 <head>에 넣어 줌. */}
        <script
          dangerouslySetInnerHTML={{
            __html: DISPLAY_INIT_SCRIPT,
          }}
        />
        <ServiceWorkerSetup />
        <LegacyStorageCleanup />
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone="Asia/Seoul"
        >
          {children}
        </NextIntlClientProvider>{" "}
        {/* 운영 빌드(사이트 주소가 운영 주소)에서만 GA를 넣음(BRD-143). 로컬·CI·E2E 빌드의 HTML에는 흔적이 없음 */}
        {isProductionSite() && (
          <GoogleAnalytics measurementId={GA_MEASUREMENT_ID} />
        )}
      </body>
    </html>
  );
}
