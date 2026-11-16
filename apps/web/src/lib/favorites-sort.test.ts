import { afterEach, describe, expect, it, vi } from "vitest";

import type { BeachView } from "@/lib/snapshot/view";
import {
  clearFavoritesSort,
  isFavoritesSort,
  resetFavoritesSortForTest,
  setFavoritesSort,
  sortFavoriteItems,
} from "./favorites-sort";

const EMPTY_METRICS = {
  waveHeight: { kind: "none" },
  wavePeriod: { kind: "none" },
  waveDirection: { kind: "none" },
  waterTemp: { kind: "none" },
  wind: { kind: "none" },
} as const;

function readyView(
  category: "clear" | "unavailable" | "undetermined",
): BeachView {
  return {
    kind: "ready",
    category,
    badge:
      category === "clear"
        ? { kind: "clear" }
        : category === "unavailable"
          ? { kind: "warning", type: "wind_wave", level: "advisory" }
          : { kind: "warning_unknown" },
    reasons: [
      category === "clear"
        ? { kind: "clear" }
        : category === "unavailable"
          ? { kind: "warning", type: "wind_wave", level: "advisory" }
          : { kind: "warning_unknown" },
    ],
    stale: false,
    confirmedAt: "2026-11-16T08:00:00Z",
    metrics: EMPTY_METRICS,
  };
}

describe("sortFavoriteItems", () => {
  const items = [
    { id: "clear-1", view: readyView("clear") },
    { id: "unknown-1", view: readyView("undetermined") },
    { id: "blocked-1", view: readyView("unavailable") },
    { id: "clear-2", view: readyView("clear") },
    { id: "blocked-2", view: readyView("unavailable") },
  ];

  it("상태 먼저는 이용불가 → 판단불가 → 특보 없음 순이고 같은 상태 안에서는 넣은 순서를 지킴", () => {
    expect(sortFavoriteItems(items, "status").map((item) => item.id)).toEqual([
      "blocked-1",
      "blocked-2",
      "unknown-1",
      "clear-1",
      "clear-2",
    ]);
  });

  it("넣은 순서는 원래 순서를 그대로 유지함", () => {
    expect(sortFavoriteItems(items, "added").map((item) => item.id)).toEqual([
      "clear-1",
      "unknown-1",
      "blocked-1",
      "clear-2",
      "blocked-2",
    ]);
  });
});

describe("favoritesSort 저장소", () => {
  afterEach(() => {
    resetFavoritesSortForTest();
    vi.unstubAllGlobals();
  });

  it("유효한 정렬 값만 인정함", () => {
    expect(isFavoritesSort("status")).toBe(true);
    expect(isFavoritesSort("added")).toBe(true);
    expect(isFavoritesSort("near")).toBe(false);
    expect(isFavoritesSort(null)).toBe(false);
  });

  it("저장과 초기화를 localStorage에 반영함", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    });

    setFavoritesSort("added");
    expect(map.get("baradun:favorites-sort")).toBe("added");

    clearFavoritesSort();
    expect(map.has("baradun:favorites-sort")).toBe(false);
  });
});
