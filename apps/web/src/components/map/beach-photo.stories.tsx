import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { BeachIllustration } from "@/components/beach-illustration";
import type { ExploreItem } from "@/lib/explore";
import type { BeachView } from "@/lib/snapshot/view";
import { MapCard } from "./map-card";

// 사진 없는 해변 그림 확인용 (GH-527 · 결정 기록 29장 D29-4, 개발 전용 Storybook)
// 지도 카드(사진 없음 · 사진 받기 실패 · 사진 있음)와 작은 썸네일(48 · 56×42 · 72×56). 상태·시각은 예시 값

const NOW = Date.parse("2026-11-16T08:05:00Z");
const VIEW: BeachView = {
  kind: "ready",
  category: "clear",
  badge: { kind: "clear" },
  reasons: [{ kind: "clear" }],
  stale: false,
  confirmedAt: "2026-11-16T08:01:00Z",
  metrics: {
    waveHeight: { kind: "none" },
    wavePeriod: { kind: "none" },
    waveDirection: { kind: "none" },
    waterTemp: { kind: "none" },
    wind: { kind: "none" },
  },
};
const NO_STATIONS = {
  waveHeight: null,
  wavePeriod: null,
  waveDirection: null,
  waterTemp: null,
  wind: null,
};
const SAMPLE_PHOTO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 4"><rect width="8" height="2" fill="#9cc7e8"/><rect y="2" width="8" height="1" fill="#2c7fb8"/><rect y="3" width="8" height="1" fill="#e2cfa5"/></svg>',
)}`;
const SACHEONJIN: ExploreItem = {
  id: "b0004",
  slug: "sacheonjin",
  name: "사천진해수욕장",
  sido: { key: "강원", label: "강원" },
  sigungu: { key: "강릉시", label: "강릉시" },
  region: "강원 강릉시",
  coords: { lat: 37.84, lng: 128.87 },
  activities: ["swimming"],
  stations: NO_STATIONS,
  warningZones: { sea: "S1151200", land: "L1022510" },
  photo: null,
  names: ["사천진해수욕장", "Sacheonjin Beach"],
  aliases: [],
  regionNames: ["강원 강릉시", "Gangwon Gangneung"],
  distanceKm: null,
  view: VIEW,
};
const GYEONGPO: ExploreItem = {
  ...SACHEONJIN,
  id: "b0002",
  slug: "gyeongpo",
  name: "경포해수욕장",
  photo: {
    // 바깥 주소 대신 스토리 안 그림(네트워크가 막혀도 '사진 있음'으로 보이게). 실제 사진 아님
    url: SAMPLE_PHOTO,
    source: "한국관광공사",
    license: "kogl-type1",
    title: "경포해수욕장",
  },
};
// 받을 수 없는 주소(사진 받기 실패 → 같은 그림)
const BROKEN: ExploreItem = {
  ...GYEONGPO,
  photo: { ...GYEONGPO.photo!, url: "/__no-such-photo__.jpg" },
};

function Cards({ locale }: { locale: "ko" | "en" }) {
  return (
    <div style={{ maxWidth: 380, margin: 16 }} className="flex flex-col gap-4">
      {[SACHEONJIN, BROKEN, GYEONGPO].map((item, index) => (
        <MapCard
          key={index}
          locale={locale}
          item={item}
          nowMs={NOW}
          onClose={() => {}}
        />
      ))}
    </div>
  );
}

function Thumbnails() {
  return (
    <div
      style={{ margin: 16 }}
      className="flex items-center gap-4 rounded-card bg-bg-surface p-4 shadow-card"
    >
      <BeachIllustration className="size-12 shrink-0 rounded-[10px]" />
      <BeachIllustration className="h-[42px] w-14 shrink-0 rounded-[9px]" />
      <BeachIllustration className="h-14 w-[72px] shrink-0 rounded-[12px]" />
    </div>
  );
}

const meta = {
  title: "Components/BeachPhoto",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const 지도카드: Story = {
  render: () => (
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <Cards locale="ko" />
    </NextIntlClientProvider>
  ),
};
export const MapCardEnglish: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Seoul">
      <Cards locale="en" />
    </NextIntlClientProvider>
  ),
};
export const 썸네일: Story = {
  render: () => (
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <Thumbnails />
    </NextIntlClientProvider>
  ),
};
