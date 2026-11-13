import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";

function collectLeafEntries(
  obj: Record<string, unknown>,
  prefix = "",
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(path, value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of collectLeafEntries(
        value as Record<string, unknown>,
        path,
      )) {
        out.set(k, v);
      }
    }
  }
  return out;
}

function extractPlaceholders(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\{([a-zA-Z0-9_]+)\s*(?:,|\})/g)].map((m) => m[1]!),
    ),
  ].sort();
}

describe("한국어·영어 문구 키 짝 맞춤 (#227 BRD-48)", () => {
  const koMap = collectLeafEntries(ko);
  const enMap = collectLeafEntries(en);

  it("ko.json과 en.json의 모든 리프 키가 일치하고 빈 문자열이 없음", () => {
    const onlyKo = [...koMap.keys()].filter((k) => !enMap.has(k));
    const onlyEn = [...enMap.keys()].filter((k) => !koMap.has(k));
    expect(onlyKo).toEqual([]);
    expect(onlyEn).toEqual([]);

    for (const [key, value] of enMap) {
      expect(value.trim().length, `empty en key: ${key}`).toBeGreaterThan(0);
    }
  });

  it("ko.json과 en.json의 치환 변수({name})가 서로 일치함", () => {
    for (const [key, koVal] of koMap) {
      const enVal = enMap.get(key);
      if (enVal === undefined) continue;
      expect(
        extractPlaceholders(enVal),
        `placeholder mismatch at ${key}`,
      ).toEqual(extractPlaceholders(koVal));
    }
  });
});
