import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { TermsContent } from "@/components/info/terms-content";
import { alternatesFor } from "@/lib/i18n";

// /terms/ (BRD-36). 정적 안내라 빌드 때 그림
const PATH = "/terms/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "pages" });
  return { title: t("terms"), alternates: alternatesFor("ko", PATH) };
}

export default function Page() {
  return <TermsContent locale="ko" />;
}
