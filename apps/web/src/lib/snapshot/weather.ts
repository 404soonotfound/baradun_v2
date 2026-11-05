import { useEffect, useSyncExternalStore } from "react";

import type {
  MidLandForecast,
  MidTaForecast,
  WeatherFile,
  WeatherGrid,
} from "@baradun/contracts";

import { isTime } from "./clock";
import { REQUEST_TIMEOUT_MS } from "./store";
import { useSnapshot } from "./use-snapshot";
import { hidesLastValues, isRecord } from "./view";

// 상세 날씨 (BRD-185, 계약 WeatherFile · 결정 기록 18장 D18-1·D18-2). manifest가 가리키는 파일을 브라우저가 받음(G4)
// 받는 방식은 history.ts(24시간 파고)와 같음: 지금 snapshotVersion 폴더만, 늦게 온 이전 응답은 버림
// 날씨는 참고 정보. 분류·관측 지연·대안 해변에 쓰지 않음(G1). 오래된 값 거르기·하루 한 칸 고르기는 publisher가 함

export type WeatherView =
  | { kind: "loading" }
  | { kind: "failed" } // 받지 못함·읽을 수 없음·이 해변 격자가 계약 모양이 아님 → 카드 자리에 안내 한 줄
  | { kind: "none" } // 이 해변이 날씨 대응표에 없음, 또는 특보·측정값도 숨긴 화면 → 카드를 두지 않음
  | {
      kind: "ready";
      grid: WeatherGrid;
      midLandId: string;
      midLand: MidLandForecast | null; // null = 구역 값이 파일에 없음(중기예보만 못 받음과 같게 보임)
      midTa: MidTaForecast | null;
    };

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const textOrNull = (v: unknown) => v === null || typeof v === "string";
const isDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// 격자 하나가 계약 모양인지. 칸 하나라도 읽을 수 없으면 그 격자 전체를 버림(일부만 그려 비어 보이지 않게)
// 하늘·강수 값은 글자인지만 봄: 모르는 값은 화면이 '–'로 그림(맑음으로 바꾸지 않음)
export function readWeatherGrid(value: unknown): WeatherGrid | null {
  if (!isRecord(value) || !isRecord(value.today)) return null;
  const { short, today, now } = value;
  if (!isDate(today.date) || !numOrNull(today.min) || !numOrNull(today.max)) {
    return null;
  }
  if (
    now !== null &&
    !(isRecord(now) && isTime(now.observedAt) && isNum(now.temperature))
  ) {
    return null;
  }
  if (short !== null) {
    if (
      !isRecord(short) ||
      !isTime(short.issuedAt) ||
      !Array.isArray(short.points) ||
      !Array.isArray(short.days)
    ) {
      return null;
    }
    const pointsOk = short.points.every(
      (p) =>
        isRecord(p) &&
        isTime(p.at) &&
        textOrNull(p.sky) &&
        textOrNull(p.precip) &&
        numOrNull(p.temperature) &&
        numOrNull(p.pop) &&
        numOrNull(p.windFrom) &&
        numOrNull(p.windSpeed),
    );
    const daysOk = short.days.every(
      (d) =>
        isRecord(d) &&
        isDate(d.date) &&
        numOrNull(d.pop) &&
        textOrNull(d.sky) &&
        textOrNull(d.precip) &&
        numOrNull(d.min) &&
        numOrNull(d.max),
    );
    if (!pointsOk || !daysOk) return null;
  }
  return value as unknown as WeatherGrid;
}

// 중기 구역 하나. 날짜 칸 하나라도 읽을 수 없으면 구역 전체를 버림 → 화면은 '이후 날씨를 확인하지 못했어요'
export function readMidLand(value: unknown): MidLandForecast | null {
  if (!isRecord(value) || !Array.isArray(value.days)) return null;
  const ok = value.days.every(
    (d) =>
      isRecord(d) &&
      isDate(d.date) &&
      numOrNull(d.pop) &&
      textOrNull(d.sky) &&
      textOrNull(d.precip),
  );
  return ok ? (value as unknown as MidLandForecast) : null;
}

export function readMidTa(value: unknown): MidTaForecast | null {
  if (!isRecord(value) || !Array.isArray(value.days)) return null;
  const ok = value.days.every(
    (d) =>
      isRecord(d) && isDate(d.date) && numOrNull(d.min) && numOrNull(d.max),
  );
  return ok ? (value as unknown as MidTaForecast) : null;
}

// 파일 전체: 네 묶음이 객체여야 읽음. 해변별 확인은 화면이 고른 해변만(beachWeather)
function readWeatherFile(value: unknown): WeatherFile | null {
  return isRecord(value) &&
    isRecord(value.beaches) &&
    isRecord(value.grids) &&
    isRecord(value.midLand) &&
    isRecord(value.midTa)
    ? (value as unknown as WeatherFile)
    : null;
}

// 해변 하나의 날씨. 대응표에 없으면 none, 격자를 읽을 수 없으면 failed
export function beachWeather(file: WeatherFile, beachId: string): WeatherView {
  const areas: unknown = file.beaches[beachId];
  if (areas === undefined) return { kind: "none" };
  if (
    !isRecord(areas) ||
    typeof areas.grid !== "string" ||
    typeof areas.midLand !== "string" ||
    typeof areas.midTa !== "string"
  ) {
    return { kind: "failed" };
  }
  const grid = readWeatherGrid(file.grids[areas.grid]);
  if (!grid) return { kind: "failed" };
  return {
    kind: "ready",
    grid,
    midLandId: areas.midLand,
    midLand: readMidLand(file.midLand[areas.midLand]),
    midTa: readMidTa(file.midTa[areas.midTa]),
  };
}

type Loaded = { url: string | null; file: WeatherFile | null; failed: boolean };
const EMPTY: Loaded = { url: null, file: null, failed: false };
let loaded: Loaded = EMPTY;
let loadingUrl: string | null = null;
let latestUrl: string | null = null;
const listeners = new Set<() => void>();

function set(next: Loaded) {
  loaded = next;
  listeners.forEach((listener) => listener());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

async function load(url: string) {
  if ((loaded.url === url && !loaded.failed) || loadingUrl === url) return;
  loadingUrl = url;
  latestUrl = url;
  let next: Loaded;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const file = readWeatherFile(await response.json());
    next = file
      ? { url, file, failed: false }
      : { url, file: null, failed: true };
  } catch {
    next = { url, file: null, failed: true };
  } finally {
    if (loadingUrl === url) loadingUrl = null;
  }
  if (url === latestUrl) set(next);
}

// 화면에서: const weather = useBeachWeather(beach.id)
// manifest에 weather가 없으면(게시 전 버전·publisher가 넣지 못함) 못 받음으로 봄(날씨 없음으로 숨기지 않음)
export function useBeachWeather(beachId: string): WeatherView {
  const snapshot = useSnapshot();
  const manifest = snapshot.manifest;
  const hidden = hidesLastValues(snapshot.phase);
  const url =
    !hidden &&
    manifest &&
    manifest.files.weather === `/data/${manifest.snapshotVersion}/weather.json`
      ? manifest.files.weather
      : null;

  useEffect(() => {
    if (url) void load(url);
  }, [url, snapshot.live, manifest]);

  const state = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => EMPTY,
  );

  // 점검·업데이트 필요·처음부터 못 받음: 특보·측정값도 보이지 않는 화면이라 카드를 두지 않음
  // ('특보와 측정값은 위에서 그대로' 안내가 사실과 달라지지 않게)
  if (hidden) return { kind: "none" };
  if (!manifest) {
    return snapshot.phase === "loading"
      ? { kind: "loading" }
      : { kind: "none" };
  }
  if (url === null) return { kind: "failed" };
  // 이전 버전 파일은 지금 스냅샷의 날씨가 아님 → 새 파일을 받을 때까지 loading
  if (state.url !== url) return { kind: "loading" };
  if (state.failed || state.file === null) return { kind: "failed" };
  return beachWeather(state.file, beachId);
}
