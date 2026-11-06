import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { ActivityEmpty } from "./activity-empty";
import { ReasonChips } from "./reason-chips";
import type { StatusCount } from "@/lib/status-count";

// 홈 해변 묶음 패널의 새 부품 확인용 (이슈 #362 · 노션 D18-5·D18-6 · 개발 전용 Storybook)
// 사유별 개수(정상 · 불러오는 중 · 오래됨)와 활동 해변 없음(전국 0곳 · 지역에만 없음)
// 지금 시각을 2026-11-06 14:30(한국 시각)으로 고정
const NOW = Date.parse("2026-11-06T05:30:00Z");

const COUNTS: StatusCount[] = [
  { category: "clear", label: { kind: "clear" }, count: 16 },
  {
    category: "unavailable",
    label: { kind: "warning", type: "wind_wave", level: "advisory" },
    count: 1,
  },
  {
    category: "undetermined",
    label: { kind: "observation_delayed" },
    count: 1,
  },
  { category: "undetermined", label: { kind: "warning_unknown" }, count: 1 },
];

const noop = () => {};
// 대신 찾아보기 줄 글은 부르는 쪽(home-screen)이 문구 키로 만듦. 여기서는 언어별 완성 글로 둠
const ALTERNATIVES = {
  ko: [
    { key: "swimming", label: "수영 해변 · 강원 강릉시 19곳", onSelect: noop },
    { key: "surfing", label: "서핑 해변 · 강원 강릉시 3곳", onSelect: noop },
  ],
  en: [
    {
      key: "swimming",
      label: "Swimming beaches · 강원 강릉시 (19)",
      onSelect: noop,
    },
    {
      key: "surfing",
      label: "Surfing beaches · 강원 강릉시 (3)",
      onSelect: noop,
    },
  ],
};
const NATIONWIDE_ALT = {
  ko: [{ key: "nationwide", label: "전국 서핑 해변 14곳", onSelect: noop }],
  en: [
    {
      key: "nationwide",
      label: "Surfing beaches nationwide (14)",
      onSelect: noop,
    },
  ],
};

function Panel({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div
        style={{ display: "grid", gap: 24, padding: 16, maxWidth: 1180 }}
        className="bg-bg-page"
      >
        <ReasonChips
          counts={COUNTS}
          clearCheckedAt="2026-11-06T05:13:00Z"
          staleChecked={null}
          nowMs={NOW}
        />
        <ReasonChips
          counts={null}
          clearCheckedAt={null}
          staleChecked={null}
          nowMs={NOW}
        />
        <ReasonChips
          counts={COUNTS.slice(1)}
          clearCheckedAt={null}
          staleChecked={{ confirmedAt: "2026-11-06T04:01:00Z" }}
          nowMs={NOW}
        />
        <ActivityEmpty
          locale={locale}
          activity="scuba"
          place="강원 강릉시"
          nationwideZero
          alternatives={ALTERNATIVES[locale]}
        />
        <ActivityEmpty
          locale={locale}
          activity="surfing"
          place="강원 고성군"
          nationwideZero={false}
          alternatives={NATIONWIDE_ALT[locale]}
        />
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Home/HomePanel",
  component: Panel,
} satisfies Meta<typeof Panel>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
