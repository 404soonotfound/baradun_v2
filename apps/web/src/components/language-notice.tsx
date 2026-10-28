"use client";

import { Languages } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Banner } from "@/components/ui/banner";
import { type Locale } from "@/lib/i18n";
import {
  languageSwitchHref,
  setLanguageChoice,
  useLanguageNotice,
} from "@/lib/language-choice";

// 첫 방문 언어 안내 (디자인 시스템 8절 10/16 결정 · BRD-48)
// 기기 언어가 주소 언어와 다를 때 한 번만, 기기 언어로 씀(이 화면 언어를 못 읽는 사람도 알아보게)
// 문구는 그 언어의 문구 키(languageNotice.*)를 서버에서 꺼내 넘김. 고르면(이동·그대로) 기기에 저장해 다시 안 띄움
export type LanguageNoticeText = {
  label: string;
  offer: string;
  switch: string;
  stay: string;
};

type Props = {
  locale: Locale; // 이 화면(주소) 언어
  texts: Partial<Record<Locale, LanguageNoticeText>>; // 안내할 수 있는 다른 언어의 문구
};

// useSearchParams는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈. 안내는 서버 렌더·첫 그리기에서 원래 비어 있어 fallback도 비움
export function LanguageNotice(props: Props) {
  return (
    <Suspense fallback={null}>
      <Notice {...props} />
    </Suspense>
  );
}

function Notice({ locale, texts }: Props) {
  const target = useLanguageNotice(locale);
  const pathname = usePathname();
  // 언어를 바꿔도 검색어(?q=)·문의 맥락(?beach=) 같은 지금 주소의 매개변수는 그대로 넘김
  const search = useSearchParams().toString();
  const text = target ? texts[target] : undefined;
  if (!target || !text) return null;
  return (
    <section lang={target} aria-label={text.label} className="mb-4">
      <Banner
        tone="gray"
        icon={<Languages size={16} />}
        title={text.offer}
        action={
          <Link
            href={languageSwitchHref(target, pathname, search)}
            hrefLang={target}
            onClick={() => setLanguageChoice(target)}
            className="font-bold text-brand-default"
          >
            {text.switch}
          </Link>
        }
        dismiss={{
          label: text.stay,
          onClick: () => setLanguageChoice(locale),
        }}
      />
    </section>
  );
}
