import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSeaObs } from "./sea-obs";

// sea_obs 읽기 (BRD-19 부품 1)
// 픽스처: 2026-10-21 00:00 KST 실응답(authKey 없는 원문)에서 측정기 7곳을 그대로 옮김
// 출처 파일 ~/data/baradun-coverage/responses/sea_obs-attempt-1.txt (저장소 밖)
const fixture = readFileSync(
  new URL("./fixtures/sea-obs-2026102100.txt", import.meta.url),
  "utf8",
);

describe("parseSeaObs", () => {
  it("부이(B)·파고부이(C)만 읽고 시각은 UTC로 바꿈", () => {
    expect(parseSeaObs(fixture)).toEqual({
      status: "ok",
      skippedRows: 0,
      rows: [
        // 정시가 아닌 관측(23:30)도 그대로 → 신선도는 관측 시각으로 판단
        {
          stationId: "22103",
          observedAt: "2026-10-20T14:30:00Z",
          waveHeight: 0.8,
          wind: 6.3,
          waterTemp: 21.6,
        },
        // 공식 14칸 뒤 숫자 묶음은 읽지 않음
        {
          stationId: "22188",
          observedAt: "2026-10-20T15:00:00Z",
          waveHeight: 0.6,
          wind: 4.9,
          waterTemp: 22.6,
        },
        // 전 항목 결측 → 줄은 남기고 값만 null
        {
          stationId: "22489",
          observedAt: "2026-10-20T15:00:00Z",
          waveHeight: null,
          wind: null,
          waterTemp: null,
        },
        {
          stationId: "22520",
          observedAt: "2026-10-20T15:00:00Z",
          waveHeight: 0.7,
          wind: 3.6,
          waterTemp: 19.3,
        },
        // 파고부이는 바람이 없음(-99.0)
        {
          stationId: "22451",
          observedAt: "2026-10-20T15:00:00Z",
          waveHeight: 0.6,
          wind: null,
          waterTemp: 19.7,
        },
        // 조위관측소(N)·표류부이(D)는 빠짐
      ],
    });
  });

  it("끝 표시가 없으면 실패(잘린 응답)", () => {
    const cut = fixture.replace("#7777END", "");
    expect(parseSeaObs(cut)).toEqual({
      status: "failed",
      reason: "끝 표시 없음(잘린 응답)",
    });
  });

  it.each(["", "<html>error</html>"])("시작 표시가 없으면 실패: %j", (text) => {
    expect(parseSeaObs(text)).toEqual({
      status: "failed",
      reason: "시작 표시 없음",
    });
  });

  it.each([
    ["칸 하나 빠짐", "B, 202610210000,    22520,", "B, 202610210000"],
    [
      "칸 하나 더 있음",
      "B, 202610210000,    22520,",
      "B, 202610210000, 0,    22520,",
    ],
    ["끝 표시 없음", "76.0, ,=", "76.0, , "],
  ])("줄 모양이 다르면 응답 전체 실패: %s", (_name, from, to) => {
    expect(parseSeaObs(fixture.replace(from, to)).status).toBe("failed");
  });

  it("시각을 읽지 못한 줄은 건너뛰고 셈", () => {
    const badTime = fixture.replace(
      "B, 202610210000,    22520,",
      "B, 202613010000,    22520,",
    );
    const result = parseSeaObs(badTime);
    expect(result.status === "ok" && result.skippedRows).toBe(1);
    expect(
      result.status === "ok" && result.rows.map((row) => row.stationId),
    ).toEqual(["22103", "22188", "22489", "22451"]);
  });
});
