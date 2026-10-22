import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_CHARS, packItems, unpackItems } from "./archive";

// 특보 원본 행 압축 저장 (10/22 사용자 결정, BRD-56)
describe("packItems·unpackItems", () => {
  it("원본 행을 그대로 되살림(숫자·글자 칸 섞임 유지)", () => {
    const items = [
      { tmFc: 202610221200, areaCode: "S1311100", command: "1" },
      { tmFc: 202610221215, areaCode: "L1082500", command: "3" },
    ];
    const packed = packItems(items);
    expect(packed.status).toBe("ok");
    if (packed.status !== "ok") return;
    expect(unpackItems(packed.archive)).toEqual({ status: "ok", items });
  });

  it("빈 목록도 저장·복원(지진해일 발표 없음 확인)", () => {
    const packed = packItems([]);
    expect(packed.status === "ok" && unpackItems(packed.archive)).toEqual({
      status: "ok",
      items: [],
    });
  });

  it("상한을 넘으면 저장하지 않고 실패", () => {
    // 압축이 거의 안 되는 무작위 글자
    const items = [randomBytes(MAX_ARCHIVE_CHARS).toString("hex")];
    expect(packItems(items)).toMatchObject({ status: "failed" });
  });

  it.each([
    ["깨진 글자", "not-base64-gzip"],
    ["배열이 아님", gzipSync(Buffer.from('{"a":1}')).toString("base64")],
  ])("복원 실패는 빈 목록이 아니라 실패: %s", (_name, archive) => {
    expect(unpackItems(archive).status).toBe("failed");
  });
});
