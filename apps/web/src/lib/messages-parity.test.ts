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

// ICU 메시지에서 최상위 치환 변수({name} 또는 {name, plural|select, ...})만 추출함
// plural/select 선택지 본문(예: other {beaches})은 변수로 오인하지 않도록 건너뜀
function extractPlaceholders(text: string): string[] {
  const names = new Set<string>();
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'" && i + 1 < text.length && text[i + 1] === "{") {
      i += 2;
      continue;
    }
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const rest = text.slice(i + 1);
    const m = /^([a-zA-Z0-9_]+)\s*(?:(,)|(\}))/.exec(rest);
    if (m) {
      names.add(m[1]!);
    }
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
  }
  return [...names].sort();
}

describe("한국어·영어 문구 키 짝 맞춤 (#227 BRD-48)", () => {
  const koMap = collectLeafEntries(ko);
  const enMap = collectLeafEntries(en);

  it("ko.json과 en.json의 모든 리프 키가 일치하고 빈 문자열이 없음", () => {
    const onlyKo = [...koMap.keys()].filter((k) => !enMap.has(k));
    const onlyEn = [...enMap.keys()].filter((k) => !koMap.has(k));
    expect(onlyKo).toEqual([]);
    expect(onlyEn).toEqual([]);

    for (const [key, value] of koMap) {
      expect(value.trim().length, `empty ko key: ${key}`).toBeGreaterThan(0);
    }
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
