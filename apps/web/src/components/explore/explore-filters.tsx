"use client"; // 활동은 기기 저장 값을 읽으므로 브라우저 부품

import { useTranslations } from "next-intl";

import { Chip } from "@/components/ui/chip";
import { ACTIVITIES, setActivity, useActivity } from "@/lib/activity";
import type { RegionPart } from "@/lib/beach-summary";
import type { SavedRegion } from "@/lib/region-list";

// 탐색 필터 칩 두 줄 (BRD-29 · 노션 2장 EXP-L 3)
//   활동: 수영 · 서핑 · 스쿠버 (하나만. 홈 활동 타일과 같은 값)
//   지역: 맨 앞 '전국', 그다음 해변이 있는 시·도(지리 순서). 시·도를 누르면 시·군 시트(10/27 결정)
// 칩 줄이 좁은 화면에서 옆으로 밀려 나가도 칩마다 Tab으로 닿음(스크롤 영역 안에 포커스 가능한 칩)

// 칩은 누르는 영역을 위아래 4px씩 넓혀 44px(ui/chip.tsx). 줄에 위아래 4px 여백(py-1)을 둬 잘리지 않게 함

export function ExploreFilters({
  chips,
  region,
  regionLabel,
  onNationwide,
  onPickSido,
}: {
  chips: readonly RegionPart[];
  region: SavedRegion | null;
  // 고른 지역의 화면 이름("강원 양양군"). 시·군까지 좁혔는지 칩에서 보이게 함
  regionLabel: string | null;
  onNationwide: () => void;
  onPickSido: (sido: string) => void;
}) {
  const t = useTranslations();
  const activity = useActivity();

  return (
    <div className="flex flex-col">
      <div
        role="group"
        aria-label={t("activity.label")}
        className="-mx-gutter flex gap-2 overflow-x-auto px-gutter py-1 lg:mx-0 lg:px-0"
      >
        {ACTIVITIES.map((item) => (
          <Chip
            key={item}
            variant={item === activity ? "on" : "default"}
            aria-pressed={item === activity}
            onClick={() => setActivity(item)}
          >
            {t(`activity.${item}`)}
          </Chip>
        ))}
      </div>
      <div
        role="group"
        aria-label={t("explore.regionLabel")}
        className="-mx-gutter flex gap-2 overflow-x-auto px-gutter py-1 lg:mx-0 lg:px-0"
      >
        <Chip
          variant={region === null ? "on" : "default"}
          aria-pressed={region === null}
          onClick={onNationwide}
        >
          {t("explore.nationwide")}
        </Chip>
        {chips.map((chip) => {
          const selected = region?.sido === chip.key;
          return (
            <Chip
              key={chip.key}
              // 고른 시·도만 ⌄ 표시(드롭다운에서 고른 값). 누르면 시·군 시트가 열림
              variant={selected ? "sel" : "default"}
              aria-haspopup="dialog"
              aria-pressed={selected}
              onClick={() => onPickSido(chip.key)}
            >
              {selected && regionLabel ? regionLabel : chip.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
