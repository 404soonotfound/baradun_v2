import { useTranslations } from "next-intl";

// '처음 오셨네요' 카드 (노션 2장 HOME 6, Figma S_M01_02 171:563) — 최근 본 해변이 없을 때 그 자리
export function FirstVisitCard() {
  const t = useTranslations("home.firstVisit");
  return (
    <section
      aria-labelledby="home-first"
      className="flex flex-col gap-2.5 rounded-card bg-bg-surface p-[18px] shadow-card"
    >
      <h2 id="home-first" className="text-title-m text-text-default">
        {t("title")}
      </h2>
      <p className="text-body-s text-text-body">{t("body")}</p>
    </section>
  );
}
