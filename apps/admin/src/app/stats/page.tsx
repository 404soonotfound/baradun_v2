import { loadBeachNamesBySlug } from "@/lib/beach-names";
import { StatsScreen } from "@/components/stats-screen";

// 이용 통계 (BRD-154·GH-333, 화면 설계서 6장 ADM-STATS)
// 서버 컴포넌트에서 공개 해변 slug→이름표만 읽어 /spots/[slug] 표시에 씀
export default function StatsPage() {
  const beachesBySlug = loadBeachNamesBySlug();
  return <StatsScreen beachesBySlug={beachesBySlug} />;
}
