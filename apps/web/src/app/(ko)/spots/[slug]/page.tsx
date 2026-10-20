import { notFound } from "next/navigation";

import { DetailPlaceholder } from "@/components/detail/detail-placeholder";
import { beachSlugParams, findBeach } from "@/lib/beaches";

// /spots/[slug]/ 장소 상세 (아키텍처 9장). 경로는 data/beaches에서 생성(B6, BRD-45)
// 정적 내보내기라 빌드 때 만든 slug만 존재. 없는 slug·숨긴 해변은 404
export const dynamicParams = false;

export function generateStaticParams() {
  return beachSlugParams();
}

type Props = { params: Promise<{ slug: string }> };

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const found = findBeach(slug);
  if (!found) notFound(); // 해변이 없을 때의 자리 slug("_")도 여기서 404
  return (
    <DetailPlaceholder locale="ko" beach={found.beach} sample={found.sample} />
  );
}
