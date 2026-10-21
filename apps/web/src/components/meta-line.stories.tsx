import type { StationRef } from "@baradun/contracts";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { MetaLine } from "./meta-line";

// 메타 정보 한 줄 확인용 (BRD-23 조각 3 · 개발 전용 Storybook)
// 지금 시각을 2026-10-21 14:30(한국 시각)으로 고정
const NOW = Date.parse("2026-10-21T05:30:00Z");

// 예시 측정소(강문해수욕장 data/beaches/b0001.json 값)
const YEONGOK: StationRef = {
  id: "22451",
  name: { ko: "연곡 파고부이", en: "Yeongok wave buoy" },
  distanceKm: 8.3,
};

function Lines() {
  const { observationMeta, warningMeta } = useMetaText();
  // [경우 이름, 글자] 목록. null이면 MetaLine이 아무것도 그리지 않음
  const rows: [string, string | null][] = [
    [
      "측정 있음",
      observationMeta("waveHeight", YEONGOK, "2026-10-21T05:20:00Z", NOW),
    ],
    ["측정 시각 모름", observationMeta("waveHeight", YEONGOK, null, NOW)],
    ["측정소 없음", observationMeta("wavePeriod", null, null, NOW)],
    [
      "특보 오늘 발표",
      warningMeta("강원중부앞바다", "기상청", "2026-10-21T05:05:00Z", NOW),
    ],
    [
      "특보 어제 발표",
      warningMeta("강원중부앞바다", "기상청", "2026-10-20T05:05:00Z", NOW),
    ],
    ["특보 정보 없음", warningMeta(null, null, null, NOW)],
  ];
  return (
    <dl style={{ display: "grid", gap: 12, padding: 16, margin: 0 }}>
      {rows.map(([name, text]) => (
        <div key={name}>
          <dt style={{ fontSize: 12, fontWeight: 700 }}>{name}</dt>
          <dd style={{ margin: 0 }}>
            <MetaLine text={text} />
            {text === null && <span>(그리지 않음)</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MetaTable({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <Lines />
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/MetaLine",
  component: MetaTable,
} satisfies Meta<typeof MetaTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
