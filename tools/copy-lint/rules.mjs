// 한국어 문체 규칙: im-not-ai(MIT, v2.4.6 e39287c)가 공개한 규칙을 옮김 (GH-546)
// - 커밋 메시지: extras/skills/commit-ko 어휘(scripts/commit_msg_lint.py 정규식)
// - 화면 문구·문서: 번역투(metrics_v2.py·diagnosis-rules.md), 연결어미 뒤 쉼표(strip_injected_commas.py),
//   AI 상투구(checks.py), 어휘 사전 change 단계(lexicon.json, 사람 글 오탐 보정본)
// - 화면 문구는 공지 금지 표현(D17-8, packages/contracts notice-rules) 차단 목록도 봄
// - 문서 전체 빈도로만 판단하는 규칙('~할 수 있다' 남발, 대구 2회+ 등)은 한 줄 단위로 막을 수 없어 넣지 않음
import { readFileSync } from "node:fs";
import { checkNoticePhrases } from "../../packages/contracts/src/notice-rules.ts";

const LEXICON = JSON.parse(
  readFileSync(new URL("./lexicon.json", import.meta.url), "utf8"),
);

// 커밋 메시지 전용(commit-lexicon.md 1~5절)
export const COMMIT_RULES = [
  {
    id: "commit:bureaucratic_verb",
    name: "사무적 동사",
    regex: /(?:수행|진행|실시)(?:함|하였|했|하였습니다|했습니다|하는|할|하여)/u,
    hint: "'~함'이나 구체적인 동사로 써요(예: '리팩터링을 진행함' → '리팩터링')",
  },
  {
    id: "commit:wordy_completion",
    name: "'작업을 완료' 명사구",
    regex: /작업을\s*(?:완료|수행|진행|실시)/u,
    hint: "작업 이름만 써요(예: '버그 수정 작업을 완료함' → '버그 수정')",
  },
  {
    id: "commit:over_polite_ending",
    name: "과공손 종결",
    regex: /하였습니다|했습니다|하였음/u,
    hint: "커밋 제목은 명사형이나 '~함'으로 끝내요",
  },
  {
    id: "commit:double_passive",
    name: "이중 피동",
    regex: /되어지(?:는|도록|었|ㄴ다|다)/u,
    hint: "'되어지다' → '되다'",
  },
  {
    id: "commit:by_passive",
    name: "'~에 의해 ~되다' 피동",
    regex: /에\s*의해\s*\S{0,12}(?:되|됨|된)/u,
    hint: "행위 주체를 주어로 세워요",
  },
  {
    id: "commit:have_literal",
    name: "'가지다' 직역",
    regex: /가지도록|가지고\s*있/u,
    hint: "'~이 있다'나 구체적인 동사로 써요",
  },
  {
    id: "commit:automated_passive",
    name: "'~하게 되다'",
    regex: /하게\s*되는|하게\s*되었/u,
    hint: "'~하다'로 바로 써요",
  },
];

// 화면 문구·문서 공통
export const TEXT_RULES = [
  {
    id: "T2b",
    name: "이중 피동",
    regex: /되어지|되어진|되어졌|되어집/u,
    hint: "'되어지다' → '되다'",
  },
  {
    id: "T2",
    name: "'~에 의해 ~되다' 피동",
    regex: /에\s*의(?:해|하여)\s*\S{0,12}(?:되|됨|된|됐|됩)/u,
    hint: "행위 주체를 주어로 세워요",
  },
  {
    id: "A-19",
    name: "이중 조사",
    regex: /에서의|에로의|으로의|으로부터의|로부터의/u,
    hint: "'-의'를 빼고 동사나 다른 조사로 풀어요(예: '해변으로의 이동' → '해변으로 이동')",
  },
  {
    id: "C-11",
    name: "연결어미 뒤 쉼표",
    // '참고·경고·광고' 같은 명사 나열은 연결어미가 아니라서 뺌(GH-546 리뷰)
    regex:
      /(?:(?<!참|경|광|최|창|원|신|공|투|사|재)고|며|지만|면서|는데|아서|어서|여서|해서|져서),\s/u,
    hint: "연결어미 바로 뒤 쉼표를 빼요",
  },
  {
    id: "D-hype",
    name: "AI 상투구",
    regex:
      /기록적인\s*성과|괄목할\s*만한|로\s*평가(?:된다|받|되)|주목받|크게\s*기여|중요한\s*역할을|시사하는\s*바가\s*크|의미가\s*크다/u,
    hint: "구체적인 사실로 바꿔 써요",
  },
];

export const LEXICON_RULES = LEXICON.entries.map((e) => ({
  id: `LEX:${e.id}`,
  name: `어휘 '${e.headword}'`,
  regex: new RegExp(e.regex, "u"),
  exclude: e.regex_exclude ? new RegExp(e.regex_exclude, "u") : null,
  hint: e.how || "문맥에 맞는 일상어로 바꿔요",
  testPositive: e.test_positive,
  testNegative: e.test_negative,
}));

function match(rule, text) {
  const m = rule.regex.exec(text);
  if (!m) return null;
  if (rule.exclude?.test(text)) return null;
  return m[0];
}

// 따옴표로 감싼 예시 인용('안전해요' 같은 표현은 못 써요)
const QUOTED = /'[^']*'|"[^"]*"|‘[^’]*’|“[^”]*”|「[^」]*」|『[^』]*』/gu;

// 공공데이터 이용 허락 문장('… license: … has no restrictions')의 'no restrictions'는 해변 통제가 아니라 이용 조건이라 뺌
const LICENSE_SENTENCE = /[^.]*\blicen[cs]e\b[^.]*(?:\.|$)/giu;

// kind: "commit" | "copy"(한국어 화면 문구 값) | "copy-en"(영어 화면 문구 값, 금지 표현만) | "doc"(*.md 줄)
// quotedExamples: 따옴표 안 금지 표현은 예시 인용으로 보고 막지 않음(운영자 사이트 안내 문구)
export function checkText(text, kind, { quotedExamples = false } = {}) {
  const rules =
    kind === "commit"
      ? COMMIT_RULES
      : kind === "copy-en"
        ? []
        : [...TEXT_RULES, ...LEXICON_RULES];
  const hits = [];
  for (const rule of rules) {
    const matched = match(rule, text);
    if (matched)
      hits.push({ id: rule.id, name: rule.name, matched, hint: rule.hint });
  }
  if (kind === "copy" || kind === "copy-en") {
    let target = quotedExamples ? text.replace(QUOTED, " ") : text;
    if (kind === "copy-en") target = target.replace(LICENSE_SENTENCE, " ");
    for (const b of checkNoticePhrases(target).blocked) {
      hits.push({
        id: `notice:${b.category}`,
        name: "금지 표현",
        matched: b.text,
        hint: "안전 보장·이용 판단·추천·점수 표현은 쓰지 않아요(AGENTS.md 제품 규칙, D17-8)",
      });
    }
  }
  return hits;
}
