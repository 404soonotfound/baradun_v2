import { HomeScreen } from "@/components/home-screen";
import { loadBeachNames } from "@/lib/beach-names";

// 운영 홈 (BRD-149, ADM-HOME). 로그인 뒤 첫 화면
// '최근 변경'의 해변 메모 기록 대상 이름을 보여 주려고 공개 해변 데이터의 이름표를 넘김(변경 이력 화면과 같음)
export default function Home() {
  return <HomeScreen beaches={loadBeachNames()} />;
}
