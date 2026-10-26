import { describe, expect, it } from "vitest";
import { kstDate, parseBeachMeta, seasonInfo } from "./season";

// 운영 기간 연결 (BRD-61 PR ②, 결정 기록 11장 운영 기간 데이터 확정(10/23))
// 올해 개장 일정이 온전할 때만 값, 그 밖은 null(배지 숨김). 날짜 비교는 한국 날짜

const meta = {
  _meta: { note: "시험" },
  beaches: {
    b0001: {
      aliases: ["강문"],
      season: {
        "2026": {
          status: "open",
          openDate: "2026-07-10",
          closeDate: "2026-08-23",
          sourceRow: 4,
          link: "EXACT",
        },
      },
    },
    // 미개장(올해 열지 않음): 날짜 없음
    b0014: {
      season: {
        "2026": {
          status: "closed",
          openDate: null,
          closeDate: null,
          sourceRow: 22,
          link: "EXACT",
        },
      },
    },
    // 미연결
    b0028: { season: { "2026": null } },
    // 운영 기간 칸 없음
    b0099: { aliases: [] },
    // 모양이 틀림: 달력에 없는 날짜
    b0100: {
      season: {
        "2026": { status: "open", openDate: "2026-02-30", closeDate: null },
      },
    },
    // 모양이 틀림: 모르는 상태
    b0101: {
      season: {
        "2026": { status: "maybe", openDate: null, closeDate: null },
      },
    },
  },
};

const { seasons, invalid } = parseBeachMeta(meta);

describe("parseBeachMeta", () => {
  it("모양이 틀린 해변만 빼고 invalid에 적음", () => {
    expect(invalid).toEqual(["b0100", "b0101"]);
    expect(Object.keys(seasons).sort()).toEqual(["b0001", "b0014", "b0028"]);
  });

  it("beaches 칸이 없으면 빈 표로 바꾸지 않고 던짐", () => {
    expect(() => parseBeachMeta({})).toThrow("beaches 칸이 없음");
    expect(() => parseBeachMeta({ beaches: [] })).toThrow(
      "beaches 칸이 없음",
    );
  });
});

describe("kstDate", () => {
  it("UTC 15:00은 한국 다음 날", () => {
    expect(kstDate("2026-07-09T14:59:59Z")).toBe("2026-07-09");
    expect(kstDate("2026-07-09T15:00:00Z")).toBe("2026-07-10");
  });
});

describe("seasonInfo", () => {
  it("개장 첫날은 한국 자정부터 기간 안", () => {
    expect(seasonInfo(seasons, "b0001", "2026-07-09T14:59:59Z")).toEqual({
      openFrom: "2026-07-10",
      openUntil: "2026-08-23",
      inSeason: false,
    });
    expect(seasonInfo(seasons, "b0001", "2026-07-09T15:00:00Z")).toMatchObject(
      { inSeason: true },
    );
  });

  it("폐장일 당일까지 기간 안, 다음 날 한국 자정부터 밖", () => {
    expect(seasonInfo(seasons, "b0001", "2026-08-23T14:59:59Z")).toMatchObject(
      { inSeason: true },
    );
    expect(seasonInfo(seasons, "b0001", "2026-08-23T15:00:00Z")).toMatchObject(
      { inSeason: false },
    );
  });

  it("다음 해에는 올해 일정이 없으므로 지난해 일정으로 추정하지 않음(null)", () => {
    // 2027-01-01 KST = 2026-12-31T15:00Z
    expect(seasonInfo(seasons, "b0001", "2026-12-31T15:00:00Z")).toBeNull();
    expect(seasonInfo(seasons, "b0001", "2026-12-31T14:59:59Z")).toMatchObject(
      { inSeason: false },
    );
  });

  it("미개장·미연결·칸 없음·모양 틀림·모르는 해변은 null(배지 숨김)", () => {
    for (const id of ["b0014", "b0028", "b0099", "b0100", "b0101", "b9999"]) {
      expect(seasonInfo(seasons, id, "2026-07-20T00:00:00Z"), id).toBeNull();
    }
  });

  it("시작일이 종료일보다 늦은 일정은 null", () => {
    const flipped = parseBeachMeta({
      beaches: {
        b0001: {
          season: {
            "2026": {
              status: "open",
              openDate: "2026-08-23",
              closeDate: "2026-07-10",
            },
          },
        },
      },
    }).seasons;
    expect(seasonInfo(flipped, "b0001", "2026-07-20T00:00:00Z")).toBeNull();
  });

  it("기준 시각이 UTC 형식이 아니면 던짐", () => {
    expect(() => seasonInfo(seasons, "b0001", "2026-07-20 09:00")).toThrow(
      "기준 시각 형식 오류",
    );
  });
});
