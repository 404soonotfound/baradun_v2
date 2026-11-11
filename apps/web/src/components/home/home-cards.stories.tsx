import type { WeatherFile } from "@baradun/contracts";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import example from "../../../../../packages/contracts/examples/valid/weather.json";
import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { NationalMapCard } from "./national-map-card";
import { NearCard } from "./near-card";
import type { Activity } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import type { BadgeLabel, BeachView, MetricView } from "@/lib/snapshot/view";
import { beachWeather, type WeatherView } from "@/lib/snapshot/weather";

// 홈 해변 카드·PC '지금 전국 바다' 카드 확인용 (이슈 #362 · #364 · 노션 D18-5·D18-8 · 개발 전용 Storybook)
// 카드: 활동 3개 × 값 있음(날씨 정상) · 값 없음(가까운 관측 없음·늦어짐·–, 날씨 실패) · 불러오는 중
// 지도 카드: 정상 · 불러오는 중 · 이용 제한·확인 못 함이 섞인 경우. 점 좌표는 예시
// 지금 시각을 계약 날씨 예시(2026-11-05 KST 08:30)에 맞춰 고정
const WEATHER_FILE = example as unknown as WeatherFile;
const NOW = Date.parse("2026-11-04T23:30:00Z");
const MEASURED = "2026-11-04T23:10:00Z";

function beach(
  id: string,
  name: string,
  lat: number,
  lng: number,
  withStations = true,
): BeachSummary {
  const station = withStations
    ? {
        id: "22451",
        name: { ko: "연곡 파고부이", en: "Yeongok buoy" },
        distanceKm: 8.3,
      }
    : null;
  return {
    id,
    slug: id,
    name,
    sido: { key: "강원", label: "강원" },
    sigungu: { key: "강릉시", label: "강릉시" },
    region: "강원 강릉시",
    coords: { lat, lng },
    activities: ["swimming", "surfing", "scuba"],
    stations: {
      waveHeight: station,
      wavePeriod: station,
      waveDirection: station,
      waterTemp: station,
      wind: station,
    },
    warningZones: { sea: "S1151200", land: "L1022510" },
    photo: null,
    names: [name, name],
    aliases: [],
    regionNames: ["강원 강릉시", "Gangwon Gangneung"],
  };
}

const value = (
  v: number,
  unit: "m" | "s" | "deg" | "°C" | "m/s",
): MetricView => ({
  kind: "value",
  value: v,
  unit,
  observedAt: MEASURED,
});

function view(
  badge: BadgeLabel,
  metrics: Partial<
    Record<keyof Extract<BeachView, { kind: "ready" }>["metrics"], MetricView>
  >,
): BeachView {
  return {
    kind: "ready",
    category:
      badge.kind === "clear"
        ? "clear"
        : badge.kind === "warning" || badge.kind === "restricted"
          ? "unavailable"
          : "undetermined",
    badge,
    reasons: [badge],
    stale: false,
    confirmedAt: "2026-11-04T23:13:00Z",
    metrics: {
      waveHeight: { kind: "hidden" },
      wavePeriod: { kind: "hidden" },
      waveDirection: { kind: "hidden" },
      waterTemp: { kind: "hidden" },
      wind: { kind: "hidden" },
      ...metrics,
    },
  };
}

const FULL = view(
  { kind: "clear" },
  {
    waveHeight: value(0.6, "m"),
    wavePeriod: value(6.2, "s"),
    waveDirection: value(158, "deg"),
    waterTemp: value(18.4, "°C"),
    wind: value(3.1, "m/s"),
  },
);
const MISSING = view(
  { kind: "warning", type: "wind_wave", level: "advisory" },
  {
    waveHeight: { kind: "none" },
    wavePeriod: { kind: "delayed" },
    waterTemp: { kind: "hidden" },
    wind: { kind: "none" },
  },
);

const CARDS: {
  beach: BeachSummary;
  view: BeachView;
  weather: WeatherView;
}[] = [
  {
    beach: beach("s1", "강문해수욕장", 37.79, 128.92),
    view: FULL,
    weather: beachWeather(WEATHER_FILE, "b0002"),
  },
  {
    beach: beach("s2", "금진해수욕장", 37.64, 129.05),
    view: MISSING,
    weather: beachWeather(WEATHER_FILE, "b0008"),
  },
  {
    beach: beach("s3", "도직해수욕장", 37.6, 129.07, false),
    view: { kind: "loading" },
    weather: { kind: "loading" },
  },
];

// 지도 카드 점(동해·남해·서해 몇 곳)
const MAP_BEACHES = [
  beach("m1", "a", 38.2, 128.6),
  beach("m2", "b", 37.8, 128.9),
  beach("m3", "c", 37.4, 129.2),
  beach("m4", "d", 36.0, 129.4),
  beach("m5", "e", 35.1, 129.0),
  beach("m6", "f", 34.8, 128.4),
  beach("m7", "g", 34.6, 127.5),
  beach("m8", "h", 34.7, 126.3),
  beach("m9", "i", 35.6, 126.5),
  beach("m10", "j", 36.7, 126.1),
  beach("m11", "k", 33.5, 126.5),
];
const MAP_VIEWS: BeachView[] = MAP_BEACHES.map((_, i) =>
  view(
    i === 3
      ? { kind: "warning", type: "wind_wave", level: "advisory" }
      : i === 5
        ? { kind: "restricted" }
        : i === 7
          ? { kind: "warning_unknown" }
          : i === 8
            ? { kind: "unconfirmed" }
            : i === 9
              ? { kind: "observation_delayed" }
              : { kind: "clear" },
    {},
  ),
);

function Board({
  locale,
  activity,
}: {
  locale: "ko" | "en";
  activity: Activity;
}) {
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
        <ul
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            margin: 0,
            padding: 0,
            listStyle: "none",
          }}
        >
          {CARDS.map(({ beach: b, view: v, weather: w }) => (
            <li key={b.id}>
              <NearCard
                locale={locale}
                beach={b}
                distanceKm={6.2}
                view={v}
                nowMs={NOW}
                activity={activity}
                weather={w}
              />
            </li>
          ))}
        </ul>
        <div style={{ maxWidth: 520 }}>
          <NationalMapCard
            href="/explore/"
            beaches={MAP_BEACHES}
            views={MAP_VIEWS}
            highlightIds={new Set(["m2", "m3"])}
            subtitle={
              locale === "ko"
                ? "공개 해변 11곳 · 큰 점은 강원 강릉시 해변 2곳"
                : "11 public beaches · large dots: 2 beaches in Gangwon Gangneung"
            }
            nowMs={NOW}
          />
        </div>
        <div style={{ maxWidth: 520 }}>
          <NationalMapCard
            href="/explore/"
            beaches={MAP_BEACHES}
            views={MAP_BEACHES.map(() => ({ kind: "loading" }))}
            highlightIds={new Set()}
            subtitle={locale === "ko" ? "공개 해변 11곳" : "11 public beaches"}
            nowMs={NOW}
          />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Home/HomeCards",
  component: Board,
} satisfies Meta<typeof Board>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Swimming: Story = { args: { locale: "ko", activity: "swimming" } };
export const Surfing: Story = { args: { locale: "ko", activity: "surfing" } };
export const Scuba: Story = { args: { locale: "ko", activity: "scuba" } };
export const English: Story = { args: { locale: "en", activity: "surfing" } };
