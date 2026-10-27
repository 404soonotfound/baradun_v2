"use client";

import type { Beach } from "@baradun/contracts";
import { CloudRain, Navigation, Phone, Star } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";

import { shownMetric, shownStation } from "@/components/detail/sea-card";
import { cn } from "@/lib/cn";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { localizedPath, type Locale } from "@/lib/i18n";
import { joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import type { DetailInfo } from "@/lib/snapshot/detail";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricKey } from "@/lib/snapshot/view";

// 장소 상세 아래쪽 묶음 (BRD-32 · 노션 2장 DET 7·8, 3장 Call119·SourceList)
// 주변 특보(정보만) → 긴급신고 119 → 정보 출처 + '정보가 실제와 달라요' / 하단 즐겨찾기·길찾기

// 주변 특보 (B3): 판단에 쓰지 않는 특보(호우·폭염 등). 없으면 카드를 두지 않음
export function NearbyWarnings({
  items,
  unreadable,
  nowMs,
}: {
  items: DetailInfo["nearbyWarnings"];
  unreadable: DetailInfo["unreadableNearby"]; // 읽지 못한 항목 수. 있으면 카드를 숨기지 않고 알림
  nowMs: number;
}) {
  const t = useTranslations();
  const { issuedAtText } = useTimeText();
  const titleId = useId();
  if (items.length === 0 && unreadable === 0) return null;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
    >
      <h2 id={titleId} className="text-title-s text-text-default">
        {t("detail.nearby.title")}
      </h2>
      <p className="text-caption text-text-muted">{t("detail.nearby.note")}</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={`${item.zoneCode}-${item.type}-${item.level}-${item.publishedAt}`}
            className="flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-icon bg-info-bg text-info-fg"
            >
              <CloudRain size={16} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-body-s font-bold text-text-default">
                {item.zoneName}{" "}
                {/* 종류·단계 잇기는 언어별 문구 키로(영어는 띄어 씀). 모르는 종류는 '기타 주의보' */}
                {item.type
                  ? t("verdict.warning.title", {
                      type: t(`warning.nearbyType.${item.type}`),
                      level: t(`warning.level.${item.level}`),
                    })
                  : t("warning.nearbyUnknown", {
                      level: t(`warning.level.${item.level}`),
                    })}
              </span>
              <span className="text-caption text-text-muted">
                {issuedAtText(item.publishedAt, nowMs)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {/* 읽지 못한 주변 특보: 발효 특보와 같은 '내용을 읽지 못했어요' 계열 문구(임시안) */}
      {unreadable !== 0 && (
        <p className="rounded-input bg-info-bg px-3.5 py-3 text-body-s text-info-fg">
          {unreadable === "all"
            ? t("detail.nearby.unreadableAll")
            : t("detail.nearby.unreadable", { count: unreadable })}
        </p>
      )}
    </section>
  );
}

// 긴급신고 119 (10/16·10/21 결정: 119 단독, 영어 화면도 119). 번호는 글자로도 보임
export function Call119({ className }: { className?: string }) {
  const t = useTranslations("detail.call119");
  // 모바일·PC 자리에 하나씩 그려지므로 id가 겹치지 않게 useId
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex items-center gap-3 rounded-card border-[1.5px] border-danger-text bg-bg-surface p-4",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-status-blocked-bg text-status-blocked-fg"
      >
        <Phone size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <h2 id={titleId} className="text-title-s text-text-default">
          {t("title")}
        </h2>
        <span className="text-caption text-text-body">{t("body")}</span>
      </span>
      <a
        href="tel:119"
        className="flex h-touch shrink-0 items-center gap-1.5 rounded-button bg-danger-call px-4 text-body-s font-bold text-danger-call-on"
      >
        <Phone aria-hidden="true" size={16} />
        {t("call")} 119
      </a>
    </section>
  );
}

// 정보 출처 3행: 파도·바람 / 특보 / 수온(통제 행은 후속, G2). 측정소 이름·거리 + 시각
export function SourceList({
  locale,
  view,
  detail,
  stations,
  nowMs,
}: {
  locale: Locale;
  view: BeachView;
  detail: DetailInfo;
  stations: Beach["stations"];
  nowMs: number;
}) {
  const t = useTranslations();
  const { stationText, agencyText } = useMetaText();
  const titleId = useId();
  const { measuredAgoText } = useTimeText();
  const { confirmedUntilText } = useBadgeText();

  // 지표 하나의 시각 자리: n분 전 측정 / 늦어짐 / 가까운 관측 없음 / –
  // 바다 상태 카드와 같은 규칙(shownMetric): 측정소를 모르는 값·지연을 '가까운 관측 없음'으로 바꾸지 않음
  function timeOf(key: MetricKey): string | null {
    if (view.kind !== "ready") return null;
    const metric = shownMetric(view, stations, key);
    if (metric.kind === "none") return t("observation.none");
    if (metric.kind === "value")
      return measuredAgoText(metric.observedAt, nowMs);
    if (metric.kind === "delayed") return t("observation.delayed");
    return "–";
  }
  function stationsOf(keys: MetricKey[]): string | null {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const key of keys) {
      const station =
        view.kind === "ready"
          ? shownStation(view.metrics[key], stations, key)
          : stations[key];
      if (station && !seen.has(station.id)) {
        seen.add(station.id);
        names.push(stationText(station));
      }
    }
    return names.length > 0 ? names.join(", ") : null;
  }

  let warningTime: string | null = null;
  if (view.kind === "ready") {
    const stamp = kstStamp(view.confirmedAt, nowMs);
    // B5·특보 확인 못 함이면 마지막 확인 시각 + '이후 확인 못 함'
    const unconfirmed =
      view.stale ||
      view.reasons.some((reason) => reason.kind === "warning_unknown");
    warningTime = unconfirmed
      ? confirmedUntilText(view.confirmedAt, nowMs)
      : stamp
        ? t("detail.verdict.basisChecked", { time: stamp })
        : t("verdict.unknownWarning.title");
  }

  const rows = [
    {
      key: "wave",
      label: t("detail.sources.wave"),
      text: joinMeta([
        stationsOf(["waveHeight", "wavePeriod", "wind"]),
        timeOf("waveHeight"),
      ]),
    },
    {
      key: "warning",
      label: t("detail.sources.warning"),
      text: joinMeta([
        detail.warningSource && agencyText(detail.warningSource),
        warningTime,
      ]),
    },
    {
      key: "waterTemp",
      label: t("detail.sources.waterTemp"),
      text: joinMeta([stationsOf(["waterTemp"]), timeOf("waterTemp")]),
    },
  ];

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-title-s text-text-default">
          {t("detail.sources.title")}
        </h2>
        <Link
          href={localizedPath(locale, "/settings/inquiry/")}
          className="inline-flex min-h-touch items-center text-body-s font-bold text-brand-default underline"
        >
          {t("detail.sources.inquiry")}
        </Link>
      </div>
      <dl className="grid grid-cols-[70px_1fr] gap-x-3 gap-y-1.5 text-body-s lg:grid-cols-[70px_1fr_70px_1fr_70px_1fr]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="text-text-default">{row.text ?? "–"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// 카카오맵 길찾기 웹 링크(10/27 결정 ③). 해변 좌표만 넘김(사용자 위치는 보내지 않음, 출발지는 카카오맵이 정함)
// 형식: https://map.kakao.com/link/to/이름,위도,경도 — 이름은 도착지 표시용(공개 해변 이름)
export function directionsUrl(
  beach: Pick<Beach, "coords">,
  name: string,
): string {
  return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${beach.coords.lat},${beach.coords.lng}`;
}

// 즐겨찾기 + 길찾기. 이용불가·판단불가면 길찾기를 보조 스타일 '이 해변 길찾기'로 낮춤
export function DetailActions({
  beach,
  view,
  className,
}: {
  beach: Beach;
  view: BeachView;
  className?: string;
}) {
  const t = useTranslations("detail.cta");
  const locale = useLocale() as Locale;
  const favorites = useFavorites();
  const favorite = favorites.includes(beach.id);
  // 판단 전(불러오는 중)도 '특보 없음'이 아니므로 낮춘 스타일
  const primary =
    view.kind === "ready" && view.category === "clear" && !view.stale;

  return (
    <div className={cn("flex gap-2", className)}>
      <button
        type="button"
        // 이름은 그대로 두고 눌림 상태(aria-pressed)로 즐겨찾기 여부를 알림
        aria-pressed={favorite}
        onClick={() => toggleFavorite(beach.id)}
        className="flex h-button shrink-0 items-center justify-center gap-1.5 rounded-button border border-border-strong bg-bg-surface px-4 text-title-s text-text-default hover:bg-bg-subtle"
      >
        <Star
          aria-hidden="true"
          size={18}
          className={favorite ? "fill-brand-default text-brand-default" : ""}
        />
        {t("favorite")}
      </button>
      <a
        href={directionsUrl(beach, beach.name[locale])}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex h-button min-w-0 flex-1 items-center justify-center gap-1.5 rounded-button px-4 text-title-s",
          primary
            ? "bg-brand-default text-brand-on shadow-card hover:opacity-90"
            : "border border-border-strong bg-bg-surface text-text-default hover:bg-bg-subtle",
        )}
      >
        <Navigation aria-hidden="true" size={18} />
        {primary ? t("directions") : t("directionsSecondary")}
        <span className="sr-only"> ({t("newWindow")})</span>
      </a>
    </div>
  );
}
