"use client";

import { Languages } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Banner } from "@/components/ui/banner";
import { localizedPath, type Locale } from "@/lib/i18n";
import {
  basePath,
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

export function LanguageNotice({
  locale,
  texts,
}: {
  locale: Locale; // 이 화면(주소) 언어
  texts: Partial<Record<Locale, LanguageNoticeText>>; // 안내할 수 있는 다른 언어의 문구
}) {
  const target = useLanguageNotice(locale);
  const pathname = usePathname();
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
            href={localizedPath(target, basePath(pathname))}
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
