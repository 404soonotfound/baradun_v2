import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { matchRange, withTopicParticle, type SearchMatch } from "@/lib/search";
import type { BeachView } from "@/lib/snapshot/view";

// 검색 결과 행 (BRD-31 · 노션 2장 SRCH '자동완성(일치 부분 굵게, 행마다 상태 배지) + 별칭 안내')
// 이름(일치 부분 굵게) · 지역 · 상태 배지(실제 사유 먼저) · 근거 줄 · 별칭이면 '다른 이름이에요' 안내
// 상태는 view를 그대로 씀(G1). 첫 응답 전에는 배지 자리만 회색(빈 배지·'특보 없음'을 미리 보이지 않음)

function Highlighted({
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
      <strong className="font-bold text-text-default">
        {text.slice(range.start, range.end)}
      </strong>
      {text.slice(range.end)}
    </>
  );
}

export function SearchResultRow({
  href,
  name,
  region,
  query,
  match,
  view,
  basis,
  onOpen,
}: {
  href: string;
  name: string;
  region: string;
  query: string;
  match: SearchMatch;
  view: BeachView;
  basis: string | null; // 특보 없음 근거 · 오래된 정보 문구(useRowText.rowBasis)
  onOpen: () => void; // 눌렀을 때 최근 검색에 해변 id와 함께 저장
}) {
  const t = useTranslations("search");
  const locale = useLocale();
  // 한국어는 조사("경포대는")를 붙임. 영어는 그대로
  const alias =
    match.kind === "alias"
      ? locale === "ko"
        ? withTopicParticle(match.alias)
        : match.alias
      : null;

  return (
    <li>
      <Link
        href={href}
        onClick={onOpen}
        className="flex min-h-touch items-center gap-3 py-3 pr-3 pl-3.5 focus-visible:-outline-offset-2"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-title-s font-normal text-text-body">
            <Highlighted text={name} query={query} />
          </span>
          <span className="truncate text-caption text-text-muted">
            <Highlighted text={region} query={query} />
          </span>
          {basis && (
            <span className="text-caption text-text-muted">{basis}</span>
          )}
          {alias && (
            <span className="text-caption font-bold text-brand-default">
              {t("aliasNote", { alias, name })}
            </span>
          )}
        </span>
        {view.kind === "ready" ? (
          <ReasonBadge label={view.badge} size="sm" />
        ) : (
          <Skeleton className="h-badge w-16 rounded-badge" />
        )}
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 text-text-muted"
        />
      </Link>
    </li>
  );
}
