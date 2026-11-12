import { PoliciesScreen } from "@/components/policies-screen";
import { parsePolicySnapshot } from "@/lib/policies";
import snapshot from "@/content/ops-policy.json";

// 운영 정책 (#335, 화면 설계서 6장 ADM-POL). 읽기 전용
// 노션 원본을 로컬 도구(tools/ops-policy/fetch.mjs)로 받은 저장소 파일을 빌드 때 확인해 넘김(결정 기록 D20-11)
// 모양이 틀리면 빌드가 멈춤(가져오지 못한 내용을 최신처럼 내보내지 않음, D16-E5)
export default function Page() {
  return <PoliciesScreen snapshot={parsePolicySnapshot(snapshot)} />;
}
