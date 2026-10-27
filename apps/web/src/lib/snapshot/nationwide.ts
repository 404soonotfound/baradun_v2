import { useEffect, useSyncExternalStore } from "react";

import type { NationwideWarningsFile, WarningItem } from "@baradun/contracts";

import {
  CLOCK_TOLERANCE_MS,
  correctedNow,
  expiryDeadline,
  isExpired,
  isTime,
} from "./clock";
import { REQUEST_TIMEOUT_MS } from "./store";
import { refreshSnapshot, useSnapshot } from "./use-snapshot";
import {
  hidesLastValues,
  includes,
  isRecord,
  WARNING_CONFIRM_VALID_MS,
  WARNING_LEVELS,
  WARNING_TYPES,
  type ViewSource,
} from "./view";

// 홈 '해상 특보' (BRD-26, 계약 NationwideWarningsFile). manifest가 가리키는 파일을 브라우저가 받음(G4)
// '특보 없음'은 범위(전국 해상)·기관(기상청)·확인 시각이 모두 있고 45분 안일 때만. 그 밖은 '확인 못 함'
// 45분 유효시간·특보 종류·단계·요청 시간 제한은 view.ts·store.ts 값을 그대로 씀

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
      includes(WARNING_TYPES, item.type) &&
      includes(WARNING_LEVELS, item.level) &&
      typeof item.zoneName === "string" &&
      item.zoneName !== "" &&
      (item.zoneCode === null || typeof item.zoneCode === "string") &&
      isTime(item.publishedAt) &&
      isTime(item.effectiveFrom),
  );
  // as unknown as = 위에서 직접 확인했으니 이 타입으로 보라고 알려줌
  return readable ? (value as unknown as NationwideWarningsFile) : null;
}

// [5] 받은 파일 + 지금 데이터 상태 → 화면 상태 (순수 함수라 테스트하기 쉬움)
export function nationwideView(
  file: NationwideWarningsFile | null,
  failed: boolean,
  source: Pick<ViewSource, "live" | "nowMs" | "clock">,
): NationwideView {
  if (file === null) return failed ? { kind: "failed" } : { kind: "loading" };
  const confirmedMs =
    file.lastConfirmedAt === null ? NaN : Date.parse(file.lastConfirmedAt);
  // 미래 확인 시각은 근거로 인정하지 않음(view.ts isFuture와 같은 2분 여유, 14.1 판정 규칙) → '확인 시각 모름'
  // nowMs가 NaN(지금 시각 모름)이면 비교가 false → 미래로 보고 버림
  const confirmedAt =
    confirmedMs <= source.nowMs + CLOCK_TOLERANCE_MS
      ? file.lastConfirmedAt
      : null;
  // 45분 만료는 해변 화면과 같은 isExpired(서버 시각을 모르면 5분 앞당김, 지금 시각 모르면 만료)
  const fresh =
    confirmedAt !== null &&
    !isExpired(
      new Date(confirmedMs + WARNING_CONFIRM_VALID_MS).toISOString(),
      source.nowMs,
      source.clock,
    );
  return {
    kind: "ready",
    items: file.items,
    confirmedAt,
    stale: !source.live || failed || !fresh,
  };
}

// [6] 받은 결과 보관 (activity.ts와 같은 틀). React 바깥 변수라 화면을 옮겨도 남음
export type Loaded = {
  url: string | null;
  file: NationwideWarningsFile | null;
  failed: boolean;
};
const EMPTY: Loaded = { url: null, file: null, failed: false };
let loaded: Loaded = EMPTY;
let loadingUrl: string | null = null; // 받는 중인 주소(같은 요청을 겹쳐 보내지 않게)
// 마지막으로 요청한 주소. 늦게 도착한 이전 버전 응답이 새 버전 결과를 덮지 않게 함
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

// 지금 주소의 결과만 씀. 이전 버전 파일은 새 스냅샷의 확인 결과가 아님 → 새 파일을 받을 때까지 loading
// (이전 빈 목록이 live와 함께 '특보 없음'으로 보이지 않게)
export function currentLoaded(
  state: Loaded,
  url: string,
): Pick<Loaded, "file" | "failed"> {
  return state.url === url
    ? { file: state.file, failed: state.failed }
    : { file: null, failed: false };
}

// [7] 파일 받기. 같은 주소를 이미 받았거나 받는 중이면 건너뜀
async function load(url: string) {
  if ((loaded.url === url && !loaded.failed) || loadingUrl === url) return;
  loadingUrl = url;
  latestUrl = url;
  let next: Loaded;
  try {
    // 버전 경로(/data/{v}/…)라 내용이 바뀌지 않음 → 브라우저 캐시를 그대로 씀
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const file = readNationwide(await response.json());
    // 읽을 수 없으면 실패. 이전에 받은 파일은 남겨 'HH:MM 확인 · 이후 확인 못 함'으로 보여줌(B5)
    next = file
      ? { url, file, failed: false }
      : { url, file: loaded.file, failed: true };
  } catch {
    next = { url, file: loaded.file, failed: true };
  } finally {
    // 그사이 다른 주소를 받기 시작했으면 그 표시는 그대로 둠
    if (loadingUrl === url) loadingUrl = null;
  }
  // 이전 버전 응답이 늦게 오면 버림(새 버전 결과·요청을 덮지 않게)
  if (url === latestUrl) set(next);
}

// [8] 화면에서: const warnings = useNationwideWarnings();
export function useNationwideWarnings(): NationwideView {
  const snapshot = useSnapshot();
  const manifest = snapshot.manifest;
  // 점검·강제 업데이트·지원 밖 형식: 지난 값을 보여주지 않음(9.1, deriveBeachView와 같은 규칙)
  const hidden = hidesLastValues(snapshot.phase);
  // 지금 snapshotVersion 폴더를 가리킬 때만 받음(store.ts statusPath와 같은 규칙)
  const url =
    !hidden &&
    manifest &&
    manifest.files.nationwideWarnings ===
      `/data/${manifest.snapshotVersion}/nationwide-warnings.json`
      ? manifest.files.nationwideWarnings
      : null;

  // Vue: watch: { url: { handler: "load", immediate: true } } 자리.
  // live가 바뀔 때(오프라인 → 다시 연결)와 manifest를 다시 받을 때(5분 조회·앱 복귀, 조회마다 새 객체)도
  // 실패한 파일을 다시 받음. 이미 받은 파일은 load가 건너뜀
  useEffect(() => {
    if (url) void load(url);
  }, [url, snapshot.live, manifest]);

  const state = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => EMPTY,
  );

  function pick(): NationwideView {
    // 지난 특보 목록·'특보 없음'이 남지 않게 실패로 보여줌
    if (hidden) return { kind: "failed" };
    // manifest를 아직 못 받음: 첫 조회 중이면 loading, 조회가 끝났는데 없으면 failed
    if (!manifest) {
      return snapshot.phase === "loading"
        ? { kind: "loading" }
        : { kind: "failed" };
    }
    // manifest는 있는데 주소가 이상함 → 받지 않고 실패로 보여줌
    if (url === null) return { kind: "failed" };
    const { file, failed } = currentLoaded(state, url);
    return nationwideView(file, failed, snapshot);
  }
  const view = pick();

  // 45분 만료 시각에 바다 정보를 다시 조회(조회가 끝나면 store가 nowMs를 바꿔 화면이 다시 계산됨).
  // store의 만료 타이머는 해변 status만 보므로, 없으면 '특보 없음'이 다음 5분 조회까지 남을 수 있음
  const expiresAt =
    view.kind === "ready" && !view.stale && view.confirmedAt !== null
      ? new Date(
          Date.parse(view.confirmedAt) + WARNING_CONFIRM_VALID_MS,
        ).toISOString()
      : null;
  const { clock } = snapshot;
  useEffect(() => {
    const deadline = expiryDeadline(expiresAt, clock);
    if (deadline === null) return;
    const delay = Math.max(0, deadline - correctedNow(clock, Date.now()));
    const timer = setTimeout(() => {
      // 안 보이는 동안은 조회하지 않음(앱 복귀 때 store가 다시 계산·조회함)
      if (document.visibilityState === "visible") void refreshSnapshot();
    }, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, clock]);

  return view;
}
