import type { Metadata } from "next";
import { alternatesFor } from "@/lib/i18n";
import { HomeScreen } from "@/components/home/home-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { hasDevSampleSnapshot } from "@/lib/dev-sample";
// Home (BRD-26)
export const metadata: Metadata = {
  alternates: alternatesFor("en", "/"),
};

export default function HomeEn() {
  // 해변 목록은 빌드 때 서버에서 만들어 props로 넘김. 상태는 브라우저가 따로 받음(G4)
  return (
    <HomeScreen
      locale="en"
      beaches={listBeachSummaries("en")}
      sampleSnapshot={hasDevSampleSnapshot()}
    />
  );
}
