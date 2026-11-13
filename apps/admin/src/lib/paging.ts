// 공통 페이징 계산 (GH-450, 시안 4차 V9·V11 장애 기록 '7건 중 1–5'). 화면 표들이 함께 씀
// - 기본 한 쪽 5행
// - 목록이 줄어 지금 쪽이 사라지면 마지막 쪽으로 당김(빈 쪽을 보이지 않게)

export const PAGE_SIZE = 5;

export interface PageWindow {
  // 0부터 시작하는 지금 쪽(범위 안으로 당긴 값)
  readonly page: number;
  // 전체 쪽 수. 0건이어도 1
  readonly pages: number;
  // 화면에 보이는 첫·끝 행 번호(1부터). 0건이면 0
  readonly from: number;
  readonly to: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

export function pageWindow(
  total: number,
  page: number,
  size: number = PAGE_SIZE,
): PageWindow {
  const count = Math.max(0, Math.floor(total));
  const per = Math.max(1, Math.floor(size));
  const pages = Math.max(1, Math.ceil(count / per));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const start = current * per;
  return {
    page: current,
    pages,
    from: count === 0 ? 0 : start + 1,
    to: Math.min(start + per, count),
    atStart: current === 0,
    atEnd: current === pages - 1,
  };
}

// 지금 쪽에 보일 행만 자름
export function pageRows<T>(
  rows: readonly T[],
  page: number,
  size: number = PAGE_SIZE,
): readonly T[] {
  const w = pageWindow(rows.length, page, size);
  return w.from === 0 ? [] : rows.slice(w.from - 1, w.to);
}
