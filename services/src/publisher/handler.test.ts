import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBeaches } from "./handler";
import { contractErrors } from "./validate";

// publisher 진입점의 해변 파일 읽기 (BRD-61 PR ②)
// Lambda에서는 묶을 때 복사한 beaches/ 폴더를 읽음. 시험은 저장소 data/beaches를 그대로 씀

const beachesDir = fileURLToPath(
  new URL("../../../data/beaches/", import.meta.url),
);

describe("loadBeaches", () => {
  it("b0000.json 모양 파일만 id 순서로 읽고, 계약(BeachesFile)을 통과함", () => {
    const beaches = loadBeaches(beachesDir);
    expect(beaches.length).toBeGreaterThan(0);
    expect(beaches.map((b) => b.id)).toEqual(
      [...beaches.map((b) => b.id)].sort(),
    );
    expect(contractErrors("BeachesFile", { beaches })).toEqual([]);
  });

  it("README 같은 다른 파일은 읽지 않음", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    writeFileSync(path.join(dir, "README.md"), "# x");
    writeFileSync(path.join(dir, "b0001.json"), '{"id":"b0001"}');
    expect(loadBeaches(dir)).toEqual([{ id: "b0001" }]);
  });

  it("해변 파일이 하나도 없으면 빈 목록으로 게시하지 않고 던짐", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    writeFileSync(path.join(dir, "README.md"), "# x");
    expect(() => loadBeaches(dir)).toThrow("해변 파일 없음");
  });
});
