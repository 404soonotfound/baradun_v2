// 한국어 문체 규칙 회귀 검사 (GH-546)
import { describe, expect, it } from "vitest";
import { checkText, LEXICON_RULES } from "../rules.mjs";

const ids2 = (hits: { id: string }[]) => hits.map((h) => h.id);
const ids = (text: string, kind: "commit" | "copy" | "copy-en" | "doc") =>
  ids2(checkText(text, kind));

describe("커밋 메시지 규칙", () => {
  it.each([
    [
      "GH-1 fix(web): 로그인 재시도 로직 수정을 진행함",
      "commit:bureaucratic_verb",
    ],
    ["GH-1 fix(web): 버그 수정 작업을 완료", "commit:wordy_completion"],
    ["GH-1 docs: 안내 문구를 수정했습니다", "commit:over_polite_ending"],
    ["GH-1 fix(core): 값이 저장되어지는 문제", "commit:double_passive"],
    ["GH-1 fix(core): 수집기에 의해 삭제된 값", "commit:by_passive"],
    ["GH-1 feat(web): 해변이 이름을 가지도록 함", "commit:have_literal"],
    ["GH-1 fix(web): 다시 시도하게 되는 문제", "commit:automated_passive"],
  ])("%s → %s", (text, id) => {
    expect(ids(text, "commit")).toContain(id);
  });

  it("저장소 형식의 자연스러운 제목은 통과", () => {
    expect(
      ids("GH-365 feat(core): 특보 유효시간 45분 경계 판정 추가", "commit"),
    ).toEqual([]);
  });

  it("커밋 규칙은 화면 문구에 쓰지 않음(문서의 합니다체 '했습니다'는 허용)", () => {
    expect(ids("배포를 마쳤습니다.", "doc")).toEqual([]);
  });
});

describe("화면 문구·문서 규칙", () => {
  it.each([
    ["값이 저장되어집니다", "T2b"],
    ["관리자에 의해 삭제됐어요", "T2"],
    ["해변으로의 이동은 하지 않아요", "A-19"],
    ["바다에 들어가는 활동은 피하고, 현장 안내를 따르세요", "C-11"],
    ["이번 개편은 크게 기여했어요", "D-hype"],
  ])("%s → %s", (text, id) => {
    expect(ids(text, "copy")).toContain(id);
    expect(ids(text, "doc")).toContain(id);
  });

  it("쉼표 없는 연결은 통과", () => {
    expect(
      ids("바다에 들어가는 활동은 피하고 현장 안내를 따르세요", "copy"),
    ).toEqual([]);
  });

  it("공지 금지 표현은 화면 문구에서만 막음", () => {
    expect(ids("지금은 안전해요", "copy")).toContain("notice:guarantee");
    expect(ids("적합도 높은 해변", "copy")).toContain("notice:score");
    // 규칙 설명 문서는 금지 표현을 예시로 적으므로 문서에는 쓰지 않음
    expect(ids("'안전해요' 같은 표현을 쓰지 않는다.", "doc")).toEqual([]);
  });

  it("허용 표현('안전요원')은 막지 않음", () => {
    expect(
      ids("최종 판단은 현장 통제와 안전요원 안내가 우선이에요", "copy"),
    ).toEqual([]);
  });
});

describe("리뷰 반영(GH-546)", () => {
  it("'참고·경고' 같은 명사 나열 뒤 쉼표는 연결어미로 보지 않음", () => {
    expect(ids("참고, 자세한 내용은 안내를 봐요", "copy")).toEqual([]);
    expect(ids("경고, 오류, 정보 순으로 보여요", "copy")).toEqual([]);
    expect(ids("피하고, 따르세요", "copy")).toContain("C-11");
  });

  it("영어 화면 문구는 금지 표현만 봄", () => {
    expect(ids("Safe to swim today", "copy-en")).toContain("notice:guarantee");
    expect(ids("It is recommended", "copy-en")).toContain("notice:recommend");
    expect(ids("Check the lifeguard, then go", "copy-en")).toEqual([]);
    // 공공데이터 이용 허락 문장은 해변 통제가 아님(en.json terms 문구)
    expect(
      ids(
        "Public Data Portal license: Beach Information Service has no restrictions.",
        "copy-en",
      ),
    ).toEqual([]);
    expect(ids("This beach has no restrictions.", "copy-en")).toContain(
      "notice:judgment",
    );
  });

  it("운영자 문구의 따옴표 예시 인용은 막지 않음(따옴표 밖은 그대로 막음)", () => {
    const quoted = "'안전해요' 같은 표현은 공지에 쓸 수 없어요";
    expect(ids(quoted, "copy")).toContain("notice:guarantee");
    expect(checkText(quoted, "copy", { quotedExamples: true })).toEqual([]);
    expect(
      ids2(checkText("지금은 안전해요", "copy", { quotedExamples: true })),
    ).toContain("notice:guarantee");
  });
});

describe("im-not-ai 어휘 사전(change 단계)", () => {
  it("61항목을 모두 옮김", () => {
    expect(LEXICON_RULES).toHaveLength(61);
  });

  // 원본 사전의 시험 문장을 그대로 써서 JS 정규식으로 옮겨도 같은 결과인지 확인
  it.each(LEXICON_RULES.map((r: { id: string }) => [r.id, r]))(
    "%s: 원본 시험 문장",
    (_id, rule) => {
      const r = rule as {
        id: string;
        testPositive: string;
        testNegative: string;
      };
      if (r.testPositive) expect(ids(r.testPositive, "doc")).toContain(r.id);
      if (r.testNegative)
        expect(ids(r.testNegative, "doc")).not.toContain(r.id);
    },
  );
});
