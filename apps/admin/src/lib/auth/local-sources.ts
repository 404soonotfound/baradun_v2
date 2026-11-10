import type { RunStatus, RunView } from "../collection";
import type { SourcesView } from "../sources";
import type { OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 데이터 출처 (BRD-149·GH-328). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 해상 특보 정상, 해양 관측은 최근 실행이 일부 실패, 사진은 기록 없음. 키 하나는 만료일 태그가 없는 모양

const MIN = 60_000;
const DATA = "https://apis.data.go.kr";
const HUB = "https://apihub.kma.go.kr/api/typ01/url/";

function runs(
  now: number,
  everyMinutes: number,
  statuses: RunStatus[],
): RunView[] {
  return statuses.map((status, i) => {
    const started = now - (i + 1) * everyMinutes * MIN;
    return {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + 900).toISOString(),
      status,
      failures:
        status === "complete"
          ? []
          : [{ source: "22105", reason: "timeout", count: 1 }],
    };
  });
}

export function localSourcesView(now: number): SourcesView {
  return {
    generatedAt: new Date(now).toISOString(),
    http: { timeoutMs: 10_000, retries: 1 },
    keysHidden: false,
    keys: [
      {
        name: "data-go-kr",
        status: "registered",
        expiresOn: "2027-03-31",
        daysLeft: 141,
        expiresInvalid: false,
      },
      {
        name: "kma-apihub",
        status: "registered",
        expiresOn: null,
        daysLeft: null,
        expiresInvalid: false,
      },
    ],
    sources: [
      {
        id: "collect-warnings",
        provider: "kma",
        key: "data-go-kr",
        judgment: true,
        calls: [
          {
            url: `${DATA}/1360000/WthrWrnInfoService/getPwnCd`,
            operation: "getPwnCd",
            rowLimit: 10_000,
            issued: null,
          },
          {
            url: `${DATA}/1360000/EqkInfoService/getTsunamiMsg`,
            operation: "getTsunamiMsg",
            rowLimit: 100,
            issued: null,
          },
        ],
        schedule: { periodMinutes: 15, offsetMinutes: 3, offSeason: null },
        budgetMs: null,
        extraRetryMax: null,
        lateAfterMinutes: 20,
        recentRuns: runs(now, 15, [
          "complete",
          "complete",
          "complete",
          "failed",
          "complete",
        ]),
        unreadableRuns: 0,
      },
      {
        id: "collect-ocean",
        provider: "kma",
        key: "kma-apihub",
        judgment: true,
        calls: [
          {
            url: `${HUB}sea_obs.php`,
            operation: "sea_obs",
            rowLimit: null,
            issued: null,
          },
          {
            url: `${HUB}kma_buoy.php`,
            operation: "kma_buoy",
            rowLimit: null,
            issued: null,
          },
        ],
        schedule: { periodMinutes: 30, offsetMinutes: 10, offSeason: null },
        budgetMs: null,
        extraRetryMax: null,
        lateAfterMinutes: 35,
        recentRuns: runs(now, 30, ["partial", "complete", "complete"]),
        unreadableRuns: 0,
      },
      {
        id: "collect-rip",
        provider: "khoa",
        key: "data-go-kr",
        judgment: false,
        calls: [
          {
            url: `${DATA}/1192136/service/GetRipCurrentApiService`,
            operation: "GetRipCurrentApiService",
            rowLimit: 1000,
            issued: null,
          },
        ],
        schedule: {
          periodMinutes: 30,
          offsetMinutes: 12,
          offSeason: {
            slotUtcMinutes: 19 * 60 + 12,
            seasonMonths: [6, 7, 8, 9],
          },
        },
        budgetMs: null,
        extraRetryMax: null,
        lateAfterMinutes: null,
        recentRuns: runs(now, 24 * 60, ["complete"]),
        unreadableRuns: 0,
      },
      {
        id: "collect-weather",
        provider: "kma",
        key: "data-go-kr",
        judgment: false,
        calls: [
          {
            url: `${DATA}/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`,
            operation: "getUltraSrtNcst",
            rowLimit: 60,
            issued: {
              hoursKst: Array.from({ length: 24 }, (_, h) => h),
              delayMinutes: 10,
            },
          },
          {
            url: `${DATA}/1360000/VilageFcstInfoService_2.0/getVilageFcst`,
            operation: "getVilageFcst",
            rowLimit: 1000,
            issued: {
              hoursKst: [2, 5, 8, 11, 14, 17, 20, 23],
              delayMinutes: 10,
            },
          },
          {
            url: `${DATA}/1360000/MidFcstInfoService/getMidLandFcst`,
            operation: "getMidLandFcst",
            rowLimit: 10,
            issued: { hoursKst: [6, 18], delayMinutes: 30 },
          },
          {
            url: `${DATA}/1360000/MidFcstInfoService/getMidTa`,
            operation: "getMidTa",
            rowLimit: 10,
            issued: { hoursKst: [6, 18], delayMinutes: 30 },
          },
        ],
        schedule: { periodMinutes: 60, offsetMinutes: 15, offSeason: null },
        budgetMs: 30_000,
        extraRetryMax: 20,
        lateAfterMinutes: 65,
        recentRuns: runs(now, 60, ["complete", "complete"]),
        unreadableRuns: 0,
      },
      {
        id: "collect-catalog",
        provider: "kto",
        key: "data-go-kr",
        judgment: false,
        calls: [
          {
            url: `${DATA}/B551011/KorService2/detailImage2`,
            operation: "detailImage2",
            rowLimit: 20,
            issued: null,
          },
          {
            url: `${DATA}/B551011/KorService2/detailCommon2`,
            operation: "detailCommon2",
            rowLimit: null,
            issued: null,
          },
        ],
        schedule: {
          periodMinutes: 24 * 60,
          offsetMinutes: 19 * 60 + 20,
          offSeason: null,
        },
        budgetMs: 30_000,
        extraRetryMax: null,
        lateAfterMinutes: null,
        recentRuns: [],
        unreadableRuns: 0,
      },
    ],
  };
}

export function localSources<T>(): OpsResult<T> {
  return { ok: true, status: 200, body: localSourcesView(Date.now()) as T };
}
