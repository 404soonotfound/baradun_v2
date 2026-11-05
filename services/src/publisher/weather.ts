import type {
  Beach,
  MidLandDay as MidLandDayOut,
  MidTaDay as MidTaDayOut,
  WeatherFile,
  WeatherGrid,
  WeatherPoint,
  WeatherPrecip,
  WeatherShortDay,
  WeatherSky,
} from "@baradun/contracts";
import type { Logger } from "../core/collect/log";
import {
  addDays,
  HOUR_FIELDS,
  kstDate,
  type HourRow,
  type MidHalf,
} from "../core/weather/kma";
import type {
  MidState,
  NowGrids,
  ShortGrid,
  ShortGrids,
} from "../core/weather/state";
import {
  formatUtcIso,
  KST_OFFSET_MS,
  parseUtcIso,
} from "../core/warnings/time";
import { PUBLISH_POLICY } from "./policy";

// weather.json 만들기 (BRD-181, 결정 기록 18장 D18-1·D18-2·D18-8·D18-9)
// 수집기가 저장한 원래 값에서 고르기만 함. 새 값을 만들지 않음
// - 오늘~모레: 3시간 간격(KST 00·03·…·21시) 점
// - 글피(단기)·그 뒤 3일(중기): 하루 한 칸 = 그날 가장 높은 강수확률 + 그 시각(반나절)의 하늘. 같으면 이른 시각
// - 오늘 최저·최고: 그날 TMN·TMX를 담은 가장 늦은 발표 값(시간별 기온으로 대신하지 않음)
// - 지금 기온: 초단기실황
// 발표 뒤 오래된 값(단기 12시간·중기 24시간·실황 2시간, 2026-11-05 사용자 결정)과 받지 못한 값은 null
// 날씨는 참고 정보. 분류에 쓰지 않음(G1): 판단 파일과 따로 게시하고, 만들지 못해도 판단 게시를 막지 않음(publish.ts)

export interface WeatherAreaEntry {
  readonly grid: string;
  readonly midLand: string;
  readonly midTa: string;
}
export interface WeatherAreaTable {
  readonly beaches: Readonly<Record<string, WeatherAreaEntry>>;
  readonly landNames: Readonly<Record<string, string>>;
  readonly taNames: Readonly<Record<string, string>>;
}

export interface WeatherInputs {
  readonly short: ShortGrids;
  readonly now: NowGrids;
  readonly mid: MidState;
}

const HOUR_MS = 60 * 60 * 1000;

// data/weather-areas.json → 게시용 표. 모양이 틀린 항목은 빼고 알림(날씨 하나 때문에 판단 게시를 멈추지 않음)
export function parseWeatherAreaTable(
  json: unknown,
  log: Logger,
): WeatherAreaTable {
  const beaches: Record<string, WeatherAreaEntry> = {};
  const landNames: Record<string, string> = {};
  const taNames: Record<string, string> = {};
  const raw = (json as { beaches?: unknown } | null)?.beaches;
  const invalid: string[] = [];
  for (const [id, entry] of Object.entries(
    typeof raw === "object" && raw !== null ? raw : {},
  )) {
    const e = entry as {
      grid?: { nx?: unknown; ny?: unknown };
      midLand?: { regId?: unknown; name?: unknown };
      midTa?: { regId?: unknown; name?: unknown };
    };
    const ok =
      Number.isInteger(e.grid?.nx) &&
      Number.isInteger(e.grid?.ny) &&
      typeof e.midLand?.regId === "string" &&
      typeof e.midLand.name === "string" &&
      typeof e.midTa?.regId === "string" &&
      typeof e.midTa.name === "string";
    if (!ok) {
      invalid.push(id);
      continue;
    }
    const landId = e.midLand!.regId as string;
    const taId = e.midTa!.regId as string;
    beaches[id] = {
      grid: `${e.grid!.nx},${e.grid!.ny}`,
      midLand: landId,
      midTa: taId,
    };
    landNames[landId] = e.midLand!.name as string;
    taNames[taId] = e.midTa!.name as string;
  }
  if (invalid.length > 0) log("error", "weather_areas_invalid", { invalid });
  return { beaches, landNames, taNames };
}

const SKY: Record<number, WeatherSky> = {
  1: "clear",
  3: "mostlyCloudy",
  4: "cloudy",
};
const PRECIP: Record<number, WeatherPrecip> = {
  0: "none",
  1: "rain",
  2: "rainSnow",
  3: "snow",
  4: "shower",
};
const field = (row: HourRow, name: (typeof HOUR_FIELDS)[number]) =>
  row[HOUR_FIELDS.indexOf(name) + 1] ?? null;

function pointOf(row: HourRow): WeatherPoint {
  const sky = field(row, "SKY");
  const pty = field(row, "PTY");
  return {
    at: formatUtcIso(row[0] * 1000),
    sky: sky === null ? null : (SKY[sky] ?? null),
    precip: pty === null ? null : (PRECIP[pty] ?? null),
    temperature: field(row, "TMP"),
    pop: field(row, "POP"),
    windFrom: field(row, "VEC"),
    windSpeed: field(row, "WSD"),
  };
}

const kstHour = (sec: number) =>
  new Date(sec * 1000 + KST_OFFSET_MS).getUTCHours();

// 중기예보 하늘 글자(wf) → 하늘·강수 형태. 활용가이드 표기: '맑음', '구름많음', '구름많고 비', '흐리고 눈' 등
// 모르는 글자는 둘 다 null(맑음으로 바꾸지 않음) + 알림
const WF_SKY: Record<string, WeatherSky> = {
  맑음: "clear",
  구름많음: "mostlyCloudy",
  구름많고: "mostlyCloudy",
  흐림: "cloudy",
  흐리고: "cloudy",
};
const WF_PRECIP: Record<string, WeatherPrecip> = {
  비: "rain",
  눈: "snow",
  "비/눈": "rainSnow",
  "눈/비": "rainSnow",
  소나기: "shower",
};
export function parseWf(
  wf: string,
): { sky: WeatherSky; precip: WeatherPrecip } | null {
  const [head, tail, ...rest] = wf.trim().split(/\s+/);
  if (rest.length > 0 || head === undefined) return null;
  const sky = WF_SKY[head];
  if (sky === undefined) return null;
  if (tail === undefined) {
    // '구름많고'·'흐리고'는 뒤에 강수가 붙어야 함
    return head.endsWith("고") ? null : { sky, precip: "none" };
  }
  const precip = head.endsWith("고") ? WF_PRECIP[tail] : undefined;
  return precip === undefined ? null : { sky, precip };
}

function shortDay(grid: ShortGrid, date: string): WeatherShortDay | null {
  const rows = grid.hours.filter((row) => kstDate(row[0] * 1000) === date);
  if (rows.length === 0) return null;
  let best: HourRow | null = null;
  for (const row of rows) {
    const pop = field(row, "POP");
    if (pop === null) continue;
    if (best === null || pop > (field(best, "POP") as number)) best = row;
  }
  const extremes = grid.extremes[date];
  const point = best ? pointOf(best) : null;
  return {
    date,
    pop: point?.pop ?? null,
    popAt: point?.at ?? null,
    sky: point?.sky ?? null,
    precip: point?.precip ?? null,
    min: extremes?.tmn?.v ?? null,
    max: extremes?.tmx?.v ?? null,
  };
}

const fresh = (iso: string | undefined, nowMs: number, maxAgeMs: number) => {
  const ms = iso === undefined ? null : parseUtcIso(iso);
  return ms !== null && nowMs - ms <= maxAgeMs && ms <= nowMs + HOUR_MS;
};

function gridOf(
  key: string,
  inputs: WeatherInputs,
  today: string,
  nowMs: number,
): WeatherGrid {
  const stored = inputs.short[key];
  const maxAge = PUBLISH_POLICY.weatherMaxAgeMs;
  let short: WeatherGrid["short"] = null;
  if (stored && fresh(stored.issuedAt, nowMs, maxAge.short)) {
    const dates = [today, addDays(today, 1), addDays(today, 2)];
    const points = stored.hours
      .filter(
        (row) =>
          dates.includes(kstDate(row[0] * 1000)) && kstHour(row[0]) % 3 === 0,
      )
      .map(pointOf);
    const day = shortDay(stored, addDays(today, 3));
    short = { issuedAt: stored.issuedAt, points, days: day ? [day] : [] };
  }
  const ext = stored?.extremes[today];
  const now = inputs.now[key];
  return {
    short,
    today: {
      date: today,
      min: ext?.tmn?.v ?? null,
      minIssuedAt: ext?.tmn ? ext.tmn.issuedAt : null,
      max: ext?.tmx?.v ?? null,
      maxIssuedAt: ext?.tmx ? ext.tmx.issuedAt : null,
    },
    now:
      now && fresh(now.observedAt, nowMs, maxAge.now)
        ? { observedAt: now.observedAt, temperature: now.temperature }
        : null,
  };
}

// 반나절 후보 중 강수확률이 가장 높은 것(같으면 앞 = 이른 시각). 값이 하나도 없으면 null
function pickHalf(halves: readonly (MidHalf | undefined)[]): MidHalf | null {
  let best: MidHalf | null = null;
  for (const half of halves) {
    if (!half || half.pop === null) continue;
    if (best === null || half.pop > (best.pop as number)) best = half;
  }
  return best;
}

export function buildWeather(
  table: WeatherAreaTable,
  publicBeaches: readonly Beach[],
  inputs: WeatherInputs,
  nowMs: number,
  log: Logger,
): WeatherFile {
  const today = kstDate(nowMs);
  const maxAge = PUBLISH_POLICY.weatherMaxAgeMs;
  const midDates = [4, 5, 6].map((n) => addDays(today, n));
  const beaches: WeatherFile["beaches"] = {};
  for (const beach of publicBeaches) {
    if (beach.hidden) continue;
    const entry = table.beaches[beach.id];
    if (entry) beaches[beach.id] = { ...entry };
  }
  const used = Object.values(beaches);
  const grids: WeatherFile["grids"] = {};
  for (const key of new Set(used.map((e) => e.grid))) {
    grids[key] = gridOf(key, inputs, today, nowMs);
  }
  const unknownWf = new Set<string>();
  const midLand: WeatherFile["midLand"] = {};
  for (const regId of new Set(used.map((e) => e.midLand))) {
    const stored = inputs.mid.land[regId] ?? {};
    midLand[regId] = {
      name: table.landNames[regId]!,
      days: midDates.map((date): MidLandDayOut => {
        const day = stored[date];
        if (!day || !fresh(day.issuedAt, nowMs, maxAge.mid)) {
          return { date, issuedAt: null, pop: null, sky: null, precip: null };
        }
        const half = pickHalf(day.all ? [day.all] : [day.am, day.pm]);
        const wf = half?.wf ?? null;
        const parsed = wf === null ? null : parseWf(wf);
        if (wf !== null && parsed === null) unknownWf.add(wf);
        return {
          date,
          issuedAt: day.issuedAt,
          pop: half?.pop ?? null,
          sky: parsed?.sky ?? null,
          precip: parsed?.precip ?? null,
        };
      }),
    };
  }
  if (unknownWf.size > 0) {
    log("warn", "weather_unknown_wf", { wf: [...unknownWf] });
  }
  const midTa: WeatherFile["midTa"] = {};
  for (const regId of new Set(used.map((e) => e.midTa))) {
    const stored = inputs.mid.ta[regId] ?? {};
    midTa[regId] = {
      name: table.taNames[regId]!,
      days: midDates.map((date): MidTaDayOut => {
        const day = stored[date];
        return day && fresh(day.issuedAt, nowMs, maxAge.mid)
          ? { date, issuedAt: day.issuedAt, min: day.min, max: day.max }
          : { date, issuedAt: null, min: null, max: null };
      }),
    };
  }
  return { beaches, grids, midLand, midTa };
}
