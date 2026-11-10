import { CollectionScreen } from "@/components/collection-screen";
import { loadBeachNames } from "@/lib/beach-names";

// 데이터 수집 현황 (BRD-149·GH-376, 화면 설계서 6장 ADM-COLLECT). 읽기 전용
// 장애 상세의 관측 지연 해변 ID를 이름으로 보여 주려고 공개 해변 데이터의 이름표를 넘김(문의 화면과 같음)
export default function Page() {
  return <CollectionScreen beaches={loadBeachNames()} />;
}
