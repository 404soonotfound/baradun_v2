import { notFound } from "next/navigation";
import { BeachDetailScreen } from "@/components/beach-detail-screen";
import { loadBeaches } from "@/lib/beach-data";

// 해변 관리 상세 (BRD-150, 화면 설계서 6장 ADM-BCH /beaches/[id]). 읽기 전용 + 운영 메모
// 정적 내보내기라 저장소의 해변 파일마다 페이지를 만듦. 없는 ID는 만들지 않음(dynamicParams false)
export const dynamicParams = false;

export function generateStaticParams() {
  return loadBeaches().map((beach) => ({ id: beach.id }));
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const beach = loadBeaches().find((b) => b.id === id);
  if (!beach) notFound();
  return <BeachDetailScreen beach={beach} />;
}
