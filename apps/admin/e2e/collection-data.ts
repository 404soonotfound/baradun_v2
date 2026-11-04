// 수집 현황 E2E 가짜 응답 (BRD-149). 해상 특보 정상(새벽 장애 1건 해결), 해양 관측 일부 실패 중, 이안류 기록 없음

const HOUR = 3_600_000;

function hourly(failedHoursAgo: number[] = [], perHour = 4) {
  const first = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
  return Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(first + i * HOUR).toISOString(),
    runs: perHour,
    ok: perHour - (failedHoursAgo.includes(23 - i) ? 1 : 0),
  }));
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

export const VIEW = {
  generatedAt: new Date().toISOString(),
  publishedVersion: "20261104T051000Z",
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
        },
      ],
      truncated: false,
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
      hourly: hourly([0], 2),
      incidents: [
        {
          startedAt: ago(10),
          endedAt: null,
          runs: 1,
          failures: [{ source: "kma_buoy", reason: "새로운 사유" }],
        },
      ],
      truncated: false,
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
    },
  ],
};
