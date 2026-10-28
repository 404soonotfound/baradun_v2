// 출시에서 뺀 기능이 남긴 기기 저장값 정리 (BRD-101)
// 즐겨찾기 변경 표시(BRD-35)를 V2 출시에서 뺌 → 그때 쓰던 지난 방문 특보 기록을 지움. 이 키를 읽거나 쓰는 코드는 없음
// 앱을 열 때 한 번(components/legacy-storage-cleanup.tsx)과 기기 데이터 초기화(lib/device-reset.ts)에서 부름
// 여러 번 불러도 결과가 같음. 저장소를 못 쓰면 조용히 넘어감(다음에 열 때 다시 시도)
export const LEGACY_FAVORITE_SEEN_KEY = "baradun:favorite-seen";

type RemoveOnly = Pick<Storage, "removeItem">;

export function clearLegacyStorage(
  getStorage: () => RemoveOnly = () => window.localStorage,
) {
  try {
    getStorage().removeItem(LEGACY_FAVORITE_SEEN_KEY);
  } catch {
    // 사생활 보호 모드·저장 차단: 지우지 못해도 앱은 이 키를 쓰지 않음
  }
}
