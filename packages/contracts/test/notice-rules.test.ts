import { describe, expect, it } from "vitest";
import {
  checkNoticePhrases,
  graphemeLength,
  NOTICE_BLOCKED_PHRASES,
  NOTICE_WARNED_PHRASES,
} from "../src/notice-rules";

const blockedOf = (text: string) =>
  checkNoticePhrases(text).blocked.map((h) => h.phrase);
const warnedOf = (text: string) =>
  checkNoticePhrases(text).warned.map((h) => h.phrase);

describe("공지 표현 검사 (D16-D1·D17-8)", () => {
  it("D17-8 차단 목록의 모든 표현을 그대로 막는다", () => {
    for (const [category, phrases] of Object.entries(NOTICE_BLOCKED_PHRASES)) {
      for (const phrase of phrases) {
        const text = phrase.replace("○", "3");
        const hits = checkNoticePhrases(text).blocked;
        expect(hits, text).toContainEqual(
          expect.objectContaining({ phrase, category }),
        );
      }
    }
  });

  it("D17-8 경고 목록의 모든 표현을 경고만 한다", () => {
    for (const phrase of NOTICE_WARNED_PHRASES) {
      expect(blockedOf(phrase), phrase).toEqual([]);
      expect(warnedOf(phrase), phrase).toContain(phrase);
    }
  });

  it("띄어쓰기·대소문자·전각 문자를 바꿔도 같은 표현으로 본다", () => {
    expect(blockedOf("오늘은 안 전 해 요")).toEqual(["안전해요"]);
    expect(blockedOf("SAFE  TO\nSWIM")).toEqual(["safe to swim"]);
    expect(blockedOf("ＴＯＰ ５ 해변")).toEqual(["TOP ○"]);
    // 붙여 넣은 문구의 폭 없는 공백·soft hyphen
    expect(blockedOf("안​전​해​요")).toEqual(["안전해요"]);
    expect(blockedOf("recom­mended")).toEqual(["recommended"]);
  });

  it("허용 표현은 먼저 빼서 단어만으로 막거나 경고하지 않는다", () => {
    expect(checkNoticePhrases("안전요원 안내를 꼭 따라 주세요")).toEqual({
      blocked: [],
      warned: [],
    });
    expect(
      checkNoticePhrases(
        "바라던 바다는 안전을 보장하지 않아요. 안전수칙을 지켜 주세요",
      ),
    ).toEqual({ blocked: [], warned: [] });
    expect(checkNoticePhrases("안전·데이터 안내를 새로 썼어요")).toEqual({
      blocked: [],
      warned: [],
    });
    expect(
      checkNoticePhrases(
        "Follow lifeguard and safety guidelines. This is not a safety guarantee.",
      ),
    ).toEqual({ blocked: [], warned: [] });
  });

  it("허용 표현 밖의 같은 단어는 그대로 검사한다", () => {
    expect(blockedOf("안전요원이 있어 안전해요")).toEqual(["안전해요"]);
    expect(warnedOf("안전요원 배치, 안전 확인")).toEqual(["안전"]);
  });

  it("영문은 단어 경계에서만 맞춘다", () => {
    expect(checkNoticePhrases("Operating hours change on Nov 12")).toEqual({
      blocked: [],
      warned: [],
    });
    expect(checkNoticePhrases("Use the underscore key. It is unsafe.")).toEqual(
      { blocked: [], warned: [] },
    );
    expect(blockedOf("Desktop 5 update")).toEqual([]);
    expect(blockedOf("Top 5 beaches")).toEqual(["TOP ○"]);
    expect(blockedOf("Recommended!")).toEqual(["recommended"]);
  });

  it("숫자 표현: 점수·순위는 막고 점검 시각은 막지 않는다", () => {
    expect(blockedOf("별점 4.5점")).toEqual(["별점", "○점"]);
    expect(checkNoticePhrases("별점 4.5점").blocked).toContainEqual({
      phrase: "○점",
      text: "5점",
      category: "score",
    });
    expect(blockedOf("인기 1위 해변")).toEqual(["○위"]);
    expect(
      checkNoticePhrases("11월 12일 02:00~04:00 점검이 있어요. 3 점검 항목"),
    ).toEqual({ blocked: [], warned: [] });
    expect(checkNoticePhrases("특별 점검 안내").blocked).toEqual([]);
    expect(checkNoticePhrases("특별점검 안내").blocked).toEqual([]);
    // '점'과 '검' 사이를 띄우면 점검이 아니라 점수로 봄
    expect(blockedOf("만족도 5점 검증 완료")).toEqual(["○점"]);
    expect(blockedOf("별점 검토 결과")).toEqual(["별점"]);
  });

  it("영문 차단 표현의 복수형도 막고, 활용형은 단어 경계로 가른다", () => {
    expect(blockedOf("Best beaches this week")).toEqual(["best beach"]);
    expect(blockedOf("Our top picks")).toEqual(["top pick"]);
    expect(blockedOf("High scores and 5-star ratings")).toEqual([
      "rating",
      "score",
    ]);
    expect(blockedOf("No risks today")).toEqual(["no risk"]);
    expect(blockedOf("Lifeguards on duty")).toEqual([]);
    expect(warnedOf("Lifeguards on duty")).toEqual([]);
    expect(blockedOf("The match was scored late")).toEqual([]);
    expect(
      checkNoticePhrases("Calm sea, calms down").warned.map((h) => h.text),
    ).toEqual(["Calm", "calms"]);
  });

  it("하이픈·가운뎃점·# 같은 이음표를 끼워도 같은 표현으로 본다", () => {
    expect(blockedOf("safe-to-swim zone")).toEqual(["safe to swim"]);
    expect(blockedOf("TOP-5 해변")).toEqual(["TOP ○"]);
    expect(blockedOf("Top #1 beach")).toEqual(["TOP ○"]);
    expect(blockedOf("추천·해변 안내")).toEqual(["추천 해변"]);
    expect(blockedOf("Risk‐free")).toEqual(["risk-free"]);
  });

  it("경계에 걸려 버린 자리 뒤의 표현도 다시 찾는다", () => {
    expect(checkNoticePhrases("v2 5점").blocked).toEqual([
      { phrase: "○점", text: "5점", category: "score" },
    ]);
  });

  it("차단으로 잡힌 자리는 경고로 한 번 더 세지 않는다", () => {
    expect(checkNoticePhrases("적합도 높은 곳")).toEqual({
      blocked: [{ phrase: "적합도", text: "적합도", category: "score" }],
      warned: [],
    });
    expect(warnedOf("위험 없음")).toEqual([]);
    expect(warnedOf("위험 주의")).toEqual(["위험"]);
  });

  it("맞은 원래 문구를 띄어쓰기째 돌려준다", () => {
    expect(checkNoticePhrases("지금 수영 가능해요").blocked).toEqual([
      { phrase: "수영 가능", text: "수영 가능", category: "judgment" },
    ]);
    expect(checkNoticePhrases("수 영가능").blocked[0]?.text).toBe("수 영가능");
  });

  it("점검 안내 같은 보통 문구는 통과한다", () => {
    expect(
      checkNoticePhrases(
        "11월 12일 새벽 데이터 점검으로 정보가 늦게 바뀔 수 있어요. 현장 안내를 확인하세요.",
      ),
    ).toEqual({ blocked: [], warned: [] });
  });
});

describe("공지 글자 수 (D16-D2)", () => {
  it("grapheme 기준으로 센다", () => {
    expect(graphemeLength("👨‍👩‍👧 가")).toBe(3);
    expect(graphemeLength("é")).toBe(1);
  });
});
