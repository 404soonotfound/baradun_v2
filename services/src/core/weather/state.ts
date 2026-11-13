import { gunzipSync, gzipSync } from "node:zlib";
import type { StateValue } from "../store/types";
import { MAX_ARCHIVE_CHARS } from "../warnings/archive";
import { parseUtcIso } from "../warnings/time";
import {
  HOUR_FIELDS,
  type DayExtremes,
  type Extreme,
  type HourRow,
  type MidHalf,
  type MidLandDay,
  type MidTaDay,
  type NowObservation,
  type ShortForecast,
} from "./kma";

// 날씨 수집 저장 형식 (BRD-181). collect-weather가 쓰고 publisher가 읽음
// - short: 격자별 마지막 단기예보(시간별 원래 값) + 날짜별 최저·최고(TMN·TMX). 154격자 × 약 70시간이라 gzip + base64 글자로 둠
//   (DynamoDB 항목 한도 400KB, 특보 원본 묶음과 같은 방식·상한)
// - now: 격자별 마지막 초단기실황 기온
// - mid: 육상 구역·기온 지점별, 날짜마다 그 날짜를 담은 가장 늦은 발표의 값
// 모두 원래 값만 둠. 하루 한 칸 고르기·3시간 간격·오래된 값 거르기는 publisher가 함(규칙이 바뀌어도 다시 계산)
// 합칠 때 같은 곳의 더 이른 발표가 늦은 발표를 덮지 않음. 실패한 곳은 이전 값 유지

export type GridKey = string; // "nx,ny"
export const gridKey = (g: { nx: number; ny: number }): GridKey =>
  `${g.nx},${g.ny}`;

export interface ShortGrid {
  readonly issuedAt: string;
  readonly hours: readonly HourRow[];
  readonly extremes: Readonly<Record<string, DayExtremes>>;
}
export type ShortGrids = Readonly<Record<GridKey, ShortGrid>>;
export type NowGrids = Readonly<Record<GridKey, NowObservation>>;
export interface MidState {
  readonly land: Readonly<Record<string, Readonly<Record<string, MidLandDay>>>>;
  readonly ta: Readonly<Record<string, Readonly<Record<string, MidTaDay>>>>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const later = (a: string, b: string) =>
  (parseUtcIso(a) ?? -Infinity) >= (parseUtcIso(b) ?? -Infinity);

export type Packed =
  { status: "ok"; archive: string } | { status: "failed"; reason: string };

export function packShort(grids: ShortGrids): Packed {
  const archive = gzipSync(Buffer.from(JSON.stringify(grids), "utf8")).toString(
    "base64",
  );
  return archive.length > MAX_ARCHIVE_CHARS
    ? { status: "failed", reason: `archive_too_large:${archive.length}` }
    : { status: "ok", archive };
}

// 칸 하나하나의 모양 검사. 틀린 칸은 버림(값이 없는 것으로 봄, 0·맑음으로 바꾸지 않음)
const isIso = (v: unknown): v is string =>
  typeof v === "string" && parseUtcIso(v) !== null;
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);

// [시각(초, 정수), 값 × HOUR_FIELDS] 모양만
function isHourRow(row: unknown): row is HourRow {
  return (
    Array.isArray(row) &&
    row.length === HOUR_FIELDS.length + 1 &&
    Number.isInteger(row[0]) &&
    row.slice(1).every(numOrNull)
  );
}

function readExtreme(v: unknown): Extreme | undefined {
  return isObject(v) && numOrNull(v.v) && isIso(v.issuedAt)
    ? { v: v.v as number | null, issuedAt: v.issuedAt }
    : undefined;
}

function readExtremes(v: unknown): Record<string, DayExtremes> {
  const out: Record<string, DayExtremes> = {};
  if (!isObject(v)) return out;
  for (const [date, day] of Object.entries(v)) {
    if (!isObject(day)) continue;
    const tmn = readExtreme(day.tmn);
    const tmx = readExtreme(day.tmx);
    if (tmn || tmx)
      out[date] = { ...(tmn ? { tmn } : {}), ...(tmx ? { tmx } : {}) };
  }
  return out;
}

// 깨진 기록은 null(읽지 못함). 빈 값으로 바꾸지 않고 부르는 쪽이 정함. 틀린 격자·행·칸만 버림
export function readShort(value: StateValue | undefined): ShortGrids | null {
  if (!isObject(value) || typeof value.archive !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(
      gunzipSync(Buffer.from(value.archive, "base64")).toString("utf8"),
    );
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  const out: Record<string, ShortGrid> = {};
  for (const [key, grid] of Object.entries(json)) {
    if (
      !isObject(grid) ||
      !isIso(grid.issuedAt) ||
      !Array.isArray(grid.hours)
    ) {
      continue;
    }
    out[key] = {
      issuedAt: grid.issuedAt,
      hours: grid.hours.filter(isHourRow),
      extremes: readExtremes(grid.extremes),
    };
  }
  return out;
}

export function readNow(value: StateValue | undefined): NowGrids | null {
  if (!isObject(value) || !isObject(value.grids)) return null;
  const out: Record<string, NowObservation> = {};
  for (const [key, obs] of Object.entries(value.grids)) {
    if (
      isObject(obs) &&
      typeof obs.observedAt === "string" &&
      parseUtcIso(obs.observedAt) !== null &&
      typeof obs.temperature === "number"
    ) {
      out[key] = { observedAt: obs.observedAt, temperature: obs.temperature };
    }
  }
  return out;
}

function readHalf(v: unknown): MidHalf | undefined {
  return isObject(v) &&
    numOrNull(v.pop) &&
    (v.wf === null || typeof v.wf === "string")
    ? { pop: v.pop as number | null, wf: v.wf as string | null }
    : undefined;
}

// 구역·지점마다 날짜 칸을 하나씩 검사해 틀린 칸만 버림(깨진 칸 하나가 수집 전체를 멈추지 않게)
export function readMid(value: StateValue | undefined): MidState | null {
  if (!isObject(value) || !isObject(value.land) || !isObject(value.ta)) {
    return null;
  }
  const land: Record<string, Record<string, MidLandDay>> = {};
  for (const [regId, days] of Object.entries(value.land)) {
    const out: Record<string, MidLandDay> = {};
    for (const [date, day] of Object.entries(isObject(days) ? days : {})) {
      if (!isObject(day) || !isIso(day.issuedAt)) continue;
      const halves: Partial<Record<"am" | "pm" | "all", MidHalf>> = {};
      for (const k of ["am", "pm", "all"] as const) {
        const h = readHalf(day[k]);
        if (h) halves[k] = h;
      }
      if (Object.keys(halves).length > 0) {
        out[date] = { issuedAt: day.issuedAt, ...halves };
      }
    }
    land[regId] = out;
  }
  const ta: Record<string, Record<string, MidTaDay>> = {};
  for (const [regId, days] of Object.entries(value.ta)) {
    const out: Record<string, MidTaDay> = {};
    for (const [date, day] of Object.entries(isObject(days) ? days : {})) {
      if (
        isObject(day) &&
        isIso(day.issuedAt) &&
        numOrNull(day.min) &&
        numOrNull(day.max)
      ) {
        out[date] = {
          issuedAt: day.issuedAt,
          min: day.min as number | null,
          max: day.max as number | null,
        };
      }
    }
    ta[regId] = out;
  }
  return { land, ta };
}

// 날짜별 최저·최고는 칸마다 더 늦은 발표 값을 남김. today(KST) 이전 날짜는 버림
function mergeExtremes(
  prev: Readonly<Record<string, DayExtremes>>,
  next: Readonly<Record<string, DayExtremes>>,
  today: string,
): Record<string, DayExtremes> {
  const out: Record<string, DayExtremes> = {};
  const pick = (a?: Extreme, b?: Extreme) =>
    !a ? b : !b ? a : later(b.issuedAt, a.issuedAt) ? b : a;
  for (const date of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (date < today) continue;
    const tmn = pick(prev[date]?.tmn, next[date]?.tmn);
    const tmx = pick(prev[date]?.tmx, next[date]?.tmx);
    out[date] = { ...(tmn ? { tmn } : {}), ...(tmx ? { tmx } : {}) };
  }
  return out;
}

// keep: 지금 대응표에 있는 격자(없어진 격자의 이전 값은 버림)
export function mergeShort(
  prev: ShortGrids,
  fresh: ReadonlyMap<GridKey, ShortForecast>,
  keep: ReadonlySet<GridKey>,
  today: string,
): Record<GridKey, ShortGrid> {
  const out: Record<GridKey, ShortGrid> = {};
  for (const key of keep) {
    const before = prev[key];
    const next = fresh.get(key);
    if (!next) {
      if (before) {
        out[key] = {
          ...before,
          extremes: mergeExtremes(before.extremes, {}, today),
        };
      }
      continue;
    }
    const newer = !before || later(next.issuedAt, before.issuedAt);
    const base = newer ? next : before;
    out[key] = {
      issuedAt: base.issuedAt,
      hours: base.hours,
      extremes: mergeExtremes(before?.extremes ?? {}, next.extremes, today),
    };
  }
  return out;
}

export function mergeNow(
  prev: NowGrids,
  fresh: ReadonlyMap<GridKey, NowObservation>,
  keep: ReadonlySet<GridKey>,
): Record<GridKey, NowObservation> {
  const out: Record<GridKey, NowObservation> = {};
  for (const key of keep) {
    const before = prev[key];
    const next = fresh.get(key);
    const pick =
      next && (!before || later(next.observedAt, before.observedAt))
        ? next
        : before;
    if (pick) out[key] = pick;
  }
  return out;
}

function mergeDays<D extends { issuedAt: string }>(
  prev: Readonly<Record<string, D>>,
  next: Readonly<Record<string, D>>,
  today: string,
): Record<string, D> {
  const out: Record<string, D> = {};
  for (const date of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (date < today) continue;
    const a = prev[date];
    const b = next[date];
    const pick = !a ? b : !b ? a : later(b.issuedAt, a.issuedAt) ? b : a;
    if (pick) out[date] = pick;
  }
  return out;
}

export function mergeMid(
  prev: MidState,
  fresh: {
    land: ReadonlyMap<string, Readonly<Record<string, MidLandDay>>>;
    ta: ReadonlyMap<string, Readonly<Record<string, MidTaDay>>>;
  },
  keep: { land: ReadonlySet<string>; ta: ReadonlySet<string> },
  today: string,
): MidState {
  const land: Record<string, Record<string, MidLandDay>> = {};
  for (const regId of keep.land) {
    land[regId] = mergeDays(
      prev.land[regId] ?? {},
      fresh.land.get(regId) ?? {},
      today,
    );
  }
  const ta: Record<string, Record<string, MidTaDay>> = {};
  for (const regId of keep.ta) {
    ta[regId] = mergeDays(
      prev.ta[regId] ?? {},
      fresh.ta.get(regId) ?? {},
      today,
    );
  }
  return { land, ta };
}

// 가장 늦은 발표 시각. 구역의 날짜 중 하나라도 그 발표를 담았으면 받은 것으로 봄(18:00 발표는 4일 칸이 없음)
export function latestIssue(
  days: Readonly<Record<string, { issuedAt: string }>> | undefined,
): number | null {
  let best: number | null = null;
  for (const day of Object.values(days ?? {})) {
    const ms = parseUtcIso(day.issuedAt);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}
