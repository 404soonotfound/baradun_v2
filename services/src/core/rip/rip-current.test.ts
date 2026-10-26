import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseRipResponse,
  readRipReadings,
  ripCurrentInfo,
  ripObservedAt,
} from "./rip-current";

// 이안류 지수 읽기·게시 규칙 (BRD-57). 실응답 픽스처(2026-08-15 송정, 줄 줄임)
// 실패 경로: 모르는 형식·문구·시각이 '정상' 정보로 보이지 않는지
const REAL = readFileSync(
  new URL("./fixtures/rip-songjung-20260815.json", import.meta.url),
  "utf8",
);
const AFTER = "2026-08-15T15:00:00Z"; // KST 08-16 00:00
const DAY = "20260815"; // 요청한 날(reqDate)
const body = (value: unknown) => JSON.stringify(value);
const row = (fields: Record<string, unknown> = {}) => ({
  obsvtrId: "SONGJUNG",
  obsrvnDt: "2026-08-15 12:00",
  lastScr: 30,
  lastScrCn: "주의",
  ...fields,
});
const response = (items: unknown, totalCount = 1, resultCode = "00") =>
  body({
    header: { resultCode, resultMsg: "NORMAL_SERVICE" },
    body: { items, pageNo: 1, numOfRows: 300, totalCount, type: "json" },
  });

describe("ripObservedAt", () => {
  it("KST로 추정해 UTC로 바꿈", () => {
    expect(ripObservedAt("2026-08-15 23:55")).toBe("2026-08-15T14:55:00Z");
  });

  it.each([
    "2026-08-15T23:55",
    "2026-08-15 23:55:00",
    "2026-02-30 10:00",
    "",
    null,
    20260815,
  ])("형식이 다르면 null: %s", (raw) => {
    expect(ripObservedAt(raw)).toBeNull();
  });
});

describe("parseRipResponse", () => {
  it("실응답: 가장 늦은 관측 하나(시각 UTC, 문구 원문)", () => {
    expect(parseRipResponse(REAL, "SONGJUNG", AFTER, DAY)).toEqual({
      status: "ok",
      latest: {
        code: "SONGJUNG",
        label: "관심",
        observedAt: "2026-08-15T14:55:00Z",
      },
      skippedRows: 0,
    });
  });

  it("미래 관측은 버리고 그 앞 관측을 씀", () => {
    // 기준 KST 08-15 12:00 → 23:55 줄은 미래
    expect(
      parseRipResponse(REAL, "SONGJUNG", "2026-08-15T03:00:00Z", DAY),
    ).toMatchObject({
      status: "ok",
      latest: { label: "주의", observedAt: "2026-08-14T15:00:00Z" },
      skippedRows: 1,
    });
  });

  it("요청한 날이 아닌 줄은 버림(다른 날 자료를 그날 자료로 보지 않음)", () => {
    const text = response(
      { item: [row(), row({ obsrvnDt: "2026-08-14 23:55" })] },
      2,
    );
    expect(parseRipResponse(text, "SONGJUNG", AFTER, DAY)).toMatchObject({
      status: "ok",
      latest: { observedAt: "2026-08-15T03:00:00Z" },
      skippedRows: 1,
    });
    expect(parseRipResponse(REAL, "SONGJUNG", AFTER, "20260816")).toEqual({
      status: "failed",
      reason: "no_rows:skipped=2",
    });
  });

  it("받은 줄 수가 totalCount보다 적으면 실패(한 쪽에 다 못 받아 마지막 관측이 빠졌을 수 있음)", () => {
    expect(
      parseRipResponse(
        response({ item: [row()] }, 2),
        "SONGJUNG",
        AFTER,
        "20260815",
      ),
    ).toEqual({ status: "failed", reason: "truncated:1/2" });
  });

  it.each([
    ["문자열", "287"],
    ["소수", 1.5],
  ])("totalCount가 정수가 아니면 형식 오류: %s", (_, totalCount) => {
    expect(
      parseRipResponse(
        response({ item: [row()] }, totalCount as never),
        "SONGJUNG",
        AFTER,
        "20260815",
      ),
    ).toEqual({ status: "failed", reason: "format:totalCount" });
  });

  it("item이 하나면 객체로 와도 읽음", () => {
    expect(
      parseRipResponse(response({ item: row() }), "SONGJUNG", AFTER, DAY),
    ).toMatchObject({ status: "ok", latest: { label: "주의" } });
  });

  it.each([
    ["JSON 아님", "<html>error</html>", "format:json"],
    [
      "XML식 response 감싸개(JSON 실응답 모양 아님)",
      body({ response: JSON.parse(REAL) }),
      "format:shape",
    ],
    ["200인데 빈 객체", "{}", "format:shape"],
    ["header만 있음", body({ header: { resultCode: "00" } }), "format:shape"],
    ["items 모양이 다름", response("x"), "format:items"],
    [
      "빈 목록인데 totalCount가 0이 아님",
      response({ item: [] }),
      "format:items",
    ],
    ["다른 오류 코드", response("", 0, "30"), "result:30"],
  ])("%s → 실패(자료 없음으로 보지 않음)", (_, text, reason) => {
    expect(parseRipResponse(text, "SONGJUNG", AFTER, DAY)).toEqual({
      status: "failed",
      reason,
    });
  });

  it("다른 해수욕장 코드·시각을 못 읽는 줄만 있으면 실패", () => {
    const text = response({
      item: [row({ obsvtrId: "HAE" }), row({ obsrvnDt: "08/15 12:00" })],
    });
    expect(parseRipResponse(text, "SONGJUNG", AFTER, DAY)).toEqual({
      status: "failed",
      reason: "no_rows:skipped=2",
    });
  });

  it.each([
    ["resultCode 03", response("", 0, "03")],
    ["00 + totalCount 0 + 빈 items", response("", 0)],
  ])("자료 없음: %s", (_, text) => {
    expect(parseRipResponse(text, "SONGJUNG", AFTER, DAY)).toEqual({
      status: "none",
    });
  });
});

describe("ripCurrentInfo", () => {
  const reading = (fields: Partial<Record<string, string>> = {}) => ({
    code: "SONGJUNG",
    label: "관심",
    observedAt: "2026-08-15T14:55:00Z",
    ...fields,
  });

  it("시즌 안 오늘 관측 → 문구 원문·관측 시각·기관", () => {
    expect(ripCurrentInfo(reading(), AFTER)).toEqual({
      info: {
        label: "관심",
        publishedAt: "2026-08-15T14:55:00Z",
        source: "국립해양조사원",
      },
      hidden: null,
    });
  });

  it("어제(KST) 관측까지 게시", () => {
    // KST 08-17 23:00, 관측 KST 08-16 00:00(어제)
    expect(
      ripCurrentInfo(
        reading({ observedAt: "2026-08-15T15:00:00Z" }),
        "2026-08-17T14:00:00Z",
      ).info,
    ).not.toBeNull();
  });

  it("그제(KST)보다 오래된 관측은 숨김", () => {
    expect(ripCurrentInfo(reading(), "2026-08-17T15:00:00Z").hidden).toBe(
      "old",
    );
  });

  it("제공 기간(6~9월) 밖 관측은 숨김: KST 10/01 00:00", () => {
    expect(
      ripCurrentInfo(
        reading({ observedAt: "2026-09-30T15:00:00Z" }),
        "2026-09-30T16:00:00Z",
      ).hidden,
    ).toBe("off_season");
  });

  it.each(["주의보", "", "보통", "WARNING"])(
    "4단계가 아닌 문구는 숨김: %s",
    (label) => {
      expect(ripCurrentInfo(reading({ label }), AFTER)).toEqual({
        info: null,
        hidden: "unknown_label",
      });
    },
  );

  it("오래된 관측은 문구가 틀려도 old로 숨김(비수기 내내 운영 알림을 내지 않음)", () => {
    expect(
      ripCurrentInfo(reading({ label: "점검중" }), "2026-10-23T03:00:00Z")
        .hidden,
    ).toBe("old");
  });

  it.each(["2026-08-15 14:55", "2026-08-16T00:00:00Z"])(
    "틀린 시각·미래 관측은 숨김: %s",
    (observedAt) => {
      expect(ripCurrentInfo(reading({ observedAt }), AFTER).hidden).toBe(
        "bad_time",
      );
    },
  );

  it("기록이 없으면 숨김", () => {
    expect(ripCurrentInfo(undefined, AFTER)).toEqual({
      info: null,
      hidden: "no_reading",
    });
  });
});

describe("readRipReadings", () => {
  it("모양이 틀린 해변은 그 해변만 버림", () => {
    expect(
      readRipReadings({
        beaches: {
          b0096: { code: "SONGJUNG", label: "관심", observedAt: AFTER },
          b0097: { code: "HAE", label: 3 },
        },
      }),
    ).toEqual({
      b0096: { code: "SONGJUNG", label: "관심", observedAt: AFTER },
    });
    expect(readRipReadings("broken")).toEqual({});
  });
});
