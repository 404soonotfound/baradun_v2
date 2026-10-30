import { useSyncExternalStore } from "react";

import type { LatLng } from "@/lib/geo";

// 지금 위치 (BRD-25·26·27). 기기 메모리에만 두고 저장·전송하지 않음
// 권한은 사용자가 버튼을 눌렀을 때만 요청. 거부한 사용자에게 자동으로 다시 묻지 않음(반복 요청 금지)
// 거부 상태에서 사용자가 직접 누른 '다시 시도'만 브라우저에 한 번 더 요청(retry, BRD-139 · 10/30 사용자 결정 A안)
// 이미 허용된 기기는 앱을 열 때 바로 위치를 받음
// 설정의 '위치 사용' 스위치(BRD-36, ON-2 '설정에서 끌 수 있어요')를 끄면 권한을 확인하지도, 위치를 받지도 않음(off)

// [1] 구분 가능한 유니언: status를 확인하면 coords가 있는지 타입이 앎
// if (state.status === "ready") 안에서는 state.coords가 null이 아님
export type LocationState =
  | { status: "checking"; coords: null } // 앱을 연 직후 권한을 확인하는 중(아직 모름)
  | { status: "idle"; coords: null } // 아직 묻지 않음(권한 확인 기능이 없는 브라우저 포함)
  | { status: "locating"; coords: null } // 위치 받는 중
  | { status: "ready"; coords: LatLng }
  // 사용자가 거부. retry: 다시 시도의 답을 기다리는 중(pending) · 다시 시도했는데도 거부(denied)
  // 다시 시도 중에도 거부로 둠: 답이 오기 전까지는 여전히 위치가 없어서 화면(지역 보기·안내 배너)이 바뀌지 않게
  | { status: "denied"; coords: null; retry?: "pending" | "denied" }
  | { status: "unavailable"; coords: null } // 기기·브라우저가 못 줌(시간 초과 포함)
  | { status: "off"; coords: null }; // 설정에서 위치 사용을 끔. 묻지도 쓰지도 않음

const CHECKING: LocationState = { status: "checking", coords: null };
const IDLE: LocationState = { status: "idle", coords: null };
const OFF: LocationState = { status: "off", coords: null };

// '위치 사용' 스위치 저장 키. 값 "off"만 저장(없으면 켜짐 = 기본값)
// 기기 데이터 초기화로 지우지 않음: 지우면 꺼 둔 위치가 다시 켜짐(사용자가 고른 보호 설정을 되돌리지 않음)
export const LOCATION_SWITCH_KEY = "baradun:location-switch";

// 스위치 저장소. 테스트에서 바꿔 끼움. 못 쓰면 null
export type SwitchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function browserStorage(): SwitchStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// 거부·꺼짐은 위치를 자동으로 다시 묻지 않는 상태(지역으로 봄). 화면의 '내 주변'·배너 버튼이 같은 규칙을 씀
// 거부는 사용자가 누른 '다시 시도'(retry)로만 한 번 더 요청
export function locationBlocked(status: LocationState["status"]): boolean {
  return status === "denied" || status === "off";
}

// 다시 시도의 답을 기다리는 중인지. 버튼을 막아 두 번 요청하지 않게 함
export function locationRetrying(state: LocationState): boolean {
  return state.status === "denied" && state.retry === "pending";
}

// [1-1] 다시 시도해도 거부일 때 권한을 바꾸는 곳 안내 (BRD-139)
//   ios     = 아이폰·아이패드 Safari. 기기 설정의 위치 서비스 → Safari 웹사이트
//   browser = 그 밖의 기기·브라우저, 판별하지 못함(기본값). 브라우저의 사이트 설정
// 아이폰 Safari는 기기 설정('Safari 웹사이트: 안 함')·이전 거부 기억 때문에 사이트 설정이 '묻기'여도 거부를 줌
// 판별은 안내 문구 고르기에만 쓰고 저장·전송하지 않음. 틀려도 문구만 다름
export type LocationGuide = "ios" | "browser";

export function locationGuide(
  userAgent: string,
  maxTouchPoints: number,
): LocationGuide {
  // 아이패드의 데스크톱 보기는 Mac처럼 보이지만 터치가 됨(Mac은 0)
  const apple =
    /iPhone|iPad|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  // Safari만 'Version/… Safari/'. 아이폰의 다른 브라우저 앱(Chrome·Firefox·Edge·Opera)·앱 안 브라우저는 그 앱의 위치 설정을 따름
  const safari =
    /Version\/[\d.]+.*Safari\//.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  return apple && safari ? "ios" : "browser";
}

// 이 기기의 안내 종류. navigator를 못 읽으면 일반 안내
export function deviceLocationGuide(): LocationGuide {
  try {
    return locationGuide(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  } catch {
    return "browser";
  }
}

// 권한 확인을 기다리는 최대 시간. 분류와 무관한 화면 대기 시간
const PERMISSION_CHECK_TIMEOUT_MS = 3_000;

// [2] 권한 상태 → 할 일 (순수 함수). 묻는 창은 띄우지 않음
// 받는 중(locating)이거나 이미 받은 위치(ready)는 덮지 않음:
// 묻는 창에서 허용하면 onchange("granted")도 같이 와서, 그대로 locate하면 ready → locating으로 되돌아감
export function permissionAction(
  current: LocationState["status"],
  permission: PermissionState,
): "locate" | "denied" | "idle" | "keep" {
  if (permission === "denied") return "denied";
  if (current === "locating") return "keep";
  if (permission === "granted") return current === "ready" ? "keep" : "locate";
  return "idle"; // "prompt" = 아직 안 물어봄(권한을 초기화한 경우 포함)
}

// [3] 위치 저장소. 테스트에서 navigator·스위치 저장소를 바꿔 끼울 수 있게 만드는 함수로 둠
export function createLocationStore(
  getStorage: () => SwitchStorage | null = browserStorage,
) {
  let state: LocationState = CHECKING; // 상태가 바뀔 때만 새 객체
  let started = false; // 처음 구독 때 한 번만 시작하기 위한 표시
  // 스위치. 저장소를 못 쓰면 이번 방문 동안 memory 값(쓰기 실패 뒤에도 memory)
  let enabled = true;
  let writeFailed = false;
  // 위치 요청·권한 확인 차례 번호. 스위치를 끄거나 새로 확인하면 올려서, 늦게 온 답이 새 상태를 덮지 않게 함
  let generation = 0;
  // 권한 변경 처리기를 붙여 둔 마지막 PermissionStatus
  let watched: PermissionStatus | null = null;
  const listeners = new Set<() => void>();

  function readEnabled(): boolean {
    if (writeFailed) return enabled;
    try {
      return getStorage()?.getItem(LOCATION_SWITCH_KEY) !== "off";
    } catch {
      return enabled;
    }
  }

  function setState(next: LocationState) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  // 권한 확인이 끝나지 않았으면 아직 묻지 않은 것으로(버튼으로만 요청)
  function settleUnknown() {
    if (state.status === "checking") setState(IDLE);
  }

  // 위치 한 번 받기. 권한을 모르는 기기면 여기서 브라우저가 묻는 창을 띄움
  // 답이 오기 전에 스위치를 끄면(차례 번호가 바뀜) 그 답은 버림
  // retry: 거부 상태의 다시 시도. 받는 중 대신 '거부 · 다시 시도 중'으로 두고, 또 거부면 '다시 시도했는데도 거부'
  function locate(retry = false) {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setState({ status: "unavailable", coords: null });
      return;
    }
    const mine = ++generation;
    setState(
      retry
        ? { status: "denied", coords: null, retry: "pending" }
        : { status: "locating", coords: null },
    );
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (mine !== generation) return;
        setState({
          status: "ready",
          coords: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
        });
      },
      (error) => {
        if (mine !== generation) return;
        // 시간 초과·위치를 알 수 없음은 다시 시도였어도 기존과 같은 '받을 수 없음'
        setState(
          error.code === error.PERMISSION_DENIED
            ? retry
              ? { status: "denied", coords: null, retry: "denied" }
              : { status: "denied", coords: null }
            : { status: "unavailable", coords: null },
        );
      },
      // 정밀 GPS 불필요(해변 거리용) · 10초 넘으면 포기 · 5분 안에 받은 위치는 다시 씀
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function applyPermission(permission: PermissionState) {
    if (!enabled) return; // 꺼 둔 동안 권한이 바뀌어도 위치를 받지 않음
    // 다시 시도 중이면 그 답(getCurrentPosition)이 결과를 정함. 묻는 창에서 허용하면 오는 알림으로 한 번 더 요청하지 않게
    if (locationRetrying(state)) return;
    const action = permissionAction(state.status, permission);
    if (action === "locate") locate();
    else if (action === "denied") setState({ status: "denied", coords: null });
    else if (action === "idle") setState(IDLE);
  }

  // 처음 구독할 때 한 번: 스위치를 읽고, 켜져 있으면 권한 확인
  function start() {
    if (started) return;
    started = true;
    enabled = readEnabled();
    if (enabled) checkPermission();
    else setState(OFF);
  }

  // 이미 허용·거부된 기기인지 확인. 권한 확인 기능이 없거나 실패하면 바로 idle(확인 중으로 남지 않게)
  // 확인 중에 스위치를 끄면 늦게 온 답은 버림(applyPermission·settleUnknown이 꺼짐을 덮지 않음)
  function checkPermission() {
    const mine = ++generation;
    const settle = () => {
      if (mine === generation) settleUnknown();
    };
    const permissions = navigator.permissions;
    if (typeof permissions?.query !== "function") {
      settle();
      return;
    }
    let query: Promise<PermissionStatus>;
    try {
      query = permissions.query({ name: "geolocation" });
    } catch {
      settle(); // 거절 대신 바로 오류를 던지는 브라우저 대비
      return;
    }
    // 답이 오지 않으면 아직 묻지 않은 것으로 둠(홈 자리 표시·ON-2가 계속 기다리지 않게). 늦게 온 답은 그대로 반영
    const timer = setTimeout(settle, PERMISSION_CHECK_TIMEOUT_MS);
    query
      .then((status) => {
        // 그사이 스위치를 바꿨거나 버튼으로 요청했으면 첫 답은 버림(그쪽 결과가 최신)
        if (mine === generation) applyPermission(status.state);
        // 브라우저 설정에서 권한을 바꾸면 따라감(거부 후 다시 허용한 경우 등). 꺼 둔 동안은 applyPermission이 무시
        // 스위치를 다시 켤 때마다 새 PermissionStatus가 올 수 있어 이전 것의 처리기는 뗌(겹쳐 붙지 않게)
        if (watched && watched !== status) watched.onchange = null;
        watched = status;
        status.onchange = () => applyPermission(status.state);
      })
      .catch(settle)
      .finally(() => clearTimeout(timer));
  }

  // 설정의 '위치 사용' 스위치. 끄면 받은 위치를 버리고(메모리에서도) 진행 중인 요청의 답도 버림
  // 켜면 권한만 다시 확인(이미 허용한 기기는 위치를 받음). 묻는 창은 띄우지 않음(버튼으로만 요청)
  function setEnabled(next: boolean) {
    enabled = next;
    try {
      const storage = getStorage();
      if (next) storage?.removeItem(LOCATION_SWITCH_KEY);
      else storage?.setItem(LOCATION_SWITCH_KEY, "off");
    } catch {
      writeFailed = true; // 이번 방문 동안은 memory 값(enabled)을 따름
    }
    started = true; // 구독 전에 바꿔도 start()가 덮지 않게
    if (next) {
      setState(CHECKING);
      checkPermission();
    } else {
      generation++;
      setState(OFF);
    }
  }

  function subscribe(onChange: () => void) {
    listeners.add(onChange);
    start();
    return () => {
      listeners.delete(onChange);
    };
  }

  // 위치 버튼·첫 실행 위치 안내(ON-2)의 허용 버튼에서만 호출. 거부·꺼짐이면 묻지 않음
  function request() {
    if (state.status === "locating" || locationBlocked(state.status)) return;
    locate();
  }

  // 거부 상태에서 사용자가 직접 누른 '다시 시도'에서만 호출(BRD-139). 브라우저에 한 번 더 요청하고, 묻는 창을 띄울지는 브라우저가 정함
  // 자동으로 부르지 않음: 앱을 열 때·권한 확인·권한 변경 알림·정렬 탭은 거부면 묻지 않음(반복 요청 금지 유지)
  // 거부가 아니면(꺼짐 포함)·이미 다시 시도 중이면 아무것도 안 함
  function retry() {
    if (state.status !== "denied" || locationRetrying(state)) return;
    locate(true);
  }

  return { getState: () => state, subscribe, request, retry, setEnabled };
}

// [4] 앱 전체에서 하나
const store = createLocationStore();

export function requestLocation() {
  store.request();
}

export function retryLocation() {
  store.retry();
}

export function setLocationEnabled(next: boolean) {
  store.setEnabled(next);
}

// [5] 화면에서: const location = useUserLocation();
// 이름을 useLocation으로 하지 않은 이유: 라우터의 주소 훅과 헷갈리지 않게
// 서버 HTML·첫 그리기는 '확인 중'(권한을 아직 모름)
export function useUserLocation(): LocationState {
  return useSyncExternalStore(store.subscribe, store.getState, () => CHECKING);
}
