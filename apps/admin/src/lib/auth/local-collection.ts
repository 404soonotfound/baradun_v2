import type {
  CollectionView,
  HourBucket,
  Incident,
  JobCollection,
  RunView,
} from "../collection";
import type { OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 수집 현황 (BRD-149). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 해상 특보는 새벽에 한 번 끊겼다 돌아오고, 해양 관측은 지금 일부 실패가 이어지는 모양

const HOUR = 3_600_000;

function job(
  id: string,
  now: number,
  everyMinutes: number,
  failedHoursAgo: readonly number[],
  incidents: readonly Incident[],
  lastRun: RunView,
): JobCollection {
  const first = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const perHour = Math.max(1, Math.round(60 / everyMinutes));
  const hourly: HourBucket[] = Array.from({ length: 24 }, (_, i) => {
    const runs = everyMinutes >= 24 * 60 ? (i === 4 ? 1 : 0) : perHour;
    const failed = failedHoursAgo.includes(23 - i) ? 1 : 0;
    return {
      hour: new Date(first + i * HOUR).toISOString(),
      runs,
      ok: runs - Math.min(failed, runs),
    };
  });
  const day = hourly.reduce(
    (acc, b) => ({ runs: acc.runs + b.runs, ok: acc.ok + b.ok }),
    { runs: 0, ok: 0 },
  );
  return {
    job: id,
    lastRun,
    lastSuccessAt:
      lastRun.status === "complete"
        ? lastRun.startedAt
        : new Date(now - 40 * 60_000).toISOString(),
    day,
    week: { runs: day.runs * 7, ok: day.ok * 7 - 1 },
    hourly,
    incidents,
    truncated: false,
  };
}

export function localCollection<T>(): OpsResult<T> {
  const now = Date.now();
  const at = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const run = (minutes: number, status: RunView["status"]): RunView => ({
    startedAt: at(minutes),
    finishedAt: at(minutes),
    status,
    failures:
      status === "complete" ? [] : [{ source: "kma_buoy", reason: "timeout" }],
  });
  const body: CollectionView = {
    generatedAt: new Date(now).toISOString(),
    publishedVersion: new Date(now - 8 * 60_000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, ""),
    jobs: [
      job(
        "collect-warnings",
        now,
        15,
        [9],
        [
          {
            startedAt: at(9 * 60 + 10),
            endedAt: at(9 * 60 - 20),
            runs: 2,
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
        run(12, "complete"),
      ),
      job(
        "collect-ocean",
        now,
        30,
        [0],
        [
          {
            startedAt: at(10),
            endedAt: null,
            runs: 1,
            failures: [{ source: "kma_buoy", reason: "timeout" }],
          },
        ],
        run(10, "partial"),
      ),
      job("collect-rip", now, 24 * 60, [], [], run(19 * 60, "complete")),
      job("collect-weather", now, 60, [], [], run(20, "complete")),
      job("collect-catalog", now, 24 * 60, [], [], run(19 * 60, "complete")),
    ],
  };
  return { ok: true, status: 200, body: body as T };
}
