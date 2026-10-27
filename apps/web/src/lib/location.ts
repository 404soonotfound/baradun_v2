import { useSyncExternalStore } from "react";

import type { LatLng } from "@/lib/geo";

// 지금 위치 (BRD-25·26·27). 기기 메모리에만 두고 저장·전송하지 않음
// 권한은 사용자가 버튼을 눌렀을 때만 요청. 거부한 사용자에게 다시 묻지 않음(반복 요청 금지)
// 이미 허용된 기기는 앱을 열 때 바로 위치를 받음

// [1] 구분 가능한 유니언: status를 확인하면 coords가 있는지 타입이 앎
// if (state.status === "ready") 안에서는 state.coords가 null이 아님
export type LocationState =
  | { status: "checking"; coords: null } // 앱을 연 직후 권한을 확인하는 중(아직 모름)
  | { status: "idle"; coords: null } // 아직 묻지 않음(권한 확인 기능이 없는 브라우저 포함)
  | { status: "locating"; coords: null } // 위치 받는 중
  | { status: "ready"; coords: LatLng }
  | { status: "denied"; coords: null } // 사용자가 거부
  | { status: "unavailable"; coords: null }; // 기기·브라우저가 못 줌(시간 초과 포함)

const CHECKING: LocationState = { status: "checking", coords: null };
const IDLE: LocationState = { status: "idle", coords: null };
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

// [3] 위치 저장소. 테스트에서 navigator를 바꿔 끼울 수 있게 만드는 함수로 둠
export function createLocationStore() {
  let state: LocationState = CHECKING; // 상태가 바뀔 때만 새 객체
  let started = false; // 권한 확인을 한 번만 하기 위한 표시
  const listeners = new Set<() => void>();

  function setState(next: LocationState) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  // 권한 확인이 끝나지 않았으면 아직 묻지 않은 것으로(버튼으로만 요청)
  function settleUnknown() {
    if (state.status === "checking") setState(IDLE);
  }

  // 위치 한 번 받기. 권한을 모르는 기기면 여기서 브라우저가 묻는 창을 띄움
  function locate() {
    if (!("geolocation" in navigator)) {
      setState({ status: "unavailable", coords: null });
      return;
    }
    setState({ status: "locating", coords: null });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setState({
          status: "ready",
          coords: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
        }),
      (error) =>
        setState(
          error.code === error.PERMISSION_DENIED
            ? { status: "denied", coords: null }
            : { status: "unavailable", coords: null },
        ),
      // 정밀 GPS 불필요(해변 거리용) · 10초 넘으면 포기 · 5분 안에 받은 위치는 다시 씀
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function applyPermission(permission: PermissionState) {
    const action = permissionAction(state.status, permission);
    if (action === "locate") locate();
    else if (action === "denied") setState({ status: "denied", coords: null });
    else if (action === "idle") setState(IDLE);
  }

  // 처음 구독할 때 한 번: 이미 허용·거부된 기기인지 확인
  // 권한 확인 기능이 없거나 실패하면 바로 idle(확인 중으로 남지 않게)
  function start() {
    if (started) return;
    started = true;
    const permissions = navigator.permissions;
    if (typeof permissions?.query !== "function") {
      settleUnknown();
      return;
    }
    let query: Promise<PermissionStatus>;
    try {
      query = permissions.query({ name: "geolocation" });
    } catch {
      settleUnknown(); // 거절 대신 바로 오류를 던지는 브라우저 대비
      return;
    }
    // 답이 오지 않으면 아직 묻지 않은 것으로 둠(홈 자리 표시·ON-2가 계속 기다리지 않게). 늦게 온 답은 그대로 반영
    const timer = setTimeout(settleUnknown, PERMISSION_CHECK_TIMEOUT_MS);
    query
      .then((status) => {
        applyPermission(status.state);
        // 설정에서 권한을 바꾸면 따라감(거부 후 다시 허용한 경우 등)
        status.onchange = () => applyPermission(status.state);
      })
      .catch(settleUnknown)
      .finally(() => clearTimeout(timer));
  }

  function subscribe(onChange: () => void) {
    listeners.add(onChange);
    start();
    return () => {
      listeners.delete(onChange);
    };
  }

  // 위치 버튼·첫 실행 위치 안내(ON-2)의 허용 버튼에서만 호출
  function request() {
    if (state.status === "locating" || state.status === "denied") return;
    locate();
  }

  return { getState: () => state, subscribe, request };
}

// [4] 앱 전체에서 하나
const store = createLocationStore();

export function requestLocation() {
  store.request();
}

// [5] 화면에서: const location = useUserLocation();
// 이름을 useLocation으로 하지 않은 이유: 라우터의 주소 훅과 헷갈리지 않게
// 서버 HTML·첫 그리기는 '확인 중'(권한을 아직 모름)
export function useUserLocation(): LocationState {
  return useSyncExternalStore(store.subscribe, store.getState, () => CHECKING);
}
