import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBeaches } from "../core/beaches/load";
import { parseManualEvent } from "./handler";
import { beachIdProblem } from "./publish";
import { parseBeachMeta } from "./season";
import { contractErrors } from "./validate";

// publisher 진입점의 해변 파일 읽기 (BRD-61 PR ②)
// Lambda에서는 묶을 때 복사한 beaches/ 폴더를 읽음. 시험은 저장소 data/beaches를 그대로 씀

const beachesDir = fileURLToPath(
  new URL("../../../data/beaches/", import.meta.url),
);

// 게시 전 해변 ID 대조(D16-C1)의 두 입력: 묶을 때 폴더째 복사한 해변 파일과 JSON으로 묶인 beach-meta.json
// 저장소에서 둘이 어긋나면 배포 뒤 모든 게시가 멈추므로(앞 게시본 유지) 여기서 먼저 잡음
describe("저장소 원본 해변 ID 목록", () => {
  it("data/beach-meta.json의 해변 칸과 data/beaches 파일의 id가 집합으로 같다", () => {
    const meta = JSON.parse(
      readFileSync(
        new URL("../../../data/beach-meta.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    expect(
      beachIdProblem(
        parseBeachMeta(meta).beachIds,
        loadBeaches(beachesDir).map((beach) => beach.id),
      ),
    ).toBeNull();
  });
});

// 사람이 직접 부르는 이벤트(되돌리기·다시 내보내기, 결정 기록 D20-1~4)
describe("parseManualEvent", () => {
  const version = "20261017T053000Z";

  it("action이 없는 이벤트(수집기가 깨운 실행)는 자동 게시", () => {
    expect(parseManualEvent(undefined)).toBeNull();
    expect(parseManualEvent({})).toBeNull();
    expect(parseManualEvent({ version })).toBeNull();
  });

  it("되돌리기·다시 내보내기를 버전과 함께 받는다", () => {
    expect(parseManualEvent({ action: "rollback", version })).toEqual({
      action: "rollback",
      version,
    });
    expect(parseManualEvent({ action: "republish", version })).toEqual({
      action: "republish",
      version,
    });
  });

  it.each([
    ["오타 난 action", { action: "rolback", version }],
    ["action이 글자가 아님", { action: 1, version }],
    ["버전 없음", { action: "rollback" }],
    ["버전 형식 다름", { action: "rollback", version: "2026-10-17" }],
    [
      "버전 뒤에 글자가 더 붙음",
      { action: "republish", version: `${version}x` },
    ],
  ])("%s이면 보통 게시로 돌리지 않고 던진다", (_name, event) => {
    expect(() => parseManualEvent(event)).toThrow();
  });
});

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
