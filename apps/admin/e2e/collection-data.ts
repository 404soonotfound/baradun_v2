// 수집 현황 E2E 가짜 응답 (BRD-149·GH-376)
// 해상 특보 정상(새벽 장애 1건 해결·경보 1건), 해양 관측 일부 실패 중 + 관측소 빠짐 1건 해결(해변 2곳 관측 지연),
// 이안류 기록 없음, 날씨 예보는 응답에 없음

const HOUR = 3_600_000;

function hourly(
  failedHoursAgo: number[] = [],
  perHour = 4,
  lateHoursAgo: number[] = [],
) {
  const first = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
  return Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(first + i * HOUR).toISOString(),
    runs: perHour,
    ok: perHour - (failedHoursAgo.includes(23 - i) ? 1 : 0),
    late: lateHoursAgo.includes(23 - i),
  }));
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const REGION = "ap-northeast-2";

const warningsAlarm = {
  id: "WarningsErrors",
  name: "BaradunV2-WarningsErrors",
  at: ago(195),
  from: "OK",
  to: "ALARM",
};

const alarm = (
  id: string,
  windowMinutes: number | null,
  state = "OK",
  functionName: string | null = null,
) => ({
  id,
  name: `BaradunV2-${id}`,
  state,
  stateUpdatedAt: state === "ALARM" ? ago(15) : ago(600),
  description: "",
  windowMinutes,
  functionName,
});

export const VIEW = {
  generatedAt: new Date().toISOString(),
  publishedVersion: "20261104T051000Z",
  publish: {
    version: "20261104T051000Z",
    publishedAt: ago(8),
    beachCount: 214,
    delayedBeaches: 3,
  },
  alarms: {
    status: "ok",
    region: REGION,
    list: [
      alarm("WarningsStopped", 25),
      alarm("OceanStopped", 60, "ALARM", "BaradunV2-Ocean"),
      alarm("WarningsErrors", 5, "OK", "BaradunV2-Warnings"),
      alarm("WeatherFailing", 180, "INSUFFICIENT_DATA"),
      alarm("SomethingNew", null),
    ],
    history: [warningsAlarm],
  },
  jobs: [
    {
      job: "collect-warnings",
      lastRun: {
        startedAt: ago(5),
        finishedAt: ago(5),
        status: "complete",
        failures: [],
      },
      lastSuccessAt: ago(5),
      day: { runs: 96, ok: 95 },
      week: { runs: 672, ok: 671 },
      hourly: hourly([3]),
      incidents: [
        {
          kind: "failure",
          startedAt: ago(200),
          endedAt: ago(185),
          runs: 1,
          failures: [
            {
              source: "pwncd",
              reason: "resultCode:22",
              code: "22",
              message: "LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR.",
            },
          ],
          stations: [],
          missingTruncated: false,
          alarms: [warningsAlarm],
        },
      ],
      truncated: false,
      lateAfterMinutes: 20,
      overdue: false,
    },
    {
      job: "collect-ocean",
      lastRun: {
        startedAt: ago(10),
        finishedAt: ago(10),
        status: "partial",
        failures: [{ source: "kma_buoy", reason: "timeout" }],
      },
      lastSuccessAt: ago(40),
      day: { runs: 48, ok: 47 },
      week: { runs: 336, ok: 335 },
      hourly: hourly([0], 2, [5]),
      incidents: [
        {
          kind: "failure",
          startedAt: ago(10),
          endedAt: null,
          runs: 1,
          failures: [{ source: "kma_buoy", reason: "새로운 사유" }],
          stations: [],
          missingTruncated: false,
          impact: {
            status: "unknown",
            reason: "failure_unknown",
            wholeSource: false,
            delayedBeachIds: [],
            stations: [],
          },
          alarms: [],
        },
        {
          kind: "stations",
          startedAt: ago(120),
          endedAt: ago(60),
          runs: 2,
          failures: [],
          stations: [
            {
              id: "22105",
              firstMissingAt: ago(120),
              lastMissingAt: ago(90),
              returnedAt: ago(60),
            },
          ],
          missingTruncated: false,
          impact: {
            status: "affected",
            wholeSource: false,
            delayedBeachIds: ["b0001", "b0002"],
            stations: [
              { id: "22105", name: "강릉 부이", beaches: 3, waveBeaches: 2 },
            ],
          },
          // 빠진 관측소 장애에는 서버가 경보를 붙이지 않음(services/src/admin/collection.ts)
        },
      ],
      truncated: false,
      lateAfterMinutes: 35,
      overdue: false,
    },
    // 이안류는 7일 기록이 없음 → '기록 없음'(정상으로 보지 않음)
    {
      job: "collect-rip",
      lastRun: null,
      lastSuccessAt: null,
      day: { runs: 0, ok: 0 },
      week: { runs: 0, ok: 0 },
      hourly: hourly([], 0),
      incidents: [],
      truncated: false,
      lateAfterMinutes: 35,
      overdue: true,
    },
    {
      job: "collect-catalog",
      lastRun: {
        startedAt: ago(600),
        finishedAt: ago(600),
        status: "complete",
        failures: [],
      },
      lastSuccessAt: ago(600),
      day: { runs: 1, ok: 1 },
      week: { runs: 7, ok: 7 },
      hourly: hourly([], 0),
      incidents: [],
      truncated: false,
      lateAfterMinutes: null,
      overdue: false,
    },
  ],
};

// 게시 요약·경보를 읽지 못한 응답. 장애의 경보는 null(읽지 못함), 해변 영향은 '확인 못 함'
export const VIEW_DEGRADED = {
  ...VIEW,
  publish: null,
  alarms: { status: "unavailable" },
  jobs: VIEW.jobs.map((job) => ({
    ...job,
    incidents: job.incidents.map((incident) => ({
      ...incident,
      alarms: null,
      ...(job.job === "collect-ocean"
        ? {
            impact: {
              status: "unknown",
              reason: "summary_unread",
              wholeSource: false,
              delayedBeachIds: [],
              stations: [],
            },
          }
        : {}),
    })),
  })),
};

// 해상 특보는 마지막 실행이 성공이지만 지연 기준을 넘김
export const VIEW_LATE = {
  ...VIEW,
  jobs: VIEW.jobs.map((job) =>
    job.job === "collect-warnings" ? { ...job, overdue: true } : job,
  ),
};
