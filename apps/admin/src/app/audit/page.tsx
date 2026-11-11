import { AuditScreen } from "@/components/audit-screen";
import { loadBeachNames } from "@/lib/beach-names";

// 변경 이력 (BRD-155, 화면 설계서 6장 ADM-AUD). 읽기 전용
// 해변 운영 메모 기록(BRD-150)의 대상 이름을 보여 주려고 공개 해변 데이터의 이름표를 넘김(문의 화면과 같음)
export default function Page() {
  return <AuditScreen beaches={loadBeachNames()} />;
}
