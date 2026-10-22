import { describe, expect, it } from "vitest";
import data from "./fixtures/tsunami-msgs.json";
import { normalizeTsunamiItem, normalizeTsunamiResponse } from "./tsunami";

// getTsunamiMsg 정규화 검사 (BRD-54 6단계). 입력: 합성 픽스처 tsunami-msgs.json

const fixture = (id: string) => {
  const found = data.responses.find((r) => r.id === id);
  if (!found) throw new Error(`픽스처 없음: ${id}`);
  return found.response;
};

const tsunami = { group: "judged", type: "tsunami" };
const ROWS = 100; // 요청 numOfRows. 픽스처 행 수보다 큼

describe("픽스처", () => {
  it("실데이터가 없어 모두 synthetic", () => {
    for (const r of data.responses) expect(r.source).toBe("synthetic");
  });
});

describe("normalizeTsunamiResponse", () => {
  it("00 · 목록 네 행 정규화 (숫자·문자열 값 모두)", () => {
    const result = normalizeTsunamiResponse(fixture("list-00"), ROWS);
    if (result.status !== "ok") throw new Error(result.status);
    const [warning, advisory, release, unknown] = result.events;

    // 활용가이드 예제: 2008-11-25 13:13 KST 경보 발표
    expect(warning).toMatchObject({
      source: "getTsunamiMsg",
      agency: "기상청",
      stationId: "108",
      publishedAt: "2008-11-25T04:13:00Z",
      seq: null,
      action: "issue",
      kind: tsunami,
      level: "warning",
      zone: { kind: "text", raw: "남해안, 동해안" },
      effectiveFrom: "2008-11-25T04:13:00Z",
      announcement: "지진해일 경보 발표",
      remark: "해안가 주민은 높은 곳으로 대피",
      unknownReasons: [],
    });
    // 진앙 정보는 해석하지 않고 원문 보관
    expect(warning?.raw).toMatchObject({ loc: "일본 홋카이도 남동쪽 해역" });

    expect(advisory).toMatchObject({
      stationId: "108",
      publishedAt: "2008-11-25T03:00:00Z",
      action: "issue",
      level: "advisory",
      zone: { kind: "text", raw: "동해안" },
      effectiveFrom: "2008-11-25T03:10:00Z",
      unknownReasons: [],
    });

    expect(release).toMatchObject({
      publishedAt: "2008-11-25T09:00:00Z",
      action: "release",
      level: null,
      effectiveFrom: "2008-11-25T09:00:00Z",
      unknownReasons: [],
    });

    expect(unknown).toMatchObject({
      action: null,
      level: null,
      kind: tsunami,
      unknownReasons: ["fcTp:9"],
    });
  });

  it('행이 한 개(객체)여도 목록으로 받음, resultCode "0"도 정상', () => {
    const result = normalizeTsunamiResponse(
      fixture("single-item-object"),
      ROWS,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        action: "issue",
        level: "warning",
      });
    }
  });

  it("03 NO_DATA → 지진해일 발표 없음 확인", () => {
    expect(normalizeTsunamiResponse(fixture("no-data-03"), ROWS)).toEqual({
      status: "none",
    });
  });

  it("99 → 조회 실패 (없음으로 읽지 않음)", () => {
    expect(normalizeTsunamiResponse(fixture("error-99"), ROWS)).toEqual({
      status: "failed",
      reason: "resultCode:99",
    });
  });

  it.each([
    [null, "format:header"],
    ["<OpenAPI_ServiceResponse>", "format:header"],
    [{ response: {} }, "format:header"],
    [{ response: { header: {} } }, "resultCode:"],
    [{ response: { header: { resultCode: 3 } } }, "resultCode:3"],
    [{ response: { header: { resultCode: "00" } } }, "format:items"],
    [
      { response: { header: { resultCode: "00" }, body: { items: "" } } },
      "format:items",
    ],
    [
      {
        response: {
          header: { resultCode: "00" },
          body: { items: { item: ["x"] } },
        },
      },
      "format:items",
    ],
  ])("형식 오류 %j → 조회 실패", (json, reason) => {
    expect(normalizeTsunamiResponse(json, ROWS)).toEqual({
      status: "failed",
      reason,
    });
  });
});

describe("normalizeTsunamiResponse 잘림", () => {
  it("받은 행 수 = 요청 numOfRows → 잘렸을 수 있어 조회 실패", () => {
    expect(normalizeTsunamiResponse(fixture("list-00"), 4)).toEqual({
      status: "failed",
      reason: "truncated:4",
    });
  });

  it("요청 numOfRows가 잘못되면 멈춤", () => {
    expect(() => normalizeTsunamiResponse(fixture("list-00"), 0)).toThrow(
      RangeError,
    );
  });
});

describe("normalizeTsunamiItem", () => {
  it("시각·지역이 없거나 잘못되면 null + 사유", () => {
    const event = normalizeTsunamiItem({
      tmFc: 200813251313,
      fcTp: 1,
      reg: " ",
    });
    expect(event).toMatchObject({
      stationId: null,
      publishedAt: null,
      effectiveFrom: null,
      announcement: null,
      remark: null,
    });
    expect(event.unknownReasons).toEqual([
      "tmFc:200813251313",
      "tmEf:",
      "reg: ",
    ]);
  });
});
