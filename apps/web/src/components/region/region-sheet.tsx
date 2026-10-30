"use client"; // 고르는 단계(useState)와 포커스 이동(useRef)이 있어 브라우저 부품

import { ChevronLeft, Navigation } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Chip } from "@/components/ui/chip";
import { Sheet } from "@/components/ui/sheet";
import type { RegionGroup, SavedRegion } from "@/lib/region-list";

// 지역 고르기 시트 (BRD-27 · 10/27 결정: 위치를 허용해도 지역을 고를 수 있음)
// 1단계 시·도(맨 앞 '전국'(BRD-127) · '내 주변') → 2단계 시·군(맨 앞 'OO 전체')
// 고른 값을 저장하거나 시트를 닫는 일은 부르는 쪽이 함
export interface RegionSheetProps {
  open: boolean;
  onClose: () => void;
  groups: readonly RegionGroup[];
  value: SavedRegion | null;
  onSelect: (region: SavedRegion) => void;
  // '전국' 칩(시·도 단계 맨 앞). 없으면 null(칩 숨김)
  nationwide?: { selected: boolean; onSelect: () => void } | null;
  // '내 주변' 칩. 위치를 거부했거나 쓰지 않는 화면(탐색)이면 null(칩 숨김)
  nearby?: { selected: boolean; onSelect: () => void } | null;
}

export function RegionSheet({
  open,
  onClose,
  groups,
  value,
  onSelect,
  nationwide = null,
  nearby = null,
}: RegionSheetProps) {
  const t = useTranslations("regionSheet");
  const [sido, setSido] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    // 열 때 저장 값의 시·도부터(고른 지역이 있으면 시·군 단계)
    if (open) setSido(value?.sido ?? null);
  }

  // 시·도가 하나뿐이고 '전국'·'내 주변'도 없으면 시·도 단계를 건너뜀
  const only =
    groups.length === 1 && !nationwide && !nearby ? groups[0] : undefined;
  const group = only ?? groups.find((item) => item.sido.key === sido);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, group]);

  return (
    <Sheet open={open} onClose={onClose} title={t("title")}>
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
            {nationwide && (
              <Chip
                size="lg"
                variant={nationwide.selected ? "on" : "default"}
                aria-pressed={nationwide.selected}
                onClick={nationwide.onSelect}
              >
                {t("nationwide")}
              </Chip>
            )}
            {nearby && (
              <Chip
                size="lg"
                variant={nearby.selected ? "on" : "default"}
                aria-pressed={nearby.selected}
                icon={<Navigation size={15} />}
                onClick={nearby.onSelect}
              >
                {t("nearby")}
              </Chip>
            )}
            {groups.map((item) => {
              const selected = value?.sido === item.sido.key;
              return (
                <Chip
                  key={item.sido.key}
                  size="lg"
                  variant={selected ? "on" : "default"}
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
