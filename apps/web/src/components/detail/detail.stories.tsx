import type { Beach } from "@baradun/contracts";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import type { DetailInfo } from "@/lib/snapshot/detail";
import type { BeachView, MetricView } from "@/lib/snapshot/view";
import { WarningSheet } from "@/components/warning-sheet";
import { AltBeaches } from "./alt-beaches";
import { Call119, DetailActions } from "./detail-sections";
import { DetailSheet } from "./detail-sheet";
import { StatGrid } from "./sea-card";
import { VerdictCard } from "./verdict-card";
import { WaveFigure } from "./wave-figure";

// 장소 상세 부품 확인용 (BRD-32 · 개발 전용 Storybook). 상태별 판단 카드 · 대안 해변 · 지표 칸 · 파도 그림 · 119 · 하단 버튼
// 바다 정보 조회를 쓰는 부품(SeaCard 차트·DetailScreen)은 화면 캡처로 확인

const NOW = Date.parse("2026-10-27T05:30:00Z");
const AT = "2026-10-27T05:10:00Z";
const value = (v: number, unit: "m" | "s" | "°C" | "m/s"): MetricView => ({
  kind: "value",
  value: v,
  unit,
  observedAt: AT,
});
const METRICS = {
  waveHeight: value(0.6, "m"),
  wavePeriod: value(6, "s"),
  waveDirection: { kind: "none" },
  waterTemp: value(21.4, "°C"),
  wind: { kind: "delayed" },
} satisfies Extract<BeachView, { kind: "ready" }>["metrics"];

const CLEAR: BeachView = {
  kind: "ready",
  category: "clear",
  badge: { kind: "clear" },
  reasons: [{ kind: "clear" }],
  stale: false,
  confirmedAt: "2026-10-27T05:18:00Z",
  metrics: METRICS,
};
const WARNING = {
  kind: "warning",
  type: "wind_wave",
  level: "advisory",
} as const;
const BLOCKED: BeachView = {
  ...CLEAR,
  category: "unavailable",
  badge: WARNING,
  reasons: [WARNING],
};
const UNKNOWN: BeachView = {
  ...CLEAR,
  category: "undetermined",
  badge: { kind: "warning_unknown" },
  reasons: [{ kind: "warning_unknown" }],
};
const DELAYED: BeachView = {
  ...CLEAR,
  category: "undetermined",
  badge: { kind: "observation_delayed" },
  reasons: [{ kind: "observation_delayed" }],
  metrics: { ...METRICS, waveHeight: { kind: "delayed" } },
};
// B5 예시는 다른 특보로 둠(같은 결론 문장이 한 화면에 둘이면 접근성 검사가 겹친 영역으로 봄)
const STRONG = {
  kind: "warning",
  type: "strong_wind",
  level: "advisory",
} as const;
const STALE: BeachView = {
  ...BLOCKED,
  badge: STRONG,
  reasons: [STRONG],
  stale: true,
};

const BASE: DetailInfo = {
  warnings: [],
  unreadableWarnings: 0,
  basis: [],
  warningSource: "기상청",
  warningConfirmedNone: true,
  offSeason: { openFrom: "2026-07-10", openUntil: "2026-08-20" },
  ripCurrent: null,
  nearbyWarnings: [],
  unreadableNearby: 0,
};
const ITEM = {
  type: "wind_wave",
  level: "advisory",
  zoneCode: "S1151200",
  zoneName: "강원북부앞바다",
  publishedAt: "2026-10-27T04:00:00Z",
  effectiveFrom: "2026-10-27T04:00:00Z",
} as const;
const BLOCKED_DETAIL: DetailInfo = {
  ...BASE,
  warnings: [ITEM],
  warningConfirmedNone: false,
  offSeason: null,
  basis: [
    {
      code: "warning",
      scope: "강원북부앞바다",
      source: "기상청",
      at: ITEM.publishedAt,
    },
  ],
};

const STATIONS: Beach["stations"] = {
  waveHeight: {
    id: "22451",
    name: { ko: "연곡 파고부이", en: "Yeongok wave buoy" },
    distanceKm: 8.3,
  },
  wavePeriod: {
    id: "22520",
    name: { ko: "강릉 해양기상부이", en: "Gangneung marine buoy" },
    distanceKm: 12.6,
  },
  waveDirection: null,
  waterTemp: {
    id: "22451",
    name: { ko: "연곡 파고부이", en: "Yeongok wave buoy" },
    distanceKm: 8.3,
  },
  wind: {
    id: "22520",
    name: { ko: "강릉 해양기상부이", en: "Gangneung marine buoy" },
    distanceKm: 12.6,
  },
};
const BEACH = {
  id: "b0001",
  slug: "gangmun",
  kind: "beach",
  name: { ko: "강문해수욕장", en: "Gangmun Beach" },
  region: {
    sido: { ko: "강원", en: "Gangwon" },
    sigungu: { ko: "강릉시", en: "Gangneung" },
  },
  coast: "east",
  coords: { lat: 37.796618, lng: 128.917591 },
  activities: ["swimming"],
  hidden: false,
  warningZones: { sea: "S1151200", land: "L1022510" },
  stations: STATIONS,
  photo: null,
  cctv: null,
} satisfies Beach;

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ width: 384 }} className="flex flex-col gap-3">
      <p className="text-caption text-text-muted">{title}</p>
      {children}
    </div>
  );
}

// altEmpty: 대안 해변 빈 상태(같은 이름의 카드가 한 화면에 둘이면 접근성 검사가 겹친 영역으로 봐서 따로 둠)
function Gallery({
  locale,
  altEmpty = false,
  sheet,
}: {
  locale: "ko" | "en";
  altEmpty?: boolean;
  // 열어 둔 시트(BRD-33). 시트는 한 번에 하나만 열림
  sheet?: "detail" | "warning";
}) {
  const alt = {
    ...BEACH,
    name: BEACH.name[locale],
    sido: { key: "강원", label: BEACH.region.sido[locale] },
    sigungu: { key: "강릉시", label: BEACH.region.sigungu[locale] },
    region: `${BEACH.region.sido[locale]} ${BEACH.region.sigungu[locale]}`,
    names: [BEACH.name.ko, BEACH.name.en],
    aliases: [],
    regionNames: [],
    distanceKm: 2.5,
    view: CLEAR,
    warningSource: "기상청",
  };
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div
        style={{ padding: 16 }}
        className="flex flex-wrap items-start gap-6 bg-bg-page"
      >
        <DetailSheet
          open={sheet === "detail"}
          onClose={() => {}}
          view={DELAYED}
          detail={{ ...BASE, offSeason: null }}
          stations={STATIONS}
          nowMs={NOW}
          kmaData
        />
        <WarningSheet
          open={sheet === "warning"}
          onClose={() => {}}
          item={ITEM}
          items={[ITEM]}
          source="기상청"
          confirmedAt={CLEAR.kind === "ready" ? CLEAR.confirmedAt : null}
          stale={false}
          nowMs={NOW}
          sourceShown
        />
        <Column title="clear + off-season">
          <VerdictCard
            beachId="b0001"
            view={CLEAR}
            detail={BASE}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
          <DetailActions beach={BEACH} view={CLEAR} />
        </Column>
        <Column title="unavailable">
          <VerdictCard
            beachId="b0002"
            view={BLOCKED}
            detail={BLOCKED_DETAIL}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
          <DetailActions beach={BEACH} view={BLOCKED} />
          <AltBeaches
            locale={locale}
            items={altEmpty ? [] : [alt]}
            nowMs={NOW}
          />
        </Column>
        <Column title="warning unknown · delayed · B5 · loading">
          <VerdictCard
            beachId="b0003"
            view={UNKNOWN}
            detail={{ ...BASE, warningConfirmedNone: false, offSeason: null }}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
          <VerdictCard
            beachId="b0003"
            view={DELAYED}
            detail={{ ...BASE, offSeason: null }}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
          <VerdictCard
            beachId="b0002"
            view={STALE}
            detail={{
              ...BLOCKED_DETAIL,
              basis: [],
              warnings: [{ ...ITEM, type: "strong_wind" }],
            }}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
          <VerdictCard
            beachId="b0001"
            view={{ kind: "loading" }}
            detail={BASE}
            stations={STATIONS}
            nowMs={NOW}
            kmaSource
          />
        </Column>
        <Column title="stats · figure · 119">
          <StatGrid
            view={CLEAR}
            stations={STATIONS}
            ripCurrent={null}
            nowMs={NOW}
          />
          <WaveFigure height={0.6} period={6} />
          <WaveFigure height={2.4} period={null} />
          <WaveFigure height={null} period={null} />
          <WaveFigure height={null} period={null} delayed />
          <Call119 />
        </Column>
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Detail/Parts",
  component: Gallery,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
export const AltEmpty: Story = { args: { locale: "ko", altEmpty: true } };
export const DetailSheetOpen: Story = {
  args: { locale: "ko", sheet: "detail" },
};
export const WarningSheetEnglish: Story = {
  args: { locale: "en", sheet: "warning" },
};
