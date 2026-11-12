import { PublishScreen } from "@/components/publish-screen";
import { loadBeachNames } from "@/lib/beach-names";

// 데이터 게시 (#331, 화면 설계서 6장 ADM-PUB)
// 변경 미리보기에서 바뀌는 해변 이름을 보여 주려고 공개 해변 데이터의 이름표를 넘김(문의·변경 이력 화면과 같음)
export default function Page() {
  return <PublishScreen beaches={loadBeachNames()} />;
}
