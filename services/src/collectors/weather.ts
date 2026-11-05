import { collapseFailures, type RunFailure } from "../core/collect/run-log";
import type { StateValue } from "../core/store/types";
import {
  kstDate,
  parseMidLand,
  parseMidTa,
  parseNow,
  parseShortForecast,
  type Grid,
  type MidLandDay,
  type MidTaDay,
  type NowObservation,
  type Parsed,
  type ShortForecast,
} from "../core/weather/kma";
import {
  gridKey,
  latestIssue,
  mergeMid,
  mergeNow,
  mergeShort,
  packShort,
  readMid,
  readNow,
  readShort,
  type GridKey,
} from "../core/weather/state";
import { formatUtcIso, parseUtcIso } from "../core/warnings/time";
import {
  exceptionReason,
  mergeAndPut,
  type CollectDeps,
  type CollectRunResult,
} from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { formatKst, slotStart } from "./schedule";

// collect-weather (BRD-181, 결정 기록 18장 D18-1·D18-8, 데이터 출처 문서 14장)
// 매시 :15. 대응표(data/weather-areas.json)의 격자·구역마다
// - 초단기실황(지금 기온): 매 실행, 그 시각 정시 실황. 아직 없으면(resultCode 03) 한 시간 전 실황
//   (2026-11-05 10:04 실호출: 10:00 실황이 아직 03. 제공 시각 근거가 없어 받을 수 있는 가장 늦은 실황을 씀)
// - 단기예보: 가장 늦은 발표(02·05·…·23시)를 아직 저장하지 않은 격자만. 놓친 발표는 다음 실행이 메움
// - 중기예보: 가장 늦은 발표(06·18시)를 아직 저장하지 않은 육상 구역·기온 지점만
// 날씨는 참고 정보. 분류·관측 지연·대안 해변에 쓰지 않음(G1) → publisher가 weather.json에만 넣음
// 실패한 곳은 이전 값을 덮지 않음. 오래된 값 거르기는 publisher가 함

export const WEATHER_JOB = "collect-weather";
export const WEATHER_STATE = {
  short: { pk: "weather", sk: "short" },
  now: { pk: "weather", sk: "now" },
  mid: { pk: "weather", sk: "mid" },
  attempt: { pk: "weather", sk: "attempt" },
} as const;

const SHORT_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/";
const MID_BASE = "https://apis.data.go.kr/1360000/MidFcstInfoService/";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// 수집할 곳(대응표에서 중복 없이)
export interface WeatherAreas {
  readonly grids: readonly Grid[];
  readonly land: readonly string[];
  readonly ta: readonly string[];
}

export interface WeatherDeps extends CollectDeps {
  readonly areas: WeatherAreas;
}

// 대응표 → 수집 목록. Lambda 번들 입력이라 모양이 틀리면 첫 실행에서 멈춤(틀린 목록으로 돌지 않음)
// 해변 id가 data/beaches 공개 해변과 맞는지는 tools/beaches 검사(weather-areas.test)가 확인함
export function parseWeatherAreas(json: unknown): WeatherAreas {
  const beaches =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as { beaches?: unknown }).beaches
      : undefined;
  if (typeof beaches !== "object" || beaches === null) {
    throw new RangeError("weather-areas.json: beaches가 없음");
  }
  const grids = new Map<GridKey, Grid>();
  const land = new Set<string>();
  const ta = new Set<string>();
  for (const [id, entry] of Object.entries(beaches)) {
    const e = entry as {
      grid?: { nx?: unknown; ny?: unknown };
      midLand?: { regId?: unknown };
      midTa?: { regId?: unknown };
    };
    const nx = e.grid?.nx;
    const ny = e.grid?.ny;
    const landId = e.midLand?.regId;
    const taId = e.midTa?.regId;
    if (
      !/^b[0-9]{4}$/.test(id) ||
      !Number.isInteger(nx) ||
      !Number.isInteger(ny) ||
      typeof landId !== "string" ||
      !/^11[A-H][0-9]0000$/.test(landId) ||
      typeof taId !== "string" ||
      !/^(11|21)[A-H][0-9]{5}$/.test(taId)
    ) {
      throw new RangeError(`weather-areas.json: 항목 형식 오류: ${id}`);
    }
    const grid = { nx: nx as number, ny: ny as number };
    grids.set(gridKey(grid), grid);
    land.add(landId);
    ta.add(taId);
  }
  if (grids.size === 0) throw new RangeError("weather-areas.json: 해변 없음");
  return {
    grids: [...grids.values()].sort((a, b) => a.nx - b.nx || a.ny - b.ny),
    land: [...land].sort(),
    ta: [...ta].sort(),
  };
}

// 지금 받을 수 있는 가장 늦은 발표(KST 날짜·시각). hours: 발표 시(KST), delayMinutes: 발표 뒤 제공까지 기다리는 분
export function latestBase(
  nowMs: number,
  hours: readonly number[],
  delayMinutes: number,
): { date: string; time: string; ms: number } {
  const ready = nowMs - delayMinutes * MINUTE_MS;
  const hourStart = Math.floor(ready / HOUR_MS) * HOUR_MS;
  for (let back = 0; back < 48; back += 1) {
    const ms = hourStart - back * HOUR_MS;
    const kst = formatKst(ms, "minute"); // yyyymmddHHMM
    if (hours.includes(Number(kst.slice(8, 10)))) {
      return { date: kst.slice(0, 8), time: kst.slice(8, 12), ms };
    }
  }
  throw new Error("발표 시각을 찾지 못함");
}

const SHORT_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
const ALL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const MID_HOURS = [6, 18];

async function fetchJson<T>(
  deps: WeatherDeps,
  url: string,
  parse: (body: string) => Parsed<T>,
): Promise<Parsed<T>> {
  const response = await deps.get(url);
  if (response.status === "failed") {
    return { status: "failed", reason: response.reason };
  }
  return parse(response.body);
}

type Task = () => Promise<void>;

// 몇 개씩 나눠 보냄. 시간 예산이 지나면 새 요청을 보내지 않음(남은 곳은 다음 실행이 메움)
async function runTasks(
  deps: WeatherDeps,
  startedMs: number,
  tasks: Task[],
): Promise<number> {
  const queue = [...tasks];
  let skipped = 0;
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      if (deps.clock() - startedMs > COLLECT_POLICY.weatherBudgetMs) {
        skipped += 1 + queue.length;
        queue.length = 0;
        return;
      }
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: COLLECT_POLICY.weatherConcurrency }, worker),
  );
  return skipped;
}

export async function collectWeather(
  deps: WeatherDeps,
): Promise<CollectRunResult> {
  const startedMs = deps.clock();
  const slotMs = slotStart(startedMs, COLLECT_POLICY.weatherSchedule);
  const slotId = formatKst(slotMs, "minute");
  const claim = await deps.ops.claimSlot(
    WEATHER_JOB,
    slotId,
    deps.owner,
    startedMs,
    COLLECT_POLICY.slotLeaseMs,
  );
  if (claim !== "claimed") {
    deps.log("info", "weather_slot_skipped", { slotId, claim });
    return { status: "skipped", slotId, claim };
  }

  const key = await deps.keys.get("data-go-kr").catch(() => null);
  const today = kstDate(startedMs);
  const shortBase = latestBase(
    startedMs,
    SHORT_HOURS,
    COLLECT_POLICY.weatherShortDelayMinutes,
  );
  const nowBase = latestBase(
    startedMs,
    ALL_HOURS,
    COLLECT_POLICY.weatherNowDelayMinutes,
  );
  const midBase = latestBase(
    startedMs,
    MID_HOURS,
    COLLECT_POLICY.weatherMidDelayMinutes,
  );
  const tmFc = `${midBase.date}${midBase.time}`;

  // 이미 받은 발표는 다시 부르지 않음. 저장값을 읽지 못하면 모두 부름
  // 저장할 때 mergeAndPut이 다시 읽음: 그 사이 다른 실행이 쓴 값과 합쳐야 해서 이 읽기를 다시 쓰지 않음
  const [prevShortRec, prevMidRec] = await Promise.all([
    deps.state.getState(WEATHER_STATE.short.pk, WEATHER_STATE.short.sk),
    deps.state.getState(WEATHER_STATE.mid.pk, WEATHER_STATE.mid.sk),
  ]);
  const prevShort = readShort(prevShortRec?.value) ?? {};
  const prevMid = readMid(prevMidRec?.value) ?? { land: {}, ta: {} };
  const shortIssued = (k: GridKey) => parseUtcIso(prevShort[k]?.issuedAt ?? "");
  const shortNeeded = deps.areas.grids.filter(
    (g) => (shortIssued(gridKey(g)) ?? -Infinity) < shortBase.ms,
  );
  const landNeeded = deps.areas.land.filter(
    (r) => (latestIssue(prevMid.land[r]) ?? -Infinity) < midBase.ms,
  );
  const taNeeded = deps.areas.ta.filter(
    (r) => (latestIssue(prevMid.ta[r]) ?? -Infinity) < midBase.ms,
  );

  const failures: RunFailure[] = [];
  const nowFresh = new Map<GridKey, NowObservation>();
  const shortFresh = new Map<GridKey, ShortForecast>();
  const landFresh = new Map<string, Record<string, MidLandDay>>();
  const taFresh = new Map<string, Record<string, MidTaDay>>();
  const record = <T>(source: string, result: Parsed<T>, ok: (v: T) => void) => {
    if (result.status === "ok") ok(result.value);
    else failures.push({ source, reason: result.reason });
  };
  const safe = <T>(p: Promise<Parsed<T>>) =>
    p.catch((error: unknown): Parsed<T> => ({
      status: "failed",
      reason: exceptionReason(error),
    }));

  const tasks: Task[] = [];
  let skipped = 0;
  if (key === null) {
    failures.push({ source: "weather", reason: "api_key" });
  } else {
    const shortParams = (
      g: Grid,
      base: { date: string; time: string },
      rows: number,
    ) =>
      new URLSearchParams({
        serviceKey: key,
        dataType: "JSON",
        pageNo: "1",
        numOfRows: String(rows),
        base_date: base.date,
        base_time: base.time,
        nx: String(g.nx),
        ny: String(g.ny),
      });
    for (const g of shortNeeded) {
      tasks.push(async () => {
        const url = `${SHORT_BASE}getVilageFcst?${shortParams(g, shortBase, COLLECT_POLICY.weatherShortNumOfRows)}`;
        const result = await safe(
          fetchJson(deps, url, (body) =>
            parseShortForecast(body, shortBase, g),
          ),
        );
        record("short", result, (v) => shortFresh.set(gridKey(g), v));
      });
    }
    const midParams = (regId: string) =>
      new URLSearchParams({
        serviceKey: key,
        dataType: "JSON",
        pageNo: "1",
        numOfRows: "10",
        regId,
        tmFc,
      });
    for (const regId of landNeeded) {
      tasks.push(async () => {
        const result = await safe(
          fetchJson(
            deps,
            `${MID_BASE}getMidLandFcst?${midParams(regId)}`,
            (body) => parseMidLand(body, regId, tmFc),
          ),
        );
        record("mid_land", result, (v) => landFresh.set(regId, v));
      });
    }
    for (const regId of taNeeded) {
      tasks.push(async () => {
        const result = await safe(
          fetchJson(deps, `${MID_BASE}getMidTa?${midParams(regId)}`, (body) =>
            parseMidTa(body, regId, tmFc),
          ),
        );
        record("mid_ta", result, (v) => taFresh.set(regId, v));
      });
    }
    // 실황은 매시 다시 받으므로 맨 뒤. 시간 예산에 걸리면 덜 자주 오는 단기·중기 발표를 먼저 지킴
    const prevHour = latestBase(nowBase.ms - HOUR_MS, ALL_HOURS, 0);
    const nowUrl = (g: Grid, base: { date: string; time: string }) =>
      `${SHORT_BASE}getUltraSrtNcst?${shortParams(g, base, COLLECT_POLICY.weatherNowNumOfRows)}`;
    const fetchNow = (g: Grid, base: { date: string; time: string }) =>
      safe(fetchJson(deps, nowUrl(g, base), (body) => parseNow(body, base, g)));
    // 이번 시각이 나왔는지는 첫 격자로 한 번만 확인(격자마다 두 번 부르면 같은 서비스 하루 한도에 가까워짐)
    // 나왔으면 첫 격자는 그 응답을 그대로 씀. 없으면(03) 모든 격자를 한 시간 전 실황으로 부름
    const first = deps.areas.grids[0]!;
    let probe: Promise<Parsed<NowObservation>> | null = null;
    const probeNow = () => (probe ??= fetchNow(first, nowBase));
    const noCurrent = (r: Parsed<NowObservation>) =>
      r.status === "failed" && r.reason === "result:03";
    for (const g of deps.areas.grids) {
      tasks.push(async () => {
        const probed = await probeNow();
        const result =
          g === first && !noCurrent(probed)
            ? probed
            : await fetchNow(g, noCurrent(probed) ? prevHour : nowBase);
        record("now", result, (v) => nowFresh.set(gridKey(g), v));
      });
    }
    skipped = await runTasks(deps, startedMs, tasks);
    if (skipped > 0) {
      failures.push({ source: "weather", reason: "budget", count: skipped });
    }
  }

  // 받은 것만 이전 값에 합쳐 씀. 받은 것이 없으면 쓰지 않음(저장한 것으로 침)
  const keepGrids = new Set(deps.areas.grids.map(gridKey));
  const saveErrors: RunFailure[] = [];
  let savesTried = 0;
  const save = async (name: string, run: () => Promise<boolean>) => {
    savesTried += 1;
    const ok = await run().catch((error: unknown) => {
      deps.log("error", `weather_${name}_failed`, {
        reason: exceptionReason(error),
      });
      return false;
    });
    if (!ok)
      saveErrors.push({ source: "storage", reason: `${name}_not_saved` });
  };
  await Promise.all([
    nowFresh.size > 0 &&
      save("now", async () => {
        const { saved } = await mergeAndPut(
          deps,
          WEATHER_STATE.now,
          "weather_now",
          (previous) => {
            const grids = mergeNow(
              readNow(previous?.value) ?? {},
              nowFresh,
              keepGrids,
            );
            return {
              value: { grids } as unknown as StateValue,
              orderAt: Math.max(previous?.orderAt ?? 0, nowBase.ms),
              result: null,
            };
          },
        );
        return saved;
      }),
    shortFresh.size > 0 &&
      save("short", async () => {
        // 깨진 기록은 버리고 새 값으로 덮으므로 남김. 충돌 재시도로 build가 다시 돌아도 한 번만
        let invalid = false;
        const { saved } = await mergeAndPut(
          deps,
          WEATHER_STATE.short,
          "weather_short",
          (previous) => {
            const prev = readShort(previous?.value);
            invalid = previous !== null && prev === null;
            const grids = mergeShort(prev ?? {}, shortFresh, keepGrids, today);
            const packed = packShort(grids);
            // 너무 크면 쓰지 않고 던짐 → save가 저장 실패(short_not_saved)로 남김. 이전 기록은 그대로
            if (packed.status === "failed") throw new RangeError(packed.reason);
            return {
              value: { archive: packed.archive } as StateValue,
              orderAt: Math.max(previous?.orderAt ?? 0, shortBase.ms),
              result: null,
            };
          },
        );
        if (invalid) deps.log("warn", "weather_short_invalid");
        return saved;
      }),
    landFresh.size + taFresh.size > 0 &&
      save("mid", async () => {
        const { saved } = await mergeAndPut(
          deps,
          WEATHER_STATE.mid,
          "weather_mid",
          (previous) => {
            const mid = mergeMid(
              readMid(previous?.value) ?? { land: {}, ta: {} },
              { land: landFresh, ta: taFresh },
              { land: new Set(deps.areas.land), ta: new Set(deps.areas.ta) },
              today,
            );
            return {
              value: mid as unknown as StateValue,
              orderAt: Math.max(previous?.orderAt ?? 0, midBase.ms),
              result: null,
            };
          },
        );
        return saved;
      }),
  ]);

  const counts = {
    now: {
      ok: nowFresh.size,
      tried: key === null ? 0 : deps.areas.grids.length,
    },
    short: {
      ok: shortFresh.size,
      tried: key === null ? 0 : shortNeeded.length,
    },
    midLand: {
      ok: landFresh.size,
      tried: key === null ? 0 : landNeeded.length,
    },
    midTa: { ok: taFresh.size, tried: key === null ? 0 : taNeeded.length },
  };
  await deps.state.putState(
    WEATHER_STATE.attempt.pk,
    WEATHER_STATE.attempt.sk,
    {
      attemptedAt: formatUtcIso(startedMs),
      slotId,
      keyLoaded: key !== null,
      shortBase: `${shortBase.date}${shortBase.time}`,
      nowBase: `${nowBase.date}${nowBase.time}`,
      midTmFc: tmFc,
      skipped,
      counts,
      saveErrors: saveErrors.map((f) => f.reason),
    },
    startedMs,
  );

  // 저장 실패를 먼저 둠 → 곳별 사유가 많아 상한에 닿아도 빠지지 않게(collect-rip과 같음)
  const all = collapseFailures([...saveErrors, ...failures]);
  // 받은 것을 하나라도 저장했으면 일부 실패. 받은 것이 없거나 모두 저장하지 못했으면 실패
  const savedAny = savesTried > saveErrors.length;
  const status =
    all.length === 0 ? "complete" : savedAny ? "partial" : "failed";
  if (status === "complete") {
    await deps.ops.completeSlot(WEATHER_JOB, slotId, deps.owner);
  }
  deps.log(status === "complete" ? "info" : "error", "weather_run_finished", {
    slotId,
    status,
    now: nowFresh.size,
    short: shortFresh.size,
    midLand: landFresh.size,
    midTa: taFresh.size,
    skipped,
  });
  if (status === "complete") return { status, slotId };
  return { status, slotId, failures: all };
}
