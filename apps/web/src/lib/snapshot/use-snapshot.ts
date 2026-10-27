import { useSyncExternalStore } from "react";

import { subscribeOnline } from "@/lib/use-online";

import { WEB_BUILD } from "./build";
import {
  createSnapshotStore,
  INITIAL_STATE,
  type KeyValueStorage,
  type SnapshotState,
  type SnapshotStore,
} from "./store";
import { deriveBeachView, type BeachView } from "./view";

// 바다 정보를 화면에 연결 (BRD-41). 원본이 React 바깥이라 activity.ts처럼 useSyncExternalStore를 씀.
// 정적 HTML(빌드)에는 상태를 넣지 않음(G4): 서버 쪽 값은 항상 "loading"

// 앱 전체에서 하나. 첫 화면이 구독할 때 만들고 시작함
let store: SnapshotStore | null = null;

function browserStorage(name: "localStorage" | "sessionStorage") {
  // 사생활 보호 모드 등에서는 꺼내기만 해도 오류가 남
  try {
    return window[name] as KeyValueStorage;
  } catch {
    return null;
  }
}

function getStore(): SnapshotStore {
  store ??= createSnapshotStore({
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    storage: browserStorage("localStorage"),
    session: browserStorage("sessionStorage"),
    reload: () => window.location.reload(),
    webBuild: WEB_BUILD,
    isVisible: () => document.visibilityState === "visible",
    isOnline: () => navigator.onLine,
    onConnectionChange: subscribeOnline,
    onVisibilityChange(listener) {
      // 뒤로 가기 캐시(bfcache)에서 돌아온 경우도 앱 복귀로 봄
      const onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted) listener();
      };
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("pageshow", onPageShow);
      return () => {
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("pageshow", onPageShow);
      };
    },
  });
  return store;
}

function subscribe(onChange: () => void) {
  const current = getStore();
  // 화면을 옮길 때마다 다시 받지 않게, 한 번 시작하면 앱이 열려 있는 동안 계속 둠(안 보이면 store가 멈춤)
  current.start();
  return current.subscribe(onChange);
}

export function useSnapshot(): SnapshotState {
  return useSyncExternalStore(
    subscribe,
    () => getStore().getState(),
    () => INITIAL_STATE,
  );
}

// 해변 하나의 화면 상태. beach는 빌드 데이터(data/beaches)의 id·노출 끔 표시
export function useBeachView(beach: {
  id: string;
  hidden: boolean;
}): BeachView {
  return deriveBeachView(beach, useSnapshot());
}

// 지금 상태를 바로 읽음(이벤트 처리 안에서 다시 시도 결과를 확인할 때)
export function getSnapshotState(): SnapshotState {
  return getStore().getState();
}

// 당겨서 새로고침·다시 시도 버튼
export function refreshSnapshot(): Promise<void> {
  return getStore().refresh();
}

// 조회 없이 지금 시각으로 다시 계산(만료를 바로 보여주고 조회는 따로)
export function recomputeSnapshot(): void {
  getStore().recompute();
}
