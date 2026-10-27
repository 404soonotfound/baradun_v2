import { useEffect, useSyncExternalStore } from "react";

import type { WaveHeightHistory } from "@baradun/contracts";

import { isTime } from "./clock";
import { REQUEST_TIMEOUT_MS } from "./store";
import { useSnapshot } from "./use-snapshot";
import { hidesLastValues, isRecord } from "./view";

// 상세 24시간 파고 (BRD-32, 계약 HistoryFile). manifest가 가리키는 파일을 브라우저가 받음(G4)
// 받는 방식은 nationwide.ts(홈 해상 특보)와 같음: 지금 snapshotVersion 폴더만, 늦게 온 이전 응답은 버림

export type HistoryView =
  | { kind: "loading" }
  | { kind: "failed" } // 받지 못함·읽을 수 없음 → 차트 자리에 실패 문구(측정값 없음과 구분)
  | { kind: "ready"; history: WaveHeightHistory | null }; // null = 이 측정소 기록이 파일에 없음

// 측정소 하나의 기록이 계약 모양인지. 점 하나라도 읽을 수 없으면 그 측정소 전체를 버림(일부만 그려 비어 보이지 않게)
export function readStationHistory(value: unknown): WaveHeightHistory | null {
  if (!isRecord(value) || value.unit !== "m" || !Array.isArray(value.points)) {
    return null;
  }
  const readable = value.points.every(
    (point) =>
      isRecord(point) &&
      isTime(point.t) &&
      (point.v === null ||
        (typeof point.v === "number" && Number.isFinite(point.v))),
  );
  return readable ? (value as unknown as WaveHeightHistory) : null;
}

// 파일 전체: stations가 객체여야 읽음. 측정소별 확인은 화면이 고른 측정소만(readStationHistory)
function readHistoryFile(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.stations) ? value.stations : null;
}

type Loaded = {
  url: string | null;
  stations: Record<string, unknown> | null;
  failed: boolean;
};
const EMPTY: Loaded = { url: null, stations: null, failed: false };
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
    const stations = readHistoryFile(await response.json());
    next = stations
      ? { url, stations, failed: false }
      : { url, stations: null, failed: true };
  } catch {
    next = { url, stations: null, failed: true };
  } finally {
    if (loadingUrl === url) loadingUrl = null;
  }
  if (url === latestUrl) set(next);
}

// 화면에서: const history = useStationHistory(beach.stations.waveHeight?.id ?? null)
export function useStationHistory(stationId: string | null): HistoryView {
  const snapshot = useSnapshot();
  const manifest = snapshot.manifest;
  const hidden = hidesLastValues(snapshot.phase);
  const url =
    !hidden &&
    manifest &&
    manifest.files.history === `/data/${manifest.snapshotVersion}/history.json`
      ? manifest.files.history
      : null;

  useEffect(() => {
    if (url && stationId) void load(url);
  }, [url, stationId, snapshot.live, manifest]);

  const state = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => EMPTY,
  );

  if (hidden) return { kind: "failed" };
  if (!manifest) {
    return snapshot.phase === "loading"
      ? { kind: "loading" }
      : { kind: "failed" };
  }
  if (url === null) return { kind: "failed" };
  // 이전 버전 파일은 지금 스냅샷의 기록이 아님 → 새 파일을 받을 때까지 loading
  if (state.url !== url) return { kind: "loading" };
  if (state.failed || state.stations === null) return { kind: "failed" };
  if (stationId === null) return { kind: "ready", history: null };
  const raw = state.stations[stationId];
  if (raw === undefined) return { kind: "ready", history: null };
  const history = readStationHistory(raw);
  return history ? { kind: "ready", history } : { kind: "failed" };
}
