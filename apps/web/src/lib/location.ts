import { useSyncExternalStore } from "react";

import type { LatLng } from "@/lib/geo";

// 지금 위치 (BRD-25·26·27). 기기 메모리에만 두고 저장·전송하지 않음
// 권한은 사용자가 버튼을 눌렀을 때만 요청. 거부한 사용자에게 다시 묻지 않음(반복 요청 금지)
// 이미 허용된 기기는 앱을 열 때 바로 위치를 받음
// 설정의 '위치 사용' 스위치(BRD-36, ON-2 '설정에서 끌 수 있어요')를 끄면 권한을 확인하지도, 위치를 받지도 않음(off)

// [1] 구분 가능한 유니언: status를 확인하면 coords가 있는지 타입이 앎
// if (state.status === "ready") 안에서는 state.coords가 null이 아님
export type LocationState =
  | { status: "checking"; coords: null } // 앱을 연 직후 권한을 확인하는 중(아직 모름)
  | { status: "idle"; coords: null } // 아직 묻지 않음(권한 확인 기능이 없는 브라우저 포함)
  | { status: "locating"; coords: null } // 위치 받는 중
  | { status: "ready"; coords: LatLng }
  | { status: "denied"; coords: null } // 사용자가 거부
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

// 거부·꺼짐은 위치를 다시 묻지 않는 상태(지역으로 봄). 화면의 '내 주변'·배너 버튼이 같은 규칙을 씀
export function locationBlocked(status: LocationState["status"]): boolean {
  return status === "denied" || status === "off";
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
  function locate() {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setState({ status: "unavailable", coords: null });
      return;
    }
    const mine = ++generation;
    setState({ status: "locating", coords: null });
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
        setState(
          error.code === error.PERMISSION_DENIED
            ? { status: "denied", coords: null }
            : { status: "unavailable", coords: null },
        );
      },
      // 정밀 GPS 불필요(해변 거리용) · 10초 넘으면 포기 · 5분 안에 받은 위치는 다시 씀
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function applyPermission(permission: PermissionState) {
    if (!enabled) return; // 꺼 둔 동안 권한이 바뀌어도 위치를 받지 않음
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

  return { getState: () => state, subscribe, request, setEnabled };
}

// [4] 앱 전체에서 하나
const store = createLocationStore();

export function requestLocation() {
  store.request();
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
