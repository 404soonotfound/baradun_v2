import { describe, expect, it } from "vitest";

import type { Activity } from "./activity";
import { alternativeBeaches } from "./alternatives";
import type { BeachView } from "./snapshot/view";

// 대안 해변 (BRD-10 결정): '특보 없음'만 · 가까운 순 최대 2곳 · 30km 이내 · 선택 활동 지원
const here = { id: "here", coords: { lat: 37.8, lng: 128.9 } };
// 위도 0.1도 ≈ 11.1km
const at = (km: number) => ({ lat: 37.8 + km / 111.19, lng: 128.9 });

const ready = (
  category: "clear" | "unavailable" | "undetermined",
  stale = false,
): BeachView =>
  ({
    kind: "ready",
    category,
    badge: { kind: "clear" },
    reasons: [{ kind: "clear" }],
    stale,
    confirmedAt: null,
    metrics: {},
  }) as unknown as BeachView;

type Item = {
  id: string;
  coords: { lat: number; lng: number };
  activities: Activity[];
  view: BeachView;
};
const item = (
  id: string,
  km: number,
  view: BeachView,
  activities: Activity[] = ["swimming"],
): Item => ({ id, coords: at(km), activities, view });

const pick = (items: Item[], activity: Activity = "swimming") =>
  alternativeBeaches(here, items, activity, (beach) => beach.view).map(
    (beach) => beach.id,
  );

describe("alternativeBeaches", () => {
  it("특보 없음만, 가까운 순 최대 2곳", () => {
    expect(
      pick([
        item("c", 20, ready("clear")),
        item("a", 5, ready("clear")),
        item("blocked", 1, ready("unavailable")),
        item("unknown", 2, ready("undetermined")),
        item("b", 10, ready("clear")),
      ]),
    ).toEqual(["a", "b"]);
  });

  it("지금 보는 해변은 넣지 않음", () => {
    expect(pick([{ ...item("here", 0, ready("clear")) }])).toEqual([]);
  });

  it("30km는 넣고 30km를 넘으면 뺌", () => {
    expect(
      pick([
        item("in", 29.9, ready("clear")),
        item("out", 30.2, ready("clear")),
      ]),
    ).toEqual(["in"]);
  });

  it("오프라인·만료로 '이후 확인 못 함'이 붙은 해변·불러오는 중인 해변은 뺌", () => {
    expect(
      pick([
        item("stale", 3, ready("clear", true)),
        item("loading", 4, { kind: "loading" }),
      ]),
    ).toEqual([]);
  });

  it("서핑을 고르면 서핑이 확인된 해변만", () => {
    expect(
      pick(
        [
          item("swim", 2, ready("clear")),
          item("surf", 5, ready("clear"), ["swimming", "surfing"]),
        ],
        "surfing",
      ),
    ).toEqual(["surf"]);
  });

  it("조건에 맞는 해변이 없으면 빈 목록", () => {
    expect(pick([])).toEqual([]);
  });
});
