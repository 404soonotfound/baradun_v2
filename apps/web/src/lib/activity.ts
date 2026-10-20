import { useSyncExternalStore } from "react";
import type { Beach } from "@baradun/contracts";

// 선택한 활동 (노션 1장: 선택 활동은 전 화면 공통으로 유지, 아키텍처: 기기에 저장) (BRD-24)
// 출시 활동은 수영·서핑·스쿠버다이빙 3종(B7). 종류는 계약(Beach.activities)에서 가져옴.
export type Activity = Beach["activities"][number];
export const ACTIVITIES = [
  "swimming",
  "surfing",
  "scuba",
] as const satisfies readonly Activity[];
export const DEFAULT_ACTIVITY: Activity = "swimming";

// 앱을 닫았다 열어도 남아야 해서 sessionStorage가 아니라 localStorage(노션: 기기에 저장)
const STORAGE_KEY = "baradun:activity";

// 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 이번 방문 동안은 유지되게 메모리에도 둠.
let memory: Activity = DEFAULT_ACTIVITY;
// 값이 바뀌면 부를 함수 모음. () => void = 인자 없이 부르고 돌려주는 값 없는 함수. Set이라 같은 함수 중복 등록 없음
const listeners = new Set<() => void>();

function isActivity(value: unknown): value is Activity {
  return (ACTIVITIES as readonly unknown[]).includes(value);
}

function read(): Activity {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isActivity(stored) ? stored : memory;
  } catch {
    return memory;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // 다른 브라우저 탭에서 바꿔도 반영
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setActivity(activity: Activity) {
  memory = activity;
  try {
    localStorage.setItem(STORAGE_KEY, activity);
  } catch {
    // 저장 못 해도 memory로 이번 방문 동안은 유지
  }
  listeners.forEach((listener) => listener());
}

// 원본이 React 바깥(브라우저 저장소)이라 Context Provider 대신 useSyncExternalStore를 씀.
// 감쌀 필요 없이 어느 컴포넌트든 useActivity() 한 줄로 같은 값을 받음.
// 서버(정적 HTML)는 빌드 때 만들어져 저장 값을 모르니 기본값, 브라우저에서는 저장된 값. 둘이 달라도 React가 알아서 다시 그림.
// (useState+useEffect로 하면 이 처리를 직접 해야 하고 effect 안 setState 린트 경고도 남.)
// 주의: 첫 화면에 잠깐 기본값(수영)이 보였다가 바뀔 수 있음. 문제가 되면 홈 화면(BRD-26)에서 타일을 잠깐 흐리게 두는 식으로 다룸.
export function useActivity(): Activity {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_ACTIVITY);
}

// 연습용: 채점 스크립트가 쓰는 줄. 커밋 전에 지움
export const __test = { isActivity, read, subscribe };
