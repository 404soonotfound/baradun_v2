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
import { joinMeta } from "@/lib/meta-join";
import { useRowText } from "@/lib/snapshot/use-row-text";

// 지도 카드 (BRD-30 · GH-529 탐색 시안 C: 노션 2장 EXP-M '2026-11-16 지도 카드', 결정 기록 29장 D29-2, 시안 S_EXPPC·S_EXPPCN)
// 사진(없으면 해변 그림) → 해변명 + 상태 칩 → '지역 · 구역 · 기관 시각' → 현장 우선 문구 → 상세 보기
// 마커를 누르면 이 카드가 그 해변으로 바뀜. 위쪽(사진·이름·칩·근거)을 누르면 상세(DET). 사진 출처 링크만 상세 링크 밖
// 상태는 게시값 그대로(G1). 칩은 실제 사유 먼저. 파고 값·측정소 줄은 두지 않음(목록과 같은 규칙, 상세에서 봄)
// 즐겨찾기·닫기는 그대로 둠(D-EXP 표 '상세 보기 + 즐겨찾기', 탭 순서: 상세 링크 → 사진 출처 → 즐겨찾기 → 상세 보기)
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
  const { rowBasis, listNote } = useRowText();
  const favorite = useFavorites().includes(item.id);
  // 사진과 링크 밖 출처 줄이 같은 '받지 못한 사진' 상태를 봄(사진을 못 받으면 출처 줄도 없음)
  const photo = useShownPhoto(item.photo);
  const view = item.view;
  const href = localizedPath(locale, `/spots/${item.slug}/`);

  // '지역 · 구역 · 기관 시각'(특보 없음) / 지역 + 칩이 말하지 못한 사유(그 외). 값은 측정소 줄이 없어 넣지 않음(상세에서 봄)
  // 오래된 정보는 listNote가 'HH:MM 확인 · 이후 확인 못 함' + 남은 사유(둘째 특보 등)를 함께 만듦
  // rowBasis도 오래된 정보 문구를 돌려주므로 그때는 부르지 않음(남은 사유가 가려지지 않게)
  const basis =
    view.kind === "ready"
      ? joinMeta([
          view.stale ? null : rowBasis(view, nowMs, item.warningZones),
          listNote(view, nowMs, { values: false }),
        ])
      : null;
  const place = joinMeta([item.region, basis]);

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-card bg-bg-surface shadow-raised",
        className,
      )}
    >
      <Link
        href={href}
        className="flex flex-col focus-visible:-outline-offset-2"
      >
        {/* 사진은 상세 링크 안(눌러도 상세), 카드 가장자리까지. 출처 링크는 링크 안 링크가 되지 않게 아래 PhotoCredit으로 뺌 */}
        <PhotoFigure
          shown={photo.shown}
          name={item.name}
          onError={photo.onError}
          checkBroken={photo.checkBroken}
          credit={false}
          overlay
          className="h-[132px] rounded-none"
        />
        <span className="flex flex-col gap-1.5 px-3.5 pt-3">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-title-s text-text-default">
              {item.name}
            </span>
            {view.kind === "ready" && (
              <ReasonBadge label={view.badge} size="sm" />
            )}
          </span>
          {place && (
            <span className="text-caption text-text-muted">{place}</span>
          )}
          <span className="text-caption text-text-muted">
            {t("safety.finalCall")}
          </span>
        </span>
      </Link>
      {/* 사진 출처(기관 링크·작품명, BRD-113 · 유형 이름은 두지 않음 GH-541). 탭 순서: 상세 링크(사진·이름) → 사진 출처 → 즐겨찾기·상세 보기 */}
      {photo.shown && (
        <PhotoCredit photo={photo.shown} className="px-3.5 pt-1.5" />
      )}

      <div className="flex gap-2 px-3.5 pt-2.5 pb-3.5">
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
          className="flex h-touch min-w-0 flex-1 items-center justify-center gap-1 rounded-button bg-brand-default px-3.5 text-body-s font-bold text-brand-on hover:bg-brand-hover"
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
        className="absolute top-2 right-2 flex size-touch items-center justify-center rounded-full bg-bg-surface text-text-default shadow-card"
      >
        <X aria-hidden="true" size={18} />
      </button>
    </div>
  );
}
