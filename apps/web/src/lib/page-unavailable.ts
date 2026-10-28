// 열지 못한 화면 안내 표식 (BRD-106 결정 29)
// 서비스 워커는 탭 화면 8개만 저장하므로, 연결이 없을 때 상세·검색 등을 열면 같은 언어 홈으로 보냄.
// 그때 홈 주소에 ?unavailable=1을 붙이고(scripts/service-worker.js UNAVAILABLE_PARAM과 같은 값),
// 홈은 이 표식을 보고 '그 화면을 열지 못했어요' 안내를 보여준 뒤 주소에서 표식을 지움(새로고침해도 다시 뜨지 않게)
// 사유만 알리는 표식이라 원래 주소·위치 등은 싣지 않음

export const UNAVAILABLE_PARAM = "unavailable";

export function hasUnavailableMark(search: string): boolean {
  return new URLSearchParams(search).get(UNAVAILABLE_PARAM) === "1";
}

// 표식만 지운 같은 주소(경로·다른 검색어·#은 그대로)
export function withoutUnavailableMark(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(UNAVAILABLE_PARAM);
  return url.pathname + url.search + url.hash;
}
