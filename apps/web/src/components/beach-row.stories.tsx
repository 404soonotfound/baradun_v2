import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import type { MetricView } from "@/lib/snapshot/view";
import { BeachRow } from "./beach-row";

// 해변 행 확인용 (BRD-81 · 개발 전용 Storybook). Figma lrow(173:570)·즐겨찾기 행(178:111)·최근 본 행(178:197)
const WAVE: MetricView = {
  kind: "value",
  value: 0.6,
  unit: "m",
  observedAt: "2026-10-21T05:20:00Z",
};

// 스토리에서 넘기는 예시 값도 언어별로 둠(영어 스토리에 한국어가 섞이지 않게)
const SAMPLE = {
  ko: {
    ingu: "인구해변",
    samcheok: "삼척해수욕장",
    mangsang: "망상해수욕장",
    gyeongpo: "경포해변",
    songjeong: "송정해수욕장",
    inguMeta: "강원 양양 · 2.1km · 10분 전 측정",
    inguMetaShort: "강원 양양 · 2.1km",
    samcheokMeta: "강원 삼척 · 18.4km · 20분 전 측정",
    mangsangMeta: "강원 동해 · 9.8km",
    gyeongpoMeta: "강원 강릉 · 12.0km",
    songjeongMeta: "부산 해운대 · 1.2km · 5분 전 측정",
    wave: "파고 0.6m · 주기 6초",
    highSeas: "풍랑주의보",
    checked: "14:20 확인 · 변경 없음",
    wasClear: "특보 없음",
    remove: "인구해변 최근 본 기록에서 지우기",
  },
  en: {
    ingu: "Ingu Beach",
    samcheok: "Samcheok Beach",
    mangsang: "Mangsang Beach",
    gyeongpo: "Gyeongpo Beach",
    songjeong: "Songjeong Beach",
    inguMeta: "Yangyang, Gangwon · 2.1km · measured 10 min ago",
    inguMetaShort: "Yangyang, Gangwon · 2.1km",
    samcheokMeta: "Samcheok, Gangwon · 18.4km · measured 20 min ago",
    mangsangMeta: "Donghae, Gangwon · 9.8km",
    gyeongpoMeta: "Gangneung, Gangwon · 12.0km",
    songjeongMeta: "Haeundae, Busan · 1.2km · measured 5 min ago",
    wave: "Wave height 0.6m · period 6s",
    highSeas: "High seas advisory",
    checked: "Checked 14:20 · no change",
    wasClear: "No warnings",
    remove: "Remove Ingu Beach from recently viewed",
  },
} as const;

function Rows({ locale }: { locale: "ko" | "en" }) {
  const s = SAMPLE[locale];
  return (
    <ul
      style={{ maxWidth: 390, margin: 16, listStyle: "none", padding: 0 }}
      className="overflow-hidden rounded-card bg-bg-surface shadow-card"
    >
      <li>
        <BeachRow
          href="#"
          name={s.ingu}
          meta={s.inguMeta}
          wave={WAVE}
          detail={s.wave}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.samcheok}
          meta={s.samcheokMeta}
          wave={WAVE}
          detail={s.highSeas}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.mangsang}
          meta={s.mangsangMeta}
          wave={{ kind: "hidden" }}
          detail={null}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.ingu}
          meta={s.inguMeta}
          wave={WAVE}
          status={{ kind: "clear" }}
          detail={s.checked}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.gyeongpo}
          meta={s.gyeongpoMeta}
          wave={{ kind: "none" }}
          status={{ kind: "warning", type: "strong_wind", level: "advisory" }}
          detail={null}
          changedFrom={s.wasClear}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.songjeong}
          meta={s.songjeongMeta}
          wave={WAVE}
          detail={s.wave}
          highlight
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name={s.ingu}
          meta={s.inguMetaShort}
          wave={WAVE}
          status={{ kind: "warning_unknown" }}
          detail={null}
          onRemove={() => {}}
          removeLabel={s.remove}
        />
      </li>
    </ul>
  );
}

function RowList({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <Rows locale={locale} />
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/BeachRow",
  component: RowList,
} satisfies Meta<typeof RowList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
