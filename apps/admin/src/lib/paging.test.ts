import { describe, expect, it } from "vitest";
import { PAGE_SIZE, pageRows, pageWindow } from "./paging";

describe("pageWindow", () => {
  it("기본 5행: 7건 첫 쪽은 1–5, 둘째 쪽은 6–7", () => {
    expect(PAGE_SIZE).toBe(5);
    expect(pageWindow(7, 0)).toEqual({
      page: 0,
      pages: 2,
      from: 1,
      to: 5,
      atStart: true,
      atEnd: false,
    });
    expect(pageWindow(7, 1)).toMatchObject({
      page: 1,
      from: 6,
      to: 7,
      atStart: false,
      atEnd: true,
    });
  });

  it("한 쪽에 다 들어가면 앞뒤 모두 끝", () => {
    expect(pageWindow(3, 0)).toMatchObject({
      pages: 1,
      from: 1,
      to: 3,
      atStart: true,
      atEnd: true,
    });
  });

  it("0건은 0–0, 쪽 수 1", () => {
    expect(pageWindow(0, 0)).toMatchObject({ pages: 1, from: 0, to: 0 });
  });

  it("목록이 줄어 지금 쪽이 없으면 마지막 쪽으로, 음수는 첫 쪽으로", () => {
    expect(pageWindow(6, 4)).toMatchObject({ page: 1, from: 6, to: 6 });
    expect(pageWindow(6, -1)).toMatchObject({ page: 0, from: 1 });
  });

  it("쪽 크기를 바꿀 수 있음", () => {
    expect(pageWindow(11, 0, 6)).toMatchObject({ pages: 2, from: 1, to: 6 });
  });
});

describe("pageRows", () => {
  it("지금 쪽 행만 자름", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7];
    expect(pageRows(rows, 0)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRows(rows, 1)).toEqual([6, 7]);
    expect(pageRows(rows, 9)).toEqual([6, 7]);
    expect(pageRows([], 0)).toEqual([]);
  });
});
