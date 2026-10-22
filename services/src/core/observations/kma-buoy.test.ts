import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKmaBuoy } from "./kma-buoy";

// kma_buoy 읽기 (BRD-19 부품 2)
// 픽스처: 2026-10-21 00:00 KST 실응답(authKey 없는 원문)에서 5줄을 그대로 옮김
// 출처 파일 ~/data/baradun-coverage/responses/kma_buoy-attempt-1.txt (저장소 밖)
const fixture = readFileSync(
  new URL("./fixtures/kma-buoy-2026102100.txt", import.meta.url),
  "utf8",
);

describe("parseKmaBuoy", () => {
  it("파주기·파향을 읽고 시각은 UTC로 바꿈", () => {
    expect(parseKmaBuoy(fixture)).toEqual({
      status: "ok",
      skippedRows: 0,
      rows: [
        // 전 항목 결측 → 줄은 남기고 값만 null
        {
          stationId: "22489",
          observedAt: "2026-10-20T14:10:00Z",
          wavePeriod: null,
          waveDirection: null,
        },
        // 같은 측정기의 다른 시각도 모두 돌려줌(최신 고르기는 부르는 쪽)
        {
          stationId: "22523",
          observedAt: "2026-10-20T14:10:00Z",
          wavePeriod: 9.4,
          waveDirection: 117,
        },
        // 평균 파고(-99.0)가 결측이어도 파주기·파향은 읽음
        {
          stationId: "22188",
          observedAt: "2026-10-20T14:30:00Z",
          wavePeriod: 5,
          waveDirection: 202,
        },
        {
          stationId: "22523",
          observedAt: "2026-10-20T15:00:00Z",
          wavePeriod: 8.2,
          waveDirection: 81,
        },
        {
          stationId: "22524",
          observedAt: "2026-10-20T15:00:00Z",
          wavePeriod: 6,
          waveDirection: 257,
        },
      ],
    });
  });

  it("끝 표시가 없으면 실패(잘린 응답)", () => {
    const cut = fixture.replace("#7777END", "");
    expect(parseKmaBuoy(cut)).toEqual({
      status: "failed",
      reason: "끝 표시 없음(잘린 응답)",
    });
  });

  it.each(["", "<html>error</html>"])("시작 표시가 없으면 실패: %j", (text) => {
    expect(parseKmaBuoy(text)).toEqual({
      status: "failed",
      reason: "시작 표시 없음",
    });
  });

  it.each([
    ["칸 하나 빠짐", "  6.0 257", "  6.0"],
    ["칸 하나 더 있음", "  6.0 257", "  6.0 257 0"],
  ])("줄 모양이 다르면 그 줄만 건너뛰고 셈: %s", (_name, from, to) => {
    const result = parseKmaBuoy(fixture.replace(from, to));
    expect(result.status === "ok" && result.skippedRows).toBe(1);
    expect(result.status === "ok" && result.rows.length).toBe(4);
  });

  it("시각을 읽지 못한 줄은 건너뛰고 셈", () => {
    const badTime = fixture.replace("202610210000 22524", "202613010000 22524");
    const result = parseKmaBuoy(badTime);
    expect(result.status === "ok" && result.skippedRows).toBe(1);
    expect(
      result.status === "ok" && result.rows.map((row) => row.stationId),
    ).toEqual(["22489", "22523", "22188", "22523"]);
  });

  it("자료 줄이 없으면 실패(빈 결과를 정상으로 남기지 않음)", () => {
    const empty = fixture
      .split("\n")
      .filter((line) => !/^\d/.test(line))
      .join("\n");
    expect(parseKmaBuoy(empty)).toEqual({
      status: "failed",
      reason: "자료 줄 없음",
    });
  });

  it("칸 이름이 바뀌면 칸 수가 같아도 응답 전체 실패", () => {
    // 칸 수는 그대로 두고 파주기(WP)와 파향(WO) 자리만 바뀐 경우
    const swapped = fixture.replace("  WP  WO", "  WO  WP");
    expect(parseKmaBuoy(swapped)).toEqual({
      status: "failed",
      reason: "칸 이름이 다름",
    });
  });

  it("모든 줄이 빠지면 실패(빈 결과를 정상으로 남기지 않음)", () => {
    const allBad = fixture.replace(/^(\d{12}) /gm, "$1 0 ");
    expect(parseKmaBuoy(allBad)).toEqual({
      status: "failed",
      reason: "쓸 수 있는 줄 없음",
    });
  });
});
