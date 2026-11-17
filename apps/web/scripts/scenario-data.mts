// 상태별 가짜 바다 데이터 (#550). E2E 픽스처(e2e/fixtures.ts)와 개발 시나리오(scripts/dev-scenario.mts)가 함께 씀
// 해변 목록·측정소 id·날씨 대응표는 빌드에 들어간 실제 data/만 받아 쓰고, 특보·관측값·공지는 모두 여기서 만든 가짜 값
// 가짜 특보 구역 이름은 '시험 …'으로 표시. 비밀값·사용자 위치는 넣지 않음
// Playwright(CommonJS로 읽음)와 Node(.mts 그대로 실행)가 함께 읽으므로 import.meta·__dirname을 쓰지 않음(경로는 부르는 쪽이 넘김)
import type { Beach } from "@baradun/contracts";
import {
  METRIC_EXPIRY_MS,
  WARNING_CONFIRMATION_TTL_MS,
} from "@baradun/contracts/judgment-policy";

export const MIN = 60_000;

// 상태를 따로 정하는 해변(강릉시 4곳). E2E 픽스처와 개발 시나리오가 같은 해변을 씀
export const SAMPLE_IDS = {
  clear: "b0001",
  warning: "b0002",
  delayed: "b0003",
  unknown: "b0004",
} as const;

// 측정소가 하나도 없고 날씨 대응표에는 있는 노출 해변(BRD-185). 데이터를 다시 만들어도 조건으로 고름
export function noStationBeachId(
  beaches: readonly Beach[],
  areas: WeatherAreas,
): string {
  const found = beaches.find(
    (beach) =>
      !beach.hidden &&
      Object.values(beach.stations).every((station) => !station) &&
      beach.id in areas,
  );
  if (!found) throw new Error("측정소 없는 노출 해변이 데이터에 없음");
  return found.id;
}
export const iso = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
export const versionOf = (ms: number) => iso(ms).replace(/[-:]/g, "");

type MetricKey = keyof Beach["stations"];
const UNITS: Record<MetricKey, string> = {
  waveHeight: "m",
  wavePeriod: "s",
  waveDirection: "deg",
  waterTemp: "°C",
  wind: "m/s",
};
// 지표별 유효시간(분). 판단 정책 상수 그대로(파주기·파향 60분, 나머지 90분, D20-5)
const validMin = (key: MetricKey) => METRIC_EXPIRY_MS[key] / MIN;
// 관측 지연 예시: 파고 유효시간을 30분 넘긴 관측(지금 정책 120분 전)
const DELAYED_AGO_MIN = validMin("waveHeight") + 30;
// 특보 확인 못 함 예시: 확인 유효시간을 35분 넘긴 마지막 확인(지금 정책 80분 전)
const UNCONFIRMED_AGO_MIN = WARNING_CONFIRMATION_TTL_MS / MIN + 35;
const VALUES: Record<MetricKey, number> = {
  waveHeight: 0.6,
  wavePeriod: 6.2,
  waveDirection: 90,
  waterTemp: 18.4,
  wind: 3.1,
};

function metric(key: MetricKey, beach: Beach, now: number, delayed = false) {
  const none = {
    value: null,
    unit: UNITS[key],
    observedAt: null,
    state: "none",
    nextExpectedAt: null,
    expiresAt: null,
  };
  if (!beach.stations[key]) return none;
  if (delayed) {
    // 파고 측정 지연(90분 초과, B4): 값은 게시돼도 화면은 숨겨야 함
    return {
      value: 0.9,
      unit: UNITS[key],
      observedAt: iso(now - DELAYED_AGO_MIN * MIN),
      state: "delayed",
      nextExpectedAt: iso(now + 30 * MIN),
      expiresAt: iso(now - (DELAYED_AGO_MIN - validMin(key)) * MIN),
    };
  }
  return {
    value: VALUES[key],
    unit: UNITS[key],
    observedAt: iso(now - 20 * MIN),
    state: "fresh",
    nextExpectedAt: iso(now + 40 * MIN),
    expiresAt: iso(now + (validMin(key) - 20) * MIN),
  };
}

function metrics(beach: Beach, now: number, delayedWave = false) {
  return Object.fromEntries(
    (Object.keys(UNITS) as MetricKey[]).map((key) => [
      key,
      metric(key, beach, now, delayedWave && key === "waveHeight"),
    ]),
  );
}

// 해변별 상태 지정. 목록에 없는 해변은 '특보 없음'
export interface StatusMarks {
  warning?: readonly string[];
  delayed?: readonly string[];
  unknown?: readonly string[];
  // 이안류(정보만) 가짜 값을 붙일 해변(정보 출처의 국립해양조사원 출처 줄 확인용, BRD-113)
  ripCurrent?: string | null;
}

export interface StatusOptions {
  // 특보 마지막 확인 시각(지금 기준 분). 기본 10분 전
  confirmedAgoMin?: number;
  // 모든 해변을 '특보 확인 못 함'으로(확인된 판단 없음)
  allUnknown?: boolean;
}

function beachStatus(
  beach: Beach,
  now: number,
  marks: StatusMarks,
  options: StatusOptions,
) {
  const confirmedAt = iso(now - (options.confirmedAgoMin ?? 10) * MIN);
  const ripCurrent =
    beach.id === marks.ripCurrent
      ? {
          label: "시험 관심",
          publishedAt: iso(now - 30 * MIN),
          source: "국립해양조사원",
        }
      : null;
  const common = {
    control: { state: "not_provided" },
    info: { season: null, ripCurrent, nearbyWarnings: [] },
    validUntil: iso(now + 30 * MIN),
  };
  const unknown = {
    ...common,
    category: "undetermined",
    reasons: [
      {
        code: "warning_unknown",
        scope: "특보구역",
        source: "기상청",
        at: null,
      },
    ],
    warning: {
      state: "unknown",
      items: [],
      source: "기상청",
      lastConfirmedAt: iso(now - UNCONFIRMED_AGO_MIN * MIN),
    },
    observation: { metrics: metrics(beach, now) },
  };
  if (options.allUnknown || marks.unknown?.includes(beach.id)) return unknown;
  if (marks.warning?.includes(beach.id)) {
    const item = {
      type: "wind_wave",
      level: "advisory",
      zoneCode: beach.warningZones.sea,
      zoneName: "시험 앞바다",
      publishedAt: iso(now - 60 * MIN),
      effectiveFrom: iso(now - 60 * MIN),
    };
    return {
      ...common,
      category: "unavailable",
      reasons: [
        {
          code: "warning",
          type: "wind_wave",
          level: "advisory",
          scope: "시험 앞바다",
          source: "기상청",
          at: item.effectiveFrom,
        },
      ],
      warning: {
        state: "active",
        items: [item],
        source: "기상청",
        lastConfirmedAt: confirmedAt,
      },
      observation: { metrics: metrics(beach, now) },
    };
  }
  const warningNone = {
    state: "none",
    items: [],
    source: "기상청",
    lastConfirmedAt: confirmedAt,
  };
  if (marks.delayed?.includes(beach.id)) {
    return {
      ...common,
      category: "undetermined",
      reasons: [
        {
          code: "observation_delayed",
          scope: beach.stations.waveHeight?.name.ko ?? "파고 측정소",
          source: "기상청",
          at: iso(now - DELAYED_AGO_MIN * MIN),
        },
      ],
      warning: warningNone,
      observation: { metrics: metrics(beach, now, true) },
    };
  }
  return {
    ...common,
    category: "clear",
    reasons: [],
    warning: warningNone,
    observation: { metrics: metrics(beach, now) },
  };
}

export function statusFile(
  beaches: readonly Beach[],
  now: number,
  marks: StatusMarks,
  options: StatusOptions = {},
) {
  return {
    beaches: Object.fromEntries(
      beaches.map((beach) => [
        beach.id,
        beachStatus(beach, now, marks, options),
      ]),
    ),
  };
}

export function manifestFile(now: number, extra: Record<string, unknown> = {}) {
  const version = versionOf(now - 5 * MIN);
  return {
    schemaVersion: 1,
    snapshotVersion: version,
    policyVersion: "warnings-1+observations-1",
    generatedAt: iso(now - 5 * MIN),
    maintenance: { active: false, until: null },
    minWebBuild: 1,
    files: {
      beaches: `/data/${version}/beaches.json`,
      status: `/data/${version}/status.json`,
      history: `/data/${version}/history.json`,
      nationwideWarnings: `/data/${version}/nationwide-warnings.json`,
      weather: `/data/${version}/weather.json`,
    },
    ...extra,
  };
}

// 공지 칸(BRD-151). 지금 보일 공지는 점검 예고(시작이 이른 것)와 일반 공지 → 점검 예고 하나만 보여야 함
// withInvalid: 게시본에는 나올 수 없는 공지(시작 전·모르는 종류)도 넣음. 화면이 거르는지 보는 E2E 전용
export function noticesOf(now: number, { withInvalid = false } = {}) {
  const text = (ko: string, en: string) => ({ ko, en });
  const notice = (
    id: string,
    kind: string,
    title: [string, string],
    startsAt: number,
    endsAt: number | null,
  ) => ({
    id,
    kind,
    title: text(...title),
    body: text(
      "새벽 2시부터 3시까지 정보가 늦게 바뀔 수 있어요.",
      "Information may update late from 2 to 3 a.m.",
    ),
    startsAt: iso(startsAt),
    endsAt: endsAt === null ? null : iso(endsAt),
  });
  const published = [
    notice(
      "n-general",
      "general",
      ["새 해변을 더했어요", "New beaches added"],
      now - 10 * MIN,
      null,
    ),
    notice(
      "n-maint",
      "maintenance_notice",
      ["데이터 점검 예고", "Planned data maintenance"],
      now - 60 * MIN,
      now + 120 * MIN,
    ),
    notice(
      "n-ended",
      "maintenance_notice",
      ["끝난 점검 예고", "Ended maintenance"],
      now - 120 * MIN,
      now - MIN,
    ),
  ];
  if (!withInvalid) return published;
  return [
    ...published,
    notice(
      "n-later",
      "maintenance_notice",
      ["시작 전 점검 예고", "Upcoming maintenance"],
      now + 60 * MIN,
      null,
    ),
    notice(
      "n-broken",
      "urgent",
      ["모르는 종류 공지", "Unknown notice"],
      now - 5 * MIN,
      null,
    ),
  ];
}

export function historyFile(beaches: readonly Beach[], now: number) {
  const ids = new Set(
    beaches.flatMap((beach) =>
      beach.stations.waveHeight ? [beach.stations.waveHeight.id] : [],
    ),
  );
  return {
    stations: Object.fromEntries(
      [...ids].map((id) => [
        id,
        {
          unit: "m",
          points: [3, 2, 1].map((hours, index) => ({
            t: iso(now - hours * 60 * MIN),
            v: [0.5, 0.6, 0.6][index],
          })),
        },
      ]),
    ),
  };
}

export function nationwideFile(now: number, { confirmed = true } = {}) {
  return {
    lastConfirmedAt: confirmed ? iso(now - 10 * MIN) : null,
    items: [],
  };
}

// 날씨 대응표(data/weather-areas.json의 beaches)
export type WeatherAreas = Record<
  string,
  {
    grid: { nx: number; ny: number };
    midLand: { regId: string };
    midTa: { regId: string };
  }
>;

// 날씨 파일(계약 WeatherFile). midFailed: 중기 구역 값 없음 / failed: 파일 자체를 못 받음(경로가 404)
export type WeatherMode = "ok" | "midFailed" | "failed";
const KST = 9 * 60 * MIN;
const kstDate = (ms: number) => new Date(ms + KST).toISOString().slice(0, 10);
export function weatherFile(
  areas: WeatherAreas,
  now: number,
  mode: WeatherMode,
) {
  // 오늘(KST) 00시부터 모레 21시까지 3시간 간격. 발표 시각은 지금 2시간 전
  const todayKst = Date.parse(`${kstDate(now)}T00:00:00Z`) - KST;
  const points = Array.from({ length: 24 }, (_, i) => ({
    at: iso(todayKst + i * 3 * 60 * MIN),
    sky: (["clear", "mostlyCloudy", "cloudy"] as const)[i % 3],
    precip: i % 8 === 5 ? "rain" : "none",
    temperature: 10 + (i % 6),
    pop: i % 8 === 5 ? 70 : (i % 4) * 10,
    windFrom: (i * 45) % 360,
    windSpeed: 2 + (i % 5),
  }));
  const day = (offset: number) => kstDate(now + offset * 24 * 60 * MIN);
  const grids: Record<string, unknown> = {};
  const beaches: Record<string, unknown> = {};
  const land = new Set<string>();
  const ta = new Set<string>();
  for (const [id, area] of Object.entries(areas)) {
    const grid = `${area.grid.nx},${area.grid.ny}`;
    beaches[id] = {
      grid,
      midLand: area.midLand.regId,
      midTa: area.midTa.regId,
    };
    land.add(area.midLand.regId);
    ta.add(area.midTa.regId);
    grids[grid] = {
      short: {
        issuedAt: iso(now - 2 * 60 * MIN),
        points,
        days: [
          {
            date: day(3),
            pop: 30,
            popAt: iso(Date.parse(`${day(3)}T06:00:00Z`) - KST),
            sky: "cloudy",
            precip: "none",
            min: 6,
            max: 13,
          },
        ],
      },
      today: {
        date: day(0),
        min: 9,
        minIssuedAt: iso(now - 9 * 60 * MIN),
        max: 16,
        maxIssuedAt: iso(now - 9 * 60 * MIN),
      },
      now: { observedAt: iso(now - 40 * MIN), temperature: 14.2 },
    };
  }
  const midDays = [4, 5, 6].map(day);
  return {
    beaches,
    grids,
    midLand:
      mode === "midFailed"
        ? {}
        : Object.fromEntries(
            [...land].map((regId) => [
              regId,
              {
                name: "시험 구역",
                days: midDays.map((date, i) => ({
                  date,
                  issuedAt: iso(now - 6 * 60 * MIN),
                  pop: [10, 0, 20][i],
                  sky: (["mostlyCloudy", "clear", "mostlyCloudy"] as const)[i],
                  precip: "none",
                })),
              },
            ]),
          ),
    midTa: Object.fromEntries(
      [...ta].map((regId) => [
        regId,
        {
          name: "시험 지점",
          days: midDays.map((date, i) => ({
            date,
            issuedAt: iso(now - 6 * 60 * MIN),
            min: 7 + i,
            max: 15 + i,
          })),
        },
      ]),
    ),
  };
}
