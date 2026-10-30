"use client";

import type { Beach } from "@baradun/contracts";
import { Navigation, Phone, Star, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import { shownMetric, shownStation } from "@/components/detail/sea-card";
import { ZoneName } from "@/components/zone-name";
import { AGENCY, agencyKeyOf, SOURCE_URL } from "@/lib/agencies";
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
  // Figma 220:3732: 머리 줄(제목 + 오른쪽 옅은 글) · 행마다 위 구분선 · 주의 면 34px 아이콘
  // 행은 누르는 곳이 아님(주변 특보 상세 화면 없음) → Figma의 › 는 두지 않음
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col overflow-hidden rounded-card bg-bg-surface shadow-card"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
        <h2 id={titleId} className="shrink-0 text-title-s text-text-default">
          {t("detail.nearby.title")}
        </h2>
        <p className="min-w-0 text-right text-caption text-text-muted">
          {t("detail.nearby.note")}
        </p>
      </div>
      <ul className="flex flex-col">
        {items.map((item) => (
          <li
            key={`${item.zoneCode}-${item.type}-${item.level}-${item.publishedAt}`}
            className="flex items-center gap-3 border-t border-border-default px-4 pt-[13px] pb-3"
          >
            <span
              aria-hidden="true"
              className="flex size-[34px] shrink-0 items-center justify-center rounded-icon bg-status-stale-bg text-status-stale-fg"
            >
              <TriangleAlert size={17} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-label text-text-default">
                {/* 구역·특보 이름 순서와 종류·단계 잇기는 언어별 문구 키로(영어는 띄어 씀). 모르는 종류는 '기타 주의보' */}
                {t.rich("warning.zoneLine", {
                  name: item.type
                    ? t("verdict.warning.title", {
                        type: t(`warning.nearbyType.${item.type}`),
                        level: t(`warning.level.${item.level}`),
                      })
                    : t("warning.nearbyUnknown", {
                        level: t(`warning.level.${item.level}`),
                      }),
                  zone: () => <ZoneName zone={item} />,
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
        <p className="mx-4 mb-4 rounded-input bg-info-bg px-3.5 py-3 text-body-s text-info-fg">
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
  // Figma 220:3743: 옅은 빨간 테두리 1px · 안쪽 옆 15 · 아이콘 면 38(반경 11) · 버튼 높이 42(반경 10) '전화'
  // 버튼 이름은 '전화 119'(보이는 '전화' + 번호를 숨긴 글자로, 화면 읽기에서 어디로 거는지 알 수 있게)
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex items-center gap-3 rounded-card border border-danger-border bg-bg-surface px-[15px] py-3.5",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-[38px] shrink-0 items-center justify-center rounded-[11px] bg-status-blocked-bg text-status-blocked-fg"
      >
        <Phone size={19} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <h2 id={titleId} className="text-title-s text-text-default">
          {t("title")}
        </h2>
        <span className="text-caption text-text-body">{t("body")}</span>
      </span>
      <a
        href="tel:119"
        // 보이는 높이 42, 누르는 영역은 위아래 1px씩 넓혀 44px(BRD-39)
        className="relative flex h-[42px] shrink-0 items-center rounded-icon bg-danger-call px-[15px] text-body font-bold text-danger-call-on before:absolute before:inset-x-0 before:-inset-y-px before:content-['']"
      >
        {t("call")}
        <span className="sr-only"> 119</span>
      </a>
    </section>
  );
}

// 정보 출처 3행: 파도·바람 / 특보 / 수온(통제 행은 후속, G2). 기관 + 측정소 이름·거리 + 시각
// 기관(기상청)은 기상법 출처 표시(BRD-113): 받은 실제 상태가 있고(kmaSource) 측정소를 보일 때만.
// 불러오는 중·처음부터 못 받음·개발용 예시에서는 측정소 이름(정적 목록)만 남고 기관을 붙이지 않음
// 이안류를 받았으면 4행째: 국립해양조사원 원문 링크 + 공공누리 제1유형 + 발표 시각
export function SourceList({
  locale,
  beachSlug,
  view,
  detail,
  stations,
  nowMs,
  kmaSource,
}: {
  locale: Locale;
  beachSlug: string;
  view: BeachView;
  detail: DetailInfo;
  stations: Beach["stations"];
  nowMs: number;
  kmaSource: boolean; // 받은 실제 상태가 있음(showsKmaSource)
}) {
  const t = useTranslations();
  const { stationText, agencyText } = useMetaText();
  const titleId = useId();
  const { issuedAtText } = useTimeText();
  const { confirmedUntilText } = useBadgeText();

  // 지표 하나의 시각 자리: HH:MM 측정(Figma '14:20 측정') / 늦어짐 / 가까운 관측 없음 / –
  // 바다 상태 카드와 같은 규칙(shownMetric): 측정소를 모르는 값·지연을 '가까운 관측 없음'으로 바꾸지 않음
  function timeOf(key: MetricKey): string | null {
    if (view.kind !== "ready") return null;
    const metric = shownMetric(view, stations, key);
    if (metric.kind === "none") return t("observation.none");
    if (metric.kind === "value") {
      const stamp = kstStamp(metric.observedAt, nowMs);
      return stamp
        ? t("observation.observedAt", { time: stamp })
        : t("observation.timeUnknown");
    }
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

  // 받은 실제 상태가 있고 측정소가 있으면 앞에 관측 기관(sea_obs·kma_buoy 모두 기상청 API허브, 결정 기록 B1)
  // Figma '기상청 강릉 해양기상부이'처럼 기관과 측정소 사이는 띄어 씀
  const sourced = kmaSource && view.kind === "ready";
  function observedBy(keys: MetricKey[]): string | null {
    const names = stationsOf(keys);
    if (!names) return null;
    return sourced ? `${agencyText(AGENCY.kma)} ${names}` : names;
  }

  // 행마다 출처(무엇이 · 누가) + 시각. 모바일은 시각을 다음 줄, PC는 오른쪽 끝(Figma 220:3754·183:1017)
  const rip = detail.ripCurrent;
  const rows: {
    key: string;
    label: string;
    main: ReactNode;
    time: string | null;
  }[] = [
    {
      key: "wave",
      label: t("detail.sources.wave"),
      main: observedBy(["waveHeight", "wavePeriod", "wind"]),
      time: timeOf("waveHeight"),
    },
    {
      key: "warning",
      label: t("detail.sources.warning"),
      main: joinMeta([
        t("detailSheet.warningScope"),
        detail.warningSource && agencyText(detail.warningSource),
      ]),
      time: warningTime,
    },
    {
      key: "waterTemp",
      label: t("detail.sources.waterTemp"),
      main: observedBy(["waterTemp"]),
      time: timeOf("waterTemp"),
    },
  ];
  // 이안류(정보만, D5)를 받았을 때만. 제공 기간 아님·읽을 수 없음은 자료가 없어 행을 두지 않음
  // 개발용 예시 값은 국립해양조사원 자료가 아니라 출처 행을 두지 않음(기상청 줄과 같은 조건)
  if (sourced && rip !== null && rip !== "unknown") {
    rows.push({
      key: "ripCurrent",
      label: t("detail.sources.ripCurrent"),
      // 아는 기관(국립해양조사원)만 원문 링크·공공누리 표시. 모르는 기관은 이름 원문 그대로(지어내지 않음)
      main:
        agencyKeyOf(rip.source) === "khoa"
          ? t.rich("detail.sources.ripCredit", {
              link: (chunks) => (
                <a
                  href={SOURCE_URL.ripCurrent}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {chunks}
                  <span className="sr-only"> ({t("common.newWindow")})</span>
                </a>
              ),
            })
          : agencyText(rip.source),
      time: issuedAtText(rip.publishedAt, nowMs),
    });
  }

  // 제목 줄은 카드 밖(Figma 정보 출처 · 정보가 실제와 달라요), 행 사이 구분선
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={titleId} className="text-title-s text-text-default">
          {t("detail.sources.title")}
        </h2>
        <Link
          // 어느 해변 문의인지 함께 넘김(문의 화면이 해변·활동을 자동 입력, BRD-37). 위치는 넘기지 않음
          href={`${localizedPath(locale, "/settings/inquiry/")}?beach=${encodeURIComponent(beachSlug)}`}
          // 보이는 줄은 18px, 누르는 영역은 위아래로 넓혀 44px(BRD-39)
          className="relative text-label-s font-bold text-brand-default before:absolute before:inset-x-0 before:-inset-y-[13px] before:content-['']"
        >
          {t("detail.sources.inquiry")}
        </Link>
      </div>
      <dl className="flex flex-col overflow-hidden rounded-card bg-bg-surface text-label-s leading-[1.5] shadow-card lg:text-label lg:leading-[1.45] lg:font-normal">
        {rows.map((row, index) => (
          <div
            key={row.key}
            className={cn(
              "flex gap-2 px-4 pt-3 pb-[11px] lg:gap-4 lg:px-[18px] lg:pt-[13px] lg:pb-3",
              index === 0
                ? "pt-[11px] lg:border-t lg:border-border-subtle"
                : "border-t border-border-default lg:border-border-subtle",
            )}
          >
            <dt className="w-[70px] shrink-0 text-text-muted lg:w-[110px]">
              {row.label}
            </dt>
            <dd className="flex min-w-0 flex-1 flex-col text-text-default lg:flex-row lg:justify-between lg:gap-4">
              <span>{row.main ?? "–"}</span>
              {row.time && <span className="lg:shrink-0">{row.time}</span>}
            </dd>
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

// 즐겨찾기 버튼. square: 모바일 하단 52px 정사각(Figma 별만), pill: PC 머리 줄 칩(별 + '즐겨찾기')
// 이름은 그대로 두고 눌림 상태(aria-pressed)로 즐겨찾기 여부를 알림. 별 색은 Figma decor/favorite
export function FavoriteButton({
  beachId,
  variant,
  className,
}: {
  beachId: string;
  variant: "square" | "pill";
  className?: string;
}) {
  const t = useTranslations("detail.cta");
  const favorites = useFavorites();
  const favorite = favorites.includes(beachId);
  const star = (
    <Star
      aria-hidden="true"
      size={variant === "square" ? 21 : 15}
      className={cn(
        favorite ? "fill-favorite text-favorite" : "",
        variant === "square" && "text-favorite",
      )}
    />
  );
  if (variant === "square") {
    return (
      <button
        type="button"
        aria-label={t("favorite")}
        aria-pressed={favorite}
        onClick={() => toggleFavorite(beachId)}
        className={cn(
          "flex size-button shrink-0 items-center justify-center rounded-button border border-border-strong bg-bg-surface hover:bg-bg-subtle",
          className,
        )}
      >
        {star}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={favorite}
      onClick={() => toggleFavorite(beachId)}
      className={cn(
        "flex h-9 shrink-0 items-center gap-[5px] rounded-full border border-border-strong bg-bg-surface px-[13px] text-[13.5px] font-medium text-text-body hover:bg-bg-subtle",
        className,
      )}
    >
      {star}
      {t("favorite")}
    </button>
  );
}

// 길찾기(Figma '버튼 · 새' 높이 52 · 글자 15.5 굵게). 이용불가·판단불가면 보조 스타일 '이 해변 길찾기'로 낮춤
export function DirectionsLink({
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
  // 판단 전(불러오는 중)도 '특보 없음'이 아니므로 낮춘 스타일
  const primary =
    view.kind === "ready" && view.category === "clear" && !view.stale;
  return (
    <a
      href={directionsUrl(beach, beach.name[locale])}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex h-button min-w-0 items-center justify-center gap-1.5 rounded-button px-1.5 text-title-region",
        primary
          ? "bg-brand-default text-brand-on hover:opacity-90"
          : "border border-border-strong bg-bg-surface text-text-default hover:bg-bg-subtle",
        className,
      )}
    >
      <Navigation aria-hidden="true" size={16} />
      {primary ? t("directions") : t("directionsSecondary")}
      <span className="sr-only"> ({t("newWindow")})</span>
    </a>
  );
}

// 모바일 하단 고정 줄: 즐겨찾기(별) + 길찾기(Figma cta: 사이 10)
export function DetailActions({
  beach,
  view,
}: {
  beach: Beach;
  view: BeachView;
}) {
  return (
    <div className="flex gap-2.5">
      <FavoriteButton beachId={beach.id} variant="square" />
      <DirectionsLink beach={beach} view={view} className="flex-1" />
    </div>
  );
}
