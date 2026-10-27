import { useTranslations } from "next-intl";

import { Chip } from "@/components/ui/chip";
import type { RegionPart } from "@/lib/beach-summary";

// '어느 바다를 볼까요?' 카드 (노션 2장 HOME '위치 거부 · 지역 고르기 전', Figma S_M01_03 171:698)
// 위치를 거부했거나 받을 수 없을 때 가까운 바다 자리에. 위치를 다시 묻지 않음
// 칩 = 해변이 있는 시·도만, 지리 순서(regionChips). 누르면 그 시·도를 기본 지역으로 저장(부르는 쪽)

// Vue: props: { chips } + this.$emit("pick", key)
export function RegionPick({
  chips,
  onPick,
}: {
  chips: readonly RegionPart[];
  onPick: (sido: string) => void;
}) {
  const t = useTranslations("home.region");
  return (
    <div className="flex flex-col gap-3 rounded-card bg-bg-surface p-[18px] shadow-card">
      <p className="text-title-m text-text-default">{t("pickTitle")}</p>
      <p className="text-body-s text-text-body">{t("pickBody")}</p>
      {/* 칩 42px(size "lg"). 줄이 넘치면 다음 줄로 */}
      <div className="flex flex-wrap gap-2">
        {chips.map((sido) => (
          <Chip key={sido.key} size="lg" onClick={() => onPick(sido.key)}>
            {sido.label}
          </Chip>
        ))}
      </div>
      <p className="text-caption text-text-muted">{t("pickNote")}</p>
    </div>
  );
}
