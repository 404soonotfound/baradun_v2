import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Beach } from "@baradun/contracts";
import { NOTICE_VERSION } from "../src/lib/notice-version";
import { beachZonesText } from "../src/lib/zone-name";
import {
  historyFile,
  iso,
  manifestFile,
  MIN,
  nationwideFile,
  noStationBeachId,
  noticesOf,
  SAMPLE_IDS,
  statusFile,
  weatherFile,
  type StatusMarks,
  type WeatherAreas,
  type WeatherMode,
} from "../scripts/scenario-data.mts";
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
).beaches as WeatherAreas;

// 상태를 따로 정한 해변(강릉시 4곳). 나머지는 '특보 없음'
export const CLEAR_ID = SAMPLE_IDS.clear;
export const WARNING_ID = SAMPLE_IDS.warning;
export const DELAYED_ID = SAMPLE_IDS.delayed;
export const UNKNOWN_ID = SAMPLE_IDS.unknown;
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
export const NO_STATION_ID = noStationBeachId(BEACHES, WEATHER_AREAS);
// 노출 중인 해변 수(홈 '전국' 개수 카드 확인용, BRD-127)
export const PUBLIC_BEACH_COUNT = BEACHES.filter(
  (beach) => !beach.hidden,
).length;

// 기본 지역 저장값(시험용 지역 선택, 사용자 위치 아님). 처음 방문을 볼 때는 deviceRegion: null
export const GANGNEUNG_REGION = JSON.stringify({
  sido: "강원",
  sigungu: "강릉시",
});

// E2E 정상 상태: 강릉 4곳에 상태를 나눠 줌. 나머지는 '특보 없음'
const MARKS: StatusMarks = {
  warning: [WARNING_ID],
  delayed: [DELAYED_ID],
  unknown: [UNKNOWN_ID],
  ripCurrent: CLEAR_ID,
};

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
  let generation = 0;
  const requests: string[] = [];
  let weather: WeatherMode = "ok";
  // 주소 맨 앞이 /data/인 것만(화면 주소 /about/data/는 제외)
  await context.route(
    (url) => url.pathname.startsWith("/data/"),
    async (route) => {
      const now = Date.now() + generation * 1000;
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
          return json(
            route,
            manifestFile(now, {
              notices: noticesOf(now, { withInvalid: true }),
            }),
          );
        }
        return json(route, manifestFile(now));
      }
      if (pathname.endsWith("/status.json")) {
        if (scenario === "noConfirmed") {
          return json(
            route,
            statusFile(BEACHES, now, MARKS, { allUnknown: true }),
          );
        }
        if (scenario === "futureConfirm") {
          return json(
            route,
            statusFile(BEACHES, now, MARKS, { confirmedAgoMin: -10 }),
          );
        }
        if (scenario === "missingWarning") {
          const file = statusFile(BEACHES, now, MARKS);
          for (const status of Object.values(file.beaches)) {
            delete (status as Record<string, unknown>).warning;
          }
          return json(route, file);
        }
        return json(route, statusFile(BEACHES, now, MARKS));
      }
      if (pathname.endsWith("/nationwide-warnings.json")) {
        return json(route, nationwideFile(now));
      }
      if (pathname.endsWith("/history.json")) {
        return json(route, historyFile(BEACHES, now));
      }
      if (pathname.endsWith("/weather.json") && weather !== "failed") {
        return json(route, weatherFile(WEATHER_AREAS, now, weather));
      }
      return route.fulfill({ status: 404, body: "" });
    },
  );
  return {
    set: (next) => {
      scenario = next;
      generation += 1;
    },
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

// 해변 참고 사진(한국관광공사 주소)은 바깥 서버 대신 1×1 그림으로 답함(GH-528 상세 사진 커버).
// 막아 두면 사진 있는 해변이 모두 '받기 실패'로만 그려져 사진 있는 화면(커버 자리·밀림)을 볼 수 없음
// "fail"이면 막힌 채로 둠(받기 실패 → 커버 없음). 나중에 건 경로가 먼저 쓰여 blockExternal 뒤에 불러야 함
const PHOTO_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==",
  "base64",
);
async function servePhotos(context: BrowserContext) {
  await context.route("https://tong.visitkorea.or.kr/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PHOTO_PIXEL }),
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
  // 해변 참고 사진 받기. "ok" = 받음(1×1 그림), "fail" = 받지 못함
  photos: "ok" | "fail";
  data: DataControl;
};

export const test = base.extend<Fixtures>({
  scenario: ["normal", { option: true }],
  seeded: [true, { option: true }],
  deviceLanguage: ["ko", { option: true }],
  deviceRegion: [GANGNEUNG_REGION, { option: true }],
  exploreView: [null, { option: true }],
  photos: ["ok", { option: true }],
  data: async (
    {
      context,
      scenario,
      seeded,
      deviceLanguage,
      deviceRegion,
      exploreView,
      photos,
      baseURL,
    },
    provide,
  ) => {
    await blockExternal(context, baseURL ?? "http://127.0.0.1:3109");
    if (photos === "ok") await servePhotos(context);
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
