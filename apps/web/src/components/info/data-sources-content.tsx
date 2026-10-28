import { getTranslations } from "next-intl/server";

import { ExternalLink, InfoSection } from "@/components/info/info-blocks";
import type { Locale } from "@/lib/i18n";

// 데이터 출처·이용 조건 /about/data/ (BRD-36 · 노션 2장 SRC, 결정 기록 11장 B1·B7·10/21 사진·10/23 운영 기간)
// 출처마다 제공 항목·이용 조건·원문 링크. 이용 조건은 각 원문(공공데이터포털 '이용허락범위' 등)을 2026-10-28에 확인한 값
// 해변 상태나 측정값은 넣지 않음(정적 HTML, G4)

type Source = {
  key: "kma" | "khoa" | "tour" | "mof" | "map";
  links: { label: string; href: string }[];
};

const SOURCES: Source[] = [
  {
    key: "kma",
    links: [
      {
        label: "linkWarning",
        href: "https://www.data.go.kr/data/15000415/openapi.do",
      },
      {
        label: "linkTsunami",
        href: "https://www.data.go.kr/data/15000420/openapi.do",
      },
      { label: "linkApiHub", href: "https://apihub.kma.go.kr/" },
    ],
  },
  {
    key: "khoa",
    links: [
      {
        label: "linkRip",
        href: "https://www.data.go.kr/data/15156028/openapi.do",
      },
    ],
  },
  {
    key: "tour",
    links: [
      {
        label: "linkTour",
        href: "https://www.data.go.kr/data/15101578/openapi.do",
      },
      {
        label: "linkKogl",
        href: "https://www.kogl.or.kr/info/licenseType1.do",
      },
    ],
  },
  {
    key: "mof",
    links: [
      {
        label: "link",
        href: "https://www.mof.go.kr/doc/ko/selectDoc.do?menuSeq=427&bbsSeq=2&docSeq=67910",
      },
    ],
  },
  {
    key: "map",
    links: [
      { label: "linkOsm", href: "https://www.openstreetmap.org/copyright" },
      { label: "linkOmt", href: "https://openmaptiles.org/" },
      { label: "linkOfm", href: "https://openfreemap.org/" },
    ],
  },
];

const PRINCIPLES = ["item1", "item2", "item3", "item4"] as const;

export async function DataSourcesContent({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "dataSources" });
  const tc = await getTranslations({ locale });
  const newWindow = tc("common.newWindow");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-title-xl text-text-default">
          {tc("pages.dataSources")}
        </h1>
        <p className="text-body text-text-body">{t("intro")}</p>
      </div>

      <InfoSection id="sources-principles" title={t("principles.title")}>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body-s text-text-body">
          {PRINCIPLES.map((item) => (
            <li key={item}>{t(`principles.${item}`)}</li>
          ))}
        </ul>
      </InfoSection>

      {SOURCES.map(({ key, links }) => (
        <InfoSection key={key} id={`sources-${key}`} title={t(`${key}.name`)}>
          <dl className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <dt className="text-caption font-bold text-text-muted">
                {t("provides")}
              </dt>
              <dd className="text-body-s text-text-default">
                {t(`${key}.provides`)}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-caption font-bold text-text-muted">
                {t("terms")}
              </dt>
              <dd className="text-body-s text-text-body">
                {t(`${key}.terms`)}
              </dd>
            </div>
          </dl>
          <ul className="flex flex-col">
            {links.map(({ label, href }) => (
              <li key={href}>
                <ExternalLink href={href} newWindow={newWindow}>
                  {t(`${key}.${label}` as Parameters<typeof t>[0])}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </InfoSection>
      ))}
    </div>
  );
}
