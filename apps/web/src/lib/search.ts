import type { BeachSummary } from "@/lib/beach-summary";

// 해변 검색 (BRD-31 · 노션 2장 SRCH). 브라우저에서 처리(아키텍처 9장). React를 쓰지 않는 순수 함수만 모음
// 방식: 공백 뺀 대소문자 무시 부분 일치(한국어·영어 이름, 다른 이름, 지역 이름). 초성 검색은 후속
// 줄 세우는 기준은 안에서만 쓰고 화면에 점수·순위를 보이지 않음. 상태(특보)와 무관하게 이름으로만 찾음

// 사용자가 공백을 넣거나 빼도, 대소문자가 달라도 같게 보도록 맞춤 (NFC: 한글 조합 방식 통일)
export function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

export type SearchMatch =
  | { kind: "name" }
  | { kind: "alias"; alias: string } // 이름은 안 맞고 다른 이름으로 찾음 → '다른 이름이에요' 안내
  | { kind: "region" };

export type SearchHit<T> = { beach: T; match: SearchMatch };

type Searchable = Pick<
  BeachSummary,
  "name" | "names" | "aliases" | "regionNames"
>;

// 찾은 순서: 이름이 검색어로 시작 → 이름에 포함 → 다른 이름 → 지역. 같으면 화면 언어 이름 순
export function searchBeaches<T extends Searchable>(
  beaches: readonly T[],
  query: string,
  locale: string,
): SearchHit<T>[] {
  const needle = normalize(query);
  if (needle === "") return [];
  const hits: { hit: SearchHit<T>; rank: number }[] = [];
  for (const beach of beaches) {
    const names = beach.names.map(normalize);
    let rank: number | null = null;
    let match: SearchMatch | null = null;
    if (names.some((name) => name.startsWith(needle))) {
      rank = 0;
      match = { kind: "name" };
    } else if (names.some((name) => name.includes(needle))) {
      rank = 1;
      match = { kind: "name" };
    } else {
      // 검색어를 담은 다른 이름 중 가장 짧은 것(예: "상맹방(승공)"보다 "승공")을 안내에 씀
      const alias = beach.aliases
        .filter((item) => normalize(item).includes(needle))
        .sort((a, b) => a.length - b.length)[0];
      if (alias !== undefined) {
        rank = 2;
        match = { kind: "alias", alias };
      } else if (
        beach.regionNames.some((region) => normalize(region).includes(needle))
      ) {
        rank = 3;
        match = { kind: "region" };
      }
    }
    if (rank !== null && match !== null)
      hits.push({ hit: { beach, match }, rank });
  }
  return hits
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.hit.beach.name.localeCompare(b.hit.beach.name, locale),
    )
    .map((item) => item.hit);
}

// 일치한 부분을 굵게 보이려고 text 안의 위치를 찾음. 공백을 건너뛰고 맞춰 보며, 못 찾으면 null
export function matchRange(
  text: string,
  query: string,
): { start: number; end: number } | null {
  const needle = normalize(query);
  if (needle === "") return null;
  const chars = [...text];
  for (let start = 0; start < chars.length; start++) {
    if (/\s/.test(chars[start] ?? "")) continue;
    let matched = "";
    for (let end = start; end < chars.length; end++) {
      const ch = chars[end] ?? "";
      if (/\s/.test(ch)) continue;
      matched += ch.normalize("NFC").toLowerCase();
      if (!needle.startsWith(matched)) break;
      if (matched === needle) {
        // 문자 단위(코드 포인트) 위치를 글자(UTF-16) 위치로
        return {
          start: chars.slice(0, start).join("").length,
          end: chars.slice(0, end + 1).join("").length,
        };
      }
    }
  }
  return null;
}

// 한국어 주제 조사: "경포대는" / "경포해변은". 마지막 글자가 한글이고 받침이 있으면 은, 아니면 는
export function withTopicParticle(word: string): string {
  // 끝의 괄호·기호는 건너뛰고 마지막 글자(한글·영문·숫자)로 정함: "상맹방(승공)" → 공
  const last = [...word.trim()]
    .reverse()
    .find((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (last === undefined) return word;
  const code = last.charCodeAt(0);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  return `${word}${isHangul && (code - 0xac00) % 28 !== 0 ? "은" : "는"}`;
}
