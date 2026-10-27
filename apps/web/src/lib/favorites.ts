import { useSyncExternalStore } from "react";

import { createDeviceList, EMPTY_IDS } from "@/lib/device-list";

// 즐겨찾기·최근 본 해변 (화면 명세 HOME·FAV, 아키텍처 9장: 기기 저장) (BRD-26)
// 저장 값은 해변 내부 id. slug는 주소용이라 데이터 연결에 쓰지 않음
// 노출 끈 해변의 id도 지우지 않음: 다시 켜면 돌아옴(9장). 화면은 목록에 있는 해변만 보여줌

// [2] 즐겨찾기는 개수 제한 없음(무한대 = slice가 아무것도 자르지 않음)
const favorites = createDeviceList(
  "baradun:favorites",
  Number.POSITIVE_INFINITY,
);

// [3] 최근 본 해변 상한. 화면 설계서에 값이 없어 임시로 둔 제안값(결정 후 노션 반영)
const RECENT_MAX = 20;
const recent = createDeviceList("baradun:recent", RECENT_MAX);

// [4] 빌드 때(정적 HTML)는 기기 저장값을 모르니 빈 목록. 브라우저에서 바로 저장값으로 바뀜
const serverSnapshot = () => EMPTY_IDS;

// [5] Vue: computed: { ...mapState(["favorites"]) } 자리. 화면에서 const ids = useFavorites();
export function useFavorites(): readonly string[] {
  return useSyncExternalStore(
    favorites.subscribe,
    favorites.getSnapshot,
    serverSnapshot,
  );
}

// [6] 즐겨찾기 별 버튼. 있으면 빼고 없으면 넣음
export function toggleFavorite(id: string) {
  if (favorites.getSnapshot().includes(id)) favorites.remove(id);
  else favorites.add(id);
}

// [7] 최근 본 목록 읽기
export function useRecent(): readonly string[] {
  return useSyncExternalStore(
    recent.subscribe,
    recent.getSnapshot,
    serverSnapshot,
  );
}

// [8] 장소 상세에 들어갈 때 호출(BRD-32) · 최근 본 전체 지우기
export const addRecent = recent.add;
export const clearRecent = recent.clear;

// 최근 본 ✕. 지우기 전 목록을 기억해 '되돌리기'에서 원래 순서·자리로 복구하는 함수를 돌려줌
export function removeRecent(id: string): () => void {
  const before = recent.getSnapshot();
  recent.remove(id);
  return () => recent.replace(before);
}

// [9] 설정 › 기기 데이터 초기화(BRD-36)에서 호출
// localStorage.clear()는 같은 탭에 알림이 안 가서 화면이 그대로임 → 저장소마다 clear 호출
export function clearFavoritesAndRecent() {
  favorites.clear();
  recent.clear();
}
