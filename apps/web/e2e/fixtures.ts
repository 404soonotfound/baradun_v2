import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Beach } from "@baradun/contracts";
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

// 상태를 따로 정한 해변(강릉시 4곳). 나머지는 '특보 없음'
export const CLEAR_ID = "b0001";
export const WARNING_ID = "b0002";
export const DELAYED_ID = "b0003";
export const UNKNOWN_ID = "b0004";
export const slugOf = (id: string) =>
  BEACHES.find((beach) => beach.id === id)?.slug ?? id;

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
  // 모든 해변을 '특보 확인 못 함'으로(전체 장애)
  allUnknown?: boolean;
}

function beachStatus(beach: Beach, now: number, options: StatusOptions) {
  const confirmedAt = iso(now - (options.confirmedAgoMin ?? 10) * MIN);
  const common = {
    control: { state: "not_provided" },
    info: { season: null, ripCurrent: null, nearbyWarnings: [] },
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
    policyVersion: "2026-10-16",
    generatedAt: iso(now - 5 * MIN),
    maintenance: { active: false, until: null },
    minWebBuild: 1,
    files: {
      beaches: `/data/${version}/beaches.json`,
      status: `/data/${version}/status.json`,
      history: `/data/${version}/history.json`,
      nationwideWarnings: `/data/${version}/nationwide-warnings.json`,
    },
    ...extra,
  };
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

type Scenario =
  | "normal" // 정상(특보 없음·이용불가·관측 지연·특보 확인 못 함이 섞임)
  | "loading" // manifest 응답 없음
  | "noData" // 처음 열었는데 데이터를 못 받음(저장된 값 없음)
  | "outage" // 전체 장애: 모든 해변 특보 확인 못 함
  | "maintenance" // 점검
  | "update" // 강제 업데이트(minWebBuild가 화면 빌드보다 높음)
  | "futureConfirm" // 특보 확인 시각이 2분 넘게 미래(믿지 않음)
  | "missingWarning"; // 계약 필수 칸(warning) 빠짐

interface DataControl {
  // 지금 쓰는 시나리오를 바꿈(다음 조회부터)
  set: (scenario: Scenario) => void;
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
        return json(route, manifestFile(now));
      }
      if (pathname.endsWith("/status.json")) {
        if (scenario === "outage") {
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
      return route.fulfill({ status: 404, body: "" });
    },
  );
  return { set: (next) => (scenario = next), requests };
}

// 같은 출처 밖 요청(지도 타일·글꼴 서버 등)은 모두 막음. 지도는 '목록으로 볼 수 있어요' 경로로 감
async function blockExternal(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort("blockedbyclient"),
  );
}

// 첫 실행 안내·언어 안내를 이미 지난 기기. 기본 지역은 강원 강릉시(시험용 지역 선택, 사용자 위치 아님)
async function seedDevice(
  context: BrowserContext,
  options: { language?: "ko" | "en"; extra?: Record<string, string> } = {},
) {
  await context.addInitScript(
    ({ language, extra }) => {
      // 테스트마다 새 context라 처음 한 번만 넣음(새로고침 뒤 앱이 바꾼 값은 그대로 둠)
      if (sessionStorage.getItem("e2e:seeded")) return;
      sessionStorage.setItem("e2e:seeded", "1");
      localStorage.setItem(
        "baradun:onboarding",
        JSON.stringify({
          noticeVersion: 1,
          acknowledgedAt: "2026-10-27T00:00:00Z",
          locationStepDone: true,
        }),
      );
      localStorage.setItem(
        "baradun:region",
        JSON.stringify({ sido: "강원", sigungu: "강릉시" }),
      );
      localStorage.setItem("baradun:language", language);
      for (const [key, value] of Object.entries(extra)) {
        localStorage.setItem(key, value);
      }
    },
    { language: options.language ?? "ko", extra: options.extra ?? {} },
  );
}

type Fixtures = {
  scenario: Scenario;
  // 첫 실행 안내를 지난 기기로 시작할지. 첫 실행 흐름을 볼 때만 false
  seeded: boolean;
  deviceLanguage: "ko" | "en";
  data: DataControl;
};

export const test = base.extend<Fixtures>({
  scenario: ["normal", { option: true }],
  seeded: [true, { option: true }],
  deviceLanguage: ["ko", { option: true }],
  data: async (
    { context, scenario, seeded, deviceLanguage, baseURL },
    provide,
  ) => {
    await blockExternal(context, baseURL ?? "http://127.0.0.1:3109");
    if (seeded) await seedDevice(context, { language: deviceLanguage });
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
