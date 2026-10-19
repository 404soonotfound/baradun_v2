import { describe, expect, it } from "vitest";
import data from "./fixtures/pwncd-events.json";

// T02 입력 파일이 망가지지 않았는지 지키는 검사. 특보 정규화(BRD-54)가 이 파일을 입력으로 써요.
const FIELDS = [
  "tmFc",
  "tmSeq",
  "areaCode",
  "areaName",
  "warnVar",
  "warnStress",
  "command",
  "cancel",
  "startTime",
  "endTime",
  "allEndTime",
];

const allRows = [
  ...data.cases.map((c) => c.row),
  ...data.scenarios.flatMap((s) => s.rows),
];

describe("특보 이력 픽스처 (BRD-16)", () => {
  it("모든 행이 getPwnCd 원본 11개 항목을 문자열로 가진다", () => {
    expect(data.fields).toEqual(FIELDS);
    for (const row of allRows) {
      expect(Object.keys(row)).toEqual(FIELDS);
      for (const value of Object.values(row)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  it("id가 겹치지 않는다", () => {
    const ids = data.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("실데이터는 수신된 종류(발표 1·해제 2·연장 3·변경발표 7, 취소 없음)만 담는다", () => {
    const real = data.cases.filter((c) => c.source !== "synthetic");
    for (const c of real) {
      expect(["1", "2", "3", "7"]).toContain(c.row.command);
      expect(c.row.cancel).toBe("0");
    }
  });

  it("실데이터에 없던 종류(정정 6·변경해제 8·취소·처음 보는 코드)는 synthetic으로 표시한다", () => {
    const synthetic = data.cases
      .filter((c) => c.source === "synthetic")
      .map((c) => c.id);
    expect(synthetic).toEqual([
      "correction",
      "change-release",
      "cancelled",
      "unknown-area-S2",
      "unknown-warnVar",
    ]);
  });
});
