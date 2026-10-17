import type { Metadata } from "next";
import Link from "next/link";
import { alternatesFor } from "@/lib/i18n";

// 홈 (임시): 실제 화면은 BRD-26
export const metadata: Metadata = {
  alternates: alternatesFor("ko", "/"),
};

export default function Home() {
  return (
    <main>
      <h1>바라던 바다</h1>
      <p>화면을 준비하고 있어요.</p>
      <Link href="/en/" hrefLang="en" lang="en">
        English
      </Link>
    </main>
  );
}
