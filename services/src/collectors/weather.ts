import { collapseFailures, type RunFailure } from "../core/collect/run-log";
import type { StateValue } from "../core/store/types";
import { ENDPOINTS, WEATHER_ISSUE_HOURS } from "./endpoints";
import {
  isTransientReason,
  kstDate,
  parseMidLand,
  parseMidTa,
  parseNow,
  parsePage,
  parseShortForecastItems,
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

const SHORT_BASE = ENDPOINTS.weatherShort;
const MID_BASE = ENDPOINTS.weatherMid;
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

const SHORT_HOURS = WEATHER_ISSUE_HOURS.short;
const ALL_HOURS = WEATHER_ISSUE_HOURS.now;
const MID_HOURS = WEATHER_ISSUE_HOURS.mid;

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

// 단기예보 한 격자: totalCount가 한 쪽보다 크면 다음 쪽(pageNo)을 이어 받아 합친 뒤 해석함(17·20시 발표 1,052행)
// 쪽 수 상한을 넘거나, 쪽마다 totalCount가 다르거나, 이어 받은 행이 totalCount보다 적으면 잘린 응답으로 실패
// (일부 행만으로 저장하지 않음: 앞 발표가 남아 화면은 그 발표 시각을 보여 줌)
// 다음 쪽은 시간 예산 안에서만 부름. 예산(30초)은 작업마다 요청 하나를 가정해 Lambda 60초에 맞춘 값이라
// 예산이 지난 뒤 쪽을 더 부르면 최악 요청 시간(21초)이 겹쳐 60초를 넘을 수 있음 → 잘린 응답 실패로 남김
async function fetchShortForecast(
  deps: WeatherDeps,
  pageUrl: (pageNo: number) => string,
  base: { date: string; time: string },
  grid: Grid,
  withinBudget: () => boolean,
): Promise<Parsed<ShortForecast>> {
  const items: unknown[] = [];
  let total: number | null = null;
  for (let pageNo = 1; ; pageNo += 1) {
    const response = await deps.get(pageUrl(pageNo));
    if (response.status === "failed") {
      return { status: "failed", reason: response.reason };
    }
    const page = parsePage(response.body);
    if (page.status === "failed") return page;
    if (pageNo > 1 && page.value.total !== total) {
      return { status: "failed", reason: "total_mismatch" };
    }
    total = page.value.total;
    items.push(...page.value.items);
    if (total === null || items.length >= total) break;
    if (pageNo >= COLLECT_POLICY.weatherShortMaxPages || !withinBudget()) {
      return { status: "failed", reason: `truncated:${items.length}/${total}` };
    }
  }
  return parseShortForecastItems(items, base, grid);
}

// 작업이 시간 예산 때문에 요청을 보내지 않고 끝나면 false(건너뛴 것으로 셈)
type Task = () => Promise<boolean | void>;

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
      if ((await task()) === false) skipped += 1;
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
  // 최종 실패는 곳(격자·구역)과 함께 로그에 남김. 실행 기록은 사유별로 묶으므로 곳은 로그에서만 찾음(BRD-186)
  const fail = (
    source: string,
    target: string,
    reason: string,
    code?: string,
    message?: string,
  ) => {
    failures.push({
      source,
      reason,
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    });
    deps.log("warn", "weather_target_failed", {
      source,
      target,
      reason,
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  };
  // 일시 실패는 바로 실패로 두지 않고 모아 두었다가, 첫 차례가 끝난 뒤 남은 시간 안에서 한 번 더 받음
  // 다시 받을 시간이 없으면 처음 실패 사유로 남김(요청은 이미 보냈으므로 budget으로 세지 않음)
  const retries: { run: () => Promise<void>; giveUp: () => void }[] = [];
  let recovered = 0;
  // 기상청이 결측(-999)으로 준 실황 격자. 수집 실패로 치지 않고(다시 받아도 같음) 곳과 개수만 남김
  // 저장값은 덮지 않으므로 그 격자 '지금 기온'은 오래되면 publisher가 null로 거름(확인하지 못했어요)
  const nowMissing: GridKey[] = [];
  const missing = (target: GridKey) => {
    nowMissing.push(target);
    deps.log("info", "weather_now_missing", { target });
  };
  const record = <T>(
    source: string,
    target: string,
    result: Parsed<T>,
    ok: (v: T) => void,
    again: () => Promise<Parsed<T>>,
  ) => {
    if (result.status === "ok") return ok(result.value);
    if (!isTransientReason(result.reason)) {
      return fail(source, target, result.reason, result.code, result.message);
    }
    const { reason: first, code: firstCode, message: firstMessage } = result;
    retries.push({
      run: async () => {
        const retried = await again();
        if (retried.status === "ok") {
          recovered += 1;
          ok(retried.value);
        } else if (retried.reason === "t1h_missing") missing(target);
        else
          fail(source, target, retried.reason, retried.code, retried.message);
      },
      giveUp: () => fail(source, target, first, firstCode, firstMessage),
    });
  };
  const safe = <T>(p: Promise<Parsed<T>>) =>
    p.catch((error: unknown): Parsed<T> => ({
      status: "failed",
      reason: exceptionReason(error),
    }));

  const tasks: Task[] = [];
  let skipped = 0;
  let retriedCount = 0;
  if (key === null) {
    failures.push({ source: "weather", reason: "api_key" });
  } else {
    const shortParams = (
      g: Grid,
      base: { date: string; time: string },
      rows: number,
      pageNo: number,
    ) =>
      new URLSearchParams({
        serviceKey: key,
        dataType: "JSON",
        pageNo: String(pageNo),
        numOfRows: String(rows),
        base_date: base.date,
        base_time: base.time,
        nx: String(g.nx),
        ny: String(g.ny),
      });
    for (const g of shortNeeded) {
      const pageUrl = (pageNo: number) =>
        `${SHORT_BASE}getVilageFcst?${shortParams(g, shortBase, COLLECT_POLICY.weatherShortNumOfRows, pageNo)}`;
      const withinBudget = () =>
        deps.clock() - startedMs <= COLLECT_POLICY.weatherBudgetMs;
      const load = () =>
        safe(fetchShortForecast(deps, pageUrl, shortBase, g, withinBudget));
      tasks.push(async () => {
        record(
          "short",
          gridKey(g),
          await load(),
          (v) => shortFresh.set(gridKey(g), v),
          load,
        );
      });
    }
    const midParams = (regId: string) =>
      new URLSearchParams({
        serviceKey: key,
        dataType: "JSON",
        pageNo: "1",
        numOfRows: String(COLLECT_POLICY.weatherMidNumOfRows),
        regId,
        tmFc,
      });
    for (const regId of landNeeded) {
      const load = () =>
        safe(
          fetchJson(
            deps,
            `${MID_BASE}getMidLandFcst?${midParams(regId)}`,
            (body) => parseMidLand(body, regId, tmFc),
          ),
        );
      tasks.push(async () => {
        record(
          "mid_land",
          regId,
          await load(),
          (v) => landFresh.set(regId, v),
          load,
        );
      });
    }
    for (const regId of taNeeded) {
      const load = () =>
        safe(
          fetchJson(deps, `${MID_BASE}getMidTa?${midParams(regId)}`, (body) =>
            parseMidTa(body, regId, tmFc),
          ),
        );
      tasks.push(async () => {
        record(
          "mid_ta",
          regId,
          await load(),
          (v) => taFresh.set(regId, v),
          load,
        );
      });
    }
    // 실황은 매시 다시 받으므로 맨 뒤. 시간 예산에 걸리면 덜 자주 오는 단기·중기 발표를 먼저 지킴
    const prevHour = latestBase(nowBase.ms - HOUR_MS, ALL_HOURS, 0);
    const nowUrl = (g: Grid, base: { date: string; time: string }) =>
      `${SHORT_BASE}getUltraSrtNcst?${shortParams(g, base, COLLECT_POLICY.weatherNowNumOfRows, 1)}`;
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
        // 첫 격자 확인을 기다리는 동안 예산이 지났으면 새 요청을 보내지 않음(Lambda 60초 안에 저장까지 끝내게)
        const reuse = g === first && !noCurrent(probed);
        if (
          !reuse &&
          deps.clock() - startedMs > COLLECT_POLICY.weatherBudgetMs
        ) {
          return false;
        }
        const base = noCurrent(probed) ? prevHour : nowBase;
        const result = reuse ? probed : await fetchNow(g, base);
        if (result.status === "failed" && result.reason === "t1h_missing") {
          return missing(gridKey(g));
        }
        record(
          "now",
          gridKey(g),
          result,
          (v) => nowFresh.set(gridKey(g), v),
          () => fetchNow(g, base),
        );
      });
    }
    skipped = await runTasks(deps, startedMs, tasks);
    if (skipped > 0) {
      failures.push({ source: "weather", reason: "budget", count: skipped });
    }
    // 다시 받기는 한 번만(다시 받은 실패는 retries에 넣지 않음). runTasks가 예산을 보고 새 요청을 멈춤
    // 기상청 전면 장애로 실패가 많으면 상한까지만 다시 받음(같은 서비스 하루 한도를 장애 시간마다 크게 쓰지 않게)
    const tried = new Set<number>();
    await runTasks(
      deps,
      startedMs,
      retries
        .slice(0, COLLECT_POLICY.weatherRetryMax)
        .map((r, i) => async () => {
          tried.add(i);
          await r.run();
        }),
    );
    retries.forEach((r, i) => {
      if (!tried.has(i)) r.giveUp();
    });
    retriedCount = tried.size;
    // 결측 격자가 많으면 바다 격자 몇 곳이 아니라 기상청 쪽 문제로 보고 실패로 남김(경보가 알게)
    if (nowMissing.length >= COLLECT_POLICY.weatherNowMissingMax) {
      failures.push({
        source: "now",
        reason: "t1h_missing",
        count: nowMissing.length,
      });
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
      missing: nowMissing.length,
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
    retried: retriedCount,
    recovered,
    nowMissing: nowMissing.length,
  });
  if (status === "complete") return { status, slotId };
  return { status, slotId, failures: all };
}
