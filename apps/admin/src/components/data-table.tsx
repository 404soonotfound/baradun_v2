import type { ReactNode } from "react";
import { fill, messages } from "@/lib/messages";
import { pageWindow, PAGE_SIZE } from "@/lib/paging";

// 운영자 화면 공통 표·페이징 (GH-450, 시안 4차 보드 공통 CSS table.w-t · V11 장애 기록 페이지 넘김)
// - 표 기본형: 겉 상자(카드) 없이 표 자체의 옅은 테두리 1px · 모서리 8 · 머리 칸 옅은 바탕
// - 칸: 머리 위아래 7px · 본문 6px · 좌우 12px(첫·끝 칸 16px), 행 사이 1px 구분선, 마지막 행은 선 없음
// - 화면들이 표 모양을 따로 만들지 않게 클래스를 나눠 둠. 행은 <tr className={TR}>로 감싸야 마지막 행 선이 빠짐
// - 색·글자·모서리는 공유 토큰. 머리 위아래 7px만 맞는 토큰이 없어 그 값 그대로 씀

export const TABLE =
  "w-full border-separate border-spacing-0 rounded-admin-box border border-border-default bg-bg-surface text-body shadow-card";

export const TH =
  "border-b border-border-default bg-bg-page px-3 py-[7px] text-left text-label-s font-semibold whitespace-nowrap text-text-body first:rounded-tl-admin-box first:pl-4 last:rounded-tr-admin-box last:pr-4";

export const TD =
  "border-b border-border-default px-3 py-1.5 align-middle whitespace-nowrap text-text-body first:pl-4 last:pr-4 group-last/row:border-b-0";

export const TR = "group/row";

// 숫자·시각 칸 오른쪽 맞춤(시안 .w-r)
export const CELL_END = "text-right";

// 칸 안 주 글자(시안 .w-nm: 이름 등)
export const CELL_NAME = "font-medium text-text-default";

export function DataTable({
  caption,
  head,
  children,
  className = "",
}: {
  // 화면 읽기용 표 이름(보이지 않음)
  caption: string;
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <table className={`${TABLE} ${className}`}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const t = messages.table;

const PAGER_BUTTON =
  "inline-flex min-h-touch items-center justify-center rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page aria-disabled:cursor-not-allowed aria-disabled:opacity-45 lg:h-8 lg:min-h-0";

// 페이지 넘김: 'N건 중 a–b' · 이전 · '1 / 2' · 다음(시안 V11). 한 쪽이면 쪽 표시와 버튼은 그대로 두고 막음
export function Pager({
  label,
  total,
  page,
  onPage,
  size = PAGE_SIZE,
  className = "",
}: {
  // 무엇의 페이지인지(예: '장애 기록 페이지'). nav 이름과 버튼 이름에 씀
  label: string;
  total: number;
  // 0부터
  page: number;
  onPage: (page: number) => void;
  size?: number;
  className?: string;
}) {
  const w = pageWindow(total, page, size);
  return (
    <nav
      aria-label={label}
      className={`mt-3 flex items-center gap-2 text-label-s text-text-muted ${className}`}
    >
      <span className="tabular-nums">
        {fill(t.range, { total, from: w.from, to: w.to })}
      </span>
      <span className="flex-1" />
      {/* 끝 쪽에서 disabled로 바꾸면 누른 버튼의 포커스가 사라져 aria-disabled로 둠 */}
      <button
        type="button"
        aria-disabled={w.atStart}
        aria-label={fill(t.prevLabel, { label })}
        onClick={() => !w.atStart && onPage(w.page - 1)}
        className={PAGER_BUTTON}
      >
        {t.prev}
      </button>
      <span aria-current="page" className="text-text-body tabular-nums">
        {fill(t.pageOf, { page: w.page + 1, pages: w.pages })}
      </span>
      <button
        type="button"
        aria-disabled={w.atEnd}
        aria-label={fill(t.nextLabel, { label })}
        onClick={() => !w.atEnd && onPage(w.page + 1)}
        className={PAGER_BUTTON}
      >
        {t.next}
      </button>
    </nav>
  );
}
