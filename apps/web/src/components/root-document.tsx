import { NextIntlClientProvider } from "next-intl";
import type { Locale } from "@/lib/i18n";
import { notoSansKr } from "@/lib/fonts";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { getMessages } from "next-intl/server";

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
    <html
      lang={locale}
      className={notoSansKr.variable}
      suppressHydrationWarning
    >
      <body>
        {/* body 맨 앞의 인라인 스크립트는 뒤 내용을 그리기 전에 실행됨(파서가 멈추고 실행).
            <head>를 직접 쓰지 않는 이유: 이 파일이 app/ 밖에 있어서 Next 린트(no-head-element)가
            페이지 라우터용 경고를 냄. 메타데이터는 metadata API가 <head>에 넣어 줌. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone="Asia/Seoul"
        >
          {children}
        </NextIntlClientProvider>{" "}
      </body>
    </html>
  );
}
