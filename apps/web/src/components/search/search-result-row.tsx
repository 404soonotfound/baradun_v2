import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ReasonBadge } from "@/components/reason-badge";
import { BeachThumb } from "@/components/search/beach-thumb";
import { Skeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { matchRange, withTopicParticle, type SearchMatch } from "@/lib/search";
import type { BeachView } from "@/lib/snapshot/view";

// 검색 목록 카드 한 줄 (GH-531 · 결정 기록 29장 D29-5·D29-7, 시안 S_SRC0P2·S_SRCR)
// 사진 72×56(없으면 해변 그림) · 이름(일치 부분 굵게) + 상태 칩(실제 사유 먼저) · 2줄째 · 3줄째 · (넷째 줄) · 별칭 안내
// 상태는 view를 그대로 씀(G1). 첫 응답 전에는 칩 자리만 회색(빈 칩·'특보 없음'을 미리 보이지 않음)

export function Highlighted({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  const range = matchRange(text, query);
  if (range === null) return text;
  return (
    <>
      {text.slice(0, range.start)}
      <strong className="font-bold">
        {text.slice(range.start, range.end)}
      </strong>
      {text.slice(range.end)}
    </>
  );
}

export function SearchResultRow({
  href,
  name,
  photo,
  region,
  query,
  match,
  view,
  meta,
  detail,
  note,
  onOpen,
}: {
  href: string;
  name: string;
  photo: BeachSummary["photo"];
  region: string; // 2줄째 앞의 지역 이름(일치 부분 굵게는 여기에만: 수온·거리 숫자를 굵게 하지 않음)
  query: string; // 일치 부분을 굵게(입력 전 최근 본 해변은 "")
  match: SearchMatch | null; // 별칭으로 찾았으면 '다른 이름이에요' 안내
  view: BeachView;
  meta: string | null; // 2줄째 '지역 · 거리 · 수온 · 측정 시각'(useRowText.listMeta)
  detail: string | null; // 3줄째(결과: 확인된 활동 · 최근 본: 구역 · 기관 시각)
  note: string | null; // 넷째 줄(useRowText.listNote)
  onOpen?: () => void; // 눌렀을 때 최근 검색에 해변 id와 함께 저장
}) {
  const t = useTranslations("search");
  const locale = useLocale();
  // 한국어는 조사("경포대는")를 붙임. 영어는 그대로
  const alias =
    match?.kind === "alias"
      ? locale === "ko"
        ? withTopicParticle(match.alias)
        : match.alias
      : null;

  return (
    <li>
      <Link
        href={href}
        {...(onOpen ? { onClick: onOpen } : {})}
        className="flex min-h-touch items-center gap-3.5 py-[13px] pr-3 pl-3.5 focus-visible:-outline-offset-2"
      >
        <BeachThumb photo={photo} className="h-14 w-[72px] rounded-[12px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-title-s text-text-default">
              <Highlighted text={name} query={query} />
            </span>
            {view.kind === "ready" ? (
              <ReasonBadge label={view.badge} size="sm" />
            ) : (
              <Skeleton className="h-badge w-16 rounded-badge" />
            )}
          </span>
          {/* 지역으로 찾았을 때도 일치 부분이 보이게 2줄째도 굵게(지금 동작 유지) */}
          {meta && (
            <span className="text-caption text-text-muted">
              {meta.startsWith(region) ? (
                <>
                  <Highlighted text={region} query={query} />
                  {meta.slice(region.length)}
                </>
              ) : (
                meta
              )}
            </span>
          )}
          {detail && (
            <span className="text-caption text-text-body">{detail}</span>
          )}
          {note && <span className="text-body-s text-text-body">{note}</span>}
          {alias && (
            <span className="text-caption font-bold text-brand-default">
              {t("aliasNote", { alias, name })}
            </span>
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 text-text-muted"
        />
      </Link>
    </li>
  );
}
