import { useEffect, useSyncExternalStore } from "react";

import type { NationwideWarningsFile, WarningItem } from "@baradun/contracts";

import { isTime } from "./clock";
import { useSnapshot } from "./use-snapshot";
import { isRecord, type ViewSource } from "./view";

// 홈 '해상 특보' (BRD-26, 계약 NationwideWarningsFile). manifest가 가리키는 파일을 브라우저가 받음(G4)
// '특보 없음'은 범위(전국 해상)·기관(기상청)·확인 시각이 모두 있고 45분 안일 때만. 그 밖은 '확인 못 함'

// [1] 특보 확인 유효시간. view.ts와 같은 45분(아키텍처 14.3 N2)
const CONFIRM_VALID_MS = 45 * 60_000;
// [2] 요청 하나의 시간 제한. store.ts와 같은 10초
const REQUEST_TIMEOUT_MS = 10_000;

const TYPES = ["wind_wave", "strong_wind", "typhoon", "storm_surge", "tsunami"];
const LEVELS = ["advisory", "warning", "severe_warning"];

// [3] 화면이 받을 모양 (구분 가능한 유니언: kind를 보면 나머지 칸이 정해짐)
export type NationwideView =
  | { kind: "loading" } // 아직 받는 중
  | { kind: "failed" } // 받지 못함·읽을 수 없음. '특보 없음'으로 보이면 안 됨
  | {
      kind: "ready";
      items: WarningItem[];
      confirmedAt: string | null; // 기상청 확인 시각. 모르면 null
      stale: boolean; // 오프라인·실패·45분 지남 → '이후 확인 못 함'
    };

// [4] 받은 값이 계약 모양인지 확인. 항목 하나라도 읽을 수 없으면 null
// (읽은 것만 보여주면 '전국 해상 특보 전부'인 척하게 됨)
export function readNationwide(value: unknown): NationwideWarningsFile | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (value.lastConfirmedAt !== null && !isTime(value.lastConfirmedAt)) {
    return null;
  }
  const readable = value.items.every(
    (item) =>
      isRecord(item) &&
      TYPES.includes(item.type as string) &&
      LEVELS.includes(item.level as string) &&
      typeof item.zoneName === "string" &&
      item.zoneName !== "" &&
      isTime(item.publishedAt),
  );
  // as unknown as = 위에서 직접 확인했으니 이 타입으로 보라고 알려줌
  return readable ? (value as unknown as NationwideWarningsFile) : null;
}

// [5] 받은 파일 + 지금 데이터 상태 → 화면 상태 (순수 함수라 테스트하기 쉬움)
export function nationwideView(
  file: NationwideWarningsFile | null,
  failed: boolean,
  source: Pick<ViewSource, "live" | "nowMs">,
): NationwideView {
  if (file === null) return failed ? { kind: "failed" } : { kind: "loading" };
  const confirmedAt = file.lastConfirmedAt;
  // nowMs가 NaN(지금 시각 모름)이면 비교가 false → 45분 안이라고 보지 않음
  const fresh =
    confirmedAt !== null &&
    source.nowMs <= Date.parse(confirmedAt) + CONFIRM_VALID_MS;
  return {
    kind: "ready",
    items: file.items,
    confirmedAt,
    stale: !source.live || failed || !fresh,
  };
}

// [6] 받은 결과 보관 (activity.ts와 같은 틀). React 바깥 변수라 화면을 옮겨도 남음
type Loaded = {
  url: string | null;
  file: NationwideWarningsFile | null;
  failed: boolean;
};
const EMPTY: Loaded = { url: null, file: null, failed: false };
let loaded: Loaded = EMPTY;
let loadingUrl: string | null = null; // 받는 중인 주소(같은 요청을 겹쳐 보내지 않게)
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

// [7] 파일 받기. 같은 주소를 이미 받았거나 받는 중이면 건너뜀
async function load(url: string) {
  if ((loaded.url === url && !loaded.failed) || loadingUrl === url) return;
  loadingUrl = url;
  try {
    // 버전 경로(/data/{v}/…)라 내용이 바뀌지 않음 → 브라우저 캐시를 그대로 씀
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const file = readNationwide(await response.json());
    // 읽을 수 없으면 실패. 이전에 받은 파일은 남겨 'HH:MM 확인 · 이후 확인 못 함'으로 보여줌(B5)
    set(
      file
        ? { url, file, failed: false }
        : { url, file: loaded.file, failed: true },
    );
  } catch {
    set({ url, file: loaded.file, failed: true });
  } finally {
    loadingUrl = null;
  }
}

// [8] 화면에서: const warnings = useNationwideWarnings();
export function useNationwideWarnings(): NationwideView {
  const snapshot = useSnapshot();
  const manifest = snapshot.manifest;
  // 지금 snapshotVersion 폴더를 가리킬 때만 받음(store.ts statusPath와 같은 규칙)
  const url =
    manifest &&
    manifest.files.nationwideWarnings ===
      `/data/${manifest.snapshotVersion}/nationwide-warnings.json`
      ? manifest.files.nationwideWarnings
      : null;

  // Vue: watch: { url: { handler: "load", immediate: true } } 자리.
  // live가 바뀔 때(오프라인 → 다시 연결)도 실패한 파일을 다시 받음
  useEffect(() => {
    if (url) void load(url);
  }, [url, snapshot.live]);

  const state = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => EMPTY,
  );
  // manifest를 아직 못 받음: 첫 조회 중이면 loading, 조회가 끝났는데 없으면 failed
  if (!manifest) {
    return snapshot.phase === "loading"
      ? { kind: "loading" }
      : { kind: "failed" };
  }
  // manifest는 있는데 주소가 이상함 → 받지 않고 실패로 보여줌
  if (url === null) return { kind: "failed" };
  return nationwideView(state.file, state.failed, snapshot);
}
