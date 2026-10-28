// Metadata: 탭 제목·검색엔진 정보 모양을 정한 Next 타입(타입만 가져옴)
import type { Metadata } from "next";
// notFound(): 부르는 순간 그리기를 멈추고 404 화면(not-found)을 대신 보여 주는 Next 함수
import { notFound } from "next/navigation";

import { DetailScreen } from "@/components/detail/detail-screen";
import {
  beachSlugParams,
  findBeach,
  listAltCandidates,
  listVisibleBeachIds,
} from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";

// /spots/[slug]/ 장소 상세 (아키텍처 9장). 경로는 data/beaches에서 생성(B6, BRD-45)
// 정적 내보내기라 빌드 때 만든 slug만 존재. 없는 slug·숨긴 해변은 404
// false = 아래 generateStaticParams가 돌려준 slug만 페이지가 있음. 목록에 없는 주소는 바로 404
// (true면 요청이 올 때 새로 그리려 하는데, 정적 내보내기는 서버가 없어서 허용 안 됨)
export const dynamicParams = false;

// 빌드 때 Next가 부르는 함수. 돌려준 목록 하나마다 HTML 한 장 생성
// 예: [{ slug: "gyeongpo" }] → out/spots/gyeongpo/index.html
// 폴더 이름 [slug]의 slug와 키 이름이 같아야 함
export function generateStaticParams() {
  return beachSlugParams();
}

// 페이지가 받는 값. params = 주소의 [slug] 자리 값. Next 16부터 Promise라 await로 꺼내 씀
type Props = { params: Promise<{ slug: string }> };

// 이 페이지의 <head> 정보를 정하는 함수(Next가 페이지마다 부름)
// title → 브라우저 탭 제목. 레이아웃의 틀("%s · 바라던 바다")에 끼워져 "경포해수욕장 · 바라던 바다"
// alternates → 같은 내용의 영어 주소를 검색엔진에 알려 줌(언어 전환 연결)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params; // Promise에서 slug 꺼내기
  const found = findBeach(slug);
  if (!found) return {}; // 없는 해변: 정보 없음(페이지 쪽에서 404)
  return {
    title: found.beach.name.en,
    alternates: alternatesFor("en", `/spots/${slug}/`),
  };
}

// 화면 본체. 서버(빌드)에서 실행돼서 beaches.ts의 파일 읽기를 쓸 수 있음(브라우저로 안 내려감)
export default async function Page({ params }: Props) {
  const { slug } = await params;
  const found = findBeach(slug); // { beach, sample } 또는 null
  if (!found) notFound(); // 해변이 없을 때의 자리 slug("_")도 여기서 404
  return (
    <DetailScreen
      locale="en"
      beach={found.beach}
      beaches={listAltCandidates(found.beach, "en")}
      allBeachIds={listVisibleBeachIds()}
      sample={found.sample}
    />
  );
}
