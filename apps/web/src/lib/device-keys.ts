// 기기 저장(localStorage) 키 중 '기기 데이터 초기화'(BRD-36, 결정 기록 11장 10/27 ⑩)로 지울 해변 기록 키
// 키 이름만 모아 둠. 지우기는 각 저장소의 clear를 부름(같은 탭 화면에 알림이 가야 해서, lib/favorites.ts)
// 기본 지역(lib/region.ts)·첫 실행 기록(lib/onboarding.ts) 등은 각 파일에 있음. 한 번에 지우는 곳은 lib/device-reset.ts
export const DEVICE_KEYS = {
  favorites: "baradun:favorites", // 즐겨찾기 해변 id
  recent: "baradun:recent", // 최근 본 해변 id
  recentVisits: "baradun:recent-visits", // 최근 본 해변을 본 시각·그때 고른 활동(BRD-129)
  recentSearch: "baradun:recent-search", // 최근 검색어
} as const;
