"use client"; // 고르는 단계(useState)와 포커스 이동(useRef)이 있어 브라우저 부품

import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Chip } from "@/components/ui/chip";
import { Sheet } from "@/components/ui/sheet";
import type { RegionGroup, SavedRegion } from "@/lib/region-list";

// 지역 고르기 시트 (노션 2장 HOME '위치 거부' 10/16 결정, Figma S_M01_03·04, BRD-27)
// 1단계 시·도 → 2단계 시·군(맨 앞 'OO 전체'). 칩 42px(size "lg")
// 홈·첫 실행(BRD-25)·탐색(BRD-29)이 같이 씀. 고른 값을 저장하거나 시트를 닫는 일은 부르는 쪽이 함
//
// 쓰는 법:
//   const sheet = useSheet("region");
//   <RegionSheet open={sheet.open} onClose={sheet.close} groups={groups} value={region}
//     onSelect={(next) => { setRegion(next); sheet.close(); }} />

// [1] Vue: props. 모양을 이름 붙여 내보내면 다른 화면에서도 같은 모양을 씀
export interface RegionSheetProps {
  open: boolean;
  onClose: () => void;
  // 고를 수 있는 시·도와 시·군(lib/region-list.ts regionGroups). 해변이 있는 곳만, 지리 순서
  groups: readonly RegionGroup[];
  // 지금 고른 지역(칩을 채움으로 표시). 없으면 null
  value: SavedRegion | null;
  // 열 때 바로 이 시·도의 시·군 단계부터(홈 칩에서 연 경우 등). 없으면 value의 시·도, 그것도 없으면 시·도 단계
  initialSido?: string | null;
  // 시·군(또는 'OO 전체' = sigungu null)을 누르면 부름. 시·도만 눌러서는 부르지 않음
  onSelect: (region: SavedRegion) => void;
}

export function RegionSheet({
  open,
  onClose,
  groups,
  value,
  initialSido = null,
  onSelect,
}: RegionSheetProps) {
  const t = useTranslations("regionSheet");
  // [2] 펼친 시·도. null이면 시·도 단계 (Vue: data() { return { sido: null } })
  const [sido, setSido] = useState<string | null>(null);
  // [3] 시트가 열린 순간을 알기 위한 이전 값. 열릴 때마다 단계를 처음으로 되돌림
  // Vue: watch: { open(now) { if (now) this.sido = … } } 자리 — 그리는 중에 바로 고치는 React 방식
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSido(initialSido ?? value?.sido ?? null);
  }

  // [4] 시·도가 하나뿐이면 시·도 단계를 건너뜀
  const only = groups.length === 1 ? groups[0] : undefined;
  const group = only ?? groups.find((item) => item.sido.key === sido);

  // [5] 단계 제목으로 포커스. 누른 칩이 사라져 포커스를 잃지 않게(화면 읽기가 새 단계를 읽어 줌)
  // Vue: this.$refs.heading.focus()
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, group]);

  return (
    <Sheet open={open} onClose={onClose} title={t("title")}>
      {/* Vue: v-if="group" / v-else */}
      {group ? (
        <div className="flex flex-col gap-3 pb-2">
          {!only && (
            <button
              type="button"
              onClick={() => setSido(null)}
              className="-ml-2 inline-flex min-h-touch items-center gap-1 self-start rounded-button px-2 text-body-s text-text-body hover:bg-bg-subtle"
            >
              <ChevronLeft aria-hidden="true" size={18} />
              {t("back")}
            </button>
          )}
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-title-s text-text-default outline-none"
          >
            {t("sigungu", { sido: group.sido.label })}
          </h3>
          <div className="flex flex-wrap gap-2">
            <Chip
              size="lg"
              variant={
                value?.sido === group.sido.key && value.sigungu === null
                  ? "on"
                  : "default"
              }
              aria-pressed={
                value?.sido === group.sido.key && value.sigungu === null
              }
              onClick={() => onSelect({ sido: group.sido.key, sigungu: null })}
            >
              {t("all", { sido: group.sido.label })}
            </Chip>
            {group.sigungu.map((part) => {
              const selected =
                value?.sido === group.sido.key && value.sigungu === part.key;
              return (
                <Chip
                  key={part.key}
                  size="lg"
                  variant={selected ? "on" : "default"}
                  aria-pressed={selected}
                  onClick={() =>
                    onSelect({ sido: group.sido.key, sigungu: part.key })
                  }
                >
                  {part.label}
                </Chip>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pb-2">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-title-s text-text-default outline-none"
          >
            {t("sido")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {groups.map((item) => {
              const selected = value?.sido === item.sido.key;
              return (
                <Chip
                  key={item.sido.key}
                  size="lg"
                  variant={selected ? "on" : "default"}
                  // 다음 단계로 가는 버튼이라 '눌림' 대신 '지금 고른 곳' 표시
                  aria-current={selected ? "true" : undefined}
                  onClick={() => setSido(item.sido.key)}
                >
                  {item.sido.label}
                </Chip>
              );
            })}
          </div>
        </div>
      )}
    </Sheet>
  );
}
