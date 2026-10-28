import { useSyncExternalStore } from "react";

import type { LocationState } from "@/lib/location";
import { NOTICE_VERSION } from "@/lib/notice-version";
import { isTime } from "@/lib/snapshot/clock";

// 첫 실행 기록 (BRD-25 · 노션 1장 이동 규칙, 2장 ON-1·ON-2)
// ON-1 서비스 안내·면책 고지: '확인했어요'를 누른 시각과 고지 버전을 기기에 저장. 버전이 바뀌면 다시 보여줌. 건너뛰기 없음
// ON-2 위치 사전 안내: 버튼 하나(위치 사용하기 / 지역 직접 고르기)를 고르면 끝.
// 위치 권한을 이미 정한 기기는 보여주지 않고 지난 것으로 저장(앱을 열 때마다 잠깐 뜨지 않게)
// 기기에만 저장하고 서버로 보내지 않음(로그인 없음, D1). 저장 틀은 lib/device-list.ts·region.ts와 같음

// [1] 고지 문구 버전(lib/notice-version.ts, 약관 화면도 읽음). 문구를 바꾸면 그 파일에서 1 올림
export { NOTICE_VERSION };

// [2] 저장하는 값
export type OnboardingRecord = {
  noticeVersion: number; // 확인한 고지 버전
  acknowledgedAt: string; // '확인했어요'를 누른 시각(ISO, UTC)
  locationStepDone: boolean; // ON-2에서 버튼을 골랐는지
};

// [3] 지금 덮을 단계. null = 덮지 않음
export type OnboardingStep = "notice" | "location" | null;

// [4] 위치 권한을 이미 정한 기기인지(받는 중·허용·거부·받을 수 없음). 확인 중이면 아직 모름
export function locationDecided(status: LocationState["status"]): boolean {
  return status !== "checking" && status !== "idle";
}

// [5] 기록 + 위치 상태 → 단계 (순수 함수)
// ON-2는 아직 묻지 않은 기기(idle)에만. 확인 중이면 결과를 기다림(덮었다 사라지지 않게), 정한 기기는 건너뜀
export function onboardingStep(
  record: OnboardingRecord | null,
  locationStatus: LocationState["status"],
): OnboardingStep {
  if (record === null || record.noticeVersion !== NOTICE_VERSION) {
    return "notice";
  }
  if (record.locationStepDone || locationStatus !== "idle") return null;
  return "location";
}

// [6] 저장 글자 → 기록. 모양이 다르면 null(고지를 다시 보여줌)
export function parseRecord(raw: string | null): OnboardingRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { noticeVersion, acknowledgedAt, locationStepDone } = value as Record<
      string,
      unknown
    >;
    if (
      !Number.isInteger(noticeVersion) ||
      !isTime(acknowledgedAt) ||
      typeof locationStepDone !== "boolean"
    ) {
      return null;
    }
    return {
      noticeVersion: noticeVersion as number,
      acknowledgedAt,
      locationStepDone,
    };
  } catch {
    return null;
  }
}

// [7] 기기 저장. 테스트에서 저장소를 바꿔 끼울 수 있게 만드는 함수로 둠
export function createOnboardingStore(storageKey: string) {
  let memory: OnboardingRecord | null = null; // 저장소를 못 쓰는 환경 대비
  let lastRaw: string | null = null; // 같은 글자면 같은 객체를 돌려주기 위한 기억
  let lastValue: OnboardingRecord | null = null;
  // 쓰기가 실패한 적 있음(읽기만 되는 환경). 이후로는 memory를 읽음 → 덮개가 닫히지 않는 일이 없게
  let writeFailed = false;
  const listeners = new Set<() => void>();

  function read(): OnboardingRecord | null {
    if (writeFailed) return memory;
    let raw: string | null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return memory;
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastValue = parseRecord(raw);
    }
    return lastValue;
  }

  // null = 기록 지움(기기 데이터 초기화, BRD-36) → 다음 그리기에서 ON-1부터 다시
  function write(next: OnboardingRecord | null) {
    memory = next;
    try {
      if (next === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      writeFailed = true;
    }
    listeners.forEach((listener) => listener());
  }

  // 다른 탭에서 바꾼 것도 따라감
  function subscribe(onChange: () => void) {
    listeners.add(onChange);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }

  // ON-1 '확인했어요'. 지금 버전과 시각을 저장하고, ON-2를 이미 지났으면 그 기록은 유지
  function acknowledge(at: string = new Date().toISOString()) {
    write({
      noticeVersion: NOTICE_VERSION,
      acknowledgedAt: at,
      locationStepDone: read()?.locationStepDone ?? false,
    });
  }

  // ON-2에서 버튼을 고름. 고지 확인 기록이 없으면 아무것도 하지 않음(ON-1부터 다시)
  function finishLocationStep() {
    const record = read();
    if (record) write({ ...record, locationStepDone: true });
  }

  function clear() {
    write(null);
  }

  return { read, subscribe, acknowledge, finishLocationStep, clear };
}

// [8] 앱 전체에서 하나
const store = createOnboardingStore("baradun:onboarding");

// 기기 데이터 초기화 직후라 첫 실행 안내(ON-1) 안에서 결과를 알려야 함(이번 방문 메모리만).
// ON-1이 바로 덮고 뒤 화면을 막아(inert) 설정 화면의 토스트가 보이지도 읽히지도 않으므로
let resetNotice = false;

export function showsResetNotice(): boolean {
  return resetNotice;
}

export function acknowledgeNotice() {
  resetNotice = false;
  store.acknowledge();
}

export function finishLocationStep() {
  store.finishLocationStep();
}

// afterReset: 기기 데이터 초기화로 지움 → 다시 덮는 ON-1에 '기기 데이터를 지웠어요'를 보여 줌
export function clearOnboarding(options: { afterReset?: boolean } = {}) {
  resetNotice = options.afterReset ?? false;
  store.clear();
}

// [9] 화면에서: const record = useOnboarding();
// undefined = 아직 모름(서버 HTML·첫 그리기). 이때는 덮지 않고 기기 기록을 읽은 뒤 정함
export function useOnboarding(): OnboardingRecord | null | undefined {
  return useSyncExternalStore(store.subscribe, store.read, () => undefined);
}
