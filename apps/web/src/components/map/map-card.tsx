"use client";

import { ChevronRight, Star, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { ReasonBadge } from "@/components/reason-badge";
import {
  PhotoCredit,
  PhotoFigure,
  useShownPhoto,
} from "@/components/map/beach-photo";
import { cn } from "@/lib/cn";
import type { ExploreItem } from "@/lib/explore";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useRowText } from "@/lib/snapshot/use-row-text";
import type { MetricKey } from "@/lib/snapshot/view";

// 지도 카드 (BRD-30 · 노션 2장 EXP-M 하단 MapCard, D-EXP 지도 카드 380px: 사진 + 요약 + 상세 보기 + 즐겨찾기)
// 마커를 누르면 이 카드가 그 해변으로 바뀜. 위쪽(사진·이름·배지·근거)을 누르면 상세(DET). 사진 출처 링크만 상세 링크 밖
// 상태는 게시값 그대로(G1). 배지는 실제 사유 먼저, '특보 없음'이면 범위·기관·확인 시각 + 현장 우선 문구
// 값을 보인 지표마다 측정소·관측 시각을 붙임(측정소 없는 값은 이미 '–'로 숨겨져 옴, explore.ts)
const SOURCED_METRICS = [
  "waveHeight",
  "wavePeriod",
] as const satisfies readonly MetricKey[];

export function MapCard({
  locale,
  item,
  nowMs,
  onClose,
  className,
}: {
  locale: Locale;
  item: ExploreItem;
  nowMs: number;
  onClose: () => void;
  className?: string;
}) {
  const t = useTranslations();
  const { rowDetail } = useRowText();
  const { observationMeta } = useMetaText();
  const favorite = useFavorites().includes(item.id);
  // 사진과 링크 밖 출처 줄이 같은 '받지 못한 사진' 상태를 봄(사진을 못 받으면 출처 줄도 없음)
  const photo = useShownPhoto(item.photo);
  const view = item.view;
  const href = localizedPath(locale, `/spots/${item.slug}/`);

  const km = item.distanceKm === null ? null : formatKm(item.distanceKm);
  const place = joinMeta([item.region, km && `${km}km`]);
  const notes: string[] = [];
  if (view.kind === "ready") {
    const detail = rowDetail(view, nowMs);
    if (detail) notes.push(detail);
    for (const key of SOURCED_METRICS) {
      const metric = view.metrics[key];
      const station = item.stations[key];
      if (metric.kind === "value" && station !== null) {
        notes.push(observationMeta(key, station, metric.observedAt, nowMs));
      }
    }
  }
  notes.push(t("safety.finalCall"));

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2.5 rounded-card bg-bg-surface p-3 shadow-raised",
        className,
      )}
    >
      <Link href={href} className="flex flex-col gap-2.5 rounded-[12px]">
        {/* 사진은 상세 링크 안(눌러도 상세). 출처 링크는 링크 안 링크가 되지 않게 아래 PhotoCredit으로 뺌 */}
        <PhotoFigure
          shown={photo.shown}
          name={item.name}
          onError={photo.onError}
          credit={false}
          className="h-[104px] lg:h-[150px]"
        />
        <span className="flex items-start justify-between gap-3 pr-1">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-title-m text-text-default">
              {item.name}
            </span>
            {place && (
              <span className="text-caption text-text-muted">{place}</span>
            )}
          </span>
          {view.kind === "ready" && <ReasonBadge label={view.badge} />}
        </span>
        <span className="flex flex-col gap-0.5 text-caption text-text-muted">
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      </Link>
      {/* 사진 출처(공공누리 제1유형 링크, BRD-113). 탭 순서: 상세 링크(사진·이름) → 사진 출처 → 즐겨찾기·상세 보기 */}
      {photo.shown && <PhotoCredit photo={photo.shown} className="-mt-1" />}

      <div className="flex gap-2">
        <button
          type="button"
          // 이름은 그대로 두고 눌림 상태(aria-pressed)로 즐겨찾기 여부를 알림
          aria-pressed={favorite}
          onClick={() => toggleFavorite(item.id)}
          className="flex h-touch shrink-0 items-center justify-center gap-1.5 rounded-button border border-border-strong bg-bg-surface px-3.5 text-body-s font-bold text-text-default hover:bg-bg-subtle"
        >
          <Star
            aria-hidden="true"
            size={16}
            className={favorite ? "fill-brand-default text-brand-default" : ""}
          />
          {t("detail.cta.favorite")}
        </button>
        <Link
          href={href}
          className="flex h-touch min-w-0 flex-1 items-center justify-center gap-1 rounded-button bg-brand-default px-3.5 text-body-s font-bold text-brand-on hover:opacity-90"
        >
          {t("map.card.detail")}
          <ChevronRight aria-hidden="true" size={16} />
        </Link>
      </div>

      {/* 사진 위 오른쪽 닫기. 링크 밖에 둠(누를 때 상세로 가지 않게) */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("map.card.close")}
        className="absolute top-4 right-4 flex size-touch items-center justify-center rounded-full bg-bg-surface text-text-default shadow-card"
      >
        <X aria-hidden="true" size={18} />
      </button>
    </div>
  );
}
