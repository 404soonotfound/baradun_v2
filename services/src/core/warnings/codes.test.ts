import { describe, expect, it } from "vitest";
import {
  JUDGED_TYPES,
  NEARBY_TYPES,
  pwnAction,
  warningKind,
  warningLevel,
} from "./codes";
import data from "./fixtures/pwncd-events.json";

// 코드표 검사 (BRD-54 3단계). 기준: 기상특보 조회서비스 활용가이드 getPwnCd 응답 명세

describe("코드표", () => {
  it("지진해일은 getPwnCd 표에 없음 (getTsunamiMsg에서 받음)", () => {
    expect(Object.values(JUDGED_TYPES)).not.toContain("tsunami");
  });
  it("판단 표와 주변 표의 코드가 겹치지 않음", () => {
    for (const code of Object.keys(JUDGED_TYPES)) {
      expect(Object.keys(NEARBY_TYPES)).not.toContain(code);
    }
  });
});

describe("특보 종류 warningKind", () => {
  it.each([
    ["1", "strong_wind"],
    ["5", "storm_surge"],
    ["6", "wind_wave"],
    ["7", "typhoon"],
  ])("판단: %s → %s", (code, type) => {
    expect(warningKind(code)).toEqual({ group: "judged", type });
  });
  it.each([
    ["2", "heavy_rain"],
    ["3", "cold_wave"],
    ["4", "dry"],
    ["8", "heavy_snow"],
    ["9", "yellow_dust"],
    ["12", "heat_wave"],
    ["13", "tropical_night"],
  ])("주변: %s → %s", (code, type) => {
    expect(warningKind(code)).toEqual({ group: "nearby", type });
  });
  it("모르는 코드는 버리지 않고 원래 값을 보관", () => {
    expect(warningKind("99")).toEqual({ group: "unknown", raw: "99" });
  });
  it("물려받은 이름(toString)과 빈 값도 모르는 코드", () => {
    expect(warningKind("toString").group).toBe("unknown");
    expect(warningKind("").group).toBe("unknown");
  });
});

describe("특보 단계 warningLevel", () => {
  it.each([
    ["0", "advisory"],
    ["1", "warning"],
    ["2", "severe_warning"],
  ])("%s → %s", (code, level) => {
    expect(warningLevel(code)).toBe(level);
  });
  it("모르는 강도는 null", () => {
    expect(warningLevel("3")).toBeNull();
  });
});

describe("발표코드 pwnAction", () => {
  it.each([
    ["1", "issue"],
    ["2", "release"],
    ["3", "extend"],
    ["6", "correct"],
    ["7", "change_issue"],
    ["8", "change_release"],
  ])("%s → %s", (code, action) => {
    expect(pwnAction(code)).toBe(action);
  });
  it("명세에 없는 코드(4·5·9)는 null", () => {
    for (const code of ["4", "5", "9"]) {
      expect(pwnAction(code)).toBeNull();
    }
  });
});

describe("BRD-16 픽스처와 대조", () => {
  it("실데이터 행의 종류·단계·발표코드는 모두 표에 있음", () => {
    const real = data.cases.filter((c) => c.source !== "synthetic");
    for (const { row } of real) {
      expect(warningKind(row.warnVar).group).not.toBe("unknown");
      expect(warningLevel(row.warnStress)).not.toBeNull();
      expect(pwnAction(row.command)).not.toBeNull();
    }
  });
  it("합성 행 unknown-warnVar는 모르는 코드", () => {
    const c = data.cases.find((c) => c.id === "unknown-warnVar");
    expect(c && warningKind(c.row.warnVar).group).toBe("unknown");
  });
});
