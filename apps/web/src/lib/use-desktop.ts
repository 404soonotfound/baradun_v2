import { useSyncExternalStore } from "react";

// PC 배치(Tailwind lg = 64rem 이상)인지. 같은 부품을 두 번 그리지 않고 자리만 바꿀 때 씀(BRD-129 홈)
// 정적 HTML과 첫 그림은 모바일(false)로 두고, 브라우저에서 바로 실제 값으로 바꿈
const QUERY = "(width >= 64rem)";

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getSnapshot() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : false;
}

export function useDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
