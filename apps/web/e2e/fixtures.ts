import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Beach } from "@baradun/contracts";
import { NOTICE_VERSION } from "../src/lib/notice-version";
import { beachZonesText } from "../src/lib/zone-name";
import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

// E2E 가짜 바다 데이터 (BRD-39). /data/** 요청을 page.route로 받아 상태별 화면을 재현함
// 실제 운영 데이터·외부 타일 서버에 기대지 않음: 해변 목록은 빌드에 들어간 data/beaches의 id·측정소 id만 읽고,
// 특보·관측값은 모두 여기서 만든 가짜 값(구역 이름은 '시험 …'으로 표시). 비밀값·사용자 위치는 넣지 않음

// Playwright가 테스트 파일을 CommonJS로 읽어서 import.meta 대신 __dirname을 씀
const REPO = path.join(__dirname, "../../..");
const BEACH_DIR = path.join(REPO, "data/beaches");

const BEACHES: Beach[] = readdirSync(BEACH_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map(
    (file) =>
      JSON.parse(readFileSync(path.join(BEACH_DIR, file), "utf8")) as Beach,
  );

// 날씨 대응표(BRD-185). 해변 → 격자·중기 구역·기온 지점은 빌드에 들어간 대응표 그대로, 예보 값은 가짜
const WEATHER_AREAS = JSON.parse(
  readFileSync(path.join(REPO, "data/weather-areas.json"), "utf8"),
).beaches as Record<
  string,
  {
    grid: { nx: number; ny: number };
    midLand: { regId: string };
    midTa: { regId: string };
  }
>;

// 상태를 따로 정한 해변(강릉시 4곳). 나머지는 '특보 없음'
export const CLEAR_ID = "b0001";
export const WARNING_ID = "b0002";
export const DELAYED_ID = "b0003";
export const UNKNOWN_ID = "b0004";
export const slugOf = (id: string) =>
  BEACHES.find((beach) => beach.id === id)?.slug ?? id;
// '특보 없음' 근거 줄의 해변 특보구역 이름(한국어, D18-11): "강원중부앞바다, 강릉평지"
export const zonesOf = (id: string): string => {
  const beach = BEACHES.find((item) => item.id === id);
  const text = beach ? beachZonesText(beach.warningZones, "ko") : null;
  if (!text) throw new Error(`특보구역 이름 없음: ${id}`);
  return text;
};
export const coordsOf = (id: string) =>
  BEACHES.find((beach) => beach.id === id)?.coords ?? null;
// 측정소가 하나도 없고 날씨 대응표에는 있는 노출 해변(BRD-185). 데이터를 다시 만들어도 조건으로 고름
export const NO_STATION_ID = (() => {
  const found = BEACHES.find(
    (beach) =>
      !beach.hidden &&
      Object.values(beach.stations).every((station) => !station) &&
      beach.id in WEATHER_AREAS,
  );
  if (!found) throw new Error("측정소 없는 노출 해변이 데이터에 없음");
  return found.id;
})();
// 노출 중인 해변 수(홈 '전국' 개수 카드 확인용, BRD-127)
export const PUBLIC_BEACH_COUNT = BEACHES.filter(
  (beach) => !beach.hidden,
).length;

// 기본 지역 저장값(시험용 지역 선택, 사용자 위치 아님). 처음 방문을 볼 때는 deviceRegion: null
export const GANGNEUNG_REGION = JSON.stringify({
  sido: "강원",
  sigungu: "강릉시",
});

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const versionOf = (ms: number) => iso(ms).replace(/[-:]/g, "");

type MetricKey = keyof Beach["stations"];
const UNITS: Record<MetricKey, string> = {
  waveHeight: "m",
  wavePeriod: "s",
  waveDirection: "deg",
  waterTemp: "°C",
  wind: "m/s",
};
// 지표별 유효시간(분). 파주기·파향 60분, 나머지 90분(view.ts METRIC_VALID_MS와 같음)
const VALID_MIN: Record<MetricKey, number> = {
  waveHeight: 90,
  wavePeriod: 60,
  waveDirection: 60,
  waterTemp: 90,
  wind: 90,
};
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
      observedAt: iso(now - 120 * MIN),
      state: "delayed",
      nextExpectedAt: iso(now + 30 * MIN),
      expiresAt: iso(now - 30 * MIN),
    };
  }
  return {
    value: VALUES[key],
    unit: UNITS[key],
    observedAt: iso(now - 20 * MIN),
    state: "fresh",
    nextExpectedAt: iso(now + 40 * MIN),
    expiresAt: iso(now + (VALID_MIN[key] - 20) * MIN),
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

interface StatusOptions {
  // 특보 마지막 확인 시각(지금 기준 분). 기본 10분 전
  confirmedAgoMin?: number;
  // 모든 해변을 '특보 확인 못 함'으로(확인된 판단 없음)
  allUnknown?: boolean;
}

function beachStatus(beach: Beach, now: number, options: StatusOptions) {
  const confirmedAt = iso(now - (options.confirmedAgoMin ?? 10) * MIN);
  // 이안류(정보만)는 '특보 없음' 해변 하나에만 가짜 값(정보 출처의 국립해양조사원 출처 줄 확인용, BRD-113)
  const ripCurrent =
    beach.id === CLEAR_ID
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
      lastConfirmedAt: iso(now - 80 * MIN),
    },
    observation: { metrics: metrics(beach, now) },
  };
  if (options.allUnknown || beach.id === UNKNOWN_ID) return unknown;
  if (beach.id === WARNING_ID) {
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
  if (beach.id === DELAYED_ID) {
    return {
      ...common,
      category: "undetermined",
      reasons: [
        {
          code: "observation_delayed",
          scope: beach.stations.waveHeight?.name.ko ?? "파고 측정소",
          source: "기상청",
          at: iso(now - 120 * MIN),
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

function statusFile(now: number, options: StatusOptions = {}) {
  return {
    beaches: Object.fromEntries(
      BEACHES.map((beach) => [beach.id, beachStatus(beach, now, options)]),
    ),
  };
}

function manifestFile(now: number, extra: Record<string, unknown> = {}) {
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
function noticesOf(now: number) {
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
  return [
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

function historyFile(now: number) {
  const ids = new Set(
    BEACHES.flatMap((beach) =>
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

// 날씨 파일(계약 WeatherFile). midFailed: 중기 구역 값 없음 / failed: 파일 자체를 못 받음(경로가 404)
type WeatherMode = "ok" | "midFailed" | "failed";
const KST = 9 * 60 * MIN;
const kstDate = (ms: number) => new Date(ms + KST).toISOString().slice(0, 10);
function weatherFile(now: number, mode: WeatherMode) {
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
  for (const [id, area] of Object.entries(WEATHER_AREAS)) {
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

type Scenario =
  | "normal" // 정상(특보 없음·이용불가·관측 지연·특보 확인 못 함이 섞임)
  | "loading" // manifest 응답 없음
  | "noData" // 처음 열었는데 데이터를 못 받음(저장된 값 없음)
  | "noConfirmed" // 확인된 판단 없음: 모든 해변 특보 확인 못 함
  | "maintenance" // 점검
  | "update" // 강제 업데이트(minWebBuild가 화면 빌드보다 높음)
  | "futureConfirm" // 특보 확인 시각이 2분 넘게 미래(믿지 않음)
  | "missingWarning" // 계약 필수 칸(warning) 빠짐
  | "notice"; // 운영자 공지(BRD-151): 보일 공지 둘·끝난 공지·시작 전 공지·깨진 공지가 섞임

interface DataControl {
  // 지금 쓰는 시나리오를 바꿈(다음 조회부터)
  set: (scenario: Scenario) => void;
  // 날씨 파일 모양을 바꿈(BRD-185, 다음 조회부터)
  setWeather: (mode: WeatherMode) => void;
  // 지금까지 받은 /data 요청 경로
  requests: string[];
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { date: new Date().toUTCString() },
    body: JSON.stringify(body),
  });
}

async function mockData(
  context: BrowserContext,
  initial: Scenario,
): Promise<DataControl> {
  let scenario = initial;
  const requests: string[] = [];
  let weather: WeatherMode = "ok";
  // 주소 맨 앞이 /data/인 것만(화면 주소 /about/data/는 제외)
  await context.route(
    (url) => url.pathname.startsWith("/data/"),
    async (route) => {
      const now = Date.now();
      const pathname = new URL(route.request().url()).pathname;
      requests.push(pathname);
      if (scenario === "loading") return; // 응답하지 않음 → 로딩 유지
      if (scenario === "noData") return route.abort("internetdisconnected");
      if (pathname === "/data/manifest.json") {
        if (scenario === "maintenance") {
          return json(
            route,
            manifestFile(now, {
              maintenance: { active: true, until: iso(now + 90 * MIN) },
            }),
          );
        }
        if (scenario === "update") {
          return json(route, manifestFile(now, { minWebBuild: 9999 }));
        }
        if (scenario === "notice") {
          return json(route, manifestFile(now, { notices: noticesOf(now) }));
        }
        return json(route, manifestFile(now));
      }
      if (pathname.endsWith("/status.json")) {
        if (scenario === "noConfirmed") {
          return json(route, statusFile(now, { allUnknown: true }));
        }
        if (scenario === "futureConfirm") {
          return json(route, statusFile(now, { confirmedAgoMin: -10 }));
        }
        if (scenario === "missingWarning") {
          const file = statusFile(now);
          for (const status of Object.values(file.beaches)) {
            delete (status as Record<string, unknown>).warning;
          }
          return json(route, file);
        }
        return json(route, statusFile(now));
      }
      if (pathname.endsWith("/nationwide-warnings.json")) {
        return json(route, { lastConfirmedAt: iso(now - 10 * MIN), items: [] });
      }
      if (pathname.endsWith("/history.json")) {
        return json(route, historyFile(now));
      }
      if (pathname.endsWith("/weather.json") && weather !== "failed") {
        return json(route, weatherFile(now, weather));
      }
      return route.fulfill({ status: 404, body: "" });
    },
  );
  return {
    set: (next) => (scenario = next),
    setWeather: (mode) => (weather = mode),
    requests,
  };
}

// 같은 출처 밖 요청(사진·분석 서버 등)은 모두 막음. 지도 판 파일(/map/)은 같은 출처지만 정적 서버에 없어(404)
// 지도는 실패 화면('목록으로 볼 수 있어요') 경로로 감
async function blockExternal(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort("blockedbyclient"),
  );
}

// 첫 실행 안내·언어 안내를 이미 지난 기기. 기본 지역은 강원 강릉시(시험용 지역 선택, 사용자 위치 아님)
// region: null이면 기본 지역을 넣지 않음(저장값 없음 → 홈 기본값, BRD-127)
async function seedDevice(
  context: BrowserContext,
  options: {
    language?: "ko" | "en";
    region?: string | null;
    extra?: Record<string, string>;
  } = {},
) {
  await context.addInitScript(
    ({ language, region, extra, noticeVersion }) => {
      // 테스트마다 새 context라 처음 한 번만 넣음(새로고침 뒤 앱이 바꾼 값은 그대로 둠)
      if (sessionStorage.getItem("e2e:seeded")) return;
      sessionStorage.setItem("e2e:seeded", "1");
      localStorage.setItem(
        "baradun:onboarding",
        JSON.stringify({
          noticeVersion, // 지금 고지 버전(lib/notice-version.ts). 낮으면 ON-1이 다시 덮어 모든 시험이 막힘
          acknowledgedAt: "2026-10-27T00:00:00Z",
          locationStepDone: true,
        }),
      );
      if (region !== null) localStorage.setItem("baradun:region", region);
      localStorage.setItem("baradun:language", language);
      for (const [key, value] of Object.entries(extra)) {
        localStorage.setItem(key, value);
      }
    },
    {
      language: options.language ?? "ko",
      region: options.region === undefined ? GANGNEUNG_REGION : options.region,
      extra: options.extra ?? {},
      noticeVersion: NOTICE_VERSION,
    },
  );
}

type Fixtures = {
  scenario: Scenario;
  // 첫 실행 안내를 지난 기기로 시작할지. 첫 실행 흐름을 볼 때만 false
  seeded: boolean;
  deviceLanguage: "ko" | "en";
  // 기기에 저장된 기본 지역(저장 글자 그대로). null = 저장값 없음
  deviceRegion: string | null;
  // 탐색 [목록 | 지도] 저장값. null = 저장값 없음(모바일 처음 보기 = 지도, BRD-128). 목록을 보는 시험만 "list"
  exploreView: "list" | "map" | null;
  data: DataControl;
};

export const test = base.extend<Fixtures>({
  scenario: ["normal", { option: true }],
  seeded: [true, { option: true }],
  deviceLanguage: ["ko", { option: true }],
  deviceRegion: [GANGNEUNG_REGION, { option: true }],
  exploreView: [null, { option: true }],
  data: async (
    {
      context,
      scenario,
      seeded,
      deviceLanguage,
      deviceRegion,
      exploreView,
      baseURL,
    },
    provide,
  ) => {
    await blockExternal(context, baseURL ?? "http://127.0.0.1:3109");
    if (seeded)
      await seedDevice(context, {
        language: deviceLanguage,
        region: deviceRegion,
        extra:
          exploreView === null ? {} : { "baradun:explore-view": exploreView },
      });
    await provide(await mockData(context, scenario));
  },
  // 모든 테스트가 가짜 데이터를 쓰게 page보다 먼저 data를 준비함
  // (Playwright가 넘기는 'use' 인자는 React 훅 규칙 검사와 이름이 겹쳐 provide로 부름)
  page: async ({ page, data }, provide) => {
    void data;
    await provide(page);
  },
});

export { expect };

// WCAG 2.2 AA 자동 검사(axe). 위반이 있으면 규칙 id·대상 요소를 보여 줌
export async function expectNoA11yViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const summary = result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
  expect(summary).toEqual([]);
}

// 가로 스크롤이 생기지 않음(문서 폭 = 화면 폭)
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// 테마 고르기: '테마' 줄을 눌러 시트를 열고(PC는 왼쪽 목록에서 '화면'을 먼저 고름),
// 시트의 선택지 버튼을 누름. 고르면 시트가 닫히고 줄 값이 바뀜
export async function chooseTheme(page: Page, name: string) {
  const panel = page
    .getByRole("navigation", { name: "설정 묶음" })
    .getByRole("button", { name: "화면" });
  if (await panel.isVisible()) await panel.click();
  await page.getByRole("button", { name: /^테마/ }).click();
  const sheet = page.getByRole("dialog", { name: "테마" });
  await sheet.getByRole("button", { name, exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: /^테마/ })).toContainText(name);
}
