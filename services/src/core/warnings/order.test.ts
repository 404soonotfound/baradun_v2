import { describe, expect, it } from "vitest";
import data from "./fixtures/pwncd-events.json";
import { normalizePwnCdRow, type PwnCdRow } from "./normalize";
import { orderPwnEvents } from "./order";

// 정렬·중복 제거 검사 (BRD-54 7단계)

const scenario = data.scenarios[0]!.rows;
const seqs = (rows: PwnCdRow[]) =>
  orderPwnEvents(rows.map(normalizePwnCdRow)).map((e) => e.raw.tmSeq);

describe("orderPwnEvents", () => {
  it("발표 시각 → 발표번호 순", () => {
    const shuffled = [scenario[3]!, scenario[1]!, scenario[0]!, scenario[2]!];
    expect(seqs(shuffled)).toEqual(["39", "46", "52", "58"]);
  });

  it("같은 시각이면 발표번호 순", () => {
    const a = { ...scenario[0]!, tmSeq: "10" };
    const b = { ...scenario[0]!, tmSeq: "9", areaCode: "S1152020" };
    expect(seqs([a, b])).toEqual(["9", "10"]);
  });

  it("달이 바뀌어 tmSeq가 작아져도 시각이 먼저", () => {
    const august = data.cases.find((c) => c.id === "issue-future-start")!.row; // 8/31 tmSeq 452
    const september = data.cases.find((c) => c.id === "extend")!.row; // 9/9 tmSeq 64
    const octoberFirst = { ...scenario[0]!, tmFc: "202610010000", tmSeq: "1" };
    expect(seqs([octoberFirst, september, august])).toEqual(["452", "64", "1"]);
  });

  it("완전히 같은 이벤트는 하나로", () => {
    const events = orderPwnEvents(
      [scenario[0]!, { ...scenario[0]! }, scenario[1]!].map(normalizePwnCdRow),
    );
    expect(events.map((e) => e.raw.tmSeq)).toEqual(["39", "46"]);
    expect(events[0]!.unknownReasons).toEqual([]);
  });

  it("같은 이벤트인데 다른 값이 섞이면 하나로 두고 충돌 사유", () => {
    const a = scenario[0]!;
    const b = { ...a, warnStress: "1" };
    const forward = orderPwnEvents([a, b].map(normalizePwnCdRow));
    const backward = orderPwnEvents([b, a].map(normalizePwnCdRow));
    expect(forward).toHaveLength(1);
    expect(forward[0]!.unknownReasons).toEqual([
      "conflict:202610140000|39|S1152010|6|1",
    ]);
    expect(backward).toEqual(forward);
  });

  it("구역명만 다른 중복은 하나로, 충돌 아님 · 받은 순서와 상관없이 같은 행", () => {
    const dangjin = data.scenarios.find(
      (s) => s.id === "L1031200-2026-09-01-area-name",
    )!.rows;
    const forward = orderPwnEvents(dangjin.map(normalizePwnCdRow));
    const backward = orderPwnEvents(
      [...dangjin].reverse().map(normalizePwnCdRow),
    );
    expect(
      forward.map((e) => [e.raw.tmSeq, e.raw.warnVar, e.raw.command]),
    ).toEqual([
      ["7", "1", "1"],
      ["7", "2", "7"],
      ["9", "1", "2"],
      ["9", "2", "2"],
    ]);
    expect(forward.flatMap((e) => e.unknownReasons)).toEqual([]);
    expect(forward.map((e) => e.raw.areaName)).toEqual(Array(4).fill("당진군"));
    expect(backward).toEqual(forward);
  });

  it("구역명과 다른 값이 함께 다르면 충돌", () => {
    const a = scenario[0]!;
    const b = { ...a, areaName: "다른 이름", warnStress: "1" };
    const forward = orderPwnEvents([a, b].map(normalizePwnCdRow));
    const backward = orderPwnEvents([b, a].map(normalizePwnCdRow));
    expect(forward[0]!.unknownReasons).toEqual([
      "conflict:202610140000|39|S1152010|6|1",
    ]);
    expect(backward).toEqual(forward);
  });

  it("충돌 뒤에 같은 이벤트가 더 와도 충돌 사유 유지", () => {
    const a = scenario[0]!;
    const b = { ...a, warnStress: "1" };
    const c = { ...a, areaName: "가" }; // 비교가 가장 작아 남는 행
    for (const rows of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ]) {
      const events = orderPwnEvents(rows.map(normalizePwnCdRow));
      expect(events).toHaveLength(1);
      expect(events[0]!.raw.areaName).toBe("가");
      expect(events[0]!.unknownReasons).toEqual([
        "conflict:202610140000|39|S1152010|6|1",
      ]);
    }
  });

  it("시각을 못 읽은 이벤트는 뒤로", () => {
    const broken = { ...scenario[0]!, tmFc: "x", tmSeq: "1" };
    expect(seqs([broken, scenario[1]!])).toEqual(["46", "1"]);
  });

  it("입력 배열을 바꾸지 않음", () => {
    const input = [scenario[1]!, scenario[0]!].map(normalizePwnCdRow);
    const before = [...input];
    orderPwnEvents(input);
    expect(input).toEqual(before);
  });
});
