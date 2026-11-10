import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { LogoMark } from "@/components/logo-mark";
import { LanguageMenu } from "@/components/shell/language-menu";
import { localizedPath, type Locale } from "@/lib/i18n";

// 사이트 푸터. 모든 화면 맨 아래(본문 main 밖, contentinfo)
// - 모바일: 로고 → 안내 링크 2열 → 언어 → 안전 문구·저작권. 아래는 하단 탭 높이만큼 비워 가려지지 않게
// - PC(lg 이상): 첫 줄 로고·링크·언어, 아래 줄 안전 문구·저작권(D18-7), 가운데 최대 1280
// 링크는 설정의 안내 화면들과 같은 순서·이름(pages.*)
const LINKS = [
  { href: "/guide/", key: "guide" },
  { href: "/about/data/", key: "dataSources" },
  { href: "/terms/", key: "terms" },
  { href: "/settings/inquiry/", key: "inquiry" },
] as const;

// 저작권 연도는 빌드한 해(정적 내보내기). 빌드 기기 시간대(CI는 UTC)와 상관없이 한국 시각(KST, UTC+9) 기준
const KST_OFFSET_MS = 9 * 60 * 60_000;
const YEAR = new Date(Date.now() + KST_OFFSET_MS).getUTCFullYear();

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale });

  return (
    // mt-auto: 본문이 짧은 화면에서도 푸터를 화면 맨 아래에 둠(body가 세로 flex, globals.css)
    <footer className="mt-auto border-t border-border-default bg-bg-surface pb-[calc(var(--spacing-tabbar)+max(14px,env(safe-area-inset-bottom)))] lg:pb-0">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-gutter py-6 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-8 lg:gap-y-3 lg:px-10 lg:py-5">
        <Link
          href={localizedPath(locale, "/")}
          className="flex w-fit items-center gap-2 border-b border-border-default pb-5 text-body font-bold text-text-default max-lg:w-full lg:border-0 lg:pb-0"
        >
          <LogoMark className="size-6 rounded-[7px]" />
          {t("meta.siteName")}
        </Link>
        <nav
          aria-label={t("footer.links")}
          className="border-b border-border-default pb-5 lg:flex-1 lg:border-0 lg:pb-0"
        >
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 lg:flex lg:flex-wrap lg:gap-x-6">
            {LINKS.map((link) => (
              <li key={link.key}>
                <Link
                  href={localizedPath(locale, link.href)}
                  className="flex min-h-touch items-center justify-between gap-2 text-body-s font-bold text-text-body hover:text-text-default lg:font-normal"
                >
                  {t(`pages.${link.key}`)}
                  <ChevronRight
                    aria-hidden="true"
                    size={16}
                    className="shrink-0 text-text-muted lg:hidden"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {/* 모바일은 언어가 안전 문구 위, PC는 첫 줄 오른쪽 끝 */}
        <div>
          <div className="lg:hidden">
            <LanguageMenu locale={locale} variant="row" />
          </div>
          <div className="hidden lg:block">
            <LanguageMenu locale={locale} variant="inline" />
          </div>
        </div>
        {/* PC는 basis-full로 아래 줄에 따로 둠 */}
        <div className="flex flex-col gap-2 text-body-s text-text-muted lg:basis-full lg:flex-row lg:justify-between lg:gap-6">
          <p>{t("footer.disclaimer")}</p>
          <p className="shrink-0">{t("footer.copyright", { year: YEAR })}</p>
        </div>
      </div>
    </footer>
  );
}
