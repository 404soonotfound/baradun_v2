import { describe, expect, it } from "vitest";
import { checkPhoto, sameImage } from "./photo-check";

// 대표 사진 공공누리 유형 다시 확인 (BRD-58). 응답 모양은 2026-10-23 실호출(detailCommon2·detailImage2) 기준
// 1유형만 허용, 사진을 못 찾으면 missing, 비정상 응답은 failed(확인 결과로 치지 않음)

const URL =
  "https://tong.visitkorea.or.kr/cms/resource/52/4120552_image2_1.jpg";
const ok = (item: unknown) => ({
  response: {
    header: { resultCode: "0000", resultMsg: "OK" },
    body: { items: { item } },
  },
});

describe("checkPhoto · 대표 이미지(detailCommon2)", () => {
  it("대표 이미지가 같고 Type1 → type1 (http 주소여도 같은 사진)", () => {
    const json = ok([
      {
        contentid: "585522",
        firstimage: URL.replace("https", "http"),
        cpyrhtDivCd: "Type1",
      },
    ]);
    expect(checkPhoto(json, "first", URL, "585522")).toEqual({
      status: "type1",
    });
  });

  it("유형이 Type3이거나 비어 있으면 not_type1", () => {
    for (const cpyrhtDivCd of ["Type3", "", undefined]) {
      const json = ok([{ contentid: "585522", firstimage: URL, cpyrhtDivCd }]);
      expect(checkPhoto(json, "first", URL, "585522")).toEqual({
        status: "not_type1",
      });
    }
  });

  it("대표 이미지가 바뀌었거나 관광지가 없어졌으면 missing", () => {
    const other = ok([
      {
        contentid: "585522",
        firstimage: "https://x/other.jpg",
        cpyrhtDivCd: "Type1",
      },
    ]);
    expect(checkPhoto(other, "first", URL, "585522")).toEqual({
      status: "missing",
    });
    const empty = {
      response: {
        header: { resultCode: "0000" },
        body: { items: "", totalCount: 0 },
      },
    };
    expect(checkPhoto(empty, "first", URL, "585522")).toEqual({
      status: "missing",
    });
  });

  it("정상 코드가 아니거나 모양이 다르면 failed (사진을 지우는 근거로 쓰지 않음)", () => {
    expect(
      checkPhoto(
        { response: { header: { resultCode: "22" } } },
        "first",
        URL,
        "1",
      ),
    ).toEqual({ status: "failed", reason: "resultCode:22" });
    expect(checkPhoto("<xml/>", "first", URL, "1")).toEqual({
      status: "failed",
      reason: "format:header",
    });
    expect(checkPhoto(ok(["x"]), "first", URL, "1")).toEqual({
      status: "failed",
      reason: "format:items",
    });
    // 행이 있는데 요청한 contentid가 없으면 형식 이상(필드가 바뀐 응답일 수 있음) → missing으로 확정하지 않음
    const mismatch = ok([{ firstimage: URL, cpyrhtDivCd: "Type1" }]);
    expect(checkPhoto(mismatch, "first", URL, "585522")).toEqual({
      status: "failed",
      reason: "format:contentid",
    });
    // 목록 자리가 빈 글자가 아닌 다른 모양이면 0건(missing)으로 읽지 않음
    for (const body of [{}, { items: {} }, { items: null }]) {
      expect(
        checkPhoto(
          { response: { header: { resultCode: "0000" }, body } },
          "first",
          URL,
          "1",
        ),
      ).toEqual({ status: "failed", reason: "format:items" });
    }
  });
});

describe("checkPhoto · 상세 이미지 목록(detailImage2)", () => {
  it("목록에서 같은 주소를 찾아 그 사진의 유형을 봄", () => {
    const json = ok([
      { originimgurl: "https://x/a.jpg", cpyrhtDivCd: "Type1" },
      { originimgurl: URL, cpyrhtDivCd: "Type3" },
    ]);
    expect(checkPhoto(json, "detail", URL, "1")).toEqual({
      status: "not_type1",
    });
    expect(checkPhoto(json, "detail", "https://x/a.jpg", "1")).toEqual({
      status: "type1",
    });
    expect(checkPhoto(json, "detail", "https://x/none.jpg", "1")).toEqual({
      status: "missing",
    });
  });

  it("목록이 잘렸고(전체 수 > 받은 수) 못 찾으면 failed (missing으로 확정하지 않음)", () => {
    const json = {
      response: {
        header: { resultCode: "0000" },
        body: {
          items: { item: [{ originimgurl: "https://x/a.jpg" }] },
          totalCount: 150,
        },
      },
    };
    expect(checkPhoto(json, "detail", URL, "1")).toEqual({
      status: "failed",
      reason: "truncated:1/150",
    });
  });
});

describe("sameImage", () => {
  it("빈 값·글자가 아닌 값은 같은 사진이 아님", () => {
    expect(sameImage("", "")).toBe(false);
    expect(sameImage(null, URL)).toBe(false);
  });
});
