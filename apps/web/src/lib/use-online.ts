import { useSyncExternalStore } from "react";

// 브라우저가 보는 인터넷 연결 상태 (BRD-28). 상황 배너에서 오프라인과 '불러오기 실패'를 나눌 때만 씀
// navigator.onLine이 true여도 실제로 못 받을 수 있음 → 그때는 store가 실패로 알려 줌(failedOnline)

// [1] 연결이 끊기거나 돌아올 때 알림 받기 (Vue: mounted에서 addEventListener, beforeDestroy에서 remove)
// 바다 정보 store(use-snapshot.ts)도 같은 함수로 연결 변화를 받음
export function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

// [2] 화면에서: const online = useOnline();
// 서버 HTML에서는 연결된 것으로(true) 그림 → 오프라인 배너가 HTML에 굳지 않음
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
