import { useSyncExternalStore } from "react";

import type { LatLng } from "@/lib/geo";

// 지금 위치 (BRD-26·27). 기기 메모리에만 두고 저장·전송하지 않음
// 권한은 사용자가 버튼을 눌렀을 때만 요청. 거부한 사용자에게 다시 묻지 않음(반복 요청 금지)
// 이미 허용된 기기는 앱을 열 때 바로 위치를 받음

// [2] 구분 가능한 유니언: status를 확인하면 coords가 있는지 타입이 앎
// if (state.status === "ready") 안에서는 state.coords가 null이 아님
export type LocationState =
  | { status: "idle"; coords: null } // 아직 요청 전
  | { status: "locating"; coords: null } // 위치 받는 중
  | { status: "ready"; coords: LatLng }
  | { status: "denied"; coords: null } // 사용자가 거부
  | { status: "unavailable"; coords: null }; // 기기·브라우저가 못 줌(시간 초과 포함)

// [3] 처음 상태와 저장 변수
const IDLE: LocationState = { status: "idle", coords: null };
let state: LocationState = IDLE; // 상태가 바뀔 때만 새 객체 → 읽기 함수는 같은 객체를 돌려줌
let started = false; // 권한 확인을 한 번만 하기 위한 표시
const listeners = new Set<() => void>();

// [4] 상태 바꾸고 구독한 화면에 알림
function setState(next: LocationState) {
  state = next;
  listeners.forEach((listener) => listener());
}

// [5] 위치 한 번 받기. 권한을 모르는 기기면 여기서 브라우저가 묻는 창을 띄움
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

// [6] 권한 상태 → 내 상태. 묻는 창은 띄우지 않음
// 버튼으로 받는 중(locating)이거나 이미 받은 위치(ready)는 덮지 않음:
// 묻는 창에서 허용하면 onchange("granted")도 같이 와서, 그대로 locate하면 ready → locating으로 되돌아감
function applyPermission(permission: PermissionState) {
  if (permission === "denied") {
    setState({ status: "denied", coords: null });
    return;
  }
  if (state.status === "locating") return;
  if (permission === "granted") {
    if (state.status !== "ready") locate();
  } else setState(IDLE); // "prompt" = 아직 안 물어봄(권한을 초기화한 경우 포함)
}

// [7] 처음 구독할 때 한 번: 이미 허용·거부된 기기인지 확인
// navigator.permissions?. = 이 기능이 없는 브라우저면 뒤를 모두 건너뜀(idle 유지 → 버튼으로만 요청)
function start() {
  if (started) return;
  started = true;
  navigator.permissions
    ?.query({ name: "geolocation" })
    .then((status) => {
      applyPermission(status.state);
      // 설정에서 권한을 바꾸면 따라감(거부 후 다시 허용한 경우 등)
      status.onchange = () => applyPermission(status.state);
    })
    .catch(() => {
      // 확인 못 하면 idle 유지
    });
}

// [8] 구독 시작 때 권한 확인도 같이
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  start();
  return () => {
    listeners.delete(onChange);
  };
}

// [9] 위치 버튼·첫 실행 위치 안내(ON-2)의 허용 버튼에서만 호출
export function requestLocation() {
  if (state.status === "locating" || state.status === "denied") return;
  locate();
}

// [10] 화면에서: const location = useUserLocation();
// 이름을 useLocation으로 하지 않은 이유: 라우터의 주소 훅과 헷갈리지 않게
export function useUserLocation(): LocationState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE,
  );
}
