import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBeachNames } from "./beach-names";
import {
  kstDateTime,
  linesNormalized,
  redactionOf,
  retentionDate,
  shortId,
} from "./inquiries";

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

  it("해변 관리 정적 페이지와 같은 규칙: b+숫자 4자리 파일만 읽고, 파일 이름과 ID가 다르면 멈춘다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    const beach = (id: string) => ({
      id,
      name: { ko: "강문해수욕장" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "강릉시" } },
    });
    write("b0001.json", beach("b0001"));
    write("b10000.json", beach("b10000"));
    expect(Object.keys(loadBeachNames(dir))).toEqual(["b0001"]);
    write("b0005.json", beach("b0500"));
    expect(() => loadBeachNames(dir)).toThrow("b0005.json");
  });

  it("저장소의 실제 해변 데이터를 모두 읽는다", () => {
    const names = loadBeachNames(
      path.join(__dirname, "../../../../data/beaches"),
    );
    expect(Object.keys(names).length).toBeGreaterThan(100);
    expect(names.b0001?.name).toBe("강문해수욕장");
  });
});

describe("개인정보 가리기 범위", () => {
  it("화면(줄바꿈 \\n)에서 고른 위치를 원래 본문(\\r\\n) 위치로 되돌린다", () => {
    const message = "첫 줄\r\n이름 김바다\r\n끝";
    const shown = linesNormalized(message);
    const at = shown.indexOf("김바다");
    expect(redactionOf(message, at, at + 3)).toEqual({
      start: message.indexOf("김바다"),
      end: message.indexOf("김바다") + 3,
      text: "김바다",
    });
  });

  it("앞뒤 공백은 빼고, 공백만 고르면 없음", () => {
    expect(redactionOf("a 010 b", 1, 6)).toEqual({
      start: 2,
      end: 5,
      text: "010",
    });
    expect(redactionOf("a   b", 1, 4)).toBeNull();
    expect(redactionOf("abc", 2, 2)).toBeNull();
  });
});
