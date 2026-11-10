import type {
  AlarmView,
  CollectionJobId,
  CollectionView,
  HourBucket,
  Incident,
  JobCollection,
  RunView,
} from "../collection";
import type { OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 수집 현황 (BRD-149·GH-376). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 해상 특보는 새벽에 한 번 끊겼다 돌아오고, 해양 관측은 지금 관측소 하나가 빠져 해변 2곳이 관측 지연으로 게시된 모양

const HOUR = 3_600_000;
const REGION = "ap-northeast-2";

function job(
  id: CollectionJobId,
  now: number,
  everyMinutes: number,
  failedHoursAgo: readonly number[],
  incidents: readonly Incident[],
  lastRun: RunView,
  lateAfterMinutes: number | null,
  lateHoursAgo: readonly number[] = [],
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
      late: lateHoursAgo.includes(23 - i),
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
    lateAfterMinutes,
    overdue: false,
  };
}

function alarm(
  id: string,
  windowMinutes: number | null,
  state: AlarmView["state"] = "OK",
  stateUpdatedAt: string | null = null,
): AlarmView {
  return {
    id,
    name: `BaradunV2-${id}`,
    state,
    stateUpdatedAt,
    description: "",
    windowMinutes,
    functionName: id.startsWith("Login")
      ? null
      : `BaradunV2-${id.replace(/(Errors|Stopped|Failing)$/, "")}`,
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
  const pwncdAlarm = {
    id: "WarningsErrors",
    name: "BaradunV2-WarningsErrors",
    at: at(9 * 60 + 5),
    from: "OK" as const,
    to: "ALARM" as const,
  };
  const body: CollectionView = {
    generatedAt: new Date(now).toISOString(),
    publishedVersion: new Date(now - 8 * 60_000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, ""),
    publish: {
      version: "local",
      publishedAt: at(8),
      beachCount: 214,
      delayedBeaches: 2,
    },
    alarms: {
      status: "ok",
      region: REGION,
      list: [
        alarm("WarningsStopped", 25),
        alarm("OceanStopped", 60),
        alarm("RipStopped", 60),
        alarm("PublishStopped", 25),
        alarm("WarningsErrors", 5, "OK", at(9 * 60 - 20)),
        alarm("OceanErrors", 5),
        alarm("RipErrors", 5),
        alarm("CatalogErrors", 5),
        alarm("PublishErrors", 5),
        alarm("WeatherFailing", 180),
        alarm("LoginAbuse", 5),
      ],
      history: [pwncdAlarm],
    },
    jobs: [
      job(
        "collect-warnings",
        now,
        15,
        [9],
        [
          {
            kind: "failure",
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
            stations: [],
            missingTruncated: false,
            alarms: [pwncdAlarm],
          },
        ],
        run(12, "complete"),
        20,
        [9],
      ),
      job(
        "collect-ocean",
        now,
        30,
        [],
        [
          {
            kind: "stations",
            startedAt: at(70),
            endedAt: null,
            runs: 3,
            failures: [],
            stations: [
              {
                id: "22105",
                firstMissingAt: at(70),
                lastMissingAt: at(10),
                returnedAt: null,
              },
              {
                id: "22190",
                firstMissingAt: at(70),
                lastMissingAt: at(40),
                returnedAt: at(10),
              },
            ],
            missingTruncated: false,
            impact: {
              status: "affected",
              wholeSource: false,
              delayedBeachIds: ["b0001", "b0002"],
              stations: [
                { id: "22105", name: "강릉 부이", beaches: 3, waveBeaches: 2 },
                { id: "22190", name: "속초 부이", beaches: 1, waveBeaches: 0 },
              ],
            },
            alarms: [],
          },
        ],
        run(10, "complete"),
        35,
      ),
      job("collect-rip", now, 24 * 60, [], [], run(19 * 60, "complete"), null),
      job("collect-weather", now, 60, [], [], run(20, "complete"), 180),
      job(
        "collect-catalog",
        now,
        24 * 60,
        [],
        [],
        run(19 * 60, "complete"),
        null,
      ),
    ],
  };
  return { ok: true, status: 200, body: body as T };
}
