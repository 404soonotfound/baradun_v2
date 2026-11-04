import { InquiriesScreen } from "@/components/inquiries-screen";
import { loadBeachNames } from "@/lib/beach-names";

// 문의 목록·상세 (BRD-153). 해변 이름표는 빌드 때 data/beaches에서 만들어 화면에 내려 줌
export default function Page() {
  return <InquiriesScreen beaches={loadBeachNames()} />;
}
