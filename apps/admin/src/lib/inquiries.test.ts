import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBeachNames } from "./beach-names";
import { kstDateTime, retentionDate, shortId } from "./inquiries";

// 운영자 문의 화면 도우미 (BRD-153)

describe("시각 표시", () => {
  it("UTC로 저장된 시각을 KST 월/일 시:분으로 보여 준다", () => {
    expect(kstDateTime("2026-11-02T04:12:00Z")).toBe("11/2 13:12");
    // UTC 날짜가 하루 앞서도 KST 날짜로
    expect(kstDateTime("2026-11-02T16:05:00Z")).toBe("11/3 01:05");
  });

  it("보관 기한은 받은 시각 + 90일의 KST 날짜", () => {
    expect(retentionDate("2026-11-02T04:12:00Z")).toBe("1/31");
  });

  it("접수 ID는 앞 4·뒤 2자로 줄인다", () => {
    expect(shortId("3f2a0000-0000-4000-8000-00000000009c")).toBe("3f2a…9c");
  });
});

describe("해변 이름표", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(dir, file), JSON.stringify(value));

  it("이름·지역·비노출 여부만 꺼낸다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    write("b0001.json", {
      id: "b0001",
      name: { ko: "강문해수욕장", en: "Gangmun" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "강릉시" } },
      hidden: false,
    });
    write("b0002.json", {
      id: "b0002",
      name: { ko: "숨은해변" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "양양군" } },
      hidden: true,
    });
    write("README.md", "x");
    expect(loadBeachNames(dir)).toEqual({
      b0001: { name: "강문해수욕장", region: "강원 강릉시", hidden: false },
      b0002: { name: "숨은해변", region: "강원 양양군", hidden: true },
    });
  });

  it("모양이 틀린 파일은 조용히 빼지 않고 멈춘다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    write("b0001.json", { id: "b0001", name: {} });
    expect(() => loadBeachNames(dir)).toThrow("b0001.json");
  });

  it("저장소의 실제 해변 데이터를 모두 읽는다", () => {
    const names = loadBeachNames(
      path.join(__dirname, "../../../../data/beaches"),
    );
    expect(Object.keys(names).length).toBeGreaterThan(100);
    expect(names.b0001?.name).toBe("강문해수욕장");
  });
});
