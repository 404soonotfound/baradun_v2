import { BeachesScreen } from "@/components/beaches-screen";
import { loadBeaches, summaryOf } from "@/lib/beach-data";

// 해변 관리 목록 (BRD-150, 화면 설계서 6장 ADM-BCH). 읽기 전용
// 해변 정보는 빌드 때 공개 저장소 파일에서 읽어 넘김(문의·수집 현황의 해변 이름표와 같은 방식, GH-329에서 정함)
// 지금 표시 상태·운영 메모는 화면이 로그인 뒤 운영 API로 받음
export default function Page() {
  return <BeachesScreen beaches={loadBeaches().map(summaryOf)} />;
}
