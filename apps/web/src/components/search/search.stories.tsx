import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import type { BeachView } from "@/lib/snapshot/view";
import { RecentSearches } from "./recent-searches";
import { SearchResultRow } from "./search-result-row";

// 검색 결과 행·최근 검색 확인용 (BRD-31 · 개발 전용 Storybook). 노션 2장 SRCH
const METRICS: Extract<BeachView, { kind: "ready" }>["metrics"] = {
  waveHeight: { kind: "hidden" },
  wavePeriod: { kind: "hidden" },
  waveDirection: { kind: "hidden" },
  waterTemp: { kind: "hidden" },
  wind: { kind: "hidden" },
};
const ready = (
  category: "clear" | "unavailable" | "undetermined",
  badge: Extract<BeachView, { kind: "ready" }>["badge"],
  stale = false,
): BeachView => ({
  kind: "ready",
  category,
  badge,
  reasons: [badge],
  stale,
  confirmedAt: "2026-10-27T05:30:00Z",
  metrics: METRICS,
});

// 스토리에서 넘기는 예시 값도 언어별로 둠(영어 스토리에 한국어가 섞이지 않게)
const SAMPLE = {
  ko: {
    gyeongpo: "경포해수욕장",
    gangmun: "강문해수욕장",
    sangmaengbang: "상맹방해수욕장",
    region: "강원 강릉시",
    regionSamcheok: "강원 삼척시",
    q: "경포",
    alias: "승공",
    clearBasis: "이 해변 특보구역 · 기상청 14:30 확인",
    stale: "14:05 확인 · 이후 확인 못 함",
    recent: ["경포", "광안리", "제주"],
  },
  en: {
    gyeongpo: "Gyeongpo Beach",
    gangmun: "Gangmun Beach",
    sangmaengbang: "Sangmaengbang Beach",
    region: "Gangwon Gangneung",
    regionSamcheok: "Gangwon Samcheok",
    q: "Gyeong",
    alias: "Seunggong",
    clearBasis: "This beach's warning zone · KMA · checked 14:30",
    stale: "Checked 14:05 · not confirmed since",
    recent: ["Gyeongpo", "Gwangalli", "Jeju"],
  },
} as const;

function Gallery({ locale }: { locale: "ko" | "en" }) {
  const s = SAMPLE[locale];
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <main
        style={{ maxWidth: 390, margin: 16 }}
        className="flex flex-col gap-5"
      >
        <h1 className="sr-only">Search</h1>
        <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
          <SearchResultRow
            href="#"
            name={s.gyeongpo}
            region={s.region}
            query={s.q}
            match={{ kind: "name" }}
            view={ready("clear", { kind: "clear" })}
            basis={s.clearBasis}
            onOpen={() => {}}
          />
          <SearchResultRow
            href="#"
            name={s.gangmun}
            region={s.region}
            query={s.q}
            match={{ kind: "region" }}
            view={ready("unavailable", {
              kind: "warning",
              type: "wind_wave",
              level: "advisory",
            })}
            basis={null}
            onOpen={() => {}}
          />
          <SearchResultRow
            href="#"
            name={s.sangmaengbang}
            region={s.regionSamcheok}
            query={s.alias}
            match={{ kind: "alias", alias: s.alias }}
            view={ready("undetermined", { kind: "warning_unknown" }, true)}
            basis={s.stale}
            onOpen={() => {}}
          />
          <SearchResultRow
            href="#"
            name={s.gangmun}
            region={s.region}
            query={s.q}
            match={{ kind: "name" }}
            view={{ kind: "loading" }}
            basis={null}
            onOpen={() => {}}
          />
        </ul>
        <RecentSearches
          items={s.recent.map((q) => ({ q, id: null }))}
          onPick={() => {}}
          onRemove={() => {}}
          onClear={() => {}}
        />
      </main>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/Search",
  component: Gallery,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
