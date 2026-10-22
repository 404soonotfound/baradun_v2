import { describe, expect, it } from "vitest";
import data from "./fixtures/pwncd-response.json";
import { normalizePwnCdResponse } from "./pwncd-response";
import { applyZoneStates } from "./zone-state";

// getPwnCd 응답 전체 판정 검사 (BRD-18, 아키텍처 4장 10/22 실응답 확인)

const fixture = (id: string): unknown => {
  const found = data.responses.find((r) => r.id === id);
  if (!found) throw new Error(`픽스처 없음: ${id}`);
  return structuredClone(found.response); // 테스트가 고쳐도 원본은 그대로
};

const ROWS = 10_000; // 수집기 요청 numOfRows(결정 기록 10/22 ⑥)

// 실응답 ok에서 첫 행을 바꿔 쓰는 합성 응답
const withFirstItem = (change: (item: Record<string, unknown>) => void) => {
  const json = fixture("ok-3rows") as {
    response: { body: { items: { item: Record<string, unknown>[] } } };
  };
  change(json.response.body.items.item[0]!);
  return json;
};

describe("정상", () => {
  it("실응답 3행: 숫자 칸을 글자로 바꿔 정규화", () => {
    const result = normalizePwnCdResponse(fixture("ok-3rows"), ROWS);
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.rowCount).toBe(3);
    const first = result.events[0]!;
    expect(first.raw).toEqual({
      tmFc: "202610221100",
      tmSeq: "134",
      areaCode: "S1323400",
      areaName: "제주도서부앞바다",
      warnVar: "6",
      warnStress: "0",
      command: "2",
      cancel: "0",
      startTime: "0",
      endTime: "202610221200",
      allEndTime: "0",
      stnId: "108",
    });
    expect(first).toMatchObject({
      publishedAt: "2026-10-22T02:00:00Z",
      seq: 134,
      action: "release",
      kind: { group: "judged", type: "wind_wave" },
      effectiveFrom: "2026-10-22T03:00:00Z",
      unknownReasons: [],
    });
  });

  it("행이 하나면 객체로 와도 받음", () => {
    const json = fixture("ok-3rows") as {
      response: { body: { items: { item: unknown } } };
    };
    const items = json.response.body.items;
    items.item = (items.item as unknown[])[0];
    const result = normalizePwnCdResponse(json, ROWS);
    expect(result.status === "ok" && result.rowCount).toBe(1);
  });

  it("stnId가 없어도 받음", () => {
    const json = withFirstItem((item) => delete item.stnId);
    const result = normalizePwnCdResponse(json, ROWS);
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.events[0]!.stationId).toBeNull();
  });
});

describe("실패", () => {
  it.each([
    ["no-data-reversed", "resultCode:03"], // 03은 '특보 없음'이 아님
    ["too-old", "resultCode:99"],
  ])("실응답 %s → %s", (id, reason) => {
    expect(normalizePwnCdResponse(fixture(id), ROWS)).toEqual({
      status: "failed",
      reason,
    });
  });

  it("요청한 만큼 꽉 참 → 잘렸을 수 있음", () => {
    expect(normalizePwnCdResponse(fixture("ok-3rows"), 3)).toEqual({
      status: "failed",
      reason: "truncated:3",
    });
  });

  it.each([
    [null, "format:header"],
    [{ response: {} }, "format:header"],
    [{ response: { header: { resultCode: "00" } } }, "format:items"],
    [{ response: { header: { resultCode: 0 } } }, "resultCode:0"],
  ])("응답 모양 오류: %j", (json, reason) => {
    expect(normalizePwnCdResponse(json, ROWS)).toEqual({
      status: "failed",
      reason,
    });
  });

  it.each([
    ["tmFc", 202610221100.5], // 소수
    ["tmSeq", -1], // 음수
    ["areaCode", { code: "S1323400" }], // 객체
    ["stnId", 108.1],
    ["areaName", undefined], // 칸 없음
  ])("칸 형식 오류: %s = %j", (field, value) => {
    const json = withFirstItem((item) => {
      if (value === undefined) delete item[field];
      else item[field] = value;
    });
    expect(normalizePwnCdResponse(json, ROWS)).toEqual({
      status: "failed",
      reason: `format:item[0].${field}`,
    });
  });

  it("행이 객체가 아님", () => {
    const json = fixture("ok-3rows") as {
      response: { body: { items: { item: unknown[] } } };
    };
    json.response.body.items.item[1] = "row";
    expect(normalizePwnCdResponse(json, ROWS)).toEqual({
      status: "failed",
      reason: "format:item[1]",
    });
  });

  it("numOfRows가 잘못되면 멈춤", () => {
    expect(() => normalizePwnCdResponse(fixture("ok-3rows"), 0)).toThrow(
      RangeError,
    );
  });
});

describe("조회 범위 앞쪽 경계", () => {
  // 발표는 59일 범위 밖이고 해제만 범위 안에 있는 경우. 실응답 첫 행(제주도서부앞바다 풍랑 해제, 12:00 KST 발효)
  const releaseOnly = () => {
    const result = normalizePwnCdResponse(fixture("ok-3rows"), ROWS);
    if (result.status !== "ok") throw new Error(result.reason);
    return [result.events[0]!];
  };

  it("해제 발효 뒤 → 해제(발효 중 아님)", () => {
    const [state] = applyZoneStates(releaseOnly(), "2026-10-22T03:00:00Z");
    expect(state!.status).toEqual({
      state: "cleared",
      at: "2026-10-22T03:00:00Z",
    });
  });

  it("해제 발효 전 → 발효 중인지 모름(unknown), 활성으로 읽지 않음", () => {
    const [state] = applyZoneStates(releaseOnly(), "2026-10-22T02:30:00Z");
    expect(state!.status).toEqual({
      state: "unknown",
      reasons: ["release_without_issue"],
    });
  });
});
