"use client"; // 이 파일부터 브라우저 코드. Vue 컴포넌트와 같은 종류

import { useTranslations } from "next-intl";

import { BeachRow } from "@/components/beach-row";
import { BeachRowSkeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";

// Vue: props: { locale: String, beaches: Array }
export function NearbyList({
  locale,
  beaches,
}: {
  locale: Locale;
  beaches: BeachSummary[];
}) {
  const t = useTranslations(); // Vue: this.$t
  const snapshot = useSnapshot(); // Vue: mapState. 훅은 맨 위에서 한 번만 호출

  // Vue: v-if. 아직 한 번도 못 받음 → 스켈레톤
  if (snapshot.phase === "loading") {
    // return <BeachRowSkeleton label={t("home.loading")} />;
  }

  return (
    <ul>
      {/* Vue: v-for="beach in beaches" :key="beach.id" */}
      {beaches.map((beach) => {
        // 훅이 아닌 보통 함수라 map 안 호출 가능. 분류는 받은 값 그대로(G1)
        const view = deriveBeachView({ id: beach.id, hidden: false }, snapshot);
        if (view.kind !== "ready") return null;
        return (
          <li key={beach.id}>
            <BeachRow
              href={localizedPath(locale, `/spots/${beach.slug}/`)}
              name={beach.name}
              meta={beach.region}
              wave={view.metrics.waveHeight}
              detail={null}
              status={view.badge}
            />
            {/* view.stale이면 '14:05 확인 · 이후 확인 못 함' 줄 필요(B5) */}
          </li>
        );
      })}
    </ul>
  );
}
