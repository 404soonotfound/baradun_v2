import type { Metadata } from "next";
import Link from "next/link";
import { alternatesFor } from "@/lib/i18n";

// Home (temporary): real screen in BRD-26
export const metadata: Metadata = {
  alternates: alternatesFor("en", "/"),
};

export default function HomeEn() {
  return (
    <main>
      <h1>Baradun Bada</h1>
      <p>This page is being prepared.</p>
      <Link href="/" hrefLang="ko" lang="ko">
        한국어
      </Link>
    </main>
  );
}
