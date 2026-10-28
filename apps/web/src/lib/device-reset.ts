import { clearActivity } from "@/lib/activity";
import { clearSortChoice } from "@/lib/explore-sort";
import { clearExploreView } from "@/lib/explore-view";
import { clearFavoritesAndRecent } from "@/lib/favorites";
import { clearInquiryDraft } from "@/lib/inquiry/draft";
import { clearLegacyStorage } from "@/lib/legacy-storage";
import { clearOnboarding } from "@/lib/onboarding";
import { setRegion } from "@/lib/region";
import { clearTabMemory } from "@/lib/tab-memory";

// 설정 › 기기 데이터 초기화 (BRD-36 · 결정 기록 11장 10/27 ⑩)
// 이 기기에 저장한 해변 기록을 모두 지움: 즐겨찾기·최근 본·최근 검색·기본 지역·첫 실행 기록·문의 임시 저장(BRD-37)
// + 고른 활동·탐색 보기(목록/지도)·정렬·탭별 마지막 주소 + 출시에서 뺀 기능이 남긴 값(lib/legacy-storage.ts, BRD-101)
// 지우지 않는 것: 화면 설정(테마·화면 움직임)과 위치 사용 스위치(사용자가 고른 보호 설정을 되돌리지 않음),
//   마지막으로 받은 바다 정보(오프라인 때 발효 특보를 잃지 않게, B5), 브라우저의 위치 권한(사이트가 지울 수 없음)
// localStorage.clear()는 같은 탭에 알림이 가지 않아 화면이 그대로임 → 저장소마다 지우기 함수를 부름
export function resetDeviceData() {
  clearFavoritesAndRecent();
  setRegion(null);
  clearInquiryDraft();
  clearActivity();
  clearExploreView();
  clearSortChoice();
  clearTabMemory();
  clearLegacyStorage();
  // 마지막: ON-1이 바로 덮이므로 다른 기록을 먼저 지움. 지운 결과는 ON-1 안에서 알림(뒤 화면 토스트는 가려짐)
  clearOnboarding({ afterReset: true });
}
